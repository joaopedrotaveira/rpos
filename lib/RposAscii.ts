///<reference path="../rpos.d.ts"/>

import events = require("events");
import { StringDecoder } from "string_decoder";

/*
rposascii protocol v2 - rpos side
See docs/rposascii-protocol-v2.md

Lines are TAB separated and end with a line feed. After the positional fields a
message may carry key=value tokens. Unknown commands and keys are ignored.
*/

// Normalised position scales. 1.0 is this many degrees.
export const PAN_SCALE_DEG = 180;
export const TILT_SCALE_DEG = 120;

export interface RposAsciiMessage {
  command: string;
  fields: string[];
  keys: { [key: string]: string };
}

export type MoveState = 'IDLE' | 'MOVING' | 'UNKNOWN';

export interface RposAsciiCaps {
  proto: number;
  abs: boolean;
  rel: boolean;
  cont: boolean;
  zoom: boolean;
  home: boolean;
  presets: number;        // 0 when not reported
  movestatus: boolean;
  position: boolean;
  fixedhome: boolean;
  hfov?: number;          // degrees
  vfov?: number;          // degrees
  panrange?: number[];    // [min, max] degrees
  tiltrange?: number[];   // [min, max] degrees
}

export interface RposAsciiStatus {
  pan?: number;           // -1..1
  tilt?: number;          // -1..1
  zoom?: number;          // -1..1
  panTilt: MoveState;
  homed: boolean;
  atHome?: boolean;
  atPreset?: string;
  error?: string;
  time: number;           // when rpos received it (ms)
  stale?: boolean;        // true when the controller did not answer in time
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseLine(line: string): RposAsciiMessage | null {
  const text = line.replace(/[\r\n]+$/, '');
  if (text.length === 0) return null;
  const tokens = text.split('\t');
  const command = tokens[0].trim().toLowerCase();
  if (command.length === 0) return null;
  const message: RposAsciiMessage = { command: command, fields: [], keys: {} };
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (KEY_PATTERN.test(token)) {
      const eq = token.indexOf('=');
      message.keys[token.substring(0, eq).toLowerCase()] = token.substring(eq + 1);
    } else {
      message.fields.push(token);
    }
  }
  return message;
}

function clean(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ');
}

export function formatNumber(value: number): string {
  if (!isFinite(value)) return '0';
  return String(parseFloat(value.toFixed(6)));
}

// fields may be strings or numbers. keys with an undefined value are left out.
export function formatLine(command: string, fields?: (string | number)[], keys?: { [key: string]: string | number | undefined }): string {
  const parts: string[] = [command];
  for (const field of (fields || [])) {
    parts.push(typeof field === 'number' ? formatNumber(field) : clean(String(field)));
  }
  if (keys) {
    for (const key of Object.keys(keys)) {
      const value = keys[key];
      if (value === undefined || value === null) continue;
      parts.push(key + '=' + (typeof value === 'number' ? formatNumber(value) : clean(String(value))));
    }
  }
  return parts.join('\t') + '\n';
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return isFinite(n) ? n : undefined;
}

function parseRange(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',');
  if (parts.length !== 2) return undefined;
  const lo = parseNumber(parts[0]);
  const hi = parseNumber(parts[1]);
  if (lo === undefined || hi === undefined || lo > hi) return undefined;
  return [lo, hi];
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function parseCaps(keys: { [key: string]: string }): RposAsciiCaps {
  const flag = (name: string) => keys[name] === '1';
  const presets = parseNumber(keys['presets']);
  const hfov = parseNumber(keys['hfov']);
  const vfov = parseNumber(keys['vfov']);
  return {
    proto: parseNumber(keys['proto']) || 2,
    abs: flag('abs'),
    rel: flag('rel'),
    cont: flag('cont'),
    zoom: flag('zoom'),
    home: flag('home'),
    presets: presets !== undefined && presets > 0 ? Math.floor(presets) : 0,
    movestatus: flag('movestatus'),
    position: flag('position'),
    fixedhome: flag('fixedhome'),
    hfov: hfov !== undefined && hfov > 0 && hfov < 360 ? hfov : undefined,
    vfov: vfov !== undefined && vfov > 0 && vfov < 360 ? vfov : undefined,
    panrange: parseRange(keys['panrange']),
    tiltrange: parseRange(keys['tiltrange'])
  };
}

export function parseStatus(keys: { [key: string]: string }, now: number): RposAsciiStatus {
  const position = (name: string) => {
    const n = parseNumber(keys[name]);
    return n === undefined ? undefined : clamp(n, -1, 1);
  };
  const moveText = (keys['pantilt'] || '').toUpperCase();
  const panTilt: MoveState = moveText === 'IDLE' || moveText === 'MOVING' ? moveText : 'UNKNOWN';
  const status: RposAsciiStatus = {
    pan: position('pan'),
    tilt: position('tilt'),
    zoom: position('zoom'),
    panTilt: panTilt,
    homed: keys['homed'] !== '0',
    time: now
  };
  if (keys['athome'] !== undefined) status.atHome = keys['athome'] === '1';
  if (keys['atpreset'] !== undefined && keys['atpreset'] !== '') status.atPreset = keys['atpreset'];
  if (keys['error'] !== undefined && keys['error'] !== '') status.error = keys['error'];
  return status;
}

// "1,3,7" -> ['1','3','7']. Anything that is not a positive integer is dropped.
export function parsePresetTokens(value: string | undefined): string[] {
  if (!value) return [];
  const tokens: string[] = [];
  for (const part of value.split(',')) {
    const t = part.trim();
    if (/^[1-9][0-9]*$/.test(t) && tokens.indexOf(t) < 0) tokens.push(t);
  }
  return tokens;
}

// Accumulates chunks from a serial port or TCP socket and returns whole lines.
// A line longer than maxLength is dropped, up to its line feed.
export class LineBuffer {
  private buffer = '';
  private skipping = false;
  private decoder = new StringDecoder('utf8');

  constructor(private maxLength: number = 4096) { }

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const pieces = text.split('\n');
    const lines: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const last = (i === pieces.length - 1);
      if (this.skipping) {
        if (!last) this.skipping = false; // the dropped line has ended
        continue;
      }
      this.buffer += pieces[i];
      if (this.buffer.length > this.maxLength) {
        // too long: drop it. If its line feed has not arrived yet, drop up to that too.
        this.buffer = '';
        this.skipping = last;
        continue;
      }
      if (!last) {
        lines.push(this.buffer.replace(/\r$/, ''));
        this.buffer = '';
      }
    }
    return lines;
  }

  reset() {
    this.buffer = '';
    this.skipping = false;
  }
}

export interface RposAsciiClientOptions {
  statusMaxAgeMs?: number;     // PTZStatusMaxAgeMs, default 500
  requestTimeoutMs?: number;   // PTZRequestTimeoutMs, default 300
  capsRetryMs?: number;        // first retry delay for getcaps, default 2000
  capsRetryMaxMs?: number;     // default 30000
}

/*
Talks to the controller through the write function. Events:
  'caps'    (RposAsciiCaps)
  'status'  (RposAsciiStatus)
  'presets' (string[])   tokens of the presets the controller has stored
*/
export class RposAsciiClient extends events.EventEmitter {
  caps: RposAsciiCaps | null = null;
  status: RposAsciiStatus | null = null;

  private lineBuffer = new LineBuffer();
  private waiters: ((status: RposAsciiStatus) => void)[] = [];
  private capsTimer: any = null;
  private capsDelay: number;
  private statusMaxAgeMs: number;
  private requestTimeoutMs: number;
  private capsRetryMs: number;
  private capsRetryMaxMs: number;

  constructor(private write: (line: string) => void, options?: RposAsciiClientOptions) {
    super();
    const o = options || {};
    this.statusMaxAgeMs = o.statusMaxAgeMs !== undefined ? o.statusMaxAgeMs : 500;
    this.requestTimeoutMs = o.requestTimeoutMs !== undefined ? o.requestTimeoutMs : 300;
    this.capsRetryMs = o.capsRetryMs !== undefined ? o.capsRetryMs : 2000;
    this.capsRetryMaxMs = o.capsRetryMaxMs !== undefined ? o.capsRetryMaxMs : 30000;
    this.capsDelay = this.capsRetryMs;
  }

  send(command: string, fields?: (string | number)[], keys?: { [key: string]: string | number | undefined }) {
    this.write(formatLine(command, fields, keys));
  }

  // Call when the link opens or reopens. Asks for caps, status and presets and
  // keeps asking for caps (with back-off) until the controller answers.
  connected() {
    this.lineBuffer.reset();
    this.capsDelay = this.capsRetryMs;
    this.requestAll();
    this.scheduleCapsRetry();
  }

  disconnected() {
    this.clearCapsTimer();
    this.lineBuffer.reset();
  }

  requestAll() {
    this.send('getcaps');
    this.send('getstatus');
    this.send('getpresets');
  }

  private clearCapsTimer() {
    if (this.capsTimer) {
      clearTimeout(this.capsTimer);
      this.capsTimer = null;
    }
  }

  private scheduleCapsRetry() {
    this.clearCapsTimer();
    this.capsTimer = setTimeout(() => {
      this.capsTimer = null;
      if (this.caps) return;
      this.requestAll();
      this.capsDelay = Math.min(this.capsDelay * 2, this.capsRetryMaxMs);
      this.scheduleCapsRetry();
    }, this.capsDelay);
    if (this.capsTimer.unref) this.capsTimer.unref();
  }

  // Serial and TCP: arbitrary chunks
  handleData(chunk: Buffer | string) {
    for (const line of this.lineBuffer.push(chunk)) this.handleLine(line);
  }

  // UDP: every datagram holds whole lines
  handleDatagram(chunk: Buffer | string) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) this.handleLine(line.replace(/\r$/, ''));
  }

  handleLine(line: string) {
    let message: RposAsciiMessage | null = null;
    try {
      message = parseLine(line);
    } catch (err) {
      return;
    }
    if (!message) return;
    if (message.command === 'caps') {
      this.caps = parseCaps(message.keys);
      this.clearCapsTimer();
      this.emit('caps', this.caps);
    } else if (message.command === 'status') {
      this.status = parseStatus(message.keys, Date.now());
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve(this.status);
      this.emit('status', this.status);
    } else if (message.command === 'presets') {
      this.emit('presets', parsePresetTokens(message.keys['used']));
    }
    // anything else is ignored
  }

  // Answer from the cache when it is fresh. Otherwise ask the controller and
  // wait up to the request timeout. On timeout the last status is returned
  // marked stale with an UNKNOWN move state, or null if there never was one.
  getStatus(): Promise<RposAsciiStatus | null> {
    const now = Date.now();
    if (this.status && now - this.status.time <= this.statusMaxAgeMs) {
      return Promise.resolve(this.status);
    }
    return new Promise<RposAsciiStatus | null>((resolve) => {
      let done = false;
      const waiter = (status: RposAsciiStatus) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(status);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        if (this.status) {
          const stale = <RposAsciiStatus>{};
          for (const key of Object.keys(this.status)) stale[key] = this.status[key];
          stale.panTilt = 'UNKNOWN';
          stale.stale = true;
          resolve(stale);
        } else {
          resolve(null);
        }
      }, this.requestTimeoutMs);
      this.waiters.push(waiter);
      this.send('getstatus');
    });
  }
}

/*
Used when the controller does not report status (a v1 controller, or
PTZStatusMode "estimate"). It dead-reckons the position from the commands rpos
sent and guesses how long a move takes. Positions are normalised, -1..1.
*/
export class MotionEstimator {
  private pan = 0;
  private tilt = 0;
  private velocityPan = 0;
  private velocityTilt = 0;
  private lastTime: number;
  private targetPan = 0;
  private targetTilt = 0;
  private speedPan = 0;   // normalised units per ms while heading for a target
  private speedTilt = 0;
  private moveEnd = 0;    // time the move to the target ends, 0 when none

  constructor(private msPerUnit: number = 1500, private now: () => number = Date.now) {
    this.lastTime = this.now();
  }

  private advance() {
    const t = this.now();
    let dt = t - this.lastTime;
    this.lastTime = t;
    if (dt <= 0) return;
    if (this.moveEnd > 0) {
      const remaining = this.moveEnd - (t - dt);
      const used = Math.min(dt, Math.max(remaining, 0));
      this.pan = clamp(this.pan + this.speedPan * used, -1, 1);
      this.tilt = clamp(this.tilt + this.speedTilt * used, -1, 1);
      if (t >= this.moveEnd) {
        this.pan = this.targetPan;
        this.tilt = this.targetTilt;
        this.moveEnd = 0;
      }
    }
    if (this.velocityPan !== 0 || this.velocityTilt !== 0) {
      this.pan = clamp(this.pan + (this.velocityPan / this.msPerUnit) * dt, -1, 1);
      this.tilt = clamp(this.tilt + (this.velocityTilt / this.msPerUnit) * dt, -1, 1);
    }
  }

  private moveTo(pan: number, tilt: number, speed: number) {
    this.advance();
    this.velocityPan = 0;
    this.velocityTilt = 0;
    this.targetPan = clamp(pan, -1, 1);
    this.targetTilt = clamp(tilt, -1, 1);
    const distance = Math.max(Math.abs(this.targetPan - this.pan), Math.abs(this.targetTilt - this.tilt));
    if (distance < 1e-6) {
      this.moveEnd = 0;
      return;
    }
    const s = clamp(speed > 0 ? speed : 1, 0.05, 1);
    const duration = (distance * this.msPerUnit) / s;
    this.speedPan = (this.targetPan - this.pan) / duration;
    this.speedTilt = (this.targetTilt - this.tilt) / duration;
    this.moveEnd = this.now() + duration;
  }

  absolute(pan: number, tilt: number, speed: number = 1) {
    this.moveTo(pan, tilt, speed);
  }

  relative(dPan: number, dTilt: number, speed: number = 1) {
    this.advance();
    this.moveTo(this.pan + dPan, this.tilt + dTilt, speed);
  }

  continuous(pan: number, tilt: number) {
    this.advance();
    this.moveEnd = 0;
    this.velocityPan = clamp(pan, -1, 1);
    this.velocityTilt = clamp(tilt, -1, 1);
  }

  stop() {
    this.advance();
    this.moveEnd = 0;
    this.velocityPan = 0;
    this.velocityTilt = 0;
  }

  home() {
    this.moveTo(0, 0, 1);
  }

  snapshot(): RposAsciiStatus {
    this.advance();
    const moving = this.moveEnd > 0 || this.velocityPan !== 0 || this.velocityTilt !== 0;
    return {
      pan: this.pan,
      tilt: this.tilt,
      zoom: 0,
      panTilt: moving ? 'MOVING' : 'IDLE',
      homed: true,
      time: this.now()
    };
  }
}

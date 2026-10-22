#!/usr/bin/env python3
"""Interactive console and self-test for a PTZ controller.

Talks to the controller over a serial port (or TCP) with the rposascii v2 protocol. It is
meant for trying out the firmware by hand. Needs pyserial for serial ports:
pip install pyserial

  ptz_console.py /dev/ttyUSB0                  interactive, keys below
  ptz_console.py /dev/ttyUSB0 --demo           run a short self-test (it MOVES the camera)
  ptz_console.py tcp://192.168.1.50:9999       the same over TCP
  ptz_console.py /dev/ttyUSB0 --baud 9600      if the firmware does not use 115200

Interactive keys (the terminal must have focus):
  arrows or w a s d   move up / left / down / right (see "mode" below)
  space or x          stop
  m                   change the move mode:  fov -> generic -> velocity
  + / -               bigger / smaller step
  v                   change the speed sent with moves: none -> 0.2 -> 0.5 -> 1.0
  c   getcaps         g   getstatus         p   getpresets
  0                   go to home            1 .. 9   go to preset 1 .. 9
  :                   type a command (see below)
  ?                   help                  q   quit (sends a stop first)

Commands after ':'
  abs P T             absolute-ptz to position P T (-1..1)
  rel P T [fov|generic]   relative-ptz
  vel P T             ptz (continuous velocity)
  set N | goto N | clear N   presets
  raw TEXT            send a line as it is, \\t is a TAB
  speed S             speed 0..1 for moves, or "none"

Move modes (rposascii)
  fov       relative-ptz with space=fov. 1.0 is one field of view (what Frigate sends)
  generic   relative-ptz with space=generic. Pan 1.0 = 180 degrees, tilt 1.0 = 120 degrees
  velocity  ptz (continuous). It keeps moving until you stop it
"""
import argparse
import math
import os
import queue
import select
import socket
import sys
import termios
import threading
import time
import tty

PAN_SCALE_DEG = 180.0
TILT_SCALE_DEG = 120.0


# ---------------------------------------------------------------- link

class Link:
    """A serial port or a TCP connection."""

    def __init__(self, target, baud):
        self.sock = None
        self.port = None
        if target.startswith('tcp://'):
            host, port = target[6:].rsplit(':', 1)
            self.sock = socket.create_connection((host, int(port)), timeout=5)
            self.sock.settimeout(0.1)
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        else:
            try:
                import serial
            except ImportError:
                sys.exit('pyserial is needed for serial ports:  pip install pyserial')
            self.port = serial.Serial(target, baud, timeout=0.1)

    def write(self, data):
        if self.sock:
            self.sock.sendall(data)
        else:
            self.port.write(data)
            self.port.flush()

    def read(self):
        if self.sock:
            try:
                return self.sock.recv(4096)
            except socket.timeout:
                return b''
        # read(n) would wait for the whole timeout unless n bytes arrive. Wait for the first
        # byte, then take whatever else is already there, so messages are not delayed.
        data = self.port.read(1)
        if data:
            data += self.port.read(self.port.in_waiting)
        return data

    def close(self):
        (self.sock or self.port).close()


# ---------------------------------------------------------------- output

out_lock = threading.Lock()
T0 = time.time()


def say(text):
    with out_lock:
        sys.stdout.write('%7.3f  %s\n' % (time.time() - T0, text))
        sys.stdout.flush()


def parse_message(line):
    """'status\\tpan=1\\tx' -> ('status', {'pan': '1'}). Keys only; enough for this tool."""
    parts = line.split('\t')
    keys = {}
    for part in parts[1:]:
        if '=' in part:
            k, v = part.split('=', 1)
            keys[k] = v
    return parts[0], keys


def describe_status(keys):
    try:
        pan = float(keys['pan']) * PAN_SCALE_DEG
        tilt = float(keys['tilt']) * TILT_SCALE_DEG
        where = 'pan %+7.2f deg  tilt %+7.2f deg' % (pan, tilt)
    except (KeyError, ValueError):
        where = 'position unknown'
    return '%s  %s  homed=%s' % (keys.get('pantilt', '?'), where, keys.get('homed', '?'))


# ---------------------------------------------------------------- the controller

class Controller:
    """Sends commands, and keeps the latest caps and status that came back."""

    def __init__(self, link):
        self.link = link
        self.messages = queue.Queue()
        self.lock = threading.Lock()
        self.status = None          # (time, keys)
        self.caps = None
        self.running = True
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()

    def _read_loop(self):
        buf = b''
        while self.running:
            try:
                chunk = self.link.read()
            except Exception as e:      # port closed or unplugged
                if self.running:
                    say('!! read error: %s' % e)
                return
            if not chunk:
                continue
            buf += chunk
            while b'\n' in buf:
                raw, buf = buf.split(b'\n', 1)
                self._handle_line(raw.decode('utf-8', 'replace').rstrip('\r'))
            if len(buf) > 4096:
                say('<- (dropped %d bytes without a line end; first bytes: %r)' % (len(buf), buf[:16]))
                buf = b''

    def _handle_line(self, line):
        now = time.time()
        shown = line.replace('\t', ' <TAB> ')
        command, keys = parse_message(line)
        extra = ''
        if command == 'status':
            with self.lock:
                self.status = (now, keys)
            extra = '   [%s]' % describe_status(keys)
        elif command == 'caps':
            with self.lock:
                self.caps = keys
        self.messages.put((now, command, keys))
        say('<- %s%s' % (shown, extra))

    # ----- sending
    def send_line(self, text, quiet=False):
        if not quiet:
            say('-> %s' % text.replace('\t', ' <TAB> '))
        self.link.write((text + '\n').encode('utf-8'))

    def close(self):
        self.running = False
        try:
            self.link.close()
        except Exception:
            pass


def f(x):
    return ('%.4f' % x).rstrip('0').rstrip('.') or '0'


# ---------------------------------------------------------------- actions

class Actions:
    def __init__(self, ctl):
        self.ctl = ctl
        self.mode = 'fov'
        self.steps = {'fov': 0.05, 'generic': 0.02, 'velocity': 0.3}
        self.speed_choices = [None, 0.2, 0.5, 1.0]
        self.speed_index = 0

    @property
    def speed(self):
        return self.speed_choices[self.speed_index]

    def speed_keys(self):
        s = self.speed
        return '' if s is None else '\tpanspeed=%s\ttiltspeed=%s' % (f(s), f(s))

    def direction(self, name):
        dx, dy = {'left': (-1, 0), 'right': (1, 0), 'up': (0, 1), 'down': (0, -1)}[name]
        step = self.steps[self.mode]
        if self.mode == 'velocity':
            self.ctl.send_line('ptz\t%s\t%s\t0' % (f(dx * step), f(dy * step)))
        else:
            self.ctl.send_line('relative-ptz\t%s\t%s\t0\tspace=%s%s' % (
                f(dx * step), f(dy * step), self.mode, self.speed_keys()))

    def stop(self):
        self.ctl.send_line('stop\tpantilt=1\tzoom=1')

    def getcaps(self):
        self.ctl.send_line('getcaps')

    def getstatus(self):
        self.ctl.send_line('getstatus')

    def getpresets(self):
        self.ctl.send_line('getpresets')

    def home(self):
        self.ctl.send_line('gotohome')

    def goto(self, n):
        self.ctl.send_line('gotopreset\tPreset %d\t%d' % (n, n))

    def setpreset(self, n):
        self.ctl.send_line('setpreset\tPreset %d\t%d' % (n, n))

    def clearpreset(self, n):
        self.ctl.send_line('clearpreset\tPreset %d\t%d' % (n, n))

    def cycle_mode(self):
        order = ['fov', 'generic', 'velocity']
        self.mode = order[(order.index(self.mode) + 1) % 3]
        self.show_settings()

    def cycle_speed(self):
        self.speed_index = (self.speed_index + 1) % len(self.speed_choices)
        self.show_settings()

    def scale_step(self, factor):
        self.steps[self.mode] = min(1.0, max(0.001, self.steps[self.mode] * factor))
        self.show_settings()

    def show_settings(self):
        say('mode %s, step %s, speed %s' % (self.mode, f(self.steps[self.mode]), self.speed or 'default'))

    def command(self, text):
        words = text.split()
        if not words:
            return
        c = words[0].lower()
        try:
            if c == 'abs':
                self.ctl.send_line('absolute-ptz\t%s\t%s\t0%s' % (f(float(words[1])), f(float(words[2])), self.speed_keys()))
            elif c == 'rel':
                space = words[3] if len(words) > 3 else 'fov'
                self.ctl.send_line('relative-ptz\t%s\t%s\t0\tspace=%s%s' % (f(float(words[1])), f(float(words[2])), space, self.speed_keys()))
            elif c == 'vel':
                self.ctl.send_line('ptz\t%s\t%s\t0' % (f(float(words[1])), f(float(words[2]))))
            elif c == 'set':
                self.setpreset(int(words[1]))
            elif c == 'goto':
                self.goto(int(words[1]))
            elif c == 'clear':
                self.clearpreset(int(words[1]))
            elif c == 'raw':
                self.ctl.send_line(text[len(words[0]):].strip().replace('\\t', '\t'))
            elif c == 'speed':
                value = words[1].lower()
                if value == 'none':
                    self.speed_choices[0] = None
                    self.speed_index = 0
                else:
                    self.speed_choices.append(min(1.0, max(0.0, float(value))))
                    self.speed_index = len(self.speed_choices) - 1
                self.show_settings()
            else:
                say('!! unknown command. Type ? for help')
        except (IndexError, ValueError):
            say('!! wrong arguments. Type ? for help')


# ---------------------------------------------------------------- the keyboard

HELP = __doc__.split('Interactive keys')[1].split('Move modes')[0]


def read_key(fd):
    """One key. Arrow keys come back as 'up', 'down', 'left', 'right'."""
    ch = os.read(fd, 1)
    if ch != b'\x1b':
        return ch.decode('utf-8', 'ignore')
    if not select.select([fd], [], [], 0.05)[0]:
        return 'esc'
    rest = os.read(fd, 8)
    return {b'[A': 'up', b'[B': 'down', b'[C': 'right', b'[D': 'left',
            b'OA': 'up', b'OB': 'down', b'OC': 'right', b'OD': 'left'}.get(rest[:2], 'esc')


def interactive(ctl, actions):
    if not sys.stdin.isatty():
        sys.exit('The interactive mode needs a terminal. Use --demo, or run it in a terminal.')
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    print('Keys: arrows/wasd move, space stop, m mode, +/- step, v speed, c caps, g status, '
          'p presets, 0 home, 1-9 presets, : command, ? help, q quit')
    actions.show_settings()
    try:
        tty.setcbreak(fd)
        while True:
            key = read_key(fd)
            if key in ('q', '\x03', '\x04'):
                break
            elif key in ('up', 'w', 'W'):
                actions.direction('up')
            elif key in ('down', 's', 'S'):
                actions.direction('down')
            elif key in ('left', 'a', 'A'):
                actions.direction('left')
            elif key in ('right', 'd', 'D'):
                actions.direction('right')
            elif key in (' ', 'x', 'X'):
                actions.stop()
            elif key == 'm':
                actions.cycle_mode()
            elif key == 'v':
                actions.cycle_speed()
            elif key == '+' or key == '=':
                actions.scale_step(2.0)
            elif key == '-':
                actions.scale_step(0.5)
            elif key == 'c':
                actions.getcaps()
            elif key == 'g':
                actions.getstatus()
            elif key == 'p':
                actions.getpresets()
            elif key == '0':
                actions.home()
            elif key in '123456789' and key:
                actions.goto(int(key))
            elif key == '?':
                print(HELP)
            elif key == ':':
                termios.tcsetattr(fd, termios.TCSADRAIN, saved)
                try:
                    text = input(':')
                except EOFError:
                    text = ''
                tty.setcbreak(fd)
                actions.command(text)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        try:
            actions.stop()
            time.sleep(0.2)
        except Exception:
            pass


# ---------------------------------------------------------------- self-test

class Demo:
    """Runs a fixed sequence and checks the answers against the firmware specification."""

    def __init__(self, ctl, actions, step):
        self.ctl = ctl
        self.actions = actions
        self.step = step
        self.results = []

    def check(self, name, ok, detail=''):
        self.results.append((name, ok, detail))
        say('%s  %s%s' % ('PASS' if ok else 'FAIL', name, ('  (%s)' % detail) if detail else ''))

    def drain(self):
        while not self.ctl.messages.empty():
            self.ctl.messages.get_nowait()

    def wait_message(self, command, timeout, predicate=None):
        """Next message of this command (that satisfies predicate), as (time, keys), or None."""
        end = time.time() + timeout
        while time.time() < end:
            try:
                t, c, keys = self.ctl.messages.get(timeout=max(0.01, end - time.time()))
            except queue.Empty:
                break
            if c == command and (predicate is None or predicate(keys)):
                return t, keys
        return None

    def ask_status(self, timeout=1.0):
        self.drain()
        sent = time.time()
        self.ctl.send_line('getstatus', quiet=True)
        got = self.wait_message('status', timeout)
        return (got[0] - sent, got[1]) if got else (None, None)

    def wait_idle(self, timeout):
        end = time.time() + timeout
        last = None
        while time.time() < end:
            _, keys = self.ask_status()
            if keys:
                last = keys
                if keys.get('pantilt') == 'IDLE' and keys.get('homed') != '0':
                    return keys
            time.sleep(0.15)
        return None

    def position(self, keys):
        try:
            return float(keys['pan']) * PAN_SCALE_DEG, float(keys['tilt']) * TILT_SCALE_DEG
        except (KeyError, ValueError, TypeError):
            return None

    def move_and_check(self, label, p, t, expect_pan_sign, expect_tilt_sign):
        _, before = self.ask_status()
        b = self.position(before)
        self.drain()
        sent = time.time()
        self.ctl.send_line('relative-ptz\t%s\t%s\t0\tspace=fov' % (f(p), f(t)))
        # The firmware must report MOVING right away, without being asked.
        first = self.wait_message('status', 0.3)
        if first is None:
            self.check('%s: status sent when the move is accepted' % label, False, 'nothing within 300 ms')
        else:
            self.check('%s: status sent when the move is accepted' % label, True, '%d ms, %s' % ((first[0] - sent) * 1000, first[1].get('pantilt')))
            self.check('%s: reports MOVING immediately' % label, first[1].get('pantilt') == 'MOVING', first[1].get('pantilt'))
        idle = self.wait_idle(8.0)
        self.check('%s: returns to IDLE' % label, idle is not None)
        a = self.position(idle) if idle else None
        if b and a:
            dpan, dtilt = a[0] - b[0], a[1] - b[1]
            self.check('%s: pan changed in the right direction' % label,
                       (dpan * expect_pan_sign > 0) if expect_pan_sign else abs(dpan) < 0.5, '%+.2f deg' % dpan)
            self.check('%s: tilt changed in the right direction' % label,
                       (dtilt * expect_tilt_sign > 0) if expect_tilt_sign else abs(dtilt) < 0.5, '%+.2f deg' % dtilt)
            fov = self.fov()
            if fov:
                want_pan, want_tilt = p * fov[0], t * fov[1]
                if p:
                    self.check('%s: pan moved by the requested part of the field of view' % label,
                               abs(dpan - want_pan) <= max(0.5, abs(want_pan) * 0.1), '%+.2f deg, wanted %+.2f' % (dpan, want_pan))
                if t:
                    self.check('%s: tilt moved by the requested part of the field of view' % label,
                               abs(dtilt - want_tilt) <= max(0.5, abs(want_tilt) * 0.1), '%+.2f deg, wanted %+.2f' % (dtilt, want_tilt))
        else:
            self.check('%s: position reported before and after' % label, False)

    def fov(self):
        caps = self.ctl.caps or {}
        try:
            return float(caps['hfov']), float(caps['vfov'])
        except (KeyError, ValueError):
            return None

    def run(self):
        say('--- identification')
        self.drain()
        self.ctl.send_line('getcaps')
        got = self.wait_message('caps', 1.0)
        self.check('getcaps is answered', got is not None)
        if got:
            caps = got[1]
            self.check('caps: proto=2', caps.get('proto') == '2', 'proto=%s' % caps.get('proto'))
            for key in ('rel', 'movestatus', 'position'):
                self.check('caps: %s=1 (Frigate needs it)' % key, caps.get(key) == '1', '%s=%s' % (key, caps.get(key)))
            fov_ok = False
            try:
                fov_ok = 10 < float(caps['hfov']) < 180 and 10 < float(caps['vfov']) < 180
            except (KeyError, ValueError):
                pass
            self.check('caps: hfov and vfov present and plausible', fov_ok, 'hfov=%s vfov=%s' % (caps.get('hfov'), caps.get('vfov')))
        self.ctl.send_line('getpresets')
        self.check('getpresets is answered', self.wait_message('presets', 1.0) is not None)

        say('--- status')
        latency, keys = self.ask_status()
        self.check('getstatus is answered', keys is not None)
        if latency is not None:
            self.check('getstatus answer within 100 ms', latency < 0.1, '%d ms' % (latency * 1000))
        if keys:
            self.check('status has pan and tilt', self.position(keys) is not None)
            self.check('status says homed=1 and IDLE', keys.get('homed') == '1' and keys.get('pantilt') == 'IDLE',
                       'homed=%s pantilt=%s' % (keys.get('homed'), keys.get('pantilt')))
        if not keys:
            say('No status: stopping the movement tests.')
            return self.report()

        say('--- movement (small steps: %s of the field of view)' % f(self.step))
        self.move_and_check('right', self.step, 0, +1, 0)
        self.move_and_check('left', -self.step, 0, -1, 0)
        self.move_and_check('down', 0, -self.step, 0, -1)
        self.move_and_check('up', 0, self.step, 0, +1)

        say('--- stop')
        self.drain()
        self.ctl.send_line('ptz\t0.3\t0\t0')
        self.wait_message('status', 0.3)
        time.sleep(0.6)
        self.ctl.send_line('stop\tpantilt=1\tzoom=1')
        idle = self.wait_idle(5.0)
        self.check('stop ends a velocity move', idle is not None)

        say('--- unknown and malformed input is ignored')
        self.drain()
        self.ctl.send_line('unknowncommand\t1\t2', quiet=True)
        self.ctl.send_line('ptz\t0.5', quiet=True)         # too few fields
        self.ctl.send_line('absolute-ptz\ta\tb\tc', quiet=True)  # not numbers
        time.sleep(0.5)
        _, after = self.ask_status()
        self.check('still answering after bad input, and not moving', after is not None and after.get('pantilt') == 'IDLE')

        say('--- home')
        self.drain()
        self.ctl.send_line('gotohome')
        self.wait_message('status', 0.3)
        idle = self.wait_idle(20.0)
        self.check('gotohome ends IDLE', idle is not None)
        if idle:
            where = self.position(idle)
            self.check('gotohome reaches (0, 0), within 1 degree', where is not None and all(abs(v) < 1.0 for v in where),
                       describe_status(idle))
        return self.report()

    def report(self):
        failed = [r for r in self.results if not r[1]]
        say('--- %d checks, %d failed' % (len(self.results), len(failed)))
        for name, _, detail in failed:
            say('FAILED: %s %s' % (name, detail))
        return 1 if failed else 0


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description='Interactive console and self-test for a PTZ controller',
                                 epilog='Run without --demo for the interactive mode. Type ? in it for help.')
    ap.add_argument('target', help='serial device such as /dev/ttyUSB0, or tcp://host:port')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--demo', action='store_true', help='run the self-test. It moves the camera')
    ap.add_argument('--step', type=float, default=0.05,
                    help='size of the moves in the self-test, as a part of the field of view (default 0.05)')
    ap.add_argument('--yes', action='store_true', help='do not ask before the self-test moves the camera')
    args = ap.parse_args()

    ctl = Controller(Link(args.target, args.baud))
    actions = Actions(ctl)
    code = 0
    try:
        time.sleep(0.5)   # a board that resets when the port opens needs a moment
        if args.demo:
            if not args.yes:
                print('The self-test sends small pan and tilt moves (%s of the field of view) and sends the camera home.\n'
                      'Make sure nothing is in the way. Press Enter to start, Ctrl-C to cancel.' % f(args.step))
                input()
            code = Demo(ctl, actions, args.step).run()
        else:
            interactive(ctl, actions)
    except KeyboardInterrupt:
        try:
            actions.stop()
        except Exception:
            pass
        print()
    finally:
        ctl.close()
    sys.exit(code)


if __name__ == '__main__':
    main()

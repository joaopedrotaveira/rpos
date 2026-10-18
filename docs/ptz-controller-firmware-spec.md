# PTZ controller firmware specification: rposascii v2

Audience: the people writing the firmware of the PTZ controller (an Arduino Nano
ESP32 driving a differential pan-tilt with two stepper motors).

This document is **self-contained and normative**. You can implement the firmware
from it alone. The design discussion and the rpos side are in
[rposascii-protocol-v2.md](rposascii-protocol-v2.md), and the reasons for all this
are in [frigate-autotracking-analysis.md](frigate-autotracking-analysis.md). If
the two documents ever disagree, this one is the contract for the firmware.

The words MUST, SHOULD and MAY are used in the usual sense. Anything marked
**(tune)** is a starting value to be tuned on the real rig.

## 1. Why this exists

rpos is an ONVIF server that runs on a Raspberry Pi. Frigate (a network video
recorder) uses it to **track a moving object by pointing the camera at it**.
Frigate sends ONVIF requests such as "move the camera by 10% of the picture to the
right", and then asks "has it stopped moving?". rpos cannot answer these questions,
because only the controller knows where the camera points and whether the motors
are running. rpos therefore asks the controller over a simple text protocol,
`rposascii`, and passes the answers on.

```
 Frigate ──ONVIF/SOAP──▶ rpos (Raspberry Pi) ──rposascii text lines──▶ PTZ controller (ESP32)
                                  ▲                  UART or TCP              │
                                  └─────────── caps / status / presets ◀──────┘
```

The firmware currently speaks only Pelco-D, which cannot report position or whether
the motors are moving, and has no "move by a fraction of the field of view". It
cannot support autotracking. This specification replaces that.

## 2. Summary

### Messages rpos sends to the controller

| Message | Positional fields | Key=value fields | What the controller does |
|---|---|---|---|
| `getcaps` | none | none | Reply with one `caps` line |
| `getstatus` | none | none | Reply with one `status` line |
| `getpresets` | none | none | Reply with one `presets` line |
| `ptz` | `p t z` | `cam` | Move at a velocity. `0 0 0` stops |
| `absolute-ptz` | `p t z` | `cam` `panspeed` `tiltspeed` | Go to a position |
| `relative-ptz` | `p t z` | `cam` `space` `panspeed` `tiltspeed` | Move by an amount |
| `stop` | none | `cam` `pantilt` `zoom` | Stop all motion |
| `gotohome` | none | `cam` | Go to (0, 0) |
| `sethome` | none | `cam` | Ignore (home is fixed) |
| `gotopreset` | `name value` | `cam` | Go to a stored position |
| `setpreset` | `name value` | `cam` | Store the current position |
| `clearpreset` | `name value` | `cam` | Forget a stored position |

Everything else rpos may send (`aux`, `focus`, `focusstop`, `focusmode`,
`brightness`, `relayactive`, `relayinactive`, and anything added later) MUST be
ignored without a reply.

### Messages the controller sends to rpos

| Message | Key=value fields | When |
|---|---|---|
| `caps` | `proto abs rel cont zoom home presets movestatus position fixedhome hfov vfov panrange tiltrange` | At boot, on a new TCP client, and on `getcaps` |
| `status` | `pan tilt zoom pantilt homed athome atpreset error` | On `getstatus`, after every move command, when motion ends, at boot |
| `presets` | `used` | After `caps` at boot, on `getpresets`, after `setpreset` and `clearpreset` |

The controller sends **nothing else**. There are no acknowledgements.

## 3. Wire format

1. **Transport:** UART serial (primary) or TCP. Both carry the same text. See
   section 9.
2. **One message per line.** A line ends with `\n`. A `\r` before it MUST be
   accepted and stripped. The controller ends its own lines with `\n` only.
3. **Fields are separated by one TAB** (`\t`, byte 0x09). A TAB is the only
   separator. Spaces are data (preset names contain spaces).
4. **The first field is the command**, lower case, matched exactly.
5. **Positional fields come next.** Each command has a fixed number of them
   (the table above). They are in a fixed order.
6. **Key=value fields come last**, in any order: `key=value`. The key is
   `[a-z_][a-z0-9_]*`. A value has no TAB or newline.
7. **Maximum line length is 256 bytes** including the command. A longer line MUST
   be dropped completely, up to its `\n`, and the next line must still work. Never
   overflow a buffer.
8. **Numbers** are decimal text with `.` as the separator: `0.25`, `-1`, `0`,
   `1e-3`. Parse them with `strtof`, never with a locale-dependent function. A
   number that is empty, malformed, `nan` or `inf` is invalid.
9. **Unknown commands, unknown keys and extra fields are ignored.** This is what
   allows the protocol to grow. For example rpos adds `cam=1` to most lines, and
   the firmware does not need to understand it.
10. **A message with too few positional fields, or an invalid positional
    number, is ignored entirely.** No motion, no reply.
11. **Debug output.** If the firmware prints debug text on the same port, each
    debug line MUST start with `#`. rpos ignores any line whose command it does
    not know, so this is safe, but keep it short and do not print while moving at
    high rate. Better still: use a separate port for debug.

### Parsing pitfalls

- **Do not use `strtok`.** It skips empty fields. `setpreset<TAB><TAB>3` (an
  empty preset name) would become `setpreset<TAB>3`, and `3` would be taken as
  the name. Use `strsep` (available in the ESP32 newlib) or a hand-written
  splitter.
- **Decide what a token is by its position, not by whether it contains `=`.** A
  preset name may be empty or contain `=` (`gotopreset<TAB>x=1<TAB>7`). The
  positional count per command settles it.
- A tested C++ implementation of all this is in
  [firmware/rposascii_parse.h](firmware/rposascii_parse.h), with its tests in
  [firmware/parser_test.cpp](firmware/parser_test.cpp). It has no Arduino
  dependency, uses no heap, and passes under the address and undefined-behaviour
  sanitisers. You can copy it into the firmware.

## 4. Coordinates and units

All positions and velocities are **normalised numbers**. The firmware converts them
to degrees and then to motor steps.

| Axis | 1.0 means | 0 means | Range | Positive means |
|---|---|---|---|---|
| Pan | 180° | The hall-sensor zero, perpendicular to the two motors | -1..+1 | The camera turns to the **right** (seen from behind the camera) |
| Tilt | 120° | The camera facing **straight up** | -1..0 recommended (see 4.1) | The camera **pitches up** |
| Zoom | n/a | n/a | n/a | n/a |

```
pan_deg   = pan  × 180          pan  = pan_deg  / 180
tilt_deg  = tilt × 120          tilt = tilt_deg / 120
```

The scales (180 and 120) are **fixed constants of the protocol**. They are not the
measured travel of your rig, so a normalised value always means the same angle.

Home is **(0, 0): pan zero and the camera facing straight up.**

### 4.1 Tilt

- Tilt is the angle from straight up, **negated**: if `m` is the angle from straight
  up, positive toward the front (the direction the camera faces at pan 0 when
  level), then `tilt_deg = −m`. So moving the camera **up** *increases* the tilt
  value, as ONVIF requires.
- Examples (front side): straight up = `0`; level at the horizon = `-90°` =
  `-0.75`; 30° below the horizon = `-120°` = `-1.0`.
- **Limits.** `TILT_MIN_DEG` is the lower stop minus a safety margin (about -120°,
  to be measured). `TILT_MAX_DEG` SHOULD be `0` (straight up): past straight up
  the image is upside down and Frigate would steer the wrong way. A pose with
  positive tilt is always reachable more safely by turning the pan by 180°.
- **Direction is set by `TILT_INVERT`** (and `PAN_INVERT` for pan), constants in the
  firmware, because the direction depends on how the rig is assembled. Fix them
  during bring-up with the checks in section 12.1.

### 4.2 Pan

- Pan is limited to **±180° (±1.0)** to protect the cable. It is **never wrapped**:
  +1.0 and -1.0 are 360° apart, not the same place.
- An absolute pan goes straight to the target through zero. It MUST NEVER take the
  "short way" across ±180°, because that would twist the cable.

### 4.3 Reported positions

`status` reports pan and tilt in the same normalised units, from the **engine's
own step count**, not from the last commanded target.

## 5. Constants the firmware defines

| Constant | Meaning | Value |
|---|---|---|
| `PAN_SCALE_DEG` | Degrees per 1.0 of pan | 180 (fixed by the protocol) |
| `TILT_SCALE_DEG` | Degrees per 1.0 of tilt | 120 (fixed by the protocol) |
| `PAN_LIMIT_DEG` | Pan limit each side of 0 | 180 |
| `TILT_MIN_DEG`, `TILT_MAX_DEG` | Tilt limits in protocol degrees | about -120 and 0 **(measure)** |
| `PAN_INVERT`, `TILT_INVERT` | Flip a motor direction | **(set at bring-up)** |
| `STEPS_PER_DEG_PAN`, `STEPS_PER_DEG_TILT` | Steps per degree, through the differential | from the mechanics |
| `MAX_PAN_DEG_S`, `MAX_TILT_DEG_S` | Speed 1.0 for each axis | **(tune)** |
| `DEFAULT_SPEED` | Fraction of the maximum used when a command has no speed | 0.6 **(tune)** |
| `MIN_SPEED` | Floor for a requested speed | 0.05 |
| acceleration, jerk | Per axis | **(tune)** |
| `HFOV_DEG`, `VFOV_DEG` | Camera field of view, reported in `caps` | 66 and 41, then **measure** |
| `HOME_TOLERANCE_DEG` | `athome` tolerance | 0.25 **(tune)** |
| `PRESET_TOLERANCE_DEG` | `atpreset` tolerance | 0.25 **(tune)** |
| `MIN_MOVE_DEG` | Moves shorter than this count as zero length | 0.05 **(tune)** |
| `PRESET_COUNT` | Number of presets | 64 |
| `SETTLE_MS` | Optional hold in `MOVING` after the motors stop | 0 to 150 **(tune)** |
| `BOOT_PRESET` | Optional preset to move to after homing | none |

`HFOV_DEG` and `VFOV_DEG` are what Frigate's tracking accuracy depends on. They
must describe the camera **at the resolution that is streamed**. See the field of
view section of the protocol document (Raspberry Pi Camera Module 3, standard
lens: 66° x 41° in the full-field sensor modes).

## 6. State model

The controller is always in one of these states:

```
              boot
               │
               ▼
        ┌─────────────┐   homing ok    ┌────────┐  move command  ┌────────┐
        │   HOMING    │ ─────────────▶ │  IDLE  │ ─────────────▶ │ MOVING │
        │ homed=0     │                │ homed=1│ ◀───────────── │ homed=1│
        └─────────────┘                └────────┘  motion ended  └────────┘
               │ homing failed              ▲
               ▼                            │ new move command replaces the
        ┌─────────────┐                     │ current motion (stays MOVING)
        │   FAULT     │                     └──────────────────────────────
        │ homed=0,    │
        │ error=...   │
        └─────────────┘
```

- **HOMING:** after boot, until the hall sensors have been found and the position
  is set. `status` says `homed=0 pantilt=MOVING`.
- **IDLE:** homed, no motor running.
- **MOVING:** at least one motor is running, or a move was accepted and has not
  completed.
- **FAULT:** homing failed or the engine is in an error state. `status` says
  `pantilt=UNKNOWN` and `error=...`. Move commands are ignored.

`pantilt` in `status` is exactly this state: `MOVING` while HOMING or MOVING, `IDLE`
while IDLE, `UNKNOWN` in FAULT.

### The rules that make Frigate work

These matter more than anything else:

1. **`MOVING` is reported synchronously.** The moment a move command is parsed and
   accepted, set the state to MOVING *before* returning to the serial reader, and
   **send a `status` line immediately**. Do not wait for the motor task to start.
   Frigate calls `RelativeMove` and then polls `GetStatus` at once. If the
   controller still says `IDLE` for the next few milliseconds, Frigate believes
   the move finished instantly.
2. **`IDLE` is reported only when the motors have stopped** (plus `SETTLE_MS` if
   used), and a `status` line is sent at that moment.
3. **A move that produces no motion is `IDLE` at once.** This includes a move
   shorter than `MIN_MOVE_DEG` on both axes, and a move that clamping reduces to
   nothing. Still send a `status` line, so rpos sees the answer.
4. **Preset and home moves are `MOVING` too**, not only pan/tilt moves. Frigate waits
   for the camera to return to its preset.
5. **Position is the real position** (step count), converted to normalised units.

## 7. Messages from rpos: behavior of each command

In every case: if the controller is in HOMING or FAULT, **move commands are
ignored** (see each command), but `getcaps`, `getstatus` and `getpresets` are
always answered.

### 7.1 `getcaps`

`getcaps` → reply with one `caps` line (section 8.1). No other effect.

### 7.2 `getstatus`

`getstatus` → reply with one `status` line (section 8.2) **within 100 ms**. rpos
gives up after 300 ms and tells Frigate the state is unknown. Answer from the live
state, not from a value cached earlier.

### 7.3 `getpresets`

`getpresets` → reply with one `presets` line (section 8.3).

### 7.4 `ptz` (continuous move)

```
ptz <TAB> p <TAB> t <TAB> z [<TAB> cam=N]
```

- `p` and `t` are velocities in -1..+1 (clamp). `z` is ignored.
- Pan velocity = `p × MAX_PAN_DEG_S`, tilt velocity = `t × MAX_TILT_DEG_S`.
- **`p == 0 && t == 0` is a stop**, the same as `stop`. (rpos sends `ptz 0 0 0` as
  its stop to controllers that did not send `caps`.)
- Otherwise the axes move until commanded otherwise. An axis with velocity 0 stops
  (with deceleration).
- **Limits:** an axis stops by itself when it reaches its limit. Pan stops at ±180°.
  Tilt stops at `TILT_MIN_DEG` or `TILT_MAX_DEG`. When both axes have stopped, the
  state becomes IDLE.
- Replaces any motion in progress (a position move is cancelled).
- There is no timeout in the firmware: rpos sends the `stop` when an ONVIF
  `Timeout` expires, and ONVIF clients send `Stop`. The firmware MAY have a
  maximum duration (for example 30 s) as a safety net in case rpos disappears, but
  MUST NOT use a short watchdog: a client may send one `ptz` and then nothing for
  a long time.
- Send a `status` line immediately (MOVING, or IDLE if both velocities clamp to 0),
  and again when the motion ends.

### 7.5 `absolute-ptz`

```
absolute-ptz <TAB> p <TAB> t <TAB> z [<TAB> cam=N <TAB> panspeed=S <TAB> tiltspeed=S]
```

- Move to position `(p, t)`, normalised. `z` is ignored.
- Clamp the target to the pan and tilt limits. Clamping is not an error.
- Pan goes straight to the target (never across ±180°).
- `panspeed` and `tiltspeed` are fractions 0..1 of `MAX_*_DEG_S` (clamp, then apply
  `MIN_SPEED`). A missing speed means `DEFAULT_SPEED`. The two axes MUST arrive at
  the same time if possible (slow the faster one), so the path is a straight line.
- Replaces any motion in progress.
- If the move is shorter than `MIN_MOVE_DEG` on both axes, it is a zero-length move
  (rule 3). Otherwise start moving, and apply rules 1 and 2.

### 7.6 `relative-ptz` (the one Frigate uses)

```
relative-ptz <TAB> p <TAB> t <TAB> z [<TAB> cam=N <TAB> space=fov|generic <TAB> panspeed=S <TAB> tiltspeed=S]
```

Move **by** an amount, starting from the **current position** (at the moment the
command is processed, not from the previous target).

| `space` | Pan changes by | Tilt changes by |
|---|---|---|
| `fov` | `p × HFOV_DEG` degrees | `t × VFOV_DEG` degrees |
| `generic`, or missing | `p × 180` degrees | `t × 120` degrees |

- In `fov` space `1.0` is one **full field of view**: the width of the picture for
  pan and the height of the picture for tilt. A positive `p` turns the camera right
  (objects in the picture move **left**). A positive `t` pitches the camera up
  (objects move **down**).
- Examples. With `hfov=66`, `vfov=41`:
  `relative-ptz 0.1 -0.05 0 space=fov` turns right by 6.6° and pitches down by
  2.05°. `relative-ptz 0.1 0 0 space=generic` turns right by 18°.
- `z` is ignored.
- Compute the target, then **clamp it to the limits**. If the camera is already at a
  limit and the move pushes outward, that axis does not move. This is not an error.
- Speeds, replacement of a motion in progress and zero-length moves are as for
  `absolute-ptz`.
- Frigate typically sends **no speed**, so `DEFAULT_SPEED` decides how quickly the
  camera follows. See the tuning note in section 12.2.
- Send `status` immediately (rules 1 and 3) and when the motion ends.

### 7.7 `stop`

```
stop [<TAB> cam=N <TAB> pantilt=1 <TAB> zoom=1]
```

- Stop all motion at once, whatever kind it is (velocity or position move,
  including a move to a preset or home). Decelerate according to the engine's
  limits; do not stop dead if that would lose steps.
- The `pantilt` and `zoom` keys MAY be ignored: `stop` always stops everything.
- Remain MOVING until the motors have actually stopped, then IDLE. Send `status`
  immediately and again when it is IDLE (if the motors were already stopped, the
  first `status` already says IDLE).
- Ignored while HOMING (it does not abort homing).

### 7.8 `gotohome`

- Move to `(0, 0)` at `DEFAULT_SPEED`. Replaces any motion in progress. Same
  `status` rules as the other moves. Ignored while HOMING or in FAULT.

### 7.9 `sethome`

- **Ignore it.** Home is fixed at `(0, 0)` by the hall sensors. `caps` says
  `fixedhome=1` so rpos tells ONVIF clients the same.

### 7.10 Presets

A preset is a stored position: `(pan_deg, tilt_deg)`. Tokens are the integers
`1..PRESET_COUNT`. `name` is only a label kept by rpos: the firmware does not need it.

| Command | Behavior |
|---|---|
| `setpreset <name> <value>` | If `value` is in `1..PRESET_COUNT`, store the **current position** in that slot (replacing the old one) and save it to flash. Send an updated `presets` line. |
| `gotopreset <name> <value>` | If the slot is in use, move to the stored position at `DEFAULT_SPEED` (clamped to the limits). If it is not in use or out of range, ignore the command. |
| `clearpreset <name> <value>` | If the slot is in use, mark it unused and save. Send an updated `presets` line. |

- `value` is decimal text, for example `3`. An invalid `value` means the command is
  ignored.
- Presets are valid across power cycles, because homing re-creates the same
  reference at each boot.
- Ignore `setpreset` and `gotopreset` while HOMING or in FAULT. (`clearpreset` is
  allowed.)
- **Storage.** The Nano ESP32 has no EEPROM. Use the `Preferences` library (NVS in
  flash). Keep all presets in **one blob** (an array of `{used, pan_deg, tilt_deg}`
  structures, about 9 bytes each, so about 600 bytes for 64 presets) and write it
  only when a preset is set or cleared. Check that the NVS partition is large
  enough. Reading the blob at boot is enough, so there is no wear from reading.
- **Flash writes stall the CPU caches.** An interrupt handler that is not in IRAM
  can miss deadlines while the flash is written, and that makes motors stutter or
  lose steps. Generate step pulses with a hardware peripheral or an IRAM-safe timer
  routine, or do the write only when the motors are stopped.
- An "erase all flash" upload deletes the presets. rpos notices on the next
  connection (it sends `getpresets`) and clears its own list to match.

### 7.11 Commands to ignore

`aux`, `focus`, `focusstop`, `focusmode`, `brightness`, `relayactive`,
`relayinactive`, and every unknown command: parse, then do nothing. No reply.

## 8. Messages the controller sends

### 8.1 `caps`

Static capabilities. Send it: at boot (once the link is ready), when a TCP client
connects, and in reply to `getcaps`. One line, for example:

```
caps<TAB>proto=2<TAB>abs=1<TAB>rel=1<TAB>cont=1<TAB>zoom=0<TAB>home=1<TAB>presets=64<TAB>movestatus=1<TAB>position=1<TAB>fixedhome=1<TAB>hfov=66<TAB>vfov=41<TAB>panrange=-180,180<TAB>tiltrange=-120,0
```

| Key | Value | Notes |
|---|---|---|
| `proto` | `2` | Protocol version |
| `abs`, `rel`, `cont` | `1` or `0` | Absolute, relative, continuous moves supported. All `1` |
| `zoom` | `0` | No zoom hardware |
| `home` | `1` | `gotohome` supported |
| `presets` | integer | `PRESET_COUNT` |
| `movestatus` | `1` | `status` reports `pantilt`. **Frigate needs `1`.** |
| `position` | `1` | `status` reports a real position |
| `fixedhome` | `1` | Home is fixed at (0, 0), `sethome` ignored |
| `hfov`, `vfov` | degrees | `HFOV_DEG`, `VFOV_DEG`. **Without them there is no field-of-view space and Frigate refuses to track.** |
| `panrange` | `min,max` | `-180,180` (degrees from home) |
| `tiltrange` | `min,max` | `TILT_MIN_DEG,TILT_MAX_DEG`, for example `-120,0` |

rpos turns these into the ONVIF node: the supported move spaces, the position
ranges (`panrange / 180` and `tiltrange / 120`), the number of presets and the
fixed-home flag. So **what `caps` says is what Frigate will believe**. Do not
claim a capability the firmware does not have, and do not omit `hfov` and `vfov`.

### 8.2 `status`

One line, for example:

```
status<TAB>pan=0.1234<TAB>tilt=-0.7500<TAB>zoom=0<TAB>pantilt=IDLE<TAB>homed=1<TAB>athome=0<TAB>atpreset=3
```

| Key | Value | Notes |
|---|---|---|
| `pan` | -1..1 | Current pan. **Omit while not homed.** |
| `tilt` | -1..1 | Current tilt. **Omit while not homed.** |
| `zoom` | `0` | Always 0 |
| `pantilt` | `IDLE`, `MOVING`, `UNKNOWN` | The state (section 6) |
| `homed` | `0` or `1` | `0` during HOMING and FAULT. Send it on **every** status line |
| `athome` | `0` or `1` | Optional. Within `HOME_TOLERANCE_DEG` of (0, 0) on both axes |
| `atpreset` | token | Optional. The nearest used preset within `PRESET_TOLERANCE_DEG`. Omit if none |
| `error` | text, no TAB | Optional. For example `HOMING_FAILED`. Omit when there is no error |

- Print `pan` and `tilt` with 3 to 5 decimals.
- `athome` and `atpreset` describe what the **picture** shows. With micro-stepping
  the position may be a few steps from a preset yet look identical, so compare with
  the tolerance, never for equality. They say nothing about whether the motors
  have stopped: that is `pantilt`.

**When to send `status`:**

1. In reply to `getstatus`.
2. Immediately after accepting **any** move command (`ptz`, `absolute-ptz`,
   `relative-ptz`, `stop`, `gotohome`, `gotopreset`), showing the new state.
3. When the motion ends (the transition to IDLE).
4. At boot, after `caps` and `presets`, and when a TCP client connects.
5. When homing finishes or fails.
6. Optionally every 200 ms while MOVING, to let rpos follow the position. Never
   faster than that.

### 8.3 `presets`

```
presets<TAB>used=1,3,7
```

`used` is the ascending list of the tokens of the stored presets, separated by commas
with no spaces. If there are none: `presets<TAB>used=`.

Send it at boot (after `caps`), when a TCP client connects, on `getpresets`, and after
`setpreset` and `clearpreset`. rpos uses it to keep its own list of presets equal to
the controller's, and gives the names `Preset N` to ones it did not know.

## 9. Transports and connection behavior

### 9.1 UART serial (primary)

- 115200 baud, 8 data bits, no parity, 1 stop bit (8N1), no flow control. The
  baud rate must be changeable in one constant, and rpos must be configured with
  the same (`PTZSerialPortSettings`).
- The Nano ESP32 USB serial port and a hardware UART both work. Nothing but
  rpos protocol traffic may be written to the port (debug lines start with `#`).
- The port is opened by rpos at start-up, which on the Nano ESP32 USB port **resets
  the board**, and the bytes sent while it boots are lost. So:
  - When the firmware is ready it MUST send `caps`, `presets` and `status` by itself.
  - rpos also asks: it sends `getcaps`, `getstatus` and `getpresets` when the port
    opens, and repeats them after 2 s, 4 s, 8 s, and so on up to every 30 s, until
    it receives a `caps`. The firmware just answers each one.
- RX buffer at least 512 bytes, read continuously, also while moving.

### 9.2 TCP

- The ESP32 is the **server**, on a configurable port (default 9999). rpos is the
  client and reconnects by itself about one second after a disconnect.
- One client at a time. If a new client connects, drop the old one.
- On connect send `caps`, `presets` and `status` at once. rpos also sends its three
  requests.
- Framing, commands and replies are exactly as for serial. Disable Nagle's algorithm
  (`setNoDelay(true)`), so short `status` lines are not held back.
- If the client disconnects, **stop all motion** that was started with a velocity
  command (`ptz`), because nobody is left to send the stop. A position move may finish.

### 9.3 Pelco-D on the same UART

Pelco-D frames are 7 bytes and start with the binary byte `0xFF`. rpos lines start
with a lowercase ASCII letter. So if the firmware keeps Pelco-D support: when the
first byte of a message is `0xFF`, hand the next 6 bytes to the Pelco-D parser;
otherwise read a line. If that proves fragile, make the mode a compile-time option.
Do not send anything that is not an rpos line (or a `#` comment) in rpos mode.

## 10. Homing

The firmware homes at every boot, using the two hall sensors (pan zero and tilt
zero). The details of the search are firmware design, but the externally visible
behavior is:

1. Boot, start homing at once, and send `caps`, `presets` and
   `status homed=0 pantilt=MOVING` (without `pan` and `tilt`).
2. During homing, answer `getcaps`, `getstatus` and `getpresets` as usual, and
   **ignore** all move commands including `stop`.
3. When the zero positions are found, set the position to the hall zero, move to home
   `(0, 0)` and send `status homed=1 pantilt=IDLE athome=1` (or MOVING first, if the
   move takes time). If `BOOT_PRESET` is used, move there afterwards.
4. If the sensors are not found within the search bound, enter FAULT:
   `status homed=0 pantilt=UNKNOWN error=HOMING_FAILED`. Do not move any more.

Design guidance (not protocol):

- A hall sensor is active over a **zone**, not a point. Find both edges and use their
  midpoint, and always make the final approach from the same direction so that
  hysteresis cancels.
- The start pose is unknown. The pan limit is there to protect the cable, and a
  search that starts the wrong way can exceed it. Prefer choosing the first search
  direction from a hint saved in NVS (which side of zero pan was last on), and bound
  the first sweep. Home slowly and at reduced current, so that reaching a stop skips
  steps instead of stalling hard. See the protocol document for the reasoning.
- After homing the position is assumed reliable. Skipped steps are not detected, so
  choose current, speed and acceleration conservatively.

## 11. Robustness requirements

- Never block the loop waiting for serial data, for the network, or for flash.
- Never overflow a buffer on a long line, on many keys, or on a long value.
- Treat every received byte as untrusted input. A malformed message is ignored
  and must never move the camera, change a preset, crash or reboot the firmware.
- Clamp every target and velocity to the limits, in all commands, also presets read
  back from flash (the flash may hold garbage). **The clamp is the only protection
  against driving into the stops and twisting the cable.**
- Do not emit step pulses faster than the motors can follow: honour the acceleration
  limits even when a command asks for a sudden change.
- A new motion command arriving while another is running must be handled smoothly
  (re-plan from the current speed and position), never with a jump.
- Do not print anything on the protocol port except protocol lines and `#` comments.

## 12. Bring-up and tuning

### 12.1 Direction checks

Do these once, and set `PAN_INVERT` and `TILT_INVERT` until they pass:

| Send | The camera must | In the picture |
|---|---|---|
| `relative-ptz 0.1 0 0 space=generic` | turn to the right | objects move left |
| `relative-ptz 0 0.1 0 space=generic` | pitch up | objects move down |
| `absolute-ptz 0 -0.75 0` | point level at the front at pan 0 | |
| `ptz 0.3 0 0`, then `stop` | turn right, then stop | |

After each, `status` must report a pan/tilt that moved in the same direction
(pan increases when turning right, tilt increases when pitching up).

### 12.2 Tuning

- **`DEFAULT_SPEED`** is the speed Frigate's tracking moves use, because Frigate sends
  no speed. Too slow and the object leaves the picture before the camera arrives.
  Too fast and the picture blurs or the camera overshoots. Test with a person
  walking across the scene. Tune acceleration for smooth starts and stops.
- **`SETTLE_MS`**: a mount that rings after stopping blurs the next frames. Holding
  `MOVING` for 50 to 150 ms after the motors stop gives Frigate sharper pictures,
  at the cost of slightly slower tracking.
- **Field of view.** Measure `HFOV_DEG` and `VFOV_DEG` at the streamed resolution:
  `fov = 2 × atan(w / (2d))` for a target of width `w` at distance `d`. Then check
  with a pan: `relative-ptz 0.25 0 0 space=fov` must move a feature by exactly a
  quarter of the picture width. The picture maps to angle through a tangent, so
  the error grows toward the edges of a wide field, and Frigate corrects it with
  later moves. A constant to scale the field of view may be needed (`FOV_SCALE`).
- **Tolerances.** One picture pixel is about 0.034° (horizontal) and 0.038°
  (vertical) at 1920x1080 and 66° x 41°. The tolerance values in section 5 are
  about 1 to 7 pixels. Adjust them to what you can see.

## 13. Conformance tests

Each row is something to send and what the controller must do. Send with
[firmware/probe.py](firmware/probe.py) (it prints every line received, with times):

```
python3 docs/firmware/probe.py /dev/ttyACM0 'getcaps' 'getstatus'
python3 docs/firmware/probe.py tcp://192.168.1.50:9999 'relative-ptz\t0.1\t0\t0\tspace=fov'
```

`\t` in an argument becomes a TAB. For serial, `pip install pyserial`.

| # | Send | Expected |
|---|---|---|
| 1 | (power on) | `caps`, `presets` and `status` arrive by themselves. First status: `homed=0 pantilt=MOVING` and no `pan`/`tilt`. Later `homed=1 pantilt=IDLE athome=1` |
| 2 | `getcaps` | one `caps` line with `proto=2 rel=1 movestatus=1 position=1 hfov=… vfov=…` |
| 3 | `getstatus` | one `status` line within 100 ms, `pantilt=IDLE homed=1` |
| 4 | `getpresets` | `presets<TAB>used=…` |
| 5 | `relative-ptz 0.1 0 0 space=fov` | a `status` with `pantilt=MOVING` **immediately** (before any `getstatus`), then `IDLE`. Pan changed by `0.1×hfov/180` |
| 6 | `relative-ptz 0 0 0 space=fov` | `status … IDLE`, no motion |
| 7 | `relative-ptz 0.0001 0 0 space=generic` | below `MIN_MOVE_DEG`: `IDLE`, no motion |
| 8 | `relative-ptz 0.2 0 0` (no `space`) | generic: pan changes by 36° |
| 9 | `relative-ptz 0.1 0 0 space=fov cam=7 id=9 extra=1` | works exactly as test 5 |
| 10 | `absolute-ptz 0 -0.75 0` | goes to level, `MOVING` then `IDLE` |
| 11 | `absolute-ptz 0.9 0 0`, then `absolute-ptz -0.9 0 0` | pan goes the long way through 0, never beyond ±180° |
| 12 | `absolute-ptz 0 -5 0` | tilt clamped to `TILT_MIN_DEG`, no error |
| 13 | `absolute-ptz 0 0.5 0` (with `TILT_MAX_DEG = 0`) | tilt stays at 0, no error |
| 14 | `relative-ptz 3 0 0 space=generic` | pan stops at +180° (`pan=1.0`) |
| 15 | `absolute-ptz 0.5 0 0 panspeed=0.2`, then the same with `panspeed=1` | the first is clearly slower |
| 16 | `ptz 0.5 0 0`, wait, `stop` | moves, then decelerates, `IDLE`, final `status` |
| 17 | `ptz 0.5 0 0`, wait, `ptz 0 0 0` | same as `stop` |
| 18 | `ptz 1 0 0` for a long time | pan stops by itself at +180°, then `IDLE` |
| 19 | `relative-ptz` while a move is running | the first is replaced, smooth, no jump |
| 20 | `stop` while a `gotopreset` is running | stops, `IDLE` |
| 21 | `setpreset Door 3`, then `getpresets` | `used=3` (and others) |
| 22 | power cycle, `gotopreset Door 3` | returns to the stored place (within tolerance) |
| 23 | `setpreset` with an empty name: `setpreset\t\t4` | stores preset 4 (the empty name must not shift the value) |
| 24 | `gotopreset X 63` (unused) and `gotopreset X 999` | ignored, no motion |
| 25 | `clearpreset X 3`, then `getpresets` | 3 is gone |
| 26 | `gotohome` | goes to (0, 0), `athome=1` |
| 27 | `sethome` | ignored, nothing changes |
| 28 | `unknowncommand 1 2`, `focus 1`, `brightness 5` | no reply, no crash |
| 29 | a line of 300 bytes, then `getstatus` | the long line is dropped, `getstatus` is answered |
| 30 | `ptz 0.5` (missing fields), `absolute-ptz a b c` | ignored, no motion |
| 31 | `getstatus\r\n` | works the same as with `\n` |
| 32 | during homing: `relative-ptz 0.1 0 0 space=fov`, `getstatus` | the move is ignored, `getstatus` answered |
| 33 | TCP: disconnect while `ptz 0.5 0 0` is running | the motors stop |
| 34 | 100 `getstatus` lines in a row | 100 answers, no loss |
| 35 | sustained: `relative-ptz` every 200 ms for 1 minute | no reboot, no missed answers |

### Checking with rpos

When rpos is configured for `rposascii` (see `rposConfig.sample-rposascii.json`)
and started, its log prints `PTZ Driver - controller capabilities received` once the
`caps` line has arrived. After that:

- ONVIF `GetNodes` must list `TranslationSpaceFov` under
  `RelativePanTiltTranslationSpace`. If it does not, `caps` has no `hfov`/`vfov`,
  or `rel` is 0.
- ONVIF `GetServiceCapabilities` must say `MoveStatus="true"` and
  `StatusPosition="true"`.
- Frigate's log must not print its "not supported" error for autotracking.

## 14. Checklist for autotracking

- [ ] `caps` has `rel=1 movestatus=1 position=1`, and correct `hfov` and `vfov`
- [ ] `relative-ptz … space=fov` moves by the right angle, in the right direction
- [ ] `MOVING` is reported before the next `getstatus` can be processed
- [ ] `IDLE` is reported when, and only when, the motors have stopped
- [ ] `getstatus` is answered within 100 ms, even while moving
- [ ] The reported position follows the real position
- [ ] `stop` stops position moves as well as velocity moves
- [ ] A preset can be stored, survives a power cycle, and `gotopreset` returns to it
- [ ] Pan never leaves ±180°, tilt never leaves its limits
- [ ] Unknown, malformed and over-long input is ignored safely
- [ ] `DEFAULT_SPEED` is tuned so that a walking person can be followed

## 15. Open items (decide when working on the firmware)

These do not change the protocol and do not block rpos:

- **Homing safety:** the random first search direction can drive the pan past ±180°.
  Options are a saved hint, a bounded first sweep, slow and low-current homing.
- **Tilt past straight up:** limit it to `-120..0` (recommended), or allow the full
  ±120° and deal with the upside-down picture.
- **Boot view:** whether to move to a preset after homing (`BOOT_PRESET`), so the
  camera isn't left facing the ceiling. Frigate returns to a preset after tracking,
  not to home, so store one at the normal view.
- **Measurements:** the tilt stops, the hall-zone widths, the field of view at the
  streamed resolution, `PAN_INVERT` and `TILT_INVERT`.
- **Tolerance values** and `SETTLE_MS`.

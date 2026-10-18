# rposascii protocol v2 (proposal)

Status: the rpos side is implemented (see
[Implementation status](#implementation-status-rpos)). The ESP32 firmware side is
not started. Related:
[frigate-autotracking-plan.md](frigate-autotracking-plan.md),
[ptz-bug-fix-plan.md](ptz-bug-fix-plan.md).

The PTZ controller is an Arduino Nano ESP32 driving two stepper motors through
a `PanTiltEngine` class. The mechanism is a **differential pan-tilt** with two hall
sensors for homing, pan limited to ±180° (cable) and tilt to about ±120° from
straight up. It talks to rpos over **UART serial** (primary) or
**TCP**. The firmware currently only understands Pelco-D, which cannot report
position or move status and has no relative-in-FOV move, so it cannot support
Frigate autotracking.

This document has three parts:

1. [The firmware profile](#part-1-the-firmware-profile): the small set of
   messages the ESP32 must implement. Everything the firmware needs to know is
   here.
2. [rpos-side behaviour](#part-2-rpos-side-behaviour): what rpos does with
   those messages. The firmware does not need to implement or know about any of
   it.
3. [Firmware checklist](#part-3-firmware-checklist): how each message maps to
   `PanTiltEngine`, with test vectors.

## Why Frigate needs a two-way protocol

Frigate autotracking needs rpos to answer questions only the hardware can
answer: where the camera is, whether it is still moving, and what it supports.
(This list is from memory of Frigate's `onvif.py`; verify it against your
version.)

| Frigate behaviour | ONVIF call | Needs from the controller |
|---|---|---|
| Check the camera supports autotracking | `GetNodes`, `GetConfigurationOptions` | Which move spaces are supported, including FOV |
| Wait until a relative move has finished | `GetStatus` (`MoveStatus`) | `IDLE` / `MOVING` |
| Calibrate, report position | `GetStatus` (`Position`) | Current pan/tilt |
| Track an object | `RelativeMove` | Translation in FOV units, with optional speed |
| Abort a move | `Stop` | Cancel any move in progress |
| Return home / to a preset | `GotoPreset`, `GotoHomePosition` | Preset and home commands |

rpos currently throws away anything the controller sends (the TCP and UDP
streams have `// TODO - emit the data`, and the serial port is never read), so
v2 needs receive-side code in rpos as well. That is Part 2.

## Decision: extend `rposascii`, don't replace it

rpos already emits `ptz`, `absolute-ptz`, `relative-ptz`, `gotohome` and the
preset lines, so v2 is the same line format plus a few messages. Because the
firmware is written alongside rpos, v2 doesn't need to preserve every v1
oddity, but it keeps v1's line format so a v1 consumer still parses the lines.

---

# Part 1: The firmware profile

## Framing

- One message per line, fields separated by a TAB (`\t`), line ended by `\n`.
  Accept `\r\n` as well (strip a trailing `\r`).
- Maximum line length 256 bytes. Discard an over-long line up to the next `\n`;
  never overflow the buffer.
- Numbers are decimal text with `.` as the separator (`0.25`, `-1`). Parse with
  `strtof`, not locale-dependent functions.
- After the fixed positional fields, a message may carry **optional fields** as
  `key=value` tokens in any order.
- **Unknown commands and unknown keys are ignored silently**, in both
  directions. This is what lets the protocol grow, and it is why rpos can send
  extras (`cam=`, `id=`) the firmware doesn't implement.
- The firmware sends nothing except `caps` and `status`. There are no
  acknowledgements.

## Conventions

- **Position:** pan and tilt are normalised, and **(0, 0) is the home position**,
  defined by the boot homing (see
  [Homing, position and limits](#homing-position-and-limits)). Positive pan is
  right and positive tilt is up.
  - Pan: `1.0` = 180°. Pan is limited to ±180° by the cabling, so -1..1 is
    exactly the reachable range. It does **not** wrap.
  - Tilt: `1.0` = 120°, with 0 straight up. Tilt is limited to about ±120°, so
    -1..1 covers the mechanical range. The reachable part is given by `tiltrange`
    in `caps`. Positive tilt means the camera pitches *up* (see
    [Geometry](#geometry)).
  - The scales are fixed constants (180° for pan, 120° for tilt), not derived from
    the measured range, so a normalised value always means the same angle.
- **Speed:** 0..1, as a fraction of the maximum speed of that axis. The firmware
  converts it to steps per second inside `PanTiltEngine`, including its own
  acceleration limits. A missing speed means "use the default speed".
- **Single camera:** one ESP32 serves one camera. The firmware ignores any
  `cam=` key and never sends one. rpos treats a message without `cam` as coming
  from the camera that link serves.
- **Zoom:** if the hardware has no zoom, read the zoom field and ignore it, and
  report `zoom=0` in `caps` and `status`.

## Homing, position and limits

The mechanism is a differential pan-tilt with two stepper motors, and
`PanTiltEngine` converts between the motor angles and pan/tilt. The protocol only
sees pan and tilt, so the coupling is internal to the engine.

### Geometry

- **Hall sensors.** Two hall sensors and their magnets define the mechanical
  zero: pan 0 is the position perpendicular to the two motors, and tilt 0 is the
  camera facing straight up.
- **Pan:** the axis could turn without limit, but the firmware limits it to ±180°
  from pan 0 to protect the cable. It is clamped, never wrapped. An absolute pan
  goes straight to the target, never the "short way" through ±180°, because that
  would twist the cable.
- **Tilt:** about ±120° from straight up. The exact value is to be measured.
- **Protocol tilt.** Home `(0, 0)` is the hall zero: pan 0 and the camera facing
  **straight up**. Tilt is the angle from straight up, signed so that **positive
  tilt pitches the camera up**, as ONVIF clients and Frigate expect (a positive
  Y velocity or translation means "up"):
  - Let `m` be the mechanical angle from straight up, positive toward the front
    (the direction the camera faces at pan 0 when level). Then
    `tilt_protocol = −m`.
  - The front horizon is therefore at `-90°` (`-0.75`), and moving toward
    straight up increases tilt toward 0. Past straight up, tilt is positive and
    the camera looks backwards.
  - Which way the motors must turn for positive tilt depends on how the rig is
    assembled and must be checked on the hardware. Put it in one constant
    (`TILT_INVERT`) in the firmware. Check: from a level pose at the front, a
    `relative-ptz 0 0.1 0` must raise the view.
- **Usable tilt range.** Past straight up (positive tilt) the camera looks
  backwards and the image is upside down, and the same view is reachable by
  panning 180° and tilting less. Autotracking would also move the wrong way
  there, because the image is inverted. So the recommended compiled-in limits are
  `TILT_MIN_DEG = −120` (the measured stop, with a margin) and
  `TILT_MAX_DEG = 0` (straight up). The protocol's `tiltrange` is then
  `-120,0`. If you want to use the full range, set `TILT_MAX_DEG` higher, but
  then the inverted image needs handling (ONVIF has an `EFlip` capability for
  this).
- **Home is straight up.** `GotoHomePosition` points the camera at the ceiling,
  which is not a useful view for Frigate. Frigate returns to a **preset** after
  tracking, not to home. So store a preset at the normal view (for example the
  level view, `tilt ≈ −0.75`) and configure that preset as Frigate's return
  preset. After a reboot the camera ends up at home, facing up. You may want an
  option (`BOOT_PRESET`) for the firmware to move to a given preset after
  homing, so the camera starts looking at the scene.

### Boot homing

- The firmware homes at start-up using the hall sensors, then moves to home
  `(0, 0)`.
- Until homing finishes, `status` reports `homed=0 pantilt=MOVING` and move
  commands are ignored. When it finishes, the firmware sends `status` with
  `homed=1 pantilt=IDLE athome=1`. rpos treats `MOVING` as busy, so Frigate waits.
- The hall sensors give an absolute reference at every boot, so positions and
  presets are reproducible across power cycles.
- A hall sensor with a magnet is active over a zone, not a point. For a precise
  zero, find both edges of the zone and use their midpoint, and always make the
  final approach from the same direction so hysteresis cancels out.
- **The start pose is unknown** and the pan search must not wreck the cable. The
  current homing tries a random direction first. The risk: pan travel is limited
  to ±180° to protect the cable, but with no position knowledge a wrong first
  guess can drive the pan well past that, up to the length of the search (for
  example from +170° with a first sweep of +180° to +350°, which is 170° beyond
  the limit). Mitigations, in order of effectiveness:
  1. **Use a hint instead of a coin flip.** Save which side of zero pan is on in
     NVS (write it only when pan crosses zero, so there are few writes) and tilt
     likewise, and choose the first search direction from that. Power loss
     rarely moves the rig, so the hint is usually right. Fall back to random
     only when there is no hint. The hint is never used as a position.
  2. **Bound the first sweep.** Move at most 180° first (and only about 120° for
     tilt), then reverse and search up to the full range the other way.
  3. **Home slowly with reduced current**, so that hitting a mechanical stop or
     the cable limit skips steps instead of stalling hard.
  4. If the sensor is active at power-up, the rig is already in the zone, so only
     the edge search is needed.
  Report `error=HOMING_FAILED` if the sensor is not found within the bound.
- After homing the position is the engine's step count and is assumed reliable.
  Skipped steps are not detected, so size motor current, speed and acceleration
  conservatively.

### Limits and behaviour

- **Clamping:** the pan limit (±180°) and the tilt limits apply to every command
  that can move an axis: absolute, relative, continuous, presets (also ones
  loaded from NVS) and home. A continuous move stops each axis at its limit.
  Clamping is not an error. A clamp is the only protection against driving into
  the stops and twisting the cable.
- **Home is fixed.** Home is `(0, 0)`, so `sethome` is ignored and `caps` reports
  `fixedhome=1`. `gotohome` moves to `(0, 0)`.
- **Tolerances.** The gearing and microstepping give a very fine resolution, far
  finer than the image can show. At 1920x1080 and 66° x 41° one pixel is about
  0.034° horizontally and 0.038° vertically. A camera can look exactly "at home"
  or "at a preset" while the step count is a few microsteps off, so never test for
  exact equality. Use tolerances, all in degrees and all constants:

  | Constant | Used for | Suggested start |
  |---|---|---|
  | `HOME_TOLERANCE_DEG` | `athome=1` while the pose is within this of home on both axes | 0.25 (about 7 px) |
  | `PRESET_TOLERANCE_DEG` | `atpreset=N` while the pose is within this of preset N | 0.25 |
  | `MIN_MOVE_DEG` | A move shorter than this is treated as zero length and completes at once with `IDLE` | 0.05 (about 1-2 px) |

  The values are a starting point to tune against what is visible in the image.
  `athome` and `atpreset` are about what the *image* shows, so they say nothing
  about whether the motors have stopped. That is `pantilt`.
- **Differential coupling.** A pan move runs both motors in the same direction
  and a tilt move runs them in opposite directions. A combined move can ask for
  more than a motor's maximum speed, so `PanTiltEngine` should scale both axes
  together, which keeps the direction of the move, rather than clip one motor.
  Acceleration limits apply to the motors.

Constants the firmware needs (names are suggestions):

| Constant | Meaning |
|---|---|
| `STEPS_PER_DEG_PAN`, `STEPS_PER_DEG_TILT` | Steps per degree of pan and tilt (motor steps, microstepping and gear ratio, through the differential) |
| `PAN_LIMIT_DEG` | Pan limit each side of 0, 180 |
| `TILT_MIN_DEG`, `TILT_MAX_DEG` | Tilt limits in protocol degrees (0 = straight up), for example -120 and 0, from the measured mechanical stops with a margin |
| `TILT_INVERT` | Flips the tilt motor direction so that positive tilt pitches the camera up |
| `HOME_TOLERANCE_DEG`, `PRESET_TOLERANCE_DEG`, `MIN_MOVE_DEG` | Tolerances, see above |
| `BOOT_PRESET` | Optional. Preset to move to after homing, or none |
| `HFOV_DEG`, `VFOV_DEG` | Camera field of view (see below) |
| `MAX_PAN_DEG_S`, `MAX_TILT_DEG_S`, accelerations | Speed 1.0 for each axis |

## Camera field of view

`caps` reports `hfov` and `vfov`, and `relative-ptz` with `space=fov` uses them,
so they must be right.

The camera is a **Raspberry Pi Camera Module 3 NoIR** with the standard
(non-wide) lens (sensor IMX708). Its datasheet figures are **66° horizontal and
41° vertical** (75° diagonal) over the full sensor field. For comparison, the
Module 3 Wide is 102° x 67° and the older v2 camera is 62.2° x 48.8°.

Use 66 and 41 as the starting values, but **measure before trusting them**:

1. **The datasheet number applies to the full sensor area, so the sensor mode
   matters.** `rpicam-hello --list-cameras` on this Pi shows the IMX708 modes:

   | Mode | Sensor area used | Field of view |
   |---|---|---|
   | 1536x864 (120 fps) | `(768, 432)/3072x1728` crop, the centre two-thirds | **narrower**, about 47° x 28° |
   | 2304x1296 (56 fps) | full `4608x2592` | full, about 66° x 41° |
   | 4608x2592 (14 fps) | full `4608x2592` | full, about 66° x 41° |

   (The narrower figures are my calculation from the crop, so verify them by
   measuring.) libcamera picks the smallest mode that covers the requested
   capture size. `camera-streamer` defaults to a 1920x1080 capture, and
   `python/gst-rtsp-launch.sh` does not override it, so a 1920x1080 capture needs
   at least 1920 pixels across and the **2304x1296 full-field mode** is the one
   that fits. That gives the full 66° x 41°. If a smaller capture size, such as
   1280x720, were requested, libcamera would use the cropped 1536x864 mode and
   the FOV would drop to about 47° x 28°, so keep the capture at 1920x1080 and
   get lower-resolution Frigate streams by scaling it
   (`--camera-stream.height` / `--camera-video.height`, which don't change the
   capture). Consider setting `--camera-width=1920 --camera-height=1080`
   explicitly in the script so a change of defaults can't alter the FOV.
2. **Measure the horizontal FOV** at the resolution Frigate will use: place a
   ruler or a known-width target at a measured distance `d`, find the width `w`
   visible across the frame, and compute `hfov = 2 × atan(w / (2d))`. Do the
   same vertically for `vfov`. Repeat with a pan test: pan by a known angle and
   check that a feature moves by the expected fraction of the frame width.
3. **Autofocus.** The Module 3 changes its focal distance, and the FOV changes a
   little with focus ("focus breathing"). Fix the focus for the use case and
   measure with that focus.
4. **Linearity.** `space=fov` treats the field as a linear scale, but the true
   mapping from image position to angle is a tangent. At a 66° field the error
   at the frame edges is a few degrees, so a single move can overshoot or
   undershoot at the edge. Frigate re-evaluates after each move, so this
   converges, but calibration may need adjusting. Consider a scale factor
   constant (`FOV_SCALE`) if tracking over- or under-shoots.
5. Put the measured values in the firmware constants. rpos reads them from
   `caps`, so nothing changes on the rpos side. If the lens or mode changes,
   re-measure.

## Messages from rpos to the controller

| Message | Fields | What the firmware does |
|---|---|---|
| `ptz` | `p \t t \t z` | Continuous move: set pan and tilt velocity to `p` and `t` (-1..1, times max speed). `0 0 0` stops. Each axis stops at its limit. |
| `absolute-ptz` | `p \t t \t z` `[panspeed=S] [tiltspeed=S]` | Move to the normalised position `(p, t)`, clamped to the pan and tilt limits. Pan goes straight there (no wrap). |
| `relative-ptz` | `p \t t \t z` `[space=fov\|generic] [panspeed=S] [tiltspeed=S]` | Move relative to the current position. See below. |
| `stop` | `[pantilt=1] [zoom=1]` | Stop all motion immediately (decelerate per the engine), including a move in progress. Ignore the flags. |
| `getstatus` | none | Reply with one `status` line. |
| `getcaps` | none | Reply with one `caps` line. |
| `gotohome` | none | Move to (0, 0). |
| `sethome` | none | Ignore. Home is fixed at (0, 0). |
| `gotopreset` | `name \t value` | Move to the position stored under preset `value`. |
| `setpreset` | `name \t value` | Store the current position under preset `value`. |
| `clearpreset` | `name \t value` | Forget preset `value`. |
| `getpresets` | none | Reply with one `presets` line listing the used preset tokens. |

`aux`, `focus`, `focusstop`, `focusmode`, `brightness`, `relayactive` and
`relayinactive` are also sent by rpos in v1. The firmware ignores them.

### `relative-ptz` in detail

- `space=fov`: `p` and `t` are fractions of the camera's field of view. `1.0`
  is one full horizontal field of view for pan and one full vertical field of
  view for tilt. This is the space Frigate uses (ONVIF `TranslationSpaceFov`).
  Target change in degrees = `p × hfov` for pan and `t × vfov` for tilt, where
  `hfov` and `vfov` are the values reported in `caps`.
- `space=generic`, or no `space`: `p` and `t` are in the normalised position
  units above, so pan changes by `p × 180°` and tilt by `t × 120°`.
- Clamp the pan and tilt targets to their limits. Clamping is not an error.
- A relative move that arrives while the engine is already moving **replaces**
  the move in progress, and is applied from the current position.
- A move shorter than `MIN_MOVE_DEG` on both axes counts as zero length and
  completes immediately.

### Presets

rpos keeps the preset *names* (`presets.json`). The firmware keeps only the preset
*positions*, keyed by `value` (the ONVIF preset token, a number starting at 1).

**Storage.** The Nano ESP32 has no EEPROM, but it has flash, and the Arduino
`Preferences` library stores data in the flash's NVS (non-volatile storage)
partition, with wear levelling. No filesystem (LittleFS or similar) is needed.

- A preset is two numbers (pan and tilt in degrees as `float`, 8 bytes) plus a
  used flag, so about 9 bytes.
- Keep all presets in **one NVS blob** (an array of structs) instead of one key
  per preset, and write it only on `setpreset` and `clearpreset`. Flash wear is
  negligible at that rate.
- 64 presets are about 600 bytes. Even 255 would be about 2.3 KB. The default NVS
  partition on Arduino-ESP32 is about 20 KB, which comfortably holds either, but
  check your partition table.
- **Report `presets=64`.** Frigate needs very few, and 64 matches newer VISCA
  cameras.
- Presets are valid across power cycles because the hall sensors re-establish
  the same reference at every boot. Clamp them on load.
- An "erase all flash" upload wipes presets, while a normal upload doesn't. rpos
  keeps its own `used` flags in `presets.json`, so the two can disagree after a
  wipe. On connect rpos sends `getpresets` and reconciles its list with the
  tokens the firmware reports (see Part 2).

## Messages from the controller to rpos

### `caps`

Static capabilities. Send it at boot, when a TCP client connects, and in reply
to `getcaps`. One line:

    caps \t proto=2 \t abs=1 \t rel=1 \t cont=1 \t zoom=0 \t home=1 \t
         movestatus=1 \t position=1 \t fixedhome=1 \t
         presets=64 \t hfov=66 \t vfov=41 \t panrange=-180,180 \t tiltrange=-120,0

(Wrapped here for reading; it is one line on the wire.)

| Key | Meaning |
|---|---|
| `proto` | Protocol version, `2`. |
| `abs`, `rel`, `cont` | 1 if absolute / relative / continuous moves are supported. |
| `zoom` | 1 if zoom is supported. |
| `home` | 1 if go-to-home is supported. |
| `presets` | Number of presets. |
| `movestatus` | 1 if `status` reports `pantilt=IDLE\|MOVING`. Must be 1 for Frigate. |
| `position` | 1 if `status` reports a real position. |
| `hfov`, `vfov` | Camera field of view in degrees. Needed for `space=fov`. |
| `panrange` | Pan limits in degrees from home, `min,max`, for example `-180,180`. |
| `tiltrange` | Tilt limits in protocol degrees (0 = straight up), `min,max`. |
| `fixedhome` | 1 if home is fixed at (0, 0) and `sethome` is ignored. |

`hfov` and `vfov` belong in the firmware because the firmware owns
steps-per-degree and the fitted lens is a property of the rig. The values in the
example are the Camera Module 3 datasheet figures, to be replaced by the
measured ones.

### `presets`

Reply to `getpresets`, and sent once after `caps` at boot:

    presets \t used=1,3,7

`used` lists the tokens of the stored presets, or is empty (`used=`) if there are
none.

### `status`

    status \t pan=0.12 \t tilt=-0.75 \t zoom=0 \t pantilt=IDLE \t homed=1 \t athome=0 \t atpreset=3

| Key | Values |
|---|---|
| `pan` | Current pan, -1..1 (1.0 = 180°). |
| `tilt` | Current tilt (1.0 = 120°, 0 = straight up, positive = pitched up). |
| `zoom` | Always 0 without zoom hardware. |
| `pantilt` | `IDLE`, `MOVING` or `UNKNOWN`. |
| `homed` | `0` while the boot homing is running, `1` once it has finished. Send it on every `status`. |
| `athome` | `1` if within `HOME_TOLERANCE_DEG` of (0, 0) on both axes, else `0`. Optional. |
| `atpreset` | Token of the nearest stored preset within `PRESET_TOLERANCE_DEG`, or absent. Optional. |
| `error` | Optional. Short text when the engine is in a fault state, for example `HOMING_FAILED`. |

Send a `status` line:

1. in reply to `getstatus`;
2. when a move starts, and again when it ends;
3. at boot, after `caps`;
4. optionally every 200 ms while moving. Don't send faster than that.

### Rules that matter for Frigate

1. **Report `MOVING` before the next `getstatus` can run.** Frigate calls
   `RelativeMove` and then polls `GetStatus` immediately. If the firmware only
   starts moving on its next loop iteration, rpos can read a stale `IDLE` and
   Frigate will think the move finished instantly. So the moment a move command
   is parsed, set the "moving" flag synchronously, before returning to the
   serial reader, and only clear it when the engine has stopped.
2. **During boot homing, report `homed=0 pantilt=MOVING`** and ignore move commands. Don't report `IDLE` before homing is done.
3. **A zero-length move is `IDLE` at once.** Don't report `MOVING` for a move
   that will take no steps.
4. **A preset or home move reports `MOVING` too**, not only pan/tilt moves.
   Frigate waits for it to finish after tracking ends.
5. **Position must come from the engine's own step count**, converted to
   -1..1. It must not be the last commanded target.

## Transports

### UART serial (primary)

- Default 115200 baud, 8 data bits, no parity, 1 stop bit (8N1). The baud rate
  is configurable on both ends (`PTZSerialPortSettings` in rpos).
- The Nano ESP32 UART or the USB serial port both work. Whichever is used,
  nothing else may print debug text to the same port.
- The ESP32 resets when the host opens a USB serial port, and bytes sent during
  boot are lost. rpos handles this (Part 2), and the firmware sends `caps` and
  `status` when ready.

### TCP

- The ESP32 is the **server**, on a configurable port (for example 9999). rpos
  already connects as a client (`PTZOutput: "tcp"`, `PTZOutputURL`).
- One client at a time. If a second client connects, drop the old one. Send
  `caps` and `status` as soon as a client connects.
- Framing is identical to serial.
- UDP is best-effort and not part of the firmware profile.

### Coexisting with Pelco-D on the same UART

Pelco-D frames are 7 bytes starting with the binary byte `0xFF`. v2 lines start
with a lower-case ASCII letter. The firmware can keep both: if the first byte of
a message is `0xFF`, hand 7 bytes to the existing Pelco-D parser, otherwise
read a line. If this proves fragile, make the mode a compile-time or config
option.

---

# Part 2: rpos-side behaviour

None of this is the firmware's concern.

## Connecting

There is no `hello`. On connect, rpos sends `getcaps` then `getstatus`.

- **Serial:** the ESP32 may be rebooting when the port opens, so rpos retries
  `getcaps` every 2 s until the first `caps` arrives.
- **TCP:** send both after every (re)connect.
- Until a `caps` has arrived, rpos acts as a v1 controller (see Fallback).
- A `caps` line may arrive at any time. rpos refreshes its node data from it.

On connect rpos also sends `getpresets` and reconciles `presets.json`: tokens
the firmware lists as used become `used` (named `Preset N` if rpos had no name,
because Frigate looks presets up by name, as I recall, and an empty name would be
unusable),
and tokens rpos marks used that the firmware doesn't list become unused. A
flash wipe on the ESP32 therefore doesn't leave phantom presets.

rpos sends `cam=N` (its `PTZCameraAddress`) on every PTZ, preset and home line,
and may send `id=N`. The firmware ignores both.

## Mapping ONVIF calls to messages

| ONVIF call | rpos sends | Notes |
|---|---|---|
| `ContinuousMove` | `ptz` | `Timeout` handled by rpos, which sends a stop when it expires |
| `AbsoluteMove` | `absolute-ptz` | `Speed` -> `panspeed` / `tiltspeed` when present |
| `RelativeMove` | `relative-ptz` | the `space` attribute -> `space=fov` or `space=generic`; `Speed` as above |
| `Stop` | `stop`, or `ptz 0 0 0` if no `caps` yet | |
| `GetStatus` | none, or `getstatus` (see below) | answered from the cache |
| `GotoPreset`, `SetPreset`, `RemovePreset` | `gotopreset`, `setpreset`, `clearpreset` | |
| `GotoHomePosition`, `SetHomePosition` | `gotohome`, `sethome` | |

## Status handling

rpos caches the last `status` with a timestamp. For `GetStatus`:

- cache fresh (`PTZStatusMaxAgeMs`, default 500): answer from the cache;
- otherwise send `getstatus` and wait up to `PTZRequestTimeoutMs` (default 300);
- on timeout, answer with the stale cache and `MoveStatus` set to `UNKNOWN`.

`caps` feeds ONVIF:

- `GetServiceCapabilities`: `MoveStatus` <- `movestatus`, `StatusPosition` <-
  `position`;
- node `FixedHomePosition` <- `fixedhome`;
- the ONVIF absolute position space: X range `panrange / 180` (-1..1), Y range
  `tiltrange / 120`, for example -1.0..0.0;
- node `SupportedPTZSpaces` built from `abs` / `rel` / `cont` / `zoom`, including
  `TranslationSpaceFov` when `rel=1` and `hfov`/`vfov` are present;
- `numPresets` <- `presets`, `supportsGoToHome` <- `home`.

## Fallback: no `caps` (v1 controller)

If no `caps` arrives, rpos behaves as v1 and estimates:

- `MOVING` when a relative or absolute move is sent, back to `IDLE` after a time
  computed from the move size and speed (`PTZEstimateMsPerUnit`, default
  1500 ms per full range), and `IDLE` at once on a stop;
- position by dead reckoning: add each relative translation, set it on each
  absolute move, clamp pan and tilt to `panrange` / `tiltrange`, and report `StatusPosition` =
  false.

`PTZStatusMode`: `auto` (default; use the controller when `caps` says
`movestatus=1`, otherwise estimate), `controller`, `estimate` or `off`.

## Receive path (code in `lib/PTZDriver.ts`)

1. **Emit received data.** Make `ReconnectingStream` and `UDPStream` emit
   `data` / `message` on the wrapper object, not on the inner socket (the inner
   socket is recreated on reconnect). These are the existing `TODO` lines.
2. **Line-buffer.** TCP and serial deliver arbitrary chunks: accumulate, split on
   `\n`, keep any partial line, strip `\r`, and cap the buffer (4 KB) so a
   controller that never sends `\n` can't grow it forever. UDP messages are
   whole lines.
3. **Serial.** Attach a `ReadlineParser` from the `serialport` package.
4. **Dispatch.** One parser turns a line into `{command, positional[], keys{}}`
   and calls a handler for `caps` and `status`. Unknown lines are ignored.
5. **Treat inbound text as untrusted.** Bounds-check numbers (clamp to -1..1,
   reject `NaN`), never use controller text in a shell or file path, and log
   instead of throwing on malformed lines.
6. **Fix the output side.** Append `cam=N` to every PTZ line and add `space=`,
   `panspeed=` and `tiltspeed=` to `absolute-ptz` and `relative-ptz`, and add
   the new `stop`, `getcaps` and `getstatus` writers.

## Reserved for later

`id=N` request ids with `ok` / `err` replies, a `hello` handshake
and `pan_deg` / `tilt_deg` in `status` are deliberately left out of the firmware
profile. Because unknown keys and commands are ignored, they can be added later
without breaking a v2 firmware.

---

# Part 3: Firmware checklist

Method names below are suggestions. Adapt them to the real `PanTiltEngine` API.

## Components

1. **Line reader.** Fixed 256-byte buffer, no `String` or heap allocation per
   line, `\r` stripped, over-long lines dropped. Fed from `Serial` or a
   `WiFiClient`, polled from `loop()` without blocking.
2. **Parser.** Split on `\t` with `strtok_r`, `strtof` for numbers, and
   `key=value` splitting for optional fields.
3. **Dispatcher.** A table of command name -> handler. Unknown commands are
   ignored.
4. **Status emitter.** Sends `status` on request, on motion start and end, and
   at most every 200 ms while moving.
5. **Preset store.** `Preferences` / NVS, keyed by the preset value.
6. **TCP server (optional).** One client, sends `caps` + `status` on connect.

## Mapping to `PanTiltEngine`

| Message | Engine call (suggested) |
|---|---|
| `ptz p t z` | `setVelocity(p, t)` (-1..1 times max speed; `0 0` stops) |
| `absolute-ptz` | `moveTo(panDeg = p*180, tiltDeg = t*120, panSpeed, tiltSpeed)` (clamped to the pan and tilt limits) |
| `relative-ptz`, `space=fov` | `moveByDegrees(p*hfov, t*vfov, panSpeed, tiltSpeed)` |
| `relative-ptz`, generic | `moveByDegrees(p*180, t*120, speeds)` |
| `stop` | `stop()` |
| `getstatus` / status line | `positionNormalized()`, `isMoving()` |
| `gotohome` | `moveTo(0, 0)` |
| `sethome` | ignored |
| `gotopreset` / `setpreset` / `clearpreset` | load / save / erase in NVS, then `moveTo(...)` |
| `getpresets` | list the used tokens |

The engine needs to expose:

- the compiled-in constants from
  [Homing, position and limits](#homing-position-and-limits);
- the differential kinematics (pan/tilt <-> the two motor angles), with combined
  moves scaled so that no motor exceeds its maximum speed;
- a `homed` flag that is 0 until homing is done;
- the hall-sensor homing routine described above;
- steps per degree and the mechanical limits for each axis, used for the
  degrees <-> normalised conversion and for clamping;
- a position taken from its own step counters;
- a synchronous `isMoving()` that becomes true as soon as a move is accepted;
- acceleration and speed limits, so the 0..1 speed maps to a safe steps/s;
- a hook (callback or flag) that the status emitter uses to detect move start
  and end.

## Safety

- Clamp every pan and tilt target and velocity to the limits. This is the only
  protection against driving into the tilt stops and twisting the cable.
- Stop continuous motion of each axis at its limit.
- Optionally cap continuous motion to a maximum duration (for example 30 s) in
  case the host disappears after a `ptz` with no `stop`. Don't use a short
  watchdog: ONVIF clients such as ODM send one `ContinuousMove` and one
  `Stop`, with nothing in between.

## Test vectors

Send these with a terminal, for example
`printf 'getstatus\n' > /dev/ttyACM0`, or with `nc <host> 9999` over TCP. Use
`printf` with `\t` for tabs.

| Send | Expect |
|---|---|
| `getcaps` | one `caps` line with `proto=2` |
| `getstatus` | `status` with `pantilt=IDLE homed=1` |
| power-up | `status ... homed=0 pantilt=MOVING` while homing, then `homed=1 pantilt=IDLE athome=1` |
| `absolute-ptz`, `0.9`, `0`, `0` then `absolute-ptz`, `-0.9`, `0`, `0` | pan turns the long way, 324°, through 0 and never past ±180° |
| `relative-ptz`, `3`, `0`, `0` (generic) | pan stops at +180° (`pan=1.0`), no error |
| `relative-ptz`, `0.1`, `0`, `0`, `space=fov` | `status ... pantilt=MOVING` **immediately**, then `IDLE` when done, with pan changed by `0.1*hfov/180` (normalised) |
| `relative-ptz`, `0`, `0`, `0`, `space=fov` | `IDLE`, no motion |
| `absolute-ptz`, `0`, `0`, `0` | moves to home (straight up), then `IDLE`, `athome=1` |
| `absolute-ptz`, `0`, `-5`, `0` | tilt clamped to `TILT_MIN_DEG`, no error |
| `absolute-ptz`, `0`, `0.5`, `0` (with `TILT_MAX_DEG = 0`) | tilt stays at 0 (straight up), no error |
| from a level pose, `relative-ptz`, `0`, `0.1`, `0`, `space=generic` | the view moves **up** (checks `TILT_INVERT`) |
| `getpresets` | `presets used=...` matching what is stored |
| a move of 0.01° | `IDLE` at once (below `MIN_MOVE_DEG`) |
| power-up with the hall sensor not found | `error=HOMING_FAILED`, `homed=0`, moves ignored |
| `sethome` | ignored, no change |
| `ptz`, `0.5`, `0`, `0` then `stop` | moves, then stops with `IDLE` |
| `relative-ptz` sent while moving | the previous move is replaced |
| `setpreset`, `Home`, `3`, power cycle, `gotopreset`, `Home`, `3` | returns to the stored position |
| `unknowncommand`, `1`, `2` | no reply and no crash |
| a line of 300 bytes | dropped, and the next line still works |
| `relative-ptz`, `0.1`, `0`, `0`, `space=fov`, `cam=2`, `id=9` | works as without the extra keys |

(Fields in the Send column are TAB-separated.)

## Decisions

- **Homing:** two hall sensors define the mechanical zero (pan 0 perpendicular
  to the motors, tilt 0 straight up). The firmware homes at every boot. The
  position is assumed reliable afterwards.
- **Home (0, 0) is pan 0 and straight up.** `sethome` is ignored.
- **Pan:** limited to ±180° in software (cable), clamped, not wrapped. 1.0 = 180°.
- **Tilt:** about ±120° from straight up (to be measured). 1.0 = 120°, 0 =
  straight up, positive pitches up. The motor direction is a firmware constant
  (`TILT_INVERT`), fixed during bring-up.
- **`athome` and `atpreset`:** tolerances in degrees, because the micro-stepping
  resolution is far finer than the image can show.
- **Presets:** stored in flash with `Preferences` (NVS) as one blob, 64 presets,
  and reconciled with rpos through `getpresets`.
- **Camera:** Camera Module 3 NoIR, standard lens. 66° x 41° applies in the
  full-field modes, which a 1920x1080 capture uses. Measure it anyway (see
  [Camera field of view](#camera-field-of-view)).

## Open questions for the firmware work

These all concern the ESP32 firmware and are deferred until that work starts.
The rpos implementation does not depend on them. The answers go into the
firmware constants and, where noted, may change the values `caps` reports.

- **Homing safety.** The random first search direction can drive pan far past
  ±180° from some start poses. Options: the saved-hint approach, bounding the
  first sweep, or accepting the risk. (See [Boot homing](#boot-homing).)
- **Tilt past straight up.** Limit tilt to `-120..0` (recommended, no inverted
  image), or use the full ±120° and handle the flip. This sets `tiltrange` in
  `caps`.
- **Boot view.** Whether to move to a preset after homing (`BOOT_PRESET`), so the
  camera isn't left facing the ceiling.
- **To measure on the hardware:** the tilt limits, the hall zone widths, the
  positive tilt direction (`TILT_INVERT`), and the lens field of view (`hfov` and
  `vfov` in `caps`).
- **Tolerance values.** The suggested 0.25° and 0.05° are guesses to tune against
  the image.

---

# Implementation status (rpos)

The rpos side of Part 2 is implemented and tested. The firmware profile in Part 1
is the contract for the ESP32 work.

## Where the code is

| File | What it does |
|---|---|
| `lib/RposAscii.ts` | Parser and formatter, `LineBuffer`, `RposAsciiClient` (caps/status/presets, cached status, request timeout, `getcaps` retry with back-off), `MotionEstimator` (the v1 fallback) |
| `lib/PTZDriver.ts` | Receive path for serial, TCP and UDP; `cam=N` and the v2 keys on every `rposascii` line; `stop`; applies `caps`; `getStatus()` |
| `services/ptz_service.ts` | Nodes built from `caps`, `GetStatus`, `GetServiceCapabilities`, `RelativeMove` with `space` and `Speed`, `Stop`, preset reconciliation |
| `lib/onvifFault.ts` | ONVIF faults for unknown profile, token, space and so on |
| `test/rposascii.test.js` | `npm test` (after `npx gulp`): 24 tests, including a fake TCP controller |
| `rposConfig.sample-rposascii.json` | Sample config for a serial ESP32 |

## Config keys

All optional. They go in `rposConfig.json`.

| Key | Default | Meaning |
|---|---|---|
| `PTZStatusMode` | `auto` | `auto`: use the controller's status if `caps` says `movestatus=1`, else estimate. Also `controller`, `estimate`, `off` |
| `PTZStatusMaxAgeMs` | 500 | A cached `status` younger than this answers `GetStatus` |
| `PTZRequestTimeoutMs` | 300 | How long `GetStatus` waits for `status` before answering `UNKNOWN` |
| `PTZEstimateMsPerUnit` | 1500 | Estimated time for a move of 1.0 (normalised), in estimate mode |
| `PTZHorizontalFOV`, `PTZVerticalFOV` | none | Degrees. Used only when `caps` has no `hfov` / `vfov` |

## Behaviour to know about

- **Before `caps` arrives** (the first moments after start, or a controller that
  never answers), rpos acts as a v1 controller: it offers absolute, relative and
  continuous moves, but no `TranslationSpaceFov`, unless `PTZHorizontalFOV` and
  `PTZVerticalFOV` are set. A client that checks the node in that window, such as
  Frigate at start-up, would see no FOV space and disable autotracking. Start the
  controller before Frigate, or set the two FOV keys.
- **`GetStatus`** is answered from the cache when it is fresh. Otherwise rpos
  sends `getstatus` and waits up to `PTZRequestTimeoutMs`. On timeout it returns
  the last position with `MoveStatus` `UNKNOWN`, or no position at all if there
  never was a status. The position is only reported when `caps` says
  `position=1`.
- **`Stop`**: a flag that is absent now means "stop that movement" (as ONVIF
  specifies). With `caps` present rpos sends `stop`, otherwise `ptz 0 0 0`.
- **`ContinuousMove` `Timeout`** is honoured by rpos, which sends the stop. A
  position move (absolute, relative, preset, home) cancels the pending timeout.
- **`AbsoluteMove`** needs a `PanTilt` position. A zoom-only absolute move gets
  a `ter:InvalidArgs` fault.
- **`RelativeMove`** with a space the node doesn't list gets a
  `ter:SpaceNotSupported` fault. No `space` attribute means the generic space.
- **`SetPreset`** takes a free slot only up to the number of presets the
  controller reports, and faults with `ter:TooManyPresets` beyond that.
- **Not implemented:** `id=` request ids and `ok` / `err`, `hello`,
  `pan_deg` / `tilt_deg`. `athome` and `atpreset` are parsed but ONVIF has no
  field for them, so they are unused.

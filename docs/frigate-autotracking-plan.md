# Frigate autotracking: implementation plan

See [frigate-autotracking-analysis.md](frigate-autotracking-analysis.md) for the
gaps this plan addresses. Nothing here has been implemented yet.

## Open question

The PTZ hardware is decided: an Arduino Nano ESP32 with two stepper motors,
reached over UART serial (primary) or TCP, using `rposascii` v2. Pelco-D and
VISCA would need new relative-move code, so they stay out of scope. Still
open: the safety of the homing search, whether to limit tilt to the useful
`-120..0` range, a boot preset, and measuring the tilt limits and the lens
field of view. The mechanism is a differential pan-tilt with two hall sensors
for homing. Home (0, 0) is pan 0 and straight up. Pan is limited to ±180° and
tilt to about ±120°. Frigate should return to a preset at the normal view, not
to home. The camera is a Camera Module 3 NoIR (about 66° x 41° in the
full-field sensor modes). See the protocol doc.

## Status

| Step | State |
|---|---|
| 0. `rposascii` two-way | rpos side done and tested. Firmware side not started; its specification is [ptz-controller-firmware-spec.md](ptz-controller-firmware-spec.md) |
| 1. Advertise the FOV space | Done. The node lists `TranslationSpaceFov` once the field of view is known (from `caps`, or `PTZHorizontalFOV` / `PTZVerticalFOV`). No zoom spaces without zoom hardware |
| 2. Fix `RelativeMove` | Done: local values, profile lookup, `space` and `Speed` passed through, ONVIF faults |
| 3. Position and move status | Done for `rposascii`: `GetStatus` position and `MoveStatus`, capabilities from `caps`, estimate fallback |
| 4. FOV-aware relative motion | rpos sends `space=fov`. The conversion to motor steps is the firmware's job. The hat driver is unchanged |
| 5. Secondary gaps | Presets reconcile with the controller. Authentication not checked against Frigate |
| 6. Test | `npm test` covers the protocol, a fake controller and the SOAP handlers. Not yet run against Frigate or the ESP32 |
| 7. Document | Protocol doc, config keys and `rposConfig.sample-rposascii.json`. No Frigate example config yet |

## Step 0: make `rposascii` two-way

Steps 3 and 4 depend on this when the controller is an `rposascii` one. The
controller is an Arduino Nano ESP32 driving two stepper motors, connected over
UART serial (primary) or TCP. It currently speaks only Pelco-D, which cannot
report position or move status. The protocol is specified in
[rposascii-protocol-v2.md](rposascii-protocol-v2.md), in three parts:

- **Firmware** (ESP32): implement the firmware profile in Part 1 and the
  checklist in Part 3. The messages are `ptz`, `absolute-ptz`, `relative-ptz`
  (with `space=fov`), `stop`, `getstatus`/`status`, `getcaps`/`caps` and the
  home and preset commands.
- **rpos**: Part 2. Emit received data from the TCP and UDP streams, add a
  line-buffered parser and a serial `ReadlineParser`, request `getcaps` and
  `getstatus` on connect, cache `status`, and append `cam=N` to every line.
- Keep a v1 fallback: if no `caps` arrives, rpos estimates `MoveStatus` and
  position itself.

## Step 1: advertise the FOV space

In `extendService()` in `services/ptz_service.ts`:

- Add `{URI: '.../PanTiltSpaces/TranslationSpaceFov', XRange: [-1, 1], YRange: [-1, 1]}`
  next to the generic entry in `RelativePanTiltTranslationSpace`.
- Make sure `DefaultRelativePanTiltTranslationSpace` is a URI the node lists.
- Optionally add the relative zoom translation and absolute zoom position spaces
  when the driver supports zoom.

## Step 2: fix `RelativeMove`

- Use local variables instead of the shared `pan`, `tilt` and `zoom`.
- Resolve the profile and camera address as `ContinuousMove` does.
- Read the `space` attribute so the driver knows whether the value is FOV or
  generic.
- Pass `{pan, tilt, zoom, space, speed, cameraAddress}` through the callback.
- Return an ONVIF fault when the profile token is unknown.

## Step 3: add a position and move-status model

- Track the current pan/tilt/zoom in `PTZDriver`, with a `moving` flag taken
  from the controller's `status` lines (`rposascii` v2) or, when the controller
  sends none, from a timer-based estimate (`PTZStatusMode`).
- Build the node's supported spaces and the `MoveStatus`/`StatusPosition`
  capabilities from the controller's `caps` reply where there is one.
- Return `Position` and `MoveStatus` (`IDLE` or `MOVING`) from `GetStatus`.
- Set `MoveStatus` and `StatusPosition` to true in `GetServiceCapabilities`.

## Step 4: FOV-aware relative motion in `PTZDriver`

- Add config keys such as `PTZHorizontalFOV`, `PTZVerticalFOV`, `PTZPanRange`,
  `PTZTiltRange`, `PTZPanInvert` and `PTZTiltInvert`, and document them in the
  sample configs.
- For FOV space, compute the move as `degrees = value × FOV`. For generic space,
  scale to the full range.
- Clamp to the limits and fix the sign convention.
- For `pan-tilt-hat`, move to the target and keep `moving` set until done.
- For `rposascii`, send `space=fov|generic` and the speeds on `relative-ptz`
  (see the protocol doc). The ESP32 firmware owns the FOV-to-steps conversion and
  reports `hfov`/`vfov` in `caps`; the FOV config keys are the fallback and the
  override.
- Optionally add relative support for VISCA (its relative-position command), or
  emulate it as an absolute move from the tracked position.

## Step 5: secondary gaps

- Check that Frigate's credentials are accepted by the existing auth.
- Make sure the profile Frigate uses has a `PTZConfiguration`.
- Make sure presets work for returning to a home position.

## Step 6: test

- Test the `rposascii` v2 exchange against a small fake controller (a script
  that answers `getcaps`, `getstatus` and `relative-ptz` over TCP, and another
  that stays silent to exercise the v1 fallback), and then against the real
  ESP32 using the test vectors in the protocol doc. Check that `MOVING` is
  reported immediately after `RelativeMove`.
- Add a SOAP test script that calls `GetNodes`, `GetConfigurationOptions`,
  `RelativeMove` and `GetStatus`, and checks that the FOV URI is present.
- Run Frigate with `onvif.autotracking.enabled` and check that its log shows no
  "unsupported" error.
- Do a manual check with `onvif-zeep` or ODM.
- Calibrate with Frigate's `calibrate_on_startup` option and tune the FOV values.

## Step 7: document

- Update the README and sample configs with the new keys.
- Add an example Frigate config.

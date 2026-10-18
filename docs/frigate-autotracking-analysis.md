# Frigate autotracking: gap analysis

Frigate autotracking needs a PTZ camera that supports relative movement within
the field of view (ONVIF `RelativePanTiltTranslationSpace` with a
`TranslationSpaceFov` entry). If the camera doesn't, Frigate logs an error and
disables autotracking.

This document lists what rpos has today and what blocks Frigate. It is based on
reading `services/ptz_service.ts`, `lib/PTZDriver.ts` and
`services/device_service.ts`. The description of Frigate's behaviour is from
memory of its `onvif.py`, so verify it against the Frigate version you run.

## What already exists

- `services/ptz_service.ts` implements `RelativeMove`, `AbsoluteMove`,
  `ContinuousMove`, `Stop`, presets, `GetNodes`, `GetConfigurations` and
  `GetConfigurationOptions`.
- The PTZ node advertises `RelativePanTiltTranslationSpace` when
  `supportsRelativePTZ` is true. That flag is only set for the `rposascii` and
  `pan-tilt-hat` drivers.
- `lib/PTZDriver.ts` handles a `relative-ptz` command for those two drivers.
- PTZ configurations are attached to the profiles.

## What blocks Frigate

1. **The wrong relative space is advertised.** The node only offers
   `http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace`.
   Frigate requires an entry with the URI
   `http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov`. This is
   the main blocker.
2. **There are no zoom spaces.** There is no `RelativeZoomTranslationSpace` and
   no `AbsoluteZoomPositionSpace`. They are only needed for zoom tracking, but
   `DefaultRelativeZoomTranslationSpace` already points at a space the node
   doesn't list.
3. **Move status is not reported.** `GetServiceCapabilities` returns
   `MoveStatus: false` and `StatusPosition: false`, and `GetStatus` returns only
   `UtcTime`. Frigate polls `GetStatus` for `MoveStatus.PanTilt` being `MOVING`
   or `IDLE` to know when a move has finished.
4. **`RelativeMove` has bugs.**
   - `pan`, `tilt` and `zoom` are shared closure variables, so values from an
     earlier call carry over into the next one.
   - `RelativeMove` and `AbsoluteMove` don't look up the profile, so
     `cameraAddress` isn't passed to the driver.
   - The `Speed` argument is ignored.
   - An unknown `ProfileToken` throws instead of returning an ONVIF fault.
5. **The driver has no FOV semantics.**
   - For the pan-tilt-hat, `relative-ptz` maps a ±1 translation to ±90° pan and
     ±80° tilt, and subtracts the pan and tilt, so the direction may be
     inverted.
   - Frigate sends values in field-of-view units, where 1.0 means one full frame
     width or height.
   - Pelco-D and VISCA have no relative support, so autotracking currently only
     works with `rposascii` or `pan-tilt-hat`.
6. **The FOV conversion needs configuration.** The camera's horizontal and
   vertical FOV, the physical pan/tilt range and the direction are not
   configurable yet.
7. **Secondary points.**
   - Frigate returns the camera to a preset, so presets must work end to end
     with `PTZDriver`. `GotoPreset` and `SetPreset` exist.
   - `device_service.ts` reports `UsernameToken: false`. Frigate sends
     credentials, so confirm the service accepts them.
8. **`rposascii` is one-way.**
   - rpos only writes to the controller. The TCP and UDP streams have
     `// TODO - emit the data` in `connect()`, and the serial port is never
     read, so anything the controller sends back is discarded.
   - Frigate needs rpos to report position, move status and capabilities, which
     only the controller knows. That needs a two-way protocol, implemented in both rpos and the ESP32
     firmware (which currently speaks only Pelco-D). See
     [rposascii-protocol-v2.md](rposascii-protocol-v2.md).
   - No `rposascii` line carries a camera address, although the other drivers
     receive one, so a multi-camera controller can't tell which camera a command
     is for.

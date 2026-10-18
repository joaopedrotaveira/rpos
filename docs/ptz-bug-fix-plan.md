# PTZ bug fix plan

These are defects found in the PTZ code while analysing Frigate autotracking
(see [frigate-autotracking-analysis.md](frigate-autotracking-analysis.md)).
They are listed here as a separate plan because most of them are worth fixing
whether or not autotracking is ever added, and several should be fixed *before*
the autotracking work, since it builds on the same code. Nothing here has been
implemented yet. Line numbers refer to the code at the time of writing and will
drift.

## Status

Fixed together with the rposascii v2 work (see
[rposascii-protocol-v2.md](rposascii-protocol-v2.md)), with tests in
`test/rposascii.test.js`:

- B1 (per-camera continuous state, `Timeout`), B2 (profile lookup and camera
  address on absolute and relative moves), B3 (one `resolveProfile` helper and
  ONVIF faults instead of crashes), B4 (lookups by token), B5 (preset rename),
  B6 (user-defined profiles), B10 (`SetHomePosition`), and B11 (the receive path
  and `cam=N` on every `rposascii` line).
- B9: the `releative-ptz` typo in the `PTZDriver.ts` header, which also now lists
  the v2 messages. The config comment still omits `rposascii` and `PTZNumPresets`.
- Also fixed, found while doing this: `SetPreset` never marked a preset as used
  when the token already existed as an empty slot.

Not done: B7 (pan-tilt-hat relative sign and units, which needs the hardware),
B8 (`var` redeclarations and `NaN` guards in the driver), the rest of B9, and B12
(the `camera-streamer` arguments).

## Bugs

### B1. Shared move state leaks between calls and cameras (high)
`services/ptz_service.ts:321-324` declares `pan`, `tilt`, `zoom` and `timeout`
once in `extendService()`. `ContinuousMove`, `AbsoluteMove`, `RelativeMove` and
`Stop` all read and write them, and each uses `try { x = ... } catch {}` to
"keep the last value".

- A `RelativeMove` that omits `Zoom` re-sends the zoom left over from an earlier
  call.
- A `ContinuousMove` on camera 2 inherits camera 1's last pan/tilt/zoom.
- `timeout` is stored and never used, so the `Timeout` argument of
  `ContinuousMove` has no effect and a lost `Stop` leaves the camera moving.

Note: ODM sends pan/tilt and zoom in separate `ContinuousMove` calls, which is
why the "keep last value" behaviour exists. The fix has to keep that working.

**Fix:** keep the last-sent pan/tilt/zoom per camera (a map keyed by camera
address), used only by `ContinuousMove`/`Stop`. `RelativeMove` and
`AbsoluteMove` use local variables and default missing axes to 0 (relative) or to
the current position (absolute). Honour `Timeout` for `ContinuousMove` by
scheduling a stop, and cancel the timer on the next move or `Stop`.

### B2. `AbsoluteMove` and `RelativeMove` skip the profile lookup (high)
`services/ptz_service.ts:345-362` never resolve the profile, so `cameraAddress`
is not passed. Every other move command passes it. On a multi-camera setup these
two commands cannot target the right camera, and the driver receives
`cameraAddress: undefined`.

**Fix:** resolve profile -> node token -> camera address in one shared helper
(see B3) and include `cameraAddress` in both callbacks. Check that
`process_ptz_command` handles it for the `absolute-ptz` and `relative-ptz`
branches.

### B3. Unknown `ProfileToken` crashes the handler (high)
`ContinuousMove`, `Stop`, `GotoHomePosition`, `SendAuxiliaryCommand`,
`GetPresets`, `GotoPreset`, `RemovePreset` and `SetPreset` all do
`profilesArray.find(...)` and then dereference `profile.PTZConfiguration` without
checking. An unknown token, or a profile with no PTZ configuration, throws a
`TypeError`. Frigate and other clients probe with whatever token they were given.

The same code repeats
`Number(NodeToken.substring(15))` followed by
`Cameras[camID - 1].PTZCameraAddress` about eight times. The magic `15`
(`"ptz_node_token_".length`) breaks silently if the token format changes, and an
out-of-range `camID` throws.

**Fix:** add one private helper, for example
`resolveProfile(profileToken): { profile, nodeToken, camID, cameraAddress }`,
that returns an ONVIF fault (`ter:InvalidArgVal/ter:NoProfile`, or
`ter:NoConfig` when the profile has no PTZ configuration) instead of throwing.
Replace all repeated blocks with it. Check how other services build SOAP faults
(`lib/SoapService.ts`) and reuse that.

### B4. Per-token lookups are hard-coded to the first item (medium)
- `GetConfigurationOptions` (`ptz_service.ts:244`) always returns
  `nodesArray[0].SupportedPTZSpaces`.
- `GetConfiguration` (`:258`) always returns `ptzConfigurationsArray[0]`.
- `GetNode` (`:272`) returns `undefined` for an unknown node token instead of a
  fault.

Both TODOs are already in the source. With more than one camera, clients get the
wrong node's spaces or configuration. Frigate calls `GetConfigurationOptions`
with the configuration token from the profile, so this matters for it.

**Fix:** look up by `args.ConfigurationToken` / `args.PTZConfigurationToken` /
`args.NodeToken`, find the matching node via `NodeToken`, and return
`ter:InvalidArgVal/ter:NoEntity` when nothing matches.

### B5. `SetPreset` rename never takes effect (medium)
In the update branch, the code compares and assigns `existingPreset.PresetName`
(capital P). The stored field is `presetName` (see the constructor and
`PresetArrayItem`). So `existingPreset.PresetName` is always `undefined`, the
condition is always true, and the name is written to a new property that is never
read or used. Renaming a preset therefore silently does nothing.

**Fix:** use `presetName` in both places, and only write the file when the name
actually changed. Re-check the "new preset" branch below it for the same
mistake.

### B6. User-defined profiles get a PTZ configuration based on the wrong field (medium)
`services/media_service.ts:353` sets `PTZConfiguration` conditionally on
`userProfile.videoEncoderConfigurationToken != ''` but then looks up
`userProfile.ptzConfigurationToken`. A saved profile with a PTZ configuration but
no video encoder loses its PTZ configuration, and one with an encoder but an
empty or missing PTZ token ends up with `undefined` from `find`. Autotracking
depends on the profile carrying a PTZ configuration.

**Fix:** condition on `userProfile.ptzConfigurationToken`.

### B7. `pan-tilt-hat` relative move: sign and units (medium)
`lib/PTZDriver.ts`, `relative-ptz` branch: new angle =
`position - translation × 90` for pan and `position - translation × 80` for tilt.

- The subtraction means a positive ONVIF pan (right) moves the hat left,
  unless the hat's own convention is inverted. The `ptz` (continuous) branch
  treats positive pan as `pan_right`, so the two branches disagree.
- 90 and 80 are the library's travel limits, not a translation scale, and are
  hard-coded.
- The result is not clamped before calling `pan()`/`tilt()`.

**Fix:** decide the convention once (positive pan = right, positive tilt = up, per
ONVIF), make `absolute-ptz`, `relative-ptz` and continuous agree, clamp to the
hat's range, and move the constants to config. This is the same work as step 4 of
the autotracking plan, so do them together.

### B8. `var` redeclaration and missing parse guards in the driver (low)
In `process_ptz_command`, `var p`, `var t` and `var z` are declared in several
`else if` branches of one function. It works because of `var` hoisting, but the
values from one branch are visible in the next. The
`try { p = parseFloat(...) } catch` blocks never throw on `NaN`, so `NaN` flows
into the serial/VISCA/pan-tilt-hat calls.

**Fix:** use `let` per branch (or extract per-command methods) and treat
`NaN` as 0.

### B9. Documentation and naming slips (low)
- `lib/PTZDriver.ts:76` documents `releative-ptz` (typo). The real command is
  `relative-ptz`, so anyone implementing the ASCII protocol from the header will
  get it wrong.
- `rposConfig.json` and the samples list valid `PTZDriver` values as "none, tenx,
  pelcod, visca and pan-tilt-hat" but omit `rposascii`, which `rposConfig.json`
  itself uses.
- The `PTZNumPresets` key is read for VISCA only and is not documented in the
  sample configs.

**Fix:** correct the typo and the comments, and document the keys.

### B10. Misleading `SetHomePosition` and `GotoHomePosition` (low)
`SetHomePosition` calls the callback with `{}`, so no `cameraAddress` reaches the
driver, and it does not look up the profile. `GotoHomePosition` does pass it.

**Fix:** use the shared helper from B3 and pass `cameraAddress`.

### B11. `rposascii` input is discarded and its output lacks the camera (medium)
- `ReconnectingStream` (TCP) and `UDPStream` (UDP) in `lib/PTZDriver.ts` log
  received data and leave `// TODO - emit the data`. The serial port is never
  read. So the controller cannot send anything useful back.
- None of the `rposascii` lines carries `cameraAddress`, although `ptz`,
  `gotohome`, presets, `aux` and `focus` all receive it. This is the ASCII half
  of B2 and B10.
- The header documents `releative-ptz` (see B9) and labels the
  `absolute-ptz`/`relative-ptz` fields "speed" when they are a position and a
  translation.

**Fix:** implement the receive path and the `cam=N` field as specified in Part 2
of [rposascii-protocol-v2.md](rposascii-protocol-v2.md). The `cam=N` part is
backward compatible with v1 controllers and can land with B2 and B10. The
receive path is only needed for autotracking, so it can wait for step 0 of that
plan, but the stream `emit` TODOs should be fixed together with it.

### B12. Missing space in the `camera-streamer` arguments (low)
`python/gst-rtsp-launch.sh` passes
`--camera-stream.disabled=0--camera-video.disabled=0` as a single argument (a
space is missing before the second option). `camera-streamer` will most likely
read it as one malformed option, so the stream and video enables may not apply.
It also does not set `--camera-width` / `--camera-height`, so the capture size
(and therefore the sensor mode and field of view) depends on the streamer's
default of 1920x1080.

**Fix:** add the space, and pin `--camera-width=1920 --camera-height=1080`. See
the field-of-view section of
[rposascii-protocol-v2.md](rposascii-protocol-v2.md). This is not a PTZ bug, but
it affects the autotracking calibration.

## Suggested order

1. **B3** first, because B2, B4 and B10 all build on the helper.
2. **B2, B1, B10** (the move handlers), then **B4**.
3. **B11** (`cam=N` on every ASCII line) together with B2 and B10; the receive
   path comes with step 0 of the autotracking plan.
4. **B5, B6** (small, independent fixes).
5. **B7, B8** together with step 4 of the autotracking plan.
6. **B9** (comments and docs) last.
7. **B12** (the streamer arguments) any time. Do it before measuring the FOV.

Steps 1-2 should land before any autotracking work, because Step 2 of the
autotracking plan rewrites `RelativeMove` and would otherwise duplicate the
profile-resolution code.

## Verification

There are no automated tests in the repo. For each fix:

- Add a small SOAP script (in `test/` or `docs/`) that sends the request with a
  valid token, an unknown token and a profile with no PTZ configuration, and
  asserts a response or an ONVIF fault rather than a crash. The service currently
  has no unit tests, so keep it simple.
- B1: send `RelativeMove` with only `PanTilt`, then check the driver call has
  `zoom: 0`; send two `ContinuousMove` calls for different cameras and check
  they do not share values; send a `ContinuousMove` with `Timeout: PT1S` and
  check a stop follows.
- B2/B10: check `cameraAddress` is present in the callback payload.
- B11: with a fake TCP controller, check every PTZ line carries `cam=N`, and
  that a controller reading only the first fields still parses the lines.
- B4: with two cameras configured, check each token returns its own node.
- B5: `SetPreset` with an existing token and a new name, then `GetPresets`.
- B6: load a saved profile with only a PTZ token set.
- B7: on real hardware, a positive relative pan moves the same direction as a
  positive continuous pan.
- Build with `npx gulp` and confirm it passes. `rpos.js` is generated and not
  tracked in git.

## Risks and notes

- Faults change behaviour for clients that currently get a crash or empty
  response, which is the intended outcome but worth noting in the changelog.
- `services/stubs/*.js` are tracked and generated from the WSDLs. The bug fixes
  here don't need them regenerated, but a change to the WSDL handling would.
- I have not run the code. Each bug is from reading the source, so reproduce it
  before fixing. B1 and B5 are the ones most worth confirming first.

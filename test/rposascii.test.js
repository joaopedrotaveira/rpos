// Tests for rposascii protocol v2 (rpos side). Run `npx gulp` first, then `npm test`.
// No test framework: each test is an async function, and the process exits non-zero on failure.
var assert = require('assert');
var net = require('net');
var os = require('os');
var fs = require('fs');
var path = require('path');
var http = require('http');

var root = path.resolve(__dirname, '..');

// PTZService reads ./wsdl and writes presets.json in the current directory.
// Run from a temporary directory so the real presets.json is not touched.
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpos-test-'));
fs.symlinkSync(path.join(root, 'wsdl'), path.join(tmp, 'wsdl'));
process.chdir(tmp);

var A = require(path.join(root, 'lib/RposAscii.js'));
var PTZDriver = require(path.join(root, 'lib/PTZDriver.js'));
var PTZService = require(path.join(root, 'services/ptz_service.js'));

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function waitFor(predicate, ms, what) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for ' + what));
      setTimeout(poll, 10);
    })();
  });
}

var CAPS_LINE = 'caps\tproto=2\tabs=1\trel=1\tcont=1\tzoom=0\thome=1\tpresets=64\tmovestatus=1\tposition=1\tfixedhome=1\thfov=66\tvfov=41\tpanrange=-180,180\ttiltrange=-120,0\n';

// ---------- protocol helpers ----------

test('parseLine splits positional fields and keys', function () {
  var m = A.parseLine('status\tpan=0.12\ttilt=-0.75\tpantilt=IDLE\n');
  assert.strictEqual(m.command, 'status');
  assert.deepStrictEqual(m.fields, []);
  assert.strictEqual(m.keys.pan, '0.12');
  assert.strictEqual(m.keys.pantilt, 'IDLE');
  var n = A.parseLine('gotopreset\tMy Preset\t3\tcam=2');
  assert.deepStrictEqual(n.fields, ['My Preset', '3']);
  assert.strictEqual(n.keys.cam, '2');
  assert.strictEqual(A.parseLine(''), null);
  assert.strictEqual(A.parseLine('\n'), null);
});

test('formatLine builds lines, drops undefined keys, removes tabs from text', function () {
  assert.strictEqual(A.formatLine('relative-ptz', [0.1, -0.05, 0], { cam: 1, space: 'fov', panspeed: undefined }),
    'relative-ptz\t0.1\t-0.05\t0\tcam=1\tspace=fov\n');
  assert.strictEqual(A.formatLine('setpreset', ['a\tb\nc', 3]), 'setpreset\ta b c\t3\n');
  assert.strictEqual(A.formatLine('getcaps'), 'getcaps\n');
  assert.strictEqual(A.formatNumber(NaN), '0');
  assert.strictEqual(A.formatNumber(0.1 + 0.2), '0.3');
});

test('parseCaps reads flags, numbers and ranges', function () {
  var caps = A.parseCaps(A.parseLine(CAPS_LINE).keys);
  assert.strictEqual(caps.rel, true);
  assert.strictEqual(caps.zoom, false);
  assert.strictEqual(caps.presets, 64);
  assert.strictEqual(caps.hfov, 66);
  assert.deepStrictEqual(caps.panrange, [-180, 180]);
  assert.deepStrictEqual(caps.tiltrange, [-120, 0]);
  // bad values are ignored
  var bad = A.parseCaps({ hfov: 'x', vfov: '-4', panrange: '5,1', presets: '-3' });
  assert.strictEqual(bad.hfov, undefined);
  assert.strictEqual(bad.vfov, undefined);
  assert.strictEqual(bad.panrange, undefined);
  assert.strictEqual(bad.presets, 0);
  assert.strictEqual(bad.abs, false);
});

test('parseStatus clamps positions and defaults unknown states', function () {
  var s = A.parseStatus({ pan: '5', tilt: 'abc', pantilt: 'moving', homed: '0', athome: '1', atpreset: '3', error: 'HOMING_FAILED' }, 1000);
  assert.strictEqual(s.pan, 1);
  assert.strictEqual(s.tilt, undefined);
  assert.strictEqual(s.panTilt, 'MOVING');
  assert.strictEqual(s.homed, false);
  assert.strictEqual(s.atHome, true);
  assert.strictEqual(s.atPreset, '3');
  assert.strictEqual(s.error, 'HOMING_FAILED');
  assert.strictEqual(A.parseStatus({}, 1).panTilt, 'UNKNOWN');
  assert.strictEqual(A.parseStatus({}, 1).homed, true);
});

test('parsePresetTokens keeps positive integers only', function () {
  assert.deepStrictEqual(A.parsePresetTokens('1,3,7'), ['1', '3', '7']);
  assert.deepStrictEqual(A.parsePresetTokens('1,,x,0,-2,3,3'), ['1', '3']);
  assert.deepStrictEqual(A.parsePresetTokens(''), []);
  assert.deepStrictEqual(A.parsePresetTokens(undefined), []);
});

test('LineBuffer joins chunks, handles CRLF, drops over-long lines', function () {
  var b = new A.LineBuffer(20);
  assert.deepStrictEqual(b.push('sta'), []);
  assert.deepStrictEqual(b.push('tus\r\nca'), ['status']);
  assert.deepStrictEqual(b.push('ps\n'), ['caps']);
  // a line of 30 bytes is dropped up to its line feed, the next one still works
  assert.deepStrictEqual(b.push(new Array(31).join('x')), []);
  assert.deepStrictEqual(b.push('yyy\nok\n'), ['ok']);
  // a multi-byte character split across chunks
  var c = new A.LineBuffer();
  var euro = Buffer.from('é\n');
  assert.deepStrictEqual(c.push(euro.slice(0, 1)), []);
  assert.deepStrictEqual(c.push(euro.slice(1)), ['é']);
});

test('RposAsciiClient: caps, status, presets, ignores junk', function () {
  var written = [];
  var client = new A.RposAsciiClient(function (l) { written.push(l); }, { capsRetryMs: 10000 });
  var events = [];
  client.on('caps', function (c) { events.push(['caps', c.presets]); });
  client.on('status', function (s) { events.push(['status', s.panTilt]); });
  client.on('presets', function (t) { events.push(['presets', t.join()]); });
  client.connected();
  assert.deepStrictEqual(written, ['getcaps\n', 'getstatus\n', 'getpresets\n']);
  client.handleData('garbage\n\n\x00\x01\nunknown\tx=1\n');
  client.handleData(CAPS_LINE + 'status\tpantilt=MOVING\n');
  client.handleData('presets\tused=2,5\n');
  assert.deepStrictEqual(events, [['caps', 64], ['status', 'MOVING'], ['presets', '2,5']]);
  client.disconnected();
});

test('RposAsciiClient: getStatus uses the cache, asks when stale, times out', async function () {
  var written = [];
  var client = new A.RposAsciiClient(function (l) { written.push(l); }, { statusMaxAgeMs: 50, requestTimeoutMs: 80 });
  // never any status: times out with null
  assert.strictEqual(await client.getStatus(), null);
  assert.deepStrictEqual(written, ['getstatus\n']);
  // a reply arriving while waiting resolves it
  var pending = client.getStatus();
  setTimeout(function () { client.handleLine('status\tpan=0.5\ttilt=0\tpantilt=IDLE'); }, 10);
  var s = await pending;
  assert.strictEqual(s.pan, 0.5);
  assert.strictEqual(s.panTilt, 'IDLE');
  // fresh: no new request
  var count = written.length;
  assert.strictEqual((await client.getStatus()).pan, 0.5);
  assert.strictEqual(written.length, count);
  // stale and no reply: the old status comes back marked UNKNOWN
  await sleep(70);
  var stale = await client.getStatus();
  assert.strictEqual(stale.panTilt, 'UNKNOWN');
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.pan, 0.5);
  assert.strictEqual(client.status.panTilt, 'IDLE', 'the cached status is not changed');
});

test('RposAsciiClient: caps are requested again with back-off until they arrive', async function () {
  var written = [];
  var client = new A.RposAsciiClient(function (l) { written.push(l); }, { capsRetryMs: 20, capsRetryMaxMs: 40 });
  client.connected();
  await sleep(150);
  var asks = written.filter(function (l) { return l === 'getcaps\n'; }).length;
  assert.ok(asks >= 3, 'asked ' + asks + ' times');
  client.handleLine(CAPS_LINE.trim());
  var after = written.length;
  await sleep(100);
  assert.strictEqual(written.length, after, 'stops asking once caps arrived');
  client.disconnected();
});

test('MotionEstimator: relative move, stop, continuous, clamp', function () {
  var t = 0;
  var e = new A.MotionEstimator(1000, function () { return t; });
  assert.strictEqual(e.snapshot().panTilt, 'IDLE');
  e.relative(0.5, 0, 1);               // 0.5 units takes 500 ms
  t = 250;
  var s = e.snapshot();
  assert.strictEqual(s.panTilt, 'MOVING');
  assert.ok(Math.abs(s.pan - 0.25) < 1e-9, 'halfway: ' + s.pan);
  t = 600;
  s = e.snapshot();
  assert.strictEqual(s.panTilt, 'IDLE');
  assert.ok(Math.abs(s.pan - 0.5) < 1e-9);
  e.absolute(-1, 0.5, 0.5);            // 1.5 units at half speed: 3000 ms
  t = 1600;
  e.stop();
  s = e.snapshot();
  assert.strictEqual(s.panTilt, 'IDLE');
  assert.ok(s.pan < 0.5 && s.pan > -1);
  e.continuous(1, 0);
  t = 10600;                           // would pass the end of the range
  s = e.snapshot();
  assert.strictEqual(s.pan, 1);
  assert.strictEqual(s.panTilt, 'MOVING');
  e.continuous(0, 0);
  assert.strictEqual(e.snapshot().panTilt, 'IDLE');
  e.relative(0, 0);                    // zero length move is idle at once
  assert.strictEqual(e.snapshot().panTilt, 'IDLE');
});

// ---------- driver against a fake controller over TCP ----------

function fakeController(reply) {
  var received = [];
  var sockets = [];
  var server = net.createServer(function (socket) {
    sockets.push(socket);
    var buffer = '';
    socket.on('data', function (d) {
      buffer += d.toString();
      var lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(function (line) {
        received.push(line);
        if (reply) reply(line, socket);
      });
    });
    socket.on('error', function () { });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        port: server.address().port, received: received,
        close: function () { sockets.forEach(function (s) { s.destroy(); }); server.close(); }
      });
    });
  });
}

function driverConfig(port, extra) {
  var config = {
    PTZDriver: 'rposascii', PTZOutput: port ? 'tcp' : 'none', PTZOutputURL: '127.0.0.1:' + port,
    PTZCameraAddress: 1, Cameras: [{ PTZCameraAddress: 1 }, { PTZCameraAddress: 2 }],
    PTZStatusMaxAgeMs: 30, PTZRequestTimeoutMs: 200
  };
  Object.keys(extra || {}).forEach(function (k) { config[k] = extra[k]; });
  return config;
}

test('PTZDriver with a v2 controller: caps, status, commands', async function () {
  var panPos = 0.12;
  var controller = await fakeController(function (line, socket) {
    if (line === 'getcaps') socket.write(CAPS_LINE);
    if (line === 'getstatus') socket.write('status\tpan=' + panPos + '\ttilt=-0.75\tzoom=0\tpantilt=IDLE\thomed=1\n');
    if (line === 'getpresets') socket.write('presets\tused=1,3\n');
  });
  var driver = new PTZDriver(driverConfig(controller.port));
  var presets = null;
  driver.events.on('presets', function (t) { presets = t; });
  try {
    await waitFor(function () { return driver.rposClient.caps && presets; }, 2000, 'caps and presets');
    assert.deepStrictEqual(controller.received.slice(0, 3), ['getcaps', 'getstatus', 'getpresets']);
    assert.strictEqual(driver.supportsRelativePTZ, true);
    assert.strictEqual(driver.hasZoom, false);
    assert.strictEqual(driver.numPresets, 64);
    assert.strictEqual(driver.hasFixedHomePosition, true);
    assert.deepStrictEqual(driver.getFov(), { h: 66, v: 41 });
    assert.deepStrictEqual(presets, ['1', '3']);
    assert.strictEqual(driver.statusSource(), 'controller');
    assert.strictEqual(driver.supportsMoveStatus(), true);
    assert.strictEqual(driver.supportsStatusPosition(), true);

    controller.received.length = 0;
    driver.process_ptz_command('relative-ptz', { pan: 0.1, tilt: -0.05, zoom: 0, space: 'fov', cameraAddress: 1, panSpeed: 0.5 });
    driver.process_ptz_command('absolute-ptz', { pan: 0, tilt: -0.75, zoom: 0, cameraAddress: 1 });
    driver.process_ptz_command('ptz', { pan: 0.5, tilt: 0, zoom: 0, cameraAddress: 2 });
    driver.process_ptz_command('stop', { cameraAddress: 1, zoom: 0, stopZoom: true });
    driver.process_ptz_command('gotopreset', { name: 'Door', value: '3', cameraAddress: 1 });
    driver.process_ptz_command('gotohome', { cameraAddress: 1 });
    driver.process_ptz_command('sethome', {});
    await waitFor(function () { return controller.received.length >= 7; }, 2000, 'commands');
    assert.deepStrictEqual(controller.received, [
      'relative-ptz\t0.1\t-0.05\t0\tcam=1\tspace=fov\tpanspeed=0.5',
      'absolute-ptz\t0\t-0.75\t0\tcam=1',
      'ptz\t0.5\t0\t0\tcam=2',
      'stop\tcam=1\tpantilt=1\tzoom=1',
      'gotopreset\tDoor\t3\tcam=1',
      'gotohome\tcam=1',
      'sethome'
    ]);

    await sleep(40);   // the cached status is now stale, so the driver asks
    var info = await driver.getStatus();
    assert.strictEqual(info.estimated, false);
    assert.strictEqual(info.pan, 0.12);
    assert.strictEqual(info.tilt, -0.75);
    assert.strictEqual(info.panTilt, 'IDLE');
  } finally {
    controller.close();
  }
});

test('PTZDriver with a silent (v1) controller estimates the status', async function () {
  var controller = await fakeController(null);
  var driver = new PTZDriver(driverConfig(controller.port, { PTZEstimateMsPerUnit: 200 }));
  try {
    await waitFor(function () { return controller.received.length >= 1; }, 2000, 'connect');
    assert.strictEqual(driver.rposClient.caps, null);
    assert.strictEqual(driver.statusSource(), 'estimate');
    assert.strictEqual(driver.supportsMoveStatus(), true);
    assert.strictEqual(driver.supportsStatusPosition(), false);
    // v1 behaviour: everything is on offer, but no FOV space
    assert.strictEqual(driver.supportsRelativePTZ, true);
    assert.strictEqual(driver.getFov(), null);
    driver.process_ptz_command('relative-ptz', { pan: 0.5, tilt: 0, zoom: 0, space: 'generic', cameraAddress: 1 });
    assert.strictEqual((await driver.getStatus()).panTilt, 'MOVING');
    await sleep(160);
    var info = await driver.getStatus();
    assert.strictEqual(info.panTilt, 'IDLE');
    assert.strictEqual(info.estimated, true);
    // a v1 controller gets ptz 0 0 0 as the stop
    controller.received.length = 0;
    driver.process_ptz_command('stop', { cameraAddress: 1, zoom: 0, stopZoom: true });
    await waitFor(function () { return controller.received.length >= 1; }, 1000, 'stop');
    assert.deepStrictEqual(controller.received, ['ptz\t0\t0\t0\tcam=1']);
  } finally {
    controller.close();
  }
});

test('PTZDriver statusSource follows PTZStatusMode', function () {
  assert.strictEqual(new PTZDriver(driverConfig(0, { PTZStatusMode: 'off' })).statusSource(), 'none');
  assert.strictEqual(new PTZDriver(driverConfig(0, { PTZStatusMode: 'estimate' })).statusSource(), 'estimate');
  assert.strictEqual(new PTZDriver(driverConfig(0, { PTZStatusMode: 'controller' })).statusSource(), 'controller');
  var other = new PTZDriver({ PTZDriver: 'none', PTZOutput: 'none', Cameras: [{}] });
  assert.strictEqual(other.statusSource(), 'none');
  assert.strictEqual(other.supportsMoveStatus(), false);
});

// ---------- the ONVIF PTZ service handlers ----------

function makeService(driverExtra) {
  var driver = new PTZDriver(driverConfig(0, driverExtra));
  var calls = [];
  var config = driverConfig(0);
  var profiles = [];
  var service = new PTZService(config, http.createServer(), function (command, data) { calls.push([command, data]); }, driver, profiles);
  profiles.push({ attributes: { token: 'profile_1' }, PTZConfiguration: service.ptzConfigurationsArray[0] });
  profiles.push({ attributes: { token: 'profile_2' }, PTZConfiguration: service.ptzConfigurationsArray[1] });
  profiles.push({ attributes: { token: 'profile_noptz' } });
  var port = service.ptz_service.PTZService.PTZ;
  return { driver: driver, service: service, calls: calls, port: port };
}

function faultOf(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected a fault');
}

function subcodes(fault) {
  var sub = fault.Fault.Code.Subcode;
  return [sub.Value, sub.Subcode && sub.Subcode.Value];
}

test('PTZService nodes: no FOV space before caps, FOV space and ranges after', function () {
  var t = makeService();
  var before = t.port.GetNodes({}).PTZNode[0].SupportedPTZSpaces;
  assert.deepStrictEqual(before.RelativePanTiltTranslationSpace.map(function (x) { return x.URI; }),
    ['http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace']);
  t.driver.rposClient.handleLine(CAPS_LINE.trim());
  var nodes = t.port.GetNodes({}).PTZNode;
  assert.strictEqual(nodes.length, 2);
  var spaces = nodes[0].SupportedPTZSpaces;
  assert.deepStrictEqual(spaces.RelativePanTiltTranslationSpace.map(function (x) { return x.URI; }), [
    'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace',
    'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov'
  ]);
  assert.deepStrictEqual(spaces.AbsolutePanTiltPositionSpace[0].XRange, { Min: -1, Max: 1 });
  assert.deepStrictEqual(spaces.AbsolutePanTiltPositionSpace[0].YRange, { Min: -1, Max: 0 });
  assert.strictEqual(spaces.RelativeZoomTranslationSpace, undefined, 'no zoom without zoom hardware');
  assert.strictEqual(spaces.ContinuousZoomVelocitySpace, undefined);
  assert.strictEqual(nodes[0].attributes.FixedHomePosition, true);
  assert.strictEqual(nodes[0].MaximumNumberOfPresets, 64);
  // lookups by token
  assert.strictEqual(t.port.GetNode({ NodeToken: 'ptz_node_token_02' }).PTZNode.attributes.token, 'ptz_node_token_02');
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.GetNode({ NodeToken: 'nope' }); })), ['ter:InvalidArgVal', 'ter:NoEntity']);
  assert.strictEqual(t.port.GetConfiguration({ PTZConfigurationToken: 'ptz_config_token_02' }).PTZConfiguration.NodeToken, 'ptz_node_token_02');
  var options = t.port.GetConfigurationOptions({ ConfigurationToken: 'ptz_config_token_01' });
  assert.ok(options.PTZConfigurationOptions.Spaces.RelativePanTiltTranslationSpace.length === 2);
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.GetConfigurationOptions({ ConfigurationToken: 'x' }); })), ['ter:InvalidArgVal', 'ter:NoEntity']);
});

test('PTZService: FOV space comes from the config when the controller sends none', function () {
  var t = makeService({ PTZHorizontalFOV: 66, PTZVerticalFOV: 41 });
  var uris = t.port.GetNodes({}).PTZNode[0].SupportedPTZSpaces.RelativePanTiltTranslationSpace.map(function (x) { return x.URI; });
  assert.strictEqual(uris.length, 2);
});

test('PTZService: service capabilities follow the controller', function () {
  var t = makeService();
  var a = t.port.GetServiceCapabilities({}).Capabilities.attributes;
  assert.strictEqual(a.MoveStatus, true, 'estimated');
  assert.strictEqual(a.StatusPosition, false);
  t.driver.rposClient.handleLine(CAPS_LINE.trim());
  a = t.port.GetServiceCapabilities({}).Capabilities.attributes;
  assert.strictEqual(a.MoveStatus, true);
  assert.strictEqual(a.StatusPosition, true);
  var none = makeService({ PTZStatusMode: 'off' });
  assert.strictEqual(none.port.GetServiceCapabilities({}).Capabilities.attributes.MoveStatus, false);
});

test('PTZService.RelativeMove: spaces, speeds, faults', function () {
  var t = makeService();
  t.driver.rposClient.handleLine(CAPS_LINE.trim());
  var fov = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov';
  t.port.RelativeMove({ ProfileToken: 'profile_1',
    Translation: { PanTilt: { attributes: { x: '0.25', y: '-0.1', space: fov } } },
    Speed: { PanTilt: { attributes: { x: '0.5', y: '0.4' } } } });
  var last = t.calls[t.calls.length - 1];
  assert.strictEqual(last[0], 'relative-ptz');
  assert.deepStrictEqual(last[1], { pan: 0.25, tilt: -0.1, zoom: 0, space: 'fov', panSpeed: 0.5, tiltSpeed: 0.4, cameraAddress: 1 });
  // no space, and the second camera
  t.port.RelativeMove({ ProfileToken: 'profile_2', Translation: { PanTilt: { attributes: { x: 0.1, y: 0 } } } });
  last = t.calls[t.calls.length - 1];
  assert.strictEqual(last[1].space, 'generic');
  assert.strictEqual(last[1].cameraAddress, 2);
  assert.strictEqual(last[1].panSpeed, undefined);
  // values from an earlier call are not reused
  t.port.RelativeMove({ ProfileToken: 'profile_1', Translation: { PanTilt: { attributes: { x: 0, y: 0.2 } } } });
  assert.strictEqual(t.calls[t.calls.length - 1][1].pan, 0);
  // faults
  assert.deepStrictEqual(subcodes(faultOf(function () {
    t.port.RelativeMove({ ProfileToken: 'profile_1', Translation: { PanTilt: { attributes: { x: 0, y: 0, space: 'urn:other' } } } });
  })), ['ter:InvalidArgVal', 'ter:SpaceNotSupported']);
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.RelativeMove({ ProfileToken: 'profile_1' }); })), ['ter:InvalidArgVal', 'ter:InvalidArgs']);
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.RelativeMove({ ProfileToken: 'nope', Translation: { PanTilt: { attributes: { x: 0, y: 0 } } } }); })), ['ter:InvalidArgVal', 'ter:NoProfile']);
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.RelativeMove({ ProfileToken: 'profile_noptz', Translation: { PanTilt: { attributes: { x: 0, y: 0 } } } }); })), ['ter:InvalidArgVal', 'ter:NoConfig']);
});

test('PTZService: FOV space is rejected while the field of view is unknown', function () {
  var t = makeService();
  var fault = faultOf(function () {
    t.port.RelativeMove({ ProfileToken: 'profile_1',
      Translation: { PanTilt: { attributes: { x: 0, y: 0, space: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov' } } } });
  });
  assert.deepStrictEqual(subcodes(fault), ['ter:InvalidArgVal', 'ter:SpaceNotSupported']);
});

test('PTZService.AbsoluteMove: position and speed', function () {
  var t = makeService();
  t.port.AbsoluteMove({ ProfileToken: 'profile_2', Position: { PanTilt: { attributes: { x: '0.5', y: '-0.5' } } }, Speed: { PanTilt: { attributes: { x: 2, y: -0.25 } } } });
  var last = t.calls[t.calls.length - 1];
  assert.deepStrictEqual(last[1], { pan: 0.5, tilt: -0.5, zoom: 0, panSpeed: 1, tiltSpeed: 0.25, cameraAddress: 2 });
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.AbsoluteMove({ ProfileToken: 'profile_1', Position: {} }); })), ['ter:InvalidArgVal', 'ter:InvalidArgs']);
});

test('PTZService.ContinuousMove keeps values per camera and honours Timeout', async function () {
  var t = makeService();
  t.port.ContinuousMove({ ProfileToken: 'profile_1', Velocity: { PanTilt: { attributes: { x: 0.5, y: -0.5 } } } });
  t.port.ContinuousMove({ ProfileToken: 'profile_1', Velocity: { Zoom: { attributes: { x: 1 } } } });
  var last = t.calls[t.calls.length - 1][1];
  assert.deepStrictEqual([last.pan, last.tilt, last.zoom], [0.5, -0.5, 1], 'pan/tilt kept when only zoom is sent');
  t.port.ContinuousMove({ ProfileToken: 'profile_2', Velocity: { PanTilt: { attributes: { x: 0.1, y: 0 } } } });
  last = t.calls[t.calls.length - 1][1];
  assert.deepStrictEqual([last.pan, last.tilt, last.zoom, last.cameraAddress], [0.1, 0, 0, 2], 'camera 2 does not inherit camera 1');
  // a relative move cancels the velocity kept for the camera
  t.port.RelativeMove({ ProfileToken: 'profile_1', Translation: { PanTilt: { attributes: { x: 0.1, y: 0 } } } });
  t.port.ContinuousMove({ ProfileToken: 'profile_1', Velocity: { Zoom: { attributes: { x: 0 } } } });
  last = t.calls[t.calls.length - 1][1];
  assert.deepStrictEqual([last.pan, last.tilt], [0, 0]);
  // Timeout
  var before = t.calls.length;
  t.port.ContinuousMove({ ProfileToken: 'profile_1', Velocity: { PanTilt: { attributes: { x: 1, y: 0 } } }, Timeout: 'PT0.1S' });
  assert.strictEqual(t.calls.length, before + 1);
  await sleep(180);
  assert.strictEqual(t.calls.length, before + 2);
  assert.strictEqual(t.calls[t.calls.length - 1][0], 'stop');
  // a Stop before the timeout cancels the timer
  t.port.ContinuousMove({ ProfileToken: 'profile_1', Velocity: { PanTilt: { attributes: { x: 1, y: 0 } } }, Timeout: 'PT0.1S' });
  t.port.Stop({ ProfileToken: 'profile_1', PanTilt: true, Zoom: true });
  var count = t.calls.length;
  await sleep(180);
  assert.strictEqual(t.calls.length, count, 'no second stop');
});

test('PTZService.Stop: flags, and a missing flag means stop', function () {
  var t = makeService();
  t.port.ContinuousMove({ ProfileToken: 'profile_1', Velocity: { PanTilt: { attributes: { x: 0.5, y: 0.5 } }, Zoom: { attributes: { x: 1 } } } });
  t.port.Stop({ ProfileToken: 'profile_1', PanTilt: false, Zoom: true });
  var last = t.calls[t.calls.length - 1];
  assert.strictEqual(last[0], 'ptz');
  assert.deepStrictEqual([last[1].pan, last[1].tilt, last[1].zoom], [0.5, 0.5, 0], 'only zoom stopped');
  t.port.Stop({ ProfileToken: 'profile_1' });
  last = t.calls[t.calls.length - 1];
  assert.strictEqual(last[0], 'stop');
  assert.strictEqual(last[1].cameraAddress, 1);
  t.port.Stop({ ProfileToken: 'profile_1', PanTilt: 'true' });
  assert.strictEqual(t.calls[t.calls.length - 1][0], 'stop');
});

test('PTZService.GetStatus answers from the controller', async function () {
  var t = makeService();
  t.driver.rposClient.handleLine(CAPS_LINE.trim());
  t.driver.rposClient.handleLine('status\tpan=0.25\ttilt=-0.5\tzoom=0\tpantilt=MOVING');
  var reply = await new Promise(function (resolve) { t.port.GetStatus({ ProfileToken: 'profile_1' }, resolve); });
  var s = reply.PTZStatus;
  assert.deepStrictEqual(Object.keys(s), ['Position', 'MoveStatus', 'UtcTime'], 'schema order');
  assert.strictEqual(s.Position.PanTilt.attributes.x, 0.25);
  assert.strictEqual(s.Position.PanTilt.attributes.y, -0.5);
  assert.ok(/PositionGenericSpace$/.test(s.Position.PanTilt.attributes.space));
  assert.strictEqual(s.Position.Zoom, undefined);
  assert.strictEqual(s.MoveStatus.PanTilt, 'MOVING');
  assert.strictEqual(s.MoveStatus.Zoom, undefined);
  assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s.UtcTime));
  assert.deepStrictEqual(subcodes(faultOf(function () { t.port.GetStatus({ ProfileToken: 'nope' }, function () { }); })), ['ter:InvalidArgVal', 'ter:NoProfile']);
  // no status support: only the time, as before
  var none = makeService({ PTZStatusMode: 'off' });
  var plain = await new Promise(function (resolve) { none.port.GetStatus({ ProfileToken: 'profile_1' }, resolve); });
  assert.deepStrictEqual(Object.keys(plain.PTZStatus), ['UtcTime']);
});

test('PTZService presets follow the controller and respect its size', function () {
  var t = makeService();
  var service = t.service;
  t.driver.rposClient.handleLine(CAPS_LINE.trim());   // 64 presets
  var names = function () { return t.port.GetPresets({ ProfileToken: 'profile_1' }).Preset.map(function (p) { return p.attributes.token + ':' + p.Name; }); };
  assert.deepStrictEqual(names(), []);
  // the controller holds presets rpos does not know
  t.driver.events.emit('presets', ['2', '5']);
  assert.deepStrictEqual(names(), ['2:Preset 2', '5:Preset 5']);
  // a new preset takes the first free slot
  var created = t.port.SetPreset({ ProfileToken: 'profile_1', PresetName: 'Door' });
  assert.strictEqual(created.PresetToken, '1');
  // renaming works
  t.port.SetPreset({ ProfileToken: 'profile_1', PresetToken: '2', PresetName: 'Gate' });
  assert.deepStrictEqual(names(), ['1:Door', '2:Gate', '5:Preset 5']);
  // the controller lost its flash: only preset 1 is left
  t.driver.events.emit('presets', ['1']);
  assert.deepStrictEqual(names(), ['1:Door']);
  // no slot beyond what the controller holds
  for (var i = 0; i < 70; i++) {
    try { t.port.SetPreset({ ProfileToken: 'profile_1', PresetName: 'p' + i }); } catch (e) {
      assert.deepStrictEqual(subcodes(e), ['ter:InvalidArgVal', 'ter:TooManyPresets']);
      break;
    }
  }
  var tokens = t.port.GetPresets({ ProfileToken: 'profile_1' }).Preset.map(function (p) { return Number(p.attributes.token); });
  assert.strictEqual(tokens.length, 64);
  assert.ok(Math.max.apply(null, tokens) <= 64);
  // the other camera is not affected by the mirror of the first one: it has its own list but is also reconciled
  assert.ok(service.presetArray.length > 0);
});

test('parseDurationMs', function () {
  assert.strictEqual(PTZService.parseDurationMs('PT5S'), 5000);
  assert.strictEqual(PTZService.parseDurationMs('PT0.5S'), 500);
  assert.strictEqual(PTZService.parseDurationMs('PT1M30S'), 90000);
  assert.strictEqual(PTZService.parseDurationMs('PT0S'), 0);
  assert.strictEqual(PTZService.parseDurationMs('junk'), 0);
  assert.strictEqual(PTZService.parseDurationMs(undefined), 0);
});

// ---------- run ----------

(async function () {
  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log('ok     ' + tests[i].name);
    } catch (err) {
      failed++;
      console.log('FAILED ' + tests[i].name + '\n       ' + (err && err.stack || err).toString().split('\n').slice(0, 6).join('\n       '));
    }
  }
  console.log('\n' + (tests.length - failed) + ' of ' + tests.length + ' passed');
  process.chdir(root);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();

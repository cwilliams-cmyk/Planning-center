'use strict';

/**
 * Black-box integration tests: the real server is spawned as a child
 * process (ephemeral HTTP port, isolated config file) and a mock VISCA
 * camera listens on 127.0.0.1:52381 counting every control packet, so the
 * tests verify actual network behavior: mode enforcement, connection
 * states, command coalescing under rapid input, and the motion watchdog.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Mock Astra camera (Sony framing on 52381) -------------------------------

function startMockCamera() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const received = []; // { type, payload: [..bytes] }
    socket.on('message', (msg, rinfo) => {
      let payload = msg;
      let type = null;
      if (msg.length > 8) {
        type = msg.readUInt16BE(0);
        payload = msg.subarray(8);
      }
      received.push({ type, payload: [...payload] });
      // Reply like a camera would (ACK/completion-ish) with Sony framing.
      const reply = Buffer.from([0x90, 0x50, 0xff]);
      const header = Buffer.alloc(8);
      header.writeUInt16BE(0x0111, 0);
      header.writeUInt16BE(reply.length, 2);
      socket.send(Buffer.concat([header, reply]), rinfo.port, rinfo.address);
    });
    socket.on('error', reject);
    socket.bind(52381, '127.0.0.1', () => resolve({
      socket,
      received,
      close: () => new Promise((r) => socket.close(r)),
    }));
  });
}

const isPanTiltDrive = (p) => p.payload[1] === 0x01 && p.payload[2] === 0x06 && p.payload[3] === 0x01;
const isPanTiltStop = (p) => isPanTiltDrive(p) && p.payload[6] === 0x03 && p.payload[7] === 0x03;
const isMove = (p) => isPanTiltDrive(p) && !isPanTiltStop(p);
const isFreeze = (p, on) =>
  p.payload[1] === 0x01 && p.payload[2] === 0x04 && p.payload[3] === 0x62 && p.payload[4] === (on ? 0x02 : 0x03);
const isInquiry = (p) => p.type === 0x0110;
const isTracking = (p, on) =>
  p.payload[1] === 0x0a && p.payload[2] === 0x11 && p.payload[3] === 0x54 && p.payload[4] === (on ? 0x02 : 0x03);
const isPresetRecall = (p, slot) =>
  p.payload[1] === 0x01 && p.payload[2] === 0x04 && p.payload[3] === 0x3f && p.payload[4] === 0x02 &&
  (slot === undefined || p.payload[5] === slot);

// ---- App child process --------------------------------------------------------

function startApp(configPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER, '--port', '0', '--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PTZ_UNFREEZE_MS: '400' }, // shorten freeze-on-recall timers for tests
    });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = /running at\s+http:\/\/localhost:(\d+)/.exec(out);
      if (m) {
        proc.stdout.off('data', onData);
        resolve({ proc, base: `http://localhost:${m[1]}` });
      }
    };
    proc.stdout.on('data', onData);
    proc.on('error', reject);
    proc.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000).unref();
  });
}

async function req(base, method, apiPath, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitFor(fn, timeoutMs = 5000, everyMs = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await tick(everyMs);
  }
}

// ---- The suite ----------------------------------------------------------------

test('integration: modes, connection states, coalescing, watchdog', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orz-test-'));
  const configPath = path.join(dir, 'cameras.json');
  const mock = await startMockCamera();
  const { proc, base } = await startApp(configPath);
  t.after(() => { proc.kill('SIGKILL'); return mock.close(); });

  await t.test('starts in Live Control mode with structural changes blocked', async () => {
    const list = await req(base, 'GET', '/api/cameras');
    assert.equal(list.data.mode, 'live');

    const add = await req(base, 'POST', '/api/cameras', { ip: '127.0.0.1' });
    assert.equal(add.status, 409);

    const scan = await req(base, 'POST', '/api/scan', {});
    assert.equal(scan.status, 409);
    assert.match(scan.data.error, /Network scan disabled in Live Control mode/);
  });

  await t.test('setup mode allows validated camera management', async () => {
    const m = await req(base, 'POST', '/api/mode', { mode: 'setup' });
    assert.equal(m.data.mode, 'setup');

    assert.equal((await req(base, 'POST', '/api/cameras', { ip: 'not-an-ip' })).status, 400);
    assert.equal((await req(base, 'POST', '/api/cameras', { ip: '192.168.1.999' })).status, 400);
    assert.equal((await req(base, 'POST', '/api/cameras', { ip: '127.0.0.1', port: 99999 })).status, 400);
    assert.equal((await req(base, 'POST', '/api/cameras', { ip: '127.0.0.1', rtsp: 'http://nope' })).status, 400);

    const add = await req(base, 'POST', '/api/cameras', { ip: '127.0.0.1', name: 'Mock Cam' });
    assert.equal(add.status, 200);

    // duplicate add updates rather than duplicating
    const dup = await req(base, 'POST', '/api/cameras', { ip: '127.0.0.1' });
    assert.equal(dup.data.existed, true);
    const list = await req(base, 'GET', '/api/cameras');
    assert.equal(list.data.cameras.length, 1);
  });

  await t.test('camera answering VISCA becomes connected', async () => {
    await waitFor(async () => {
      const { data } = await req(base, 'GET', '/api/cameras');
      return data.cameras[0].state === 'connected';
    });
  });

  await t.test('an unreachable camera stays non-connected and does not affect others', async () => {
    await req(base, 'POST', '/api/cameras', { ip: '127.0.0.99', name: 'Ghost' });
    await tick(1200);
    const { data } = await req(base, 'GET', '/api/cameras');
    const ghost = data.cameras.find((c) => c.ip === '127.0.0.99');
    const real = data.cameras.find((c) => c.ip === '127.0.0.1');
    assert.notEqual(ghost.state, 'connected');
    assert.equal(real.state, 'connected');

    // The healthy camera is still instantly controllable.
    const move = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'move', dir: 'up' });
    assert.equal(move.status, 200);
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'stop' });
    await req(base, 'DELETE', '/api/cameras/127.0.0.99');
  });

  await t.test('rapid joystick input is coalesced and rate-limited on the wire', async () => {
    const before = mock.received.length;
    // 20 rapid direction changes inside ~100ms (a panicking operator).
    const dirs = ['up', 'down', 'left', 'right'];
    for (let i = 0; i < 20; i++) {
      await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'move', dir: dirs[i % 4] });
    }
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'stop' });
    await tick(600);
    const during = mock.received.slice(before);
    const moves = during.filter(isMove);
    assert.ok(moves.length <= 8, `expected coalescing, saw ${moves.length} move packets for 20 inputs`);
    assert.ok(during.some(isPanTiltStop), 'stop must reach the camera');
    // The last drive-related packet on the wire must be a stop, never a move.
    const drives = during.filter(isPanTiltDrive);
    assert.ok(isPanTiltStop(drives[drives.length - 1]), 'no movement may follow the stop');
  });

  await t.test('motion watchdog stops the camera when keepalives cease', async () => {
    const before = mock.received.length;
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'move', dir: 'left' });
    // No keepalive, no stop: the server must stop the camera by itself.
    await tick(2200);
    const during = mock.received.slice(before);
    assert.ok(during.some(isPanTiltStop), 'watchdog did not send a stop');
  });

  await t.test('preset save is blocked in Live mode, allowed in Setup', async () => {
    await req(base, 'POST', '/api/mode', { mode: 'live' });
    const blocked = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'preset', mode: 'set', slot: 1 });
    assert.equal(blocked.status, 409);
    const recall = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'preset', mode: 'recall', slot: 1 });
    assert.equal(recall.status, 200);

    await req(base, 'POST', '/api/mode', { mode: 'setup' });
    const set = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'preset', mode: 'set', slot: 1 });
    assert.equal(set.status, 200);
    const named = await req(base, 'PUT', '/api/cameras/127.0.0.1/presets/1', { name: 'Wide Stage' });
    assert.equal(named.data.presets['1'].name, 'Wide Stage');
  });

  await t.test('image freeze on recall: freeze, recall, redundant unfreeze', async () => {
    // still in setup mode from the previous subtest
    await req(base, 'PATCH', '/api/cameras/127.0.0.1', { freezeOnRecall: true });
    const before = mock.received.length;
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'preset', mode: 'recall', slot: 1 });
    await tick(1200); // unfreeze timers run at 400/800ms in tests
    const during = mock.received.slice(before);
    const freezeIdx = during.findIndex((p) => isFreeze(p, true));
    const recallIdx = during.findIndex((p) => p.payload[3] === 0x3f && p.payload[4] === 0x02);
    const unfreezes = during.filter((p) => isFreeze(p, false));
    assert.ok(freezeIdx >= 0, 'freeze must be sent');
    assert.ok(recallIdx > freezeIdx, 'freeze must precede the recall');
    assert.ok(unfreezes.length >= 2, `unfreeze must be sent redundantly (saw ${unfreezes.length})`);
    await req(base, 'PATCH', '/api/cameras/127.0.0.1', { freezeOnRecall: false });
  });

  await t.test('preset display order: validated, persisted, layout-only', async () => {
    const bad = await req(base, 'PUT', '/api/cameras/127.0.0.1/preset-order', { order: [1, 1, 2, 3, 4, 5, 6, 7, 8] });
    assert.equal(bad.status, 400);
    const good = await req(base, 'PUT', '/api/cameras/127.0.0.1/preset-order', { order: [9, 8, 7, 6, 5, 4, 3, 2, 1] });
    assert.equal(good.status, 200);
    const { data } = await req(base, 'GET', '/api/cameras');
    assert.deepEqual(data.cameras.find((c) => c.ip === '127.0.0.1').presetOrder, [9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await req(base, 'PUT', '/api/cameras/127.0.0.1/preset-order', { order: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  });

  await t.test('disabled camera: no commands, no probes; enable restores', async () => {
    const dis = await req(base, 'POST', '/api/cameras/127.0.0.1/disable', { disabled: true });
    assert.equal(dis.status, 200);
    let list = await req(base, 'GET', '/api/cameras');
    assert.equal(list.data.cameras[0].state, 'disabled');

    const move = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'move', dir: 'up' });
    assert.equal(move.status, 409);
    assert.match(move.data.error, /disabled/i);

    // No probes while disabled: the wire must stay quiet.
    const before = mock.received.length;
    await tick(1500);
    const inquiries = mock.received.slice(before).filter(isInquiry);
    assert.equal(inquiries.length, 0, 'disabled camera must not be probed');

    await req(base, 'POST', '/api/cameras/127.0.0.1/disable', { disabled: false });
    await waitFor(async () => {
      const r = await req(base, 'GET', '/api/cameras');
      return r.data.cameras[0].state === 'connected';
    });
  });

  await t.test('AI tracking: on/off commands, manual pan/tilt lockout, dual method', async () => {
    // Turn tracking on (default extended-VISCA method).
    let before = mock.received.length;
    const on = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'tracking', on: true });
    assert.equal(on.status, 200);
    await tick(200);
    assert.ok(mock.received.slice(before).some((p) => isTracking(p, true)), 'tracking-on bytes must reach the camera');
    let list = await req(base, 'GET', '/api/cameras');
    assert.equal(list.data.cameras.find((c) => c.ip === '127.0.0.1').tracking, true);

    // Manual pan/tilt and home are honestly rejected while tracking.
    const move = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'move', dir: 'up' });
    assert.equal(move.status, 409);
    assert.match(move.data.error, /AI Tracking is active/);
    const home = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'home' });
    assert.equal(home.status, 409);
    // Zoom and preset recall remain available.
    assert.equal((await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'zoom', dir: 'tele' })).status, 200);
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'zoom', dir: 'stop' });

    // Tracking cannot be broadcast to all cameras.
    const all = await req(base, 'POST', '/api/all/ptz', { action: 'tracking', on: true });
    assert.equal(all.status, 409);

    // Turn tracking off -> manual control restored.
    before = mock.received.length;
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'tracking', on: false });
    await tick(300);
    assert.ok(mock.received.slice(before).some((p) => isTracking(p, false)), 'tracking-off bytes must reach the camera');
    const move2 = await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'move', dir: 'up' });
    assert.equal(move2.status, 200);
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'stop' });

    // Alternate method: recall preset 80 (on) / 81 (off) - standard VISCA.
    assert.equal(
      (await req(base, 'PATCH', '/api/cameras/127.0.0.1', { trackingMethod: 'bogus' })).status, 400);
    await req(base, 'PATCH', '/api/cameras/127.0.0.1', { trackingMethod: 'preset' });
    before = mock.received.length;
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'tracking', on: true });
    await req(base, 'POST', '/api/camera/127.0.0.1/ptz', { action: 'tracking', on: false });
    await tick(300);
    const during = mock.received.slice(before);
    assert.ok(during.some((p) => isPresetRecall(p, 80)), 'preset-method on must recall preset 80');
    assert.ok(during.some((p) => isPresetRecall(p, 81)), 'preset-method off must recall preset 81');
    await req(base, 'PATCH', '/api/cameras/127.0.0.1', { trackingMethod: 'visca' });
  });

  await t.test('manual retry probes immediately and works in Live mode', async () => {
    await req(base, 'POST', '/api/mode', { mode: 'live' });
    const before = mock.received.length;
    const r = await req(base, 'POST', '/api/cameras/127.0.0.1/retry', {});
    assert.equal(r.status, 200);
    await tick(300);
    const inquiries = mock.received.slice(before).filter(isInquiry);
    assert.ok(inquiries.length >= 1, 'retry must trigger an immediate probe');
    await req(base, 'POST', '/api/mode', { mode: 'setup' });
  });

  await t.test('all-stop endpoint works and diagnostics are exposed', async () => {
    assert.equal((await req(base, 'POST', '/api/all/stop', {})).status, 200);
    const diag = await req(base, 'GET', '/api/diagnostics');
    assert.ok(diag.data.version);
    assert.ok(Array.isArray(diag.data.log) && diag.data.log.length > 0);
    assert.match(diag.data.text, /PTZ Control/);
    assert.ok(diag.data.cameras.every((c) => typeof c.nextStep === 'string' && c.nextStep.length > 0),
      'each camera needs a recommended next action');
    assert.ok(!/password|token/i.test(diag.data.text), 'diagnostics must not leak secrets');
  });

  await t.test('config persists across an app restart (camera + preset name)', async () => {
    await tick(400); // let the debounced save flush
    proc.kill('SIGKILL');
    await tick(200);
    const second = await startApp(configPath);
    try {
      const { data } = await req(second.base, 'GET', '/api/cameras');
      const cam = data.cameras.find((c) => c.ip === '127.0.0.1');
      assert.ok(cam, 'saved camera must survive restart');
      assert.equal(cam.name, 'Mock Cam');
      assert.equal(cam.presets['1'].name, 'Wide Stage');
      assert.equal(data.mode, 'live', 'app must always restart in Live Control mode');
    } finally {
      second.proc.kill('SIGKILL');
    }
  });
});

test('integration: corrupt config is backed up, not silently lost', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orz-corrupt-'));
  const configPath = path.join(dir, 'cameras.json');
  fs.writeFileSync(configPath, '{ this is not json !!!');
  const { proc, base } = await startApp(configPath);
  try {
    const { data } = await req(base, 'GET', '/api/cameras');
    assert.deepEqual(data.cameras, []);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.equal(backups.length, 1, 'corrupt config must be preserved for recovery');
  } finally {
    proc.kill('SIGKILL');
  }
});

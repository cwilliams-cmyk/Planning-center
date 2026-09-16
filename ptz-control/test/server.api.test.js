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

// ---- App child process --------------------------------------------------------

function startApp(configPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER, '--port', '0', '--config', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
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

  await t.test('all-stop endpoint works and diagnostics are exposed', async () => {
    assert.equal((await req(base, 'POST', '/api/all/stop', {})).status, 200);
    const diag = await req(base, 'GET', '/api/diagnostics');
    assert.ok(diag.data.version);
    assert.ok(Array.isArray(diag.data.log) && diag.data.log.length > 0);
    assert.match(diag.data.text, /OrZ Control/);
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

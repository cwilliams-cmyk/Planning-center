'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HealthMonitor, MAX_BACKOFF_MS } = require('../lib/health');

function makeMonitor(opts = {}) {
  const inquiries = [];
  const transitions = [];
  const mon = new HealthMonitor((camera) => inquiries.push(camera.ip), {
    baseMs: 1000,
    liveBaseMs: 2000,
    onTransition: (ip, state, prev) => transitions.push({ ip, state, prev }),
    ...opts,
  });
  return { mon, inquiries, transitions };
}

const CAM = { ip: '10.0.0.5', name: 'Test', protocol: 'sony' };

test('new camera starts in connecting and probes send inquiries', () => {
  const { mon, inquiries } = makeMonitor();
  mon.add(CAM);
  assert.equal(mon.status(CAM.ip).state, 'connecting');
  mon.probe(CAM.ip, 1000);
  assert.equal(inquiries.length, 1);
  assert.equal(mon.status(CAM.ip).state, 'connecting');
  mon.stopAll();
});

test('reply transitions to connected; misses degrade then go offline', () => {
  const { mon, transitions } = makeMonitor();
  mon.add(CAM);
  let t = 1000;
  mon.probe(CAM.ip, t);
  mon.noteReply(CAM.ip, (t += 100));
  assert.equal(mon.status(CAM.ip).state, 'connected');

  // three unanswered probes: connected -> degraded -> degraded -> offline
  mon.probe(CAM.ip, (t += 1000)); // accounts nothing (last reply after last probe)
  mon.probe(CAM.ip, (t += 1000)); // miss 1
  assert.equal(mon.status(CAM.ip).state, 'degraded');
  mon.probe(CAM.ip, (t += 1000)); // miss 2
  assert.equal(mon.status(CAM.ip).state, 'degraded');
  mon.probe(CAM.ip, (t += 1000)); // miss 3
  assert.equal(mon.status(CAM.ip).state, 'offline');

  const seq = transitions.map((x) => x.state);
  assert.deepEqual(seq, ['connected', 'degraded', 'offline']);
  mon.stopAll();
});

test('offline probes back off exponentially with jitter, capped', () => {
  const { mon } = makeMonitor();
  mon.add(CAM);
  let t = 1000;
  // Drive to offline.
  for (let i = 0; i < 4; i++) mon.probe(CAM.ip, (t += 1000));
  assert.equal(mon.status(CAM.ip).state, 'offline');

  const delays = [];
  for (let i = 0; i < 8; i++) delays.push(mon.probe(CAM.ip, (t += 60000)));

  // Backoff doubles per offline probe (2s was consumed by the probe that
  // transitioned to offline): 4s, 8s, ... capped at 60s, +/-20% jitter.
  assert.ok(delays[0] >= 4000 * 0.8 && delays[0] <= 4000 * 1.2, `first backoff ${delays[0]}`);
  assert.ok(delays[1] >= 8000 * 0.8 && delays[1] <= 8000 * 1.2, `second backoff ${delays[1]}`);
  const last = delays[delays.length - 1];
  assert.ok(last <= MAX_BACKOFF_MS * 1.2, `backoff must cap (got ${last})`);
  assert.ok(last >= MAX_BACKOFF_MS * 0.8, `backoff should reach the cap (got ${last})`);
  mon.stopAll();
});

test('a single reply recovers an offline camera and resets backoff', () => {
  const { mon, transitions } = makeMonitor();
  mon.add(CAM);
  let t = 1000;
  for (let i = 0; i < 4; i++) mon.probe(CAM.ip, (t += 1000));
  assert.equal(mon.status(CAM.ip).state, 'offline');

  mon.noteReply(CAM.ip, (t += 500));
  assert.equal(mon.status(CAM.ip).state, 'connected');
  const next = mon.probe(CAM.ip, (t += 1000));
  assert.ok(next >= 1000 * 0.8 && next <= 1000 * 1.2, 'probe interval must reset after recovery');
  assert.equal(transitions[transitions.length - 1].state, 'connected');
  mon.stopAll();
});

test('live mode uses the slower probe interval', () => {
  const { mon } = makeMonitor();
  mon.add(CAM);
  mon.noteReply(CAM.ip, 900);
  mon.setLiveMode(true);
  const delay = mon.probe(CAM.ip, 1000);
  assert.ok(delay >= 2000 * 0.8 && delay <= 2000 * 1.2, `live interval ${delay}`);
  mon.setLiveMode(false);
  const delay2 = mon.probe(CAM.ip, 1000);
  assert.ok(delay2 >= 1000 * 0.8 && delay2 <= 1000 * 1.2, `setup interval ${delay2}`);
  mon.stopAll();
});

test('per-camera independence: one offline camera does not affect another', () => {
  const { mon } = makeMonitor();
  const camA = { ip: '10.0.0.5' };
  const camB = { ip: '10.0.0.6' };
  mon.add(camA);
  mon.add(camB);
  let t = 1000;
  for (let i = 0; i < 4; i++) {
    mon.probe(camA.ip, (t += 1000));
    mon.probe(camB.ip, t);
    mon.noteReply(camB.ip, t + 10);
  }
  assert.equal(mon.status(camA.ip).state, 'offline');
  assert.equal(mon.status(camB.ip).state, 'connected');
  mon.stopAll();
});

test('suspend stops inquiries; resume revalidates without counting sleep as misses', () => {
  const { mon, inquiries } = makeMonitor();
  mon.add(CAM);
  mon.noteReply(CAM.ip, 900);
  mon.suspend();
  const before = inquiries.length;
  mon.probe(CAM.ip, 100000); // during sleep no packet should go out
  assert.equal(inquiries.length, before);
  mon.resume();
  assert.equal(mon.status(CAM.ip).misses, 0);
  assert.equal(mon.status(CAM.ip).state, 'connected');
  mon.stopAll();
});

test('removed camera is forgotten', () => {
  const { mon } = makeMonitor();
  mon.add(CAM);
  mon.remove(CAM.ip);
  assert.equal(mon.probe(CAM.ip), null);
  mon.stopAll();
});

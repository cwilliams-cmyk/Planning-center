'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CameraQueue, MotionGuard, KIND } = require('../lib/queue');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('rate-limits sends to the minimum interval', async () => {
  const sent = [];
  const q = new CameraQueue((p) => sent.push({ p, t: Date.now() }), { minIntervalMs: 50 });
  q.push(Buffer.from([1]), KIND.ONESHOT);
  q.push(Buffer.from([2]), KIND.ONESHOT);
  q.push(Buffer.from([3]), KIND.ONESHOT);
  await tick(200);
  assert.equal(sent.length, 3);
  assert.ok(sent[1].t - sent[0].t >= 45, 'second send too soon');
  assert.ok(sent[2].t - sent[1].t >= 45, 'third send too soon');
  q.close();
});

test('coalesces movement: newest move replaces queued move', async () => {
  const sent = [];
  const q = new CameraQueue((p) => sent.push(p[0]), { minIntervalMs: 40 });
  q.push(Buffer.from([10]), KIND.MOVE); // sends promptly
  await tick(10);
  // These arrive faster than the rate limit; only the newest should survive.
  q.push(Buffer.from([11]), KIND.MOVE);
  q.push(Buffer.from([12]), KIND.MOVE);
  q.push(Buffer.from([13]), KIND.MOVE);
  await tick(150);
  assert.deepEqual(sent, [10, 13]);
  q.close();
});

test('stop discards queued movement, jumps the queue, and is sent twice', async () => {
  const sent = [];
  const q = new CameraQueue((p) => sent.push(p[0]), { minIntervalMs: 30 });
  q.push(Buffer.from([1]), KIND.MOVE);
  await tick(5);
  q.push(Buffer.from([2]), KIND.MOVE);   // queued
  q.push(Buffer.from([9]), KIND.STOP);   // must kill [2]
  q.push(Buffer.from([3]), KIND.MOVE);   // after the stop
  await tick(250);
  const stops = sent.filter((b) => b === 9).length;
  assert.equal(stops, 2, 'stop must be sent redundantly');
  assert.ok(!sent.includes(2), 'queued move must not outlive a stop');
  assert.ok(sent.indexOf(9) < sent.indexOf(3), 'stop must precede later movement');
  q.close();
});

test('queue never grows unbounded and never drops stops', async () => {
  const sent = [];
  const q = new CameraQueue((p) => sent.push(p[0]), { minIntervalMs: 1000, maxQueue: 5 });
  q.push(Buffer.from([9]), KIND.STOP);
  for (let i = 0; i < 30; i++) q.push(Buffer.from([i]), KIND.ONESHOT);
  assert.ok(q.pending <= 6, `queue grew to ${q.pending}`);
  q.close();
});

test('closed queue ignores pushes', async () => {
  const sent = [];
  const q = new CameraQueue((p) => sent.push(p[0]), { minIntervalMs: 5 });
  q.close();
  q.push(Buffer.from([1]), KIND.MOVE);
  await tick(30);
  assert.equal(sent.length, 0);
});

test('MotionGuard stops a camera when keepalives cease', () => {
  const stopped = [];
  const guard = new MotionGuard((ip) => stopped.push(ip), { timeoutMs: 100, tickMs: 10000 });
  const t0 = Date.now();
  guard.noteMotion('10.0.0.1');
  guard.tick(t0 + 50); // still fresh
  assert.deepEqual(stopped, []);
  guard.tick(t0 + 200); // stale -> stop
  assert.deepEqual(stopped, ['10.0.0.1']);
  guard.tick(t0 + 400); // already stopped; no duplicate
  assert.deepEqual(stopped, ['10.0.0.1']);
});

test('MotionGuard keepalive refresh prevents the stop', () => {
  const stopped = [];
  const guard = new MotionGuard((ip) => stopped.push(ip), { timeoutMs: 100, tickMs: 10000 });
  const t0 = Date.now();
  guard.noteMotion('10.0.0.1');
  guard.moving.set('10.0.0.1', t0 + 80); // keepalive arrived
  guard.tick(t0 + 150);
  assert.deepEqual(stopped, []);
  guard.noteStop('10.0.0.1'); // explicit stop clears tracking
  guard.tick(t0 + 10000);
  assert.deepEqual(stopped, []);
});

test('MotionGuard stopAll halts everything moving', () => {
  const stopped = [];
  const guard = new MotionGuard((ip) => stopped.push(ip), { timeoutMs: 5000, tickMs: 10000 });
  guard.noteMotion('a');
  guard.noteMotion('b');
  guard.stopAll();
  assert.deepEqual(stopped.sort(), ['a', 'b']);
  assert.equal(guard.moving.size, 0);
});

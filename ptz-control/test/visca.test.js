'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cmd, sonyWrap } = require('../lib/visca');

test('panTilt builds correct drive bytes and clamps speeds', () => {
  const b = cmd.panTilt(12, 10, 0x01, 0x02);
  assert.deepEqual([...b], [0x81, 0x01, 0x06, 0x01, 12, 10, 0x01, 0x02, 0xff]);

  const clamped = cmd.panTilt(99, 99, 0x03, 0x03);
  assert.equal(clamped[4], 0x18); // pan speed max
  assert.equal(clamped[5], 0x14); // tilt speed max

  const low = cmd.panTilt(0, -5, 0x03, 0x03);
  assert.equal(low[4], 0x01);
  assert.equal(low[5], 0x01);
});

test('panTiltStop uses stop direction codes', () => {
  const b = cmd.panTiltStop();
  assert.equal(b[6], 0x03);
  assert.equal(b[7], 0x03);
});

test('zoom encodes tele/wide/stop with speed', () => {
  assert.equal(cmd.zoom('tele', 3)[4], 0x23);
  assert.equal(cmd.zoom('wide', 7)[4], 0x37);
  assert.equal(cmd.zoom('stop', 5)[4], 0x00);
  assert.equal(cmd.zoom('tele', 99)[4], 0x27); // speed clamped to 7
});

test('focus encodes far/near/stop', () => {
  assert.equal(cmd.focus('far', 2)[4], 0x22);
  assert.equal(cmd.focus('near', 2)[4], 0x32);
  assert.equal(cmd.focus('stop', 2)[4], 0x00);
});

test('preset set/recall/reset encode mode and clamp slot', () => {
  assert.deepEqual([...cmd.preset('set', 3)], [0x81, 0x01, 0x04, 0x3f, 0x01, 3, 0xff]);
  assert.equal(cmd.preset('recall', 5)[4], 0x02);
  assert.equal(cmd.preset('reset', 5)[4], 0x00);
  assert.equal(cmd.preset('recall', 500)[5], 127);
});

test('exposure/image commands encode safely and reject unknowns', () => {
  assert.equal(cmd.exposureMode('manual')[4], 0x03);
  assert.equal(cmd.exposureMode('bogus'), null);
  assert.equal(cmd.imageStep('iris', 'up')[3], 0x0b);
  assert.equal(cmd.imageStep('iris', 'up')[4], 0x02);
  assert.equal(cmd.imageStep('iris', 'sideways'), null);
  assert.equal(cmd.imageStep('nope', 'up'), null);
  assert.equal(cmd.whiteBalance('onepush')[4], 0x03);
  assert.equal(cmd.whiteBalance('nope'), null);
});

test('sonyWrap frames payload with type, length, and sequence', () => {
  const payload = cmd.versionInq();
  const framed = sonyWrap(payload, 0x01020304, 0x0110);
  assert.equal(framed.length, 8 + payload.length);
  assert.equal(framed.readUInt16BE(0), 0x0110);
  assert.equal(framed.readUInt16BE(2), payload.length);
  assert.equal(framed.readUInt32BE(4), 0x01020304);
  assert.deepEqual([...framed.subarray(8)], [...payload]);
});

test('safety boundary: no video/network/reboot commands exist', () => {
  // The command module must expose control-safe builders only. If a future
  // change adds e.g. reboot/network/stream commands, this list forces a
  // deliberate review of docs/SAFETY.md first.
  const allowed = new Set([
    'panTilt', 'panTiltStop', 'home', 'zoom', 'focus', 'autoFocus', 'preset',
    'versionInq', 'exposureMode', 'imageStep', 'expCompOn', 'whiteBalance',
    'onePushWBTrigger', 'backlight', 'pictureFreeze', 'tracking',
  ]);
  for (const key of Object.keys(cmd)) {
    assert.ok(allowed.has(key), `unexpected command builder "${key}" - review safety policy before allowing`);
  }
});

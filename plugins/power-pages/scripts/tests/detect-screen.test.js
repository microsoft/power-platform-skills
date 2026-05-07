const assert = require('node:assert/strict');
const test = require('node:test');

const { detectScreenSize, FALLBACK, parseFirstWxH } = require('../lib/detect-screen');

test('parseFirstWxH extracts WxH from common formats', () => {
  assert.deepEqual(parseFirstWxH('1920x1080'), { width: 1920, height: 1080 });
  assert.deepEqual(parseFirstWxH('1920 x 1080'), { width: 1920, height: 1080 });
  assert.deepEqual(parseFirstWxH('Resolution: 2560 x 1440 Retina'), { width: 2560, height: 1440 });
  assert.deepEqual(parseFirstWxH('  3840×2160  '), { width: 3840, height: 2160 });
});

test('parseFirstWxH rejects implausibly small or non-numeric values', () => {
  assert.equal(parseFirstWxH(''), null);
  assert.equal(parseFirstWxH('640x100'), null); // height < 480
  assert.equal(parseFirstWxH('100x600'), null); // width < 640
  assert.equal(parseFirstWxH('no dimensions here'), null);
});

test('detectScreenSize falls back when platform is unknown', () => {
  const result = detectScreenSize({ platform: 'aix' });
  assert.deepEqual(result, FALLBACK);
});

test('detectScreenSize returns plausible dimensions for the current platform', () => {
  // On the host running the tests, detection may succeed or fall back.
  // Either way the shape should be correct and dimensions plausible.
  const result = detectScreenSize();
  assert.equal(typeof result.width, 'number');
  assert.equal(typeof result.height, 'number');
  assert.equal(result.width >= 640, true);
  assert.equal(result.height >= 480, true);
});

test('FALLBACK has reasonable dimensions for a small laptop', () => {
  assert.equal(FALLBACK.width >= 1024, true);
  assert.equal(FALLBACK.height >= 600, true);
});

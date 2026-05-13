const assert = require('node:assert/strict');
const test = require('node:test');

const {
  detectScreenSize,
  FALLBACK,
  parseFirstWxH,
  parseMacDisplayBlock,
  parseMacDisplayBlocks,
} = require('../lib/detect-screen');

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

// --- macOS display parsing ---------------------------------------------------

test('parseMacDisplayBlock prefers UI Looks like over Resolution', () => {
  // Mixed block where both fields are present: UI Looks like wins because
  // it already reflects the post-scaling logical resolution the OS reports
  // to apps (the "Resolution" line on Retina panels is the physical count).
  const text = [
    'Resolution: 5120 x 2880 (5K/UHD+ - Ultra High Definition Plus)',
    'UI Looks like: 2560 x 1440 @ 120.00Hz',
  ].join('\n');
  assert.deepEqual(parseMacDisplayBlock(text), { width: 2560, height: 1440 });
});

test('parseMacDisplayBlock halves a Retina resolution when no UI Looks like line is present', () => {
  // Built-in Retina panels at the default macOS scaling report only the
  // physical resolution; the logical (CSS) size is half that on each axis.
  const text = [
    'Display Type: Built-in Liquid Retina XDR Display',
    'Resolution: 3456 x 2234 Retina',
    'Main Display: Yes',
  ].join('\n');
  assert.deepEqual(parseMacDisplayBlock(text), { width: 1728, height: 1117 });
});

test('parseMacDisplayBlock returns Resolution as-is for non-Retina displays', () => {
  const text = 'Resolution: 1920 x 1080 (1080p FHD - Full High Definition)';
  assert.deepEqual(parseMacDisplayBlock(text), { width: 1920, height: 1080 });
});

test('parseMacDisplayBlock returns null when no resolution is present', () => {
  assert.equal(parseMacDisplayBlock('Mirror: Off\nOnline: Yes'), null);
  assert.equal(parseMacDisplayBlock(''), null);
  assert.equal(parseMacDisplayBlock(null), null);
});

test('parseMacDisplayBlocks splits multi-display output and flags the main display', () => {
  // Real-world shape observed on a MacBook Pro driving two external monitors.
  // The detector must pick the built-in (main) panel, not one of the externals.
  const out = [
    'Graphics/Displays:',
    '',
    '    Apple M5 Max:',
    '',
    '      Chipset Model: Apple M5 Max',
    '      Displays:',
    '        Color LCD:',
    '          Display Type: Built-in Liquid Retina XDR Display',
    '          Resolution: 3456 x 2234 Retina',
    '          Main Display: Yes',
    '          Mirror: Off',
    '        DELL U2725QE:',
    '          Resolution: 5120 x 2880 (5K/UHD+ - Ultra High Definition Plus)',
    '          UI Looks like: 2560 x 1440 @ 120.00Hz',
    '          Mirror: Off',
    '        DELL U2725QE:',
    '          Resolution: 5120 x 2880 (5K/UHD+ - Ultra High Definition Plus)',
    '          UI Looks like: 2560 x 1440 @ 120.00Hz',
  ].join('\n');

  const blocks = parseMacDisplayBlocks(out);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].name, 'Color LCD');
  assert.equal(blocks[0].isMain, true);
  assert.equal(blocks[1].name, 'DELL U2725QE');
  assert.equal(blocks[1].isMain, false);
  assert.equal(blocks[2].name, 'DELL U2725QE');
  assert.equal(blocks[2].isMain, false);

  // The main display should drive the result, not the externals — even
  // though the externals come later in the listing and have larger
  // post-scaling resolutions. Chrome opens at --window-position=0,0, which
  // lands on the main display, so sizing to an external would overflow the
  // window past the right edge of the visible monitor area.
  const mainSize = parseMacDisplayBlock(blocks.find((b) => b.isMain).text);
  assert.deepEqual(mainSize, { width: 1728, height: 1117 });
});

test('parseMacDisplayBlocks falls back to the first block when none is marked main', () => {
  // Some macOS versions omit "Main Display: Yes" on single-monitor setups.
  // In that case the first (and only) block is what we want.
  const out = [
    'Graphics/Displays:',
    '    Apple M1:',
    '      Displays:',
    '        Color LCD:',
    '          Resolution: 2560 x 1600 Retina',
    '          Mirror: Off',
  ].join('\n');

  const blocks = parseMacDisplayBlocks(out);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].isMain, false);
  assert.deepEqual(parseMacDisplayBlock(blocks[0].text), { width: 1280, height: 800 });
});

test('parseMacDisplayBlocks ignores top-level non-display text and empty input', () => {
  assert.deepEqual(parseMacDisplayBlocks(''), []);
  assert.deepEqual(parseMacDisplayBlocks('Graphics/Displays:\n    Apple M1:\n      Chipset Model: Apple M1\n'), []);
});

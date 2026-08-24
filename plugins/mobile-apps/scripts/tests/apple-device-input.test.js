'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appleFile,
  cleanupTemporary,
  createTemporaryAppleFile,
  parseInput,
  readExternalInput,
  safeSummary,
  validateRecords,
} = require('../../assets/apple-fastlane/fastlane/lib/apple_device_input');

// These all-zero identifiers are syntactically representative but deliberately
// impossible fixture values; they are not copied from an Apple device.
const LEGACY_FAKE = '0'.repeat(40);
const MODERN_FAKE = `${'0'.repeat(8)}-${'0'.repeat(16)}`;
const OTHER_FAKE = '1'.repeat(40);
const WORK = path.join(__dirname, '.apple-device-input-work');
const EXTERNAL = path.join(os.homedir(), '.mobile-app-apple-device-input-tests');

test.afterEach(() => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(EXTERNAL, { recursive: true, force: true });
});

test('accepts strict JSON, CSV, and Apple-compatible input', () => {
  const json = JSON.stringify({
    devices: [{ name: 'Lab phone', udid: LEGACY_FAKE, platform: 'ios' }],
  });
  const csv = `name,udid,platform\nLab phone,${MODERN_FAKE},ios\n`;
  const apple = [
    '# sanitized offline fixture',
    'Device ID\tDevice Name\tDevice Platform',
    `${OTHER_FAKE}\tLab tablet\tios`,
    '',
  ].join('\n');

  assert.equal(parseInput(json, 'json')[0].udid, LEGACY_FAKE);
  assert.equal(parseInput(csv, 'csv')[0].udid, MODERN_FAKE);
  assert.equal(parseInput(apple, 'apple')[0].name, 'Lab tablet');
});

test('rejects malformed fields, platforms, duplicates, and conflicts', () => {
  assert.throws(
    () => validateRecords([{ name: 'Bad', udid: 'not-a-device-id', platform: 'ios' }]),
    /udid-format-invalid/,
  );
  assert.throws(
    () => validateRecords([{ name: 'Bad', udid: LEGACY_FAKE, platform: 'mac' }]),
    /platform-invalid/,
  );
  assert.throws(
    () => validateRecords([
      { name: 'Same', udid: LEGACY_FAKE, platform: 'ios' },
      { name: 'Same', udid: OTHER_FAKE, platform: 'ios' },
    ]),
    /duplicate-name-conflict/,
  );
  assert.throws(
    () => validateRecords([
      { name: 'First', udid: LEGACY_FAKE, platform: 'ios' },
      { name: 'Second', udid: LEGACY_FAKE.toLowerCase(), platform: 'ios' },
    ]),
    /duplicate-udid-conflict/,
  );
  assert.throws(
    () => validateRecords(Array.from({ length: 101 }, (_, index) => ({
      name: `Device ${index}`,
      udid: index.toString(16).padStart(40, '0'),
      platform: 'ios',
    }))),
    /device-count-limit/,
  );
  assert.throws(
    () => parseInput(`name,name,udid\nOne,Two,${LEGACY_FAKE}\n`, 'csv'),
    /delimited-header-invalid/,
  );
});

test('rejects repository files and symlinked external files', () => {
  fs.mkdirSync(WORK, { recursive: true });
  const repositoryFile = path.join(WORK, 'devices.json');
  fs.writeFileSync(repositoryFile, JSON.stringify([
    { name: 'Lab phone', udid: LEGACY_FAKE, platform: 'ios' },
  ]));
  assert.throws(() => readExternalInput(repositoryFile), /repository-input-forbidden/);

  fs.mkdirSync(EXTERNAL, { recursive: true });
  const externalFile = path.join(EXTERNAL, 'devices.json');
  fs.writeFileSync(externalFile, fs.readFileSync(repositoryFile));
  const link = path.join(EXTERNAL, 'linked.json');
  fs.symlinkSync(externalFile, link);
  assert.throws(() => readExternalInput(link), /symlink-path-forbidden/);
  assert.throws(() => readExternalInput('devices.json'), /input-path-must-be-absolute/);
});

test('reads a validated regular file outside repositories', () => {
  fs.mkdirSync(EXTERNAL, { recursive: true });
  const externalFile = path.join(EXTERNAL, 'devices.csv');
  fs.writeFileSync(externalFile, `name,udid,platform\nLab phone,${LEGACY_FAKE},ios\n`);

  assert.deepEqual(readExternalInput(externalFile), [{
    name: 'Lab phone',
    udid: LEGACY_FAKE,
    platform: 'ios',
  }]);
});

test('creates a private external Apple file, masks summaries, and cleans up', () => {
  fs.mkdirSync(EXTERNAL, { recursive: true, mode: 0o700 });
  const records = validateRecords([
    { name: 'Lab phone', udid: LEGACY_FAKE, platform: 'ios' },
    { name: 'Lab tablet', udid: MODERN_FAKE, platform: 'ios' },
  ]);
  const prepared = createTemporaryAppleFile(records, { tempRoot: EXTERNAL });

  assert.equal(fs.statSync(prepared.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(prepared.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(prepared.file, 'utf8'), appleFile(records));
  assert.deepEqual(safeSummary(records), {
    count: 2,
    platformCounts: { ios: 2 },
    maskedSuffixes: ['…0000', '…0000'],
  });
  assert.doesNotMatch(JSON.stringify(safeSummary(records)), new RegExp(LEGACY_FAKE));

  cleanupTemporary(prepared);
  assert.equal(fs.existsSync(prepared.directory), false);
});

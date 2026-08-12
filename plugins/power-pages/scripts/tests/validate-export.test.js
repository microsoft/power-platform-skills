const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'export-solution',
  'scripts',
  'validate-export.js'
);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 0;
    const compressedData = method === 8 ? zlib.deflateRawSync(data) : data;
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localRecords.push(localHeader, name, compressedData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressedData.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localRecords, centralDirectory, endRecord]);
}

function makeProject(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-export-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

function validSolutionEntries(extraEntries = []) {
  return [
    {
      name: 'Solution.xml',
      data: `<ImportExportXml>${crypto.randomBytes(1400).toString('hex')}</ImportExportXml>`,
      method: 8,
    },
    ...extraEntries,
  ];
}

function runValidator(projectRoot, env = process.env) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    cwd: projectRoot,
    input: JSON.stringify({ cwd: projectRoot }),
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
}

test('approves when no exported solution ZIP exists', (t) => {
  const projectRoot = makeProject(t);
  const result = runValidator(projectRoot);

  assert.equal(result.status, 0, result.stderr);
});

test('approves a valid deflated solution ZIP containing Solution.xml', (t) => {
  const projectRoot = makeProject(t);
  fs.writeFileSync(
    path.join(projectRoot, 'release_unmanaged.zip'),
    createZip(validSolutionEntries())
  );

  const result = runValidator(projectRoot);

  assert.equal(result.status, 0, result.stderr);
});

test('handles malicious archive and path names without invoking a shell', (t) => {
  const projectRoot = makeProject(t);
  const markerName = 'validator-command-ran';
  const zipName = `release_$(touch ${markerName})_unmanaged.zip`;
  fs.writeFileSync(
    path.join(projectRoot, zipName),
    createZip(validSolutionEntries([
      {
        name: 'assets/"quoted"; $(ignored) & payload.txt',
        data: 'not executable',
      },
    ]))
  );

  const result = runValidator(projectRoot);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(projectRoot, markerName)), false);
});

test('handles spaces, quotes, and cross-platform filename metacharacters', (t) => {
  const projectRoot = makeProject(t);
  const zipPath = path.join(projectRoot, "release 'review copy' & (final); 100%_managed.zip");
  fs.writeFileSync(zipPath, createZip(validSolutionEntries()));

  const result = runValidator(projectRoot);

  assert.equal(result.status, 0, result.stderr);
});

test('blocks a corrupt ZIP instead of approving by file size', (t) => {
  const projectRoot = makeProject(t);
  fs.writeFileSync(
    path.join(projectRoot, 'corrupt_unmanaged.zip'),
    crypto.randomBytes(1500)
  );

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not be validated/i);
});

test('blocks a structurally valid ZIP that does not contain Solution.xml', (t) => {
  const projectRoot = makeProject(t);
  fs.writeFileSync(
    path.join(projectRoot, 'missing_solution_managed.zip'),
    createZip([
      {
        name: 'Other.xml',
        data: crypto.randomBytes(1400),
      },
    ])
  );

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not contain solution\.xml/i);
});

test('blocks a ZIP when the Solution.xml payload fails its integrity check', (t) => {
  const projectRoot = makeProject(t);
  const archive = createZip([
    {
      name: 'Solution.xml',
      data: crypto.randomBytes(1400),
      method: 0,
    },
  ]);
  archive[30 + Buffer.byteLength('Solution.xml')] ^= 0xff;
  fs.writeFileSync(path.join(projectRoot, 'damaged_managed.zip'), archive);

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /integrity check/i);
});

test('blocks duplicate root Solution.xml entries', (t) => {
  const projectRoot = makeProject(t);
  fs.writeFileSync(
    path.join(projectRoot, 'duplicate_unmanaged.zip'),
    createZip([
      ...validSolutionEntries(),
      {
        name: 'solution.XML',
        data: crypto.randomBytes(1400),
      },
    ])
  );

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /duplicate Solution\.xml/i);
});

test('blocks a ZIP with a corrupt non-manifest local header', (t) => {
  const projectRoot = makeProject(t);
  const archive = createZip(validSolutionEntries([
    {
      name: 'Customizations.xml',
      data: crypto.randomBytes(1400),
    },
  ]));
  const secondLocalHeader = archive.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
  archive.writeUInt32LE(0, secondLocalHeader);
  fs.writeFileSync(path.join(projectRoot, 'corrupt_entry_managed.zip'), archive);

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /local header.*invalid signature/i);
});

test('blocks local-header metadata that disagrees with the central directory', (t) => {
  const projectRoot = makeProject(t);
  const archive = createZip(validSolutionEntries());
  archive.writeUInt32LE(1, 18);
  fs.writeFileSync(path.join(projectRoot, 'corrupt_metadata_managed.zip'), archive);

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /sizes or checksum.*disagree/i);
});

test('blocks oversized archives before reading them into memory', (t) => {
  const projectRoot = makeProject(t);
  const zipPath = path.join(projectRoot, 'oversized_unmanaged.zip');
  fs.writeFileSync(zipPath, Buffer.alloc(0));
  fs.truncateSync(zipPath, 100 * 1024 * 1024 + 1);

  const result = runValidator(projectRoot);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /exceeds the supported 100 MiB/i);
});

test('validates without unzip, grep, or any executable available on PATH', (t) => {
  const projectRoot = makeProject(t);
  fs.writeFileSync(
    path.join(projectRoot, 'windows-compatible_unmanaged.zip'),
    createZip(validSolutionEntries())
  );

  const envWithoutPath = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')
  );
  const result = runValidator(projectRoot, { ...envWithoutPath, PATH: '' });

  assert.equal(result.status, 0, result.stderr);
});

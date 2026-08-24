#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEGACY_UDID = /^[0-9A-F]{40}$/;
const MODERN_UDID = /^[0-9A-F]{8}-[0-9A-F]{16}$/;
const ALLOWED_PLATFORMS = new Set(['ios']);
const MAX_DEVICES = 100;

function blocked(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizePlatform(value) {
  const platform = String(value || 'ios').trim().toLowerCase();
  if (!ALLOWED_PLATFORMS.has(platform)) throw blocked('platform-invalid');
  return platform;
}

function normalizeUdid(value) {
  const udid = String(value || '').trim().toUpperCase();
  if (!LEGACY_UDID.test(udid) && !MODERN_UDID.test(udid)) {
    throw blocked('udid-format-invalid');
  }
  return udid;
}

function normalizeName(value) {
  const name = String(value || '').trim();
  // Apple accepts user-assigned display names, but control characters make its
  // tab-delimited upload format ambiguous and can forge terminal log lines.
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw blocked('device-name-invalid');
  }
  return name;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw blocked('record-invalid');
  }
  const keys = Object.keys(record);
  const known = new Set([
    'name', 'udid', 'platform',
    'Device Name', 'Device ID', 'Device Platform',
  ]);
  if (keys.some((key) => !known.has(key))) throw blocked('record-field-invalid');
  return {
    name: normalizeName(record.name ?? record['Device Name']),
    udid: normalizeUdid(record.udid ?? record['Device ID']),
    platform: normalizePlatform(record.platform ?? record['Device Platform']),
  };
}

function validateRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw blocked('devices-empty');
  if (records.length > MAX_DEVICES) throw blocked('device-count-limit');

  const normalized = records.map(normalizeRecord);
  const byUdid = new Map();
  const byName = new Map();
  for (const record of normalized) {
    const udidKey = record.udid.replaceAll('-', '');
    const nameKey = record.name.toLocaleLowerCase('en-US');
    const priorUdid = byUdid.get(udidKey);
    if (priorUdid) {
      throw blocked(
        priorUdid.name === record.name && priorUdid.platform === record.platform
          ? 'duplicate-device'
          : 'duplicate-udid-conflict',
      );
    }
    const priorName = byName.get(nameKey);
    if (priorName && priorName.udid.replaceAll('-', '') !== udidKey) {
      throw blocked('duplicate-name-conflict');
    }
    byUdid.set(udidKey, record);
    byName.set(nameKey, record);
  }
  return normalized;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw blocked('delimited-input-malformed');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/u, ''));
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
}

function recordsFromRows(rows, delimiter) {
  // Apple's sample permits blank/comment rows around device entries. Ignore a
  // row only when its first field begins with '#'; embedded '#' remains data.
  const contentRows = rows.filter((row) => !row[0]?.trimStart().startsWith('#'));
  if (contentRows.length < 2) throw blocked('devices-empty');
  const headers = contentRows[0].map((value) => value.trim());
  const required = delimiter === '\t'
    ? ['Device ID', 'Device Name']
    : null;
  if (required && (headers[0] !== required[0] || headers[1] !== required[1])) {
    throw blocked('apple-header-invalid');
  }

  const aliases = new Map([
    ['device id', 'udid'],
    ['udid', 'udid'],
    ['device name', 'name'],
    ['name', 'name'],
    ['device platform', 'platform'],
    ['platform', 'platform'],
  ]);
  const mapped = headers.map((header) => aliases.get(header.toLowerCase()));
  if (!mapped.includes('name') || !mapped.includes('udid')
      || mapped.some((header) => !header)
      || new Set(mapped).size !== mapped.length) {
    throw blocked('delimited-header-invalid');
  }
  return contentRows.slice(1).map((row) => {
    if (row.length !== headers.length) throw blocked('delimited-row-invalid');
    return Object.fromEntries(mapped.map((header, index) => [header, row[index]]));
  });
}

function parseInput(text, format) {
  if (format === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw blocked('json-malformed');
    }
    return validateRecords(Array.isArray(parsed) ? parsed : parsed?.devices);
  }
  const delimiter = format === 'apple' ? '\t' : ',';
  return validateRecords(recordsFromRows(parseDelimited(text, delimiter), delimiter));
}

function detectFormat(file, text) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.csv') return 'csv';
  if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) return 'json';
  if (text.split(/\r?\n/u, 1)[0].includes('\t')) return 'apple';
  throw blocked('input-format-unsupported');
}

function assertNoSymlinkComponents(candidate) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') throw blocked('input-file-missing');
      throw error;
    }
    if (stat.isSymbolicLink()) throw blocked('symlink-path-forbidden');
  }
}

function repositoryAncestor(candidate) {
  let cursor = fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
  cursor = fs.realpathSync(cursor);
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function readExternalInput(file) {
  if (!path.isAbsolute(file)) throw blocked('input-path-must-be-absolute');
  assertNoSymlinkComponents(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw blocked('input-must-be-regular-file');
  if (repositoryAncestor(file)) throw blocked('repository-input-forbidden');
  const text = fs.readFileSync(file, 'utf8');
  return parseInput(text, detectFormat(file, text));
}

function appleFile(records) {
  return [
    'Device ID\tDevice Name\tDevice Platform',
    ...records.map(({ udid, name, platform }) => `${udid}\t${name}\t${platform}`),
    '',
  ].join('\n');
}

function maskUdid(udid) {
  return `…${udid.slice(-4)}`;
}

function safeSummary(records) {
  const platformCounts = {};
  for (const { platform } of records) {
    platformCounts[platform] = (platformCounts[platform] || 0) + 1;
  }
  return {
    count: records.length,
    platformCounts,
    maskedSuffixes: records.map(({ udid }) => maskUdid(udid)),
  };
}

function createTemporaryAppleFile(records, options = {}) {
  const tempRoot = fs.realpathSync(options.tempRoot || os.tmpdir());
  if (repositoryAncestor(tempRoot)) throw blocked('repository-temp-forbidden');
  const directory = fs.mkdtempSync(path.join(tempRoot, 'mobile-app-apple-devices-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'devices.txt');
  fs.writeFileSync(file, appleFile(records), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { directory, file, ...safeSummary(records) };
}

function cleanupTemporary(result) {
  if (!result?.directory) return;
  fs.rmSync(result.directory, { recursive: true, force: true });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input' && argv[index + 1]) {
      args.input = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--stdin-json') {
      args.stdinJson = true;
    } else {
      throw blocked('arguments-invalid');
    }
  }
  if (Boolean(args.input) === Boolean(args.stdinJson)) throw blocked('input-mode-invalid');
  return args;
}

function main(argv = process.argv.slice(2)) {
  let temporary;
  try {
    const args = parseArgs(argv);
    const records = args.input
      ? readExternalInput(args.input)
      : parseInput(fs.readFileSync(0, 'utf8'), 'json');
    temporary = createTemporaryAppleFile(records);
    process.stdout.write(`${JSON.stringify(temporary)}\n`);
    return 0;
  } catch (error) {
    cleanupTemporary(temporary);
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      reason: error?.code || 'input-processing-failed',
    })}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  appleFile,
  assertNoSymlinkComponents,
  cleanupTemporary,
  createTemporaryAppleFile,
  detectFormat,
  main,
  maskUdid,
  normalizeRecord,
  parseDelimited,
  parseInput,
  readExternalInput,
  repositoryAncestor,
  safeSummary,
  validateRecords,
};

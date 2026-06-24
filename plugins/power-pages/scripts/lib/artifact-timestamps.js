// Shared helpers for stamping machine-readable timestamps onto artifacts
// written by Power Pages skills, plus read-side age and staleness checks.
// Keep artifact timestamp semantics centralized here so writers and validators
// do not drift over time.

'use strict';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function assertObject(obj, functionName) {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    throw new Error(`${functionName}: obj must be an object.`);
  }
}

function isoNow(now) {
  return new Date(now === undefined ? Date.now() : now).toISOString();
}

function stamp(obj, { now } = {}) {
  assertObject(obj, 'stamp');

  const timestamp = isoNow(now);
  if (typeof obj.createdAt !== 'string' || obj.createdAt.length === 0) {
    obj.createdAt = timestamp;
  }
  obj.updatedAt = timestamp;
  return obj;
}

function withSchemaVersion(obj, version) {
  assertObject(obj, 'withSchemaVersion');

  if (version !== undefined && !Object.prototype.hasOwnProperty.call(obj, 'schemaVersion')) {
    obj.schemaVersion = version;
  }
  return obj;
}

function ageMs(stampedObj, { now } = {}, field = 'updatedAt') {
  assertObject(stampedObj, 'ageMs');

  const value = stampedObj[field];
  if (value === undefined || value === null || value === '') return null;

  const timestampMs = new Date(value).getTime();
  if (Number.isNaN(timestampMs)) return null;

  const nowMs = new Date(now === undefined ? Date.now() : now).getTime();
  if (Number.isNaN(nowMs)) return null;

  return nowMs - timestampMs;
}

function describeAge(ms) {
  if (ms === null || ms === undefined || ms < 0 || Number.isNaN(ms)) return 'unknown';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function isStale(stampedObj, { now, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}, field = 'updatedAt') {
  const age = ageMs(stampedObj, { now }, field);
  if (age === null) return true;
  return age > maxAgeMs;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function parseNowArg(argv) {
  const index = argv.indexOf('--now');
  if (index === -1) return undefined;
  return argv[index + 1];
}

async function main() {
  const input = await readStdin();
  const obj = input.trim() ? JSON.parse(input) : {};
  process.stdout.write(`${JSON.stringify(stamp(obj, { now: parseNowArg(process.argv.slice(2)) }), null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  stamp,
  withSchemaVersion,
  ageMs,
  describeAge,
  isStale,
};

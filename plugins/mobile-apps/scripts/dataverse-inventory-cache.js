#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./lib/dataverse-planning-telemetry');

const CACHE_SCHEMA_VERSION = 1;
const DATAVERSE_API_VERSION = '9.2';
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function identity(context) {
  return {
    environmentUrl: normalizeUrl(context.environmentUrl),
    tenantId: String(context.tenantId || '').trim().toLowerCase(),
    solution: String(context.solution || 'Default').trim(),
    apiVersion: String(context.apiVersion || DATAVERSE_API_VERSION),
    inventorySchemaVersion: Number(context.inventorySchemaVersion || 3),
  };
}

function sameIdentity(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function readInventoryCache(file, context, {
  ttlMs = DEFAULT_TTL_MS,
  nowMs = () => Date.now(),
  fileSystem = fs,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('inventory cache TTL must be positive');
  const resolved = path.resolve(file);
  if (!fileSystem.existsSync(resolved)) return { hit: false, reason: 'missing', inventory: null };
  let cache;
  try {
    cache = JSON.parse(fileSystem.readFileSync(resolved, 'utf8'));
  } catch {
    return { hit: false, reason: 'invalid-json', inventory: null };
  }
  if (cache.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(cache.inventory)) {
    return { hit: false, reason: 'invalid-shape', inventory: null };
  }
  if (!sameIdentity(cache.identity || {}, identity(context))) {
    return { hit: false, reason: 'identity-mismatch', inventory: null };
  }
  const ageMs = nowMs() - Number(cache.cachedAtMs);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) {
    return { hit: false, reason: 'expired', inventory: null, ageMs };
  }
  return {
    hit: true,
    reason: 'fresh',
    inventory: cache.inventory,
    ageMs,
    cachedAt: cache.cachedAt,
  };
}

function writeInventoryCache(file, context, inventory, {
  nowMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  fileSystem = fs,
} = {}) {
  if (!Array.isArray(inventory)) throw new Error('inventory cache requires an array');
  const cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    identity: identity(context),
    cachedAt: nowIso(),
    cachedAtMs: nowMs(),
    inventory,
  };
  atomicWriteJson(file, cache, fileSystem);
  return cache;
}

function invalidateInventoryCache(file, fileSystem = fs) {
  const resolved = path.resolve(file);
  fileSystem.rmSync(resolved, { force: true });
  return !fileSystem.existsSync(resolved);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--file') args.file = argv[++index];
    else if (argv[index] === '--invalidate') args.invalidate = true;
  }
  return args;
}

function main(argv = process.argv, {
  fileSystem = fs,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const args = parseArgs(argv);
  if (!args.file || !args.invalidate) {
    stderr.write(
      'Usage: node dataverse-inventory-cache.js --file <json> --invalidate\n',
    );
    return 2;
  }
  try {
    if (!invalidateInventoryCache(args.file, fileSystem)) {
      stderr.write(
        `dataverse-inventory-cache: failed to invalidate ${path.resolve(args.file)}\n`,
      );
      return 2;
    }
    stdout.write(`${JSON.stringify({ status: 'invalidated', file: path.resolve(args.file) })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`dataverse-inventory-cache: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  CACHE_SCHEMA_VERSION,
  DATAVERSE_API_VERSION,
  DEFAULT_TTL_MS,
  identity,
  invalidateInventoryCache,
  main,
  readInventoryCache,
  sameIdentity,
  writeInventoryCache,
};
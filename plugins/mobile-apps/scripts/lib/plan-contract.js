'use strict';

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();

function entryFor(filePath, { optional = false } = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    cache.delete(resolved);
    if (optional) return null;
    throw new Error(`file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  const cached = cache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    text: fs.readFileSync(resolved, 'utf8'),
    json: undefined,
  };
  cache.set(resolved, entry);
  return entry;
}

function readText(filePath, options) {
  return entryFor(filePath, options)?.text ?? null;
}

function readJson(filePath, options) {
  const entry = entryFor(filePath, options);
  if (!entry) return null;
  if (entry.json === undefined) entry.json = JSON.parse(entry.text);
  return entry.json;
}

function clear() {
  cache.clear();
}

module.exports = { clear, readJson, readText };
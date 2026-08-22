'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY_PATH = path.join(PLUGIN_ROOT, 'shared', 'contracts', 'checks.json');
const CLASSES = new Set(['A', 'B', 'C']);
const SCOPES = new Set(['screen', 'app']);

function validate(entries, { requireFiles = true } = {}) {
  const errors = [];
  const ids = new Set();
  const modules = new Set();
  if (!Array.isArray(entries)) return ['check registry must be an array'];
  for (const [index, entry] of entries.entries()) {
    const label = entry?.id || `entry ${index}`;
    if (!entry?.id || ids.has(entry.id)) errors.push(`${label}: id is missing or duplicated`);
    else ids.add(entry.id);
    if (!entry?.module || modules.has(entry.module)) errors.push(`${label}: module is missing or duplicated`);
    else modules.add(entry.module);
    if (![1, 2, 3].includes(entry?.tier)) errors.push(`${label}: tier must be 1, 2, or 3`);
    if (!CLASSES.has(entry?.class)) errors.push(`${label}: class must be A, B, or C`);
    if (!SCOPES.has(entry?.scope)) errors.push(`${label}: scope must be screen or app`);
    if (!String(entry?.rule || '').trim()) errors.push(`${label}: rule is required`);
    if (typeof entry?.blocking !== 'boolean') errors.push(`${label}: blocking must be boolean`);
    if (entry?.blocking && !entry?.fixture) errors.push(`${label}: blocking checks require a fixture`);
    if (requireFiles && entry?.fixture && !fs.existsSync(path.join(PLUGIN_ROOT, entry.fixture))) errors.push(`${label}: fixture does not exist: ${entry.fixture}`);
    if (requireFiles && entry?.module) {
      const implementation = entry.tier === 1
        ? path.join(__dirname, 'static', 'run.js')
        : entry.tier === 3
          ? path.join(__dirname, 'device', 'checks', `${entry.module}.js`)
          : path.join(__dirname, 'checks', `${entry.module}.js`);
      if (!fs.existsSync(implementation)) errors.push(`${label}: check implementation does not exist`);
    }
  }
  return errors;
}

function load() {
  const entries = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const errors = validate(entries);
  if (errors.length > 0) throw new Error(`invalid check registry:\n- ${errors.join('\n- ')}`);
  return entries;
}

function resolve(entries, name) {
  return entries.find((entry) => entry.id === name || entry.module === name) || null;
}

module.exports = { PLUGIN_ROOT, REGISTRY_PATH, load, resolve, validate };
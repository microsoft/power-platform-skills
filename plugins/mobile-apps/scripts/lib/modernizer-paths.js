'use strict';

const path = require('node:path');

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isWindowsReservedBasename(value) {
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(String(value || ''));
}

function buildArtifactNameMap(names, fallback = 'artifact') {
  const map = new Map();
  const used = new Set();
  for (const name of names) {
    if (map.has(name)) throw new Error(`Duplicate source name cannot be mapped safely: ${name}`);
    let stem = String(name || fallback)
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120) || fallback;
    if (isWindowsReservedBasename(stem)) stem = `_${stem}`;
    const base = stem;
    let suffix = 2;
    while (used.has(stem.toLowerCase())) stem = `${base}_${suffix++}`;
    used.add(stem.toLowerCase());
    map.set(name, stem);
  }
  return map;
}

module.exports = {
  buildArtifactNameMap,
  isWindowsReservedBasename,
  pathContains,
};

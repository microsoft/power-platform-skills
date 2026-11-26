'use strict';

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', '..', '..', 'references', 'design-rubric-catalog.json');
const SEVERITY_ORDER = ['major', 'minor'];
const EFFORT_ORDER = ['S', 'M', 'L'];

let cached;

function loadCatalog() {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const byId = new Map(raw.issues.map((i) => [i.id, i]));
  const dimToCategory = {};
  for (const cat of raw.categories) for (const d of cat.dimensions) dimToCategory[d] = cat.id;
  const dimOrder = raw.categories.flatMap((c) => c.dimensions);
  cached = { ...raw, byId, dimToCategory, dimOrder };
  return cached;
}

function profileOf(name = 'full') {
  const p = loadCatalog().profiles[name];
  if (!p) throw new Error(`Unknown review profile "${name}".`);
  return p;
}

function judgmentIds(profile = 'full') {
  const p = profileOf(profile);
  const all = loadCatalog().issues.filter((i) => i.detection === 'judgment').map((i) => i.id);
  return p.judgments === 'all' ? all : all.filter((id) => p.judgments.includes(id));
}

function measuredAllowed(profile = 'full') {
  const p = profileOf(profile);
  return (id) => p.measured === 'all' || p.measured.includes(id);
}

function severityRank(s) {
  const r = SEVERITY_ORDER.indexOf(s);
  return r === -1 ? SEVERITY_ORDER.length : r;
}

function maxSeverity(a, b) {
  return severityRank(a) <= severityRank(b) ? a : b;
}

module.exports = { loadCatalog, judgmentIds, profileOf, measuredAllowed, severityRank, maxSeverity, SEVERITY_ORDER, EFFORT_ORDER };

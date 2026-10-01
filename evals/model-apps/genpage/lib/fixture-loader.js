'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Loads fixtures from a directory. Each subdirectory is one fixture.
// Fixture folder name convention: "<eval-id>-<kebab-slug>" — id is parsed
// from the leading digits before the first hyphen.
//
//   fixtures/
//     1-account-gallery/
//       page.tsx                      ← .tsx output (consumed by Layer 2)
//       workflow-log.md               ← log of agent actions (consumed by Layer 1)
//       genpage-plan.md               ← plan doc (consumed by Layer 1)
//       genpage-entity-creation-log.md ← entity-builder transactions (Layer 1)
//     2-mock-dashboard/
//       dashboard.tsx
//
// Each fixture exposes:
//   id, dirName, dir
//   files: [{ path, name, content }]  ← every .tsx except RuntimeTypes (Layer 2)
//   workflowLog: string | null         ← workflow-log.md content (Layer 1)
//   genpagePlan: string | null         ← genpage-plan.md content (Layer 1)
//   genpageEditPlan: string | null     ← genpage-edit-plan.md content (Layer 1 edit flow)
//   entityCreationLog: string | null   ← current log or legacy alias (Layer 1)
//   contractVersion, manifest, events, artifacts ← versioned synthetic evidence

const ENTITY_CREATION_LOG = 'genpage-entity-creation-log.md';
// Historical captures predate the skill-specific prefix; keep their old name as a read-only alias.
const LEGACY_ENTITY_CREATION_LOG = 'entity-creation-log.md';

function readJson(dir, name) {
  const text = readOptional(dir, name);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${path.basename(dir)}: invalid JSON in ${name}: ${error.message}`);
  }
}

function evidenceFile(dir, name) {
  if (typeof name !== 'string' || !name || path.win32.isAbsolute(name) || path.posix.isAbsolute(name)
    || name.split(/[\\/]/).some((part) => part === '..' || part === '.' || !part)) {
    throw new Error(`${path.basename(dir)}: invalid artifact path ${JSON.stringify(name)}`);
  }
  const full = path.resolve(dir, ...name.split(/[\\/]/));
  const root = fs.realpathSync(dir);
  const real = fs.realpathSync(full);
  const relative = path.relative(root, real);
  const stat = fs.lstatSync(full);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !stat.isFile() || stat.nlink > 1) {
    throw new Error(`${path.basename(dir)}: artifact path is outside the fixture or not a plain file: ${name}`);
  }
  return fs.readFileSync(full, 'utf8');
}

function fixtureEvidence(dir, dirName, historicalContracts) {
  const manifest = readJson(dir, 'fixture.json') || historicalContracts[dirName]
    || { contractVersion: 1, provenance: 'historical' };
  if (!manifest || ![1, 2].includes(manifest.contractVersion)) {
    throw new Error(`${dirName}: unsupported fixture contract version`);
  }
  if (manifest.contractVersion === 2 && manifest.provenance !== 'synthetic') {
    throw new Error(`${dirName}: current eval fixtures must be labelled synthetic`);
  }
  const artifacts = {};
  for (const name of manifest.artifacts || []) {
    artifacts[name.replace(/\\/g, '/')] = evidenceFile(dir, name);
  }
  let events;
  if (manifest.toolResults) {
    const text = evidenceFile(dir, manifest.toolResults);
    try { events = JSON.parse(text); } catch (error) {
      throw new Error(`${dirName}: invalid JSON in ${manifest.toolResults}: ${error.message}`);
    }
    if (!Array.isArray(events) || events.some((event) => !event || typeof event.command !== 'string' || !event.command.trim())) {
      throw new Error(`${dirName}: tool results must be an ordered array of command/result events`);
    }
    const ids = events.map((event) => event.id).filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length) throw new Error(`${dirName}: duplicate tool-result event id`);
  }
  return { contractVersion: manifest.contractVersion, manifest, events, artifacts };
}

function loadFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory does not exist: ${fixturesDir}`);
  }
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Labels live beside, not INSIDE, captured directories: updating compatibility metadata must
  // never rewrite the original transcript/source evidence.
  const historicalContracts = readJson(fixturesDir, 'contracts.json') || {};

  const fixtures = [];
  for (const entry of entries) {
    const match = entry.name.match(/^(\d+)(?:-(.+))?$/);
    if (!match) continue;
    const id = parseInt(match[1], 10);
    const dir = path.join(fixturesDir, entry.name);
    fixtures.push({
      id,
      dirName: entry.name,
      dir,
      files: listTsxFiles(dir),
      workflowLog: readOptional(dir, 'workflow-log.md'),
      genpagePlan: readOptional(dir, 'genpage-plan.md'),
      genpageEditPlan: readOptional(dir, 'genpage-edit-plan.md'),
      // Only absence permits the legacy alias. An empty current log must not borrow old transactions.
      entityCreationLog: readOptional(dir, ENTITY_CREATION_LOG) ?? readOptional(dir, LEGACY_ENTITY_CREATION_LOG),
      ...fixtureEvidence(dir, entry.name, historicalContracts),
    });
  }
  return fixtures;
}

function listTsxFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.tsx')) continue;
    if (/^RuntimeTypes\.tsx?$/i.test(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, 'utf8');
    out.push({ path: full, name, content });
  }
  return out;
}

function readOptional(dir, fileName) {
  const full = path.join(dir, fileName);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

module.exports = { loadFixtures, listTsxFiles, readOptional, ENTITY_CREATION_LOG, LEGACY_ENTITY_CREATION_LOG };

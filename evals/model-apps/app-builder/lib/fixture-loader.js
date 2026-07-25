'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Load each fixture subdir (named "<eval-id>-<slug>"); its app-spec.json is the graded input.
// Mirrors evals/model-apps/genpage/lib/fixture-loader.js, but the app-builder input is the App
// Spec (not .tsx). Fixture directories that lack an app-spec.json are silently skipped.
function loadFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) throw new Error(`Fixtures directory does not exist: ${fixturesDir}`);
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const fixtures = [];
  for (const entry of entries) {
    const m = entry.name.match(/^(\d+)(?:-(.+))?$/);
    if (!m) continue;
    const dir = path.join(fixturesDir, entry.name);
    const specPath = path.join(dir, 'app-spec.json');
    if (!fs.existsSync(specPath)) continue;
    fixtures.push({ id: parseInt(m[1], 10), dirName: entry.name, dir, spec: JSON.parse(fs.readFileSync(specPath, 'utf8')) });
  }
  return fixtures;
}

module.exports = { loadFixtures };

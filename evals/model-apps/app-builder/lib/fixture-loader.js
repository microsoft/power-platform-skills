'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Load each fixture subdir (named "<eval-id>-<slug>"); its app-spec.json is the graded input.
// Mirrors evals/model-apps/genpage/lib/fixture-loader.js, but the app-builder input is the App
// Spec (not .tsx). Fixture directories that lack an app-spec.json are silently skipped.
//
// Every failure below names the FIXTURE. A bare `JSON.parse` reports only a character offset
// ("Expected double-quoted property name ... at position 25"), which tells an operator running a
// corpus of fixtures nothing about which one to fix.
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
    // Strip a UTF-8 BOM: editors on Windows add one by default and `JSON.parse` rejects the
    // leading \uFEFF, which failed the whole run for a file that is otherwise valid JSON.
    const raw = fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, '');
    let spec;
    try {
      spec = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Fixture ${entry.name}: ${specPath} is not valid JSON — ${e.message}`);
    }
    // `null`, `[]`, `"str"` and numbers all parse fine and were accepted as specs, so the real
    // problem surfaced much later as an opaque stage-facts error. An App Spec is a JSON object.
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`Fixture ${entry.name}: ${specPath} must contain a JSON object (an App Spec), got ${Array.isArray(spec) ? 'an array' : spec === null ? 'null' : typeof spec}`);
    }
    fixtures.push({ id: parseInt(m[1], 10), dirName: entry.name, dir, spec });
  }
  return fixtures;
}

module.exports = { loadFixtures };

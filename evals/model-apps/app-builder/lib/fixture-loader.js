'use strict';
const fs = require('node:fs');
const path = require('node:path');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readFixtureJson(file, fixtureName, kind) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let value;
  try { value = JSON.parse(raw); }
  catch (e) { throw new Error(`Fixture ${fixtureName}: ${file} is not valid JSON — ${e.message}`); }
  if (!isObject(value)) {
    throw new Error(`Fixture ${fixtureName}: ${file} must contain a JSON object (${kind}), got ${Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value}`);
  }
  return value;
}

function fixtureFile(dir, relative, fixtureName) {
  if (typeof relative !== 'string' || !relative) throw new Error(`Fixture ${fixtureName}: evidence file must be a non-empty relative path`);
  const root = fs.realpathSync(dir);
  // Both containment checks must use the canonical root; a junction alias is not an escape.
  const file = path.resolve(root, relative);
  const confined = (candidate) => {
    const rel = path.relative(root, candidate);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!confined(file) || !confined(fs.realpathSync(file))) {
    throw new Error(`Fixture ${fixtureName}: evidence file '${relative}' resolves outside the fixture`);
  }
  return file;
}

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
    const spec = readFixtureJson(specPath, entry.name, 'an App Spec');
    const evidencePath = path.join(dir, 'evidence.json');
    const evidence = fs.existsSync(evidencePath) ? readFixtureJson(evidencePath, entry.name, 'eval evidence') : {};
    if (evidence.formReconcile !== undefined) {
      const reconcile = evidence.formReconcile;
      if (!isObject(reconcile) || !Array.isArray(reconcile.forms)) {
        throw new Error(`Fixture ${entry.name}: formReconcile must be an object with a forms array`);
      }
      for (const [i, form] of reconcile.forms.entries()) {
        if (!isObject(form) || ['id', 'entity', 'name'].some((key) => typeof form[key] !== 'string' || !form[key].trim())) {
          throw new Error(`Fixture ${entry.name}: formReconcile.forms[${i}] must be an object with id, entity and name`);
        }
        form.xml = fs.readFileSync(fixtureFile(dir, form.xmlFile, entry.name), 'utf8');
      }
    }
    const baselinePath = path.join(dir, 'baseline-app-spec.json');
    const baselineSpec = fs.existsSync(baselinePath) ? readFixtureJson(baselinePath, entry.name, 'an App Spec baseline') : null;
    const entityEditPath = path.join(dir, 'entity-edit-app-spec.json');
    const entityEditSpec = fs.existsSync(entityEditPath) ? readFixtureJson(entityEditPath, entry.name, 'an entity-edited App Spec') : null;
    fixtures.push({ id: parseInt(m[1], 10), dirName: entry.name, dir, spec, evidence, baselineSpec, entityEditSpec });
  }
  return fixtures;
}

module.exports = { loadFixtures };

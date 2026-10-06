'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLUGIN_ROOT } = require('./helpers/telemetry-fixtures.js');

const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const OPT_OUT = 'POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT';
const SHARED_SOURCES = new Set([
  'shared/skills/**',
  'shared/telemetry/**',
  'plugins/power-pages/scripts/lib/telemetry/region/**',
]);

function workflow(t, name) {
  const file = path.join(REPO_ROOT, '.github', 'workflows', name);
  if (!fs.existsSync(file)) {
    t.skip('workflows not present in an installed plugin');
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

for (const name of [
  'pcf-script-tests.yml', 'pcf-projects.yml', 'pcf-matrix-drift.yml', 'shared-telemetry-tests.yml',
]) {
  test(`${name} opts out of PCF telemetry transmission on every job`, (t) => {
    const text = workflow(t, name);
    if (text === null) return;
    // Trigger keys such as push/schedule also have four spaces. Count only
    // below jobs:, otherwise a fully opted-out workflow gets a false failure.
    const jobsAt = text.search(/^jobs:[ \t]*\r?$/m);
    assert.ok(jobsAt >= 0, 'workflow must declare jobs');
    const jobSection = text.slice(jobsAt);
    const jobs = [...jobSection.matchAll(/^ {4}([a-z0-9-]+):[ \t]*\r?$/gim)];
    const optOuts = (jobSection.match(new RegExp(OPT_OUT, 'g')) || []).length;
    assert.ok(jobs.length > 0, 'workflow must have jobs');
    assert.equal(optOuts, jobs.length, `every job needs an opt-out (${optOuts} set / ${jobs.length} jobs)`);
    for (let index = 0; index < jobs.length; index++) {
      const block = jobSection.slice(jobs[index].index, jobs[index + 1]?.index);
      // Count alone could pass with two variables in one job or a step-level env.
      // Require the opt-out under each job's env, at the repository's YAML indent.
      assert.match(block, new RegExp(`^ {8}env:[ \\t]*\\r?\\n(?: {12}[^\\n]*\\n)*? {12}${OPT_OUT}: "1"[ \\t]*\\r?$`, 'm'),
        `${jobs[index][1]} must opt out at job level`);
    }
  });
}

test('PCF script CI watches every bundled telemetry source without widening unrelated scope', (t) => {
  const text = workflow(t, 'pcf-script-tests.yml');
  if (text === null) return;
  const globs = [];
  for (const line of text.slice(text.indexOf('paths:')).split('\n').slice(1)) {
    const entry = /^\s+-\s+"([^"]+)"\s*$/.exec(line);
    if (entry) { globs.push(entry[1]); continue; }
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    break;
  }
  for (const source of SHARED_SOURCES) {
    assert.ok(globs.includes(source), `${source} must trigger PCF's copy drift tests`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...source.replace(/\/\*\*$/, '').split('/'))));
  }
  const { COPY_SETS } = require(path.join(REPO_ROOT, 'scripts', 'validate-plugin-copies.js'));
  const copySet = COPY_SETS.find((set) => set.name === 'pcf-from-model-apps');
  const modelSources = new Set([...copySet.verbatim.map((pair) => pair.source), copySet.subset.source]
    .filter((source) => source.startsWith('plugins/model-apps/')));
  for (const glob of globs) {
    assert.ok(glob.startsWith('plugins/pcf/') || glob.startsWith('evals/pcf/')
      || glob === '.github/workflows/pcf-script-tests.yml' || glob === 'scripts/validate-plugin-copies.js'
      || SHARED_SOURCES.has(glob) || modelSources.has(glob), `unrelated CI filter: ${glob}`);
  }
  for (const source of modelSources) assert.ok(globs.includes(source), `existing copied source must remain watched: ${source}`);
});

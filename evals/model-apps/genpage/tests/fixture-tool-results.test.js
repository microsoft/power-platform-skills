'use strict';
// Corpus consistency for recorded feature-flag probes.
//
// Contract-2 fixtures record each command a run made in tool-results.json, including the
// feature-gate probes `node .../scripts/lib/feature-flags.js <flag>`, which print `enabled` /
// `disabled`. A synthetic trace once recorded `disabled` with exit code 0, contradicting the
// script — and nothing noticed, because no check compares the two. Recorded evidence that the real
// tool could never produce teaches the graders the wrong contract, so pin every recorded probe to
// the exit code the actual script returns for that output, measured here by running it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const FLAGS_SCRIPT = path.join(REPO, 'plugins', 'model-apps', 'scripts', 'lib', 'feature-flags.js');
const FIXTURES = path.join(__dirname, '..', 'fixtures');

/** Exit code the real script returns for a flag forced on/off through its env override. */
function measuredExit(flag, on) {
  // GENPAGE_ENABLE_<FLAG> outranks feature-flags.json (see the script's precedence), so this
  // measures both outputs without depending on the committed flag values.
  const envName = `GENPAGE_ENABLE_${flag.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const r = spawnSync(process.execPath, [FLAGS_SCRIPT, flag], { encoding: 'utf8', env: { ...process.env, [envName]: on ? '1' : '0' } });
  return { code: r.status, out: r.stdout.trim() };
}

function recordedProbes() {
  const out = [];
  for (const dir of fs.readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const file = path.join(FIXTURES, dir.name, 'tool-results.json');
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const events = Array.isArray(data) ? data : data.events || [];
    for (const ev of events) {
      // e.g. "node 'D:/repo/plugins/model-apps/scripts/lib/feature-flags.js' custom-api"
      //      "node scripts\\lib\\feature-flags.js custom-api"
      const m = /feature-flags\.js['"]?\s+([a-z][a-z0-9-]*)\b/.exec(String(ev.command || ''));
      if (m && typeof ev.result === 'string' && 'exitCode' in ev) out.push({ fixture: dir.name, id: ev.id, flag: m[1], result: ev.result, exitCode: ev.exitCode });
    }
  }
  return out;
}

test('feature-flags.js exits 0 for enabled and 1 for disabled (the contract the fixtures record)', () => {
  assert.deepEqual(measuredExit('custom-api', true), { code: 0, out: 'enabled' });
  assert.deepEqual(measuredExit('custom-api', false), { code: 1, out: 'disabled' });
});

test('every recorded feature-flag probe pairs its output with the exit code the script returns', () => {
  const probes = recordedProbes();
  assert.ok(probes.length > 0, 'expected recorded feature-flag probes in the corpus');
  const expected = { enabled: 0, disabled: 1 };
  const wrong = probes.filter((p) => expected[p.result] !== p.exitCode)
    .map((p) => `${p.fixture} ${p.id}: ${p.flag} → ${JSON.stringify(p.result)} with exitCode ${p.exitCode} (the script exits ${expected[p.result]})`);
  assert.deepEqual(wrong, []);
});

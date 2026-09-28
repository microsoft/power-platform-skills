'use strict';
// Layer 3 eval: lock the runtime phase/step SEQUENCE of a build (as tee'd into the build journal).
// Unlike the dry-run plan golden, this captures what actually executes — idempotency skips, the
// default-view enrichment step, publish, etc. A drift here means the build's behavior changed.
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildModelApp } = require('../build-model-app.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { assertGolden } = require('./helpers/golden.js');

const sample = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', `app-spec.${n}.json`), 'utf8'));

async function captureSequence(spec, opts) {
  const { sdk } = makeSimpleMockSdk();
  const seq = [];
  const journal = { path: 'x', record: (e) => seq.push(`${e.phase}\t${e.status}\t${e.label}`), close: () => {} };
  await buildModelApp(spec, { apply: true, env: 'https://x', ...opts }, { sdk, journal });
  return seq.join('\n') + '\n';
}

test('journal eval: project-tracker build step sequence', async () => {
  assertGolden('journal.project-tracker.txt', await captureSequence(sample('project-tracker'), {}));
});

test('journal eval: support-desk build step sequence (with sample data)', async () => {
  assertGolden('journal.support-desk.txt', await captureSequence(sample('support-desk'), { sampleData: true }));
});

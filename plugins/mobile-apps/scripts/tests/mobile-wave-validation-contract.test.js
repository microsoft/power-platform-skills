'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const screenBuilder = fs.readFileSync(path.join(pluginRoot, 'agents', 'screen-builder.md'), 'utf8');
const createSkill = fs.readFileSync(
  path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
  'utf8',
);

function bashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
}

test('screen builders retain lexical validation without running semantic AST', () => {
  const validationStep = screenBuilder.slice(
    screenBuilder.indexOf('## Step 4 — Validate the written screen'),
    screenBuilder.indexOf('## Step 5 — Return Status'),
  );
  const dispatcherBlocks = bashBlocks(validationStep).filter(
    (block) => block.includes('validate-mobile-files.js'),
  );
  assert.equal(dispatcherBlocks.length, 1);
  assert.match(dispatcherBlocks[0], /--lexical-only/);
  assert.doesNotMatch(dispatcherBlocks[0], /validate-mobile-ast\.js/);
  assert.match(validationStep, /do not run\s+`validate-mobile-ast\.js`/i);
});

test('create flow runs one complete-wave semantic batch before TypeScript', () => {
  const waveGate = createSkill.slice(
    createSkill.indexOf('After handling every builder status in the wave'),
    createSkill.indexOf('Common wave-gate repair classes'),
  );
  const semanticIndex = waveGate.indexOf('validate-mobile-files.js');
  const typeScriptIndex = waveGate.indexOf('npx tsc --noEmit');
  const dispatcherBlocks = bashBlocks(waveGate).filter(
    (block) => block.includes('validate-mobile-files.js'),
  );
  assert.equal(dispatcherBlocks.length, 1);
  assert.doesNotMatch(dispatcherBlocks[0], /--lexical-only/);
  assert.doesNotMatch(dispatcherBlocks[0], /validate-mobile-ast\.js/);
  assert.ok(semanticIndex >= 0, 'wave gate must invoke the batch dispatcher');
  assert.ok(typeScriptIndex > semanticIndex, 'semantic batch must run before the TypeScript gate');
  assert.match(waveGate, /one --file "<target_file>" argument per screen in the current wave/);
  assert.match(waveGate, /re-spawn only the affected screen-builders/);
  assert.match(waveGate, /rerun the same complete-wave\s+batch/i);
  assert.match(waveGate, /Do not run TypeScript or launch the next wave until this\s+gate exits `0`/i);
});

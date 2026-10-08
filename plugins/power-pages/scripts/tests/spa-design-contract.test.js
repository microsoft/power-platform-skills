'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const pluginRoot = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');
const digest = (text) => createHash('sha256').update(text).digest('hex');

// These contracts come from PR #691, merge 4d90f8783c4a08043b86fbcff8d3aded3c1b0038.
// Classic adapters may reuse them, not change SPA behavior. Update these fingerprints
// only for an intentional SPA change. Normalize checkout line endings for Windows.
// https://github.com/microsoft/power-platform-skills/pull/691
test('classic adoption leaves upstream SPA references, capture and plan rendering unchanged', () => {
  const contracts = {
    'references/design-aesthetics.md': '9360c9c282012ff5edfea01a00fe82c9e1a5d649b8c29c5fa57ea3297f5885a4',
    'references/page-blueprints.md': '69f27e3328862be7ebe1908be028388a60b7378080b32c91a5142d3c2a5fbb7c',
    'references/design-critique.md': 'c28ed5b1952b4b627c43775b94eb7f76b234100fa45510358be5fd2def0212be',
    'scripts/capture-design-review.js': '8e42cb9161baa6e67ba0fc4c191cf95291afd7f34743100c83dcf105d00df023',
    'scripts/axe-audit.js': '6c02337e05f5b636fb25b68381b9158c08d6a16a1c92424cd4a8de324a67d5ba',
    'scripts/render-createsite-plan.js': 'd006e45cee4ec1a667b60a7d05f5a8dfa7244b70238edc8e8ced7ba8970e6fa1',
    'skills/create-site/assets/create-site-plan.html': '09bfd3c168e5a83a65fa80b7b8414101b9cfdb0316b9664bedf66043cf02811b',
  };
  for (const [file, expected] of Object.entries(contracts)) {
    assert.equal(digest(read(file)), expected, file);
  }
});

test('classic dispatch does not rewrite the SPA standalone review workflow', () => {
  const source = read('skills/exceptional-web-design/SKILL.md');
  const bodyStart = source.indexOf('# Exceptional Web Design');
  assert.ok(bodyStart > 0);
  const dispatch = source.slice(0, bodyStart);
  assert.match(dispatch, /workflows\/classic-site\.md/);
  assert.match(dispatch, /do not continue into the workflow below/);
  assert.match(dispatch, /Do not add native discovery or questions to an already identified code site/);
  assert.equal(digest(source.slice(bodyStart)), 'efcd3ea21ab8524063222b95e7a39400da0aca34f0173b802e7fee2582b5381b');
});

test('SPA typography, implementation and critique completion retain the upstream contract', () => {
  const source = read('skills/create-site/SKILL.md');
  const routed = source.split('## Code-Site Workflow');
  assert.equal(routed.length, 2);
  assert.match(routed[0], /classic exceptions never alter SPA fonts/i);
  assert.doesNotMatch(routed[1], /style-site\/references\/design-critique|workflows\/classic-site/);
  const start = source.indexOf('### 5.7 Design Critique Pass');
  const end = source.indexOf('## Phase 6: Accessibility Verification');
  assert.ok(start >= 0 && end > start);
  assert.equal(digest(source.slice(start, end)), '40eb272ecbfcc6bf25c68e88c97c99cc395a91e5f19a1016f895f19a37516d40');
  const foundations = source.split('\n').find((line) => line.startsWith('1. **Design foundations**'));
  assert.ok(foundations);
  assert.equal(digest(foundations), '804aeb0a5ef531dfc94525d1b94b47dfff5a738900af2c18f0970e75c22cac75');
  const typography = source.split('\n').find((line) => line.startsWith('| `TYPOGRAPHY_DATA`'));
  assert.ok(typography);
  assert.equal(digest(typography), '5359be6c6bce58f855b4411488b679a8d6b6a02da73d1c14f37f397ffe837aeb');
  assert.match(source, /Chosen Google Fonts verified loaded by the font check/);
});

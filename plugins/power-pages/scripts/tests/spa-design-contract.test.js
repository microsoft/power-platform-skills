'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(pluginRoot, ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');

test('non-SPA dispatch remains isolated from the SPA standalone review workflow', () => {
  const source = read('skills/exceptional-web-design/SKILL.md');
  const bodyStart = source.indexOf('# Exceptional Web Design');
  assert.ok(bodyStart > 0);
  const dispatch = source.slice(0, bodyStart);
  const spaWorkflow = source.slice(bodyStart);

  assert.match(dispatch, /workflows\/non-spa-site\.md/);
  assert.match(dispatch, /do not continue into the workflow below/);
  assert.match(dispatch, /Do not add native discovery or questions to an already identified SPA site/);
  assert.doesNotMatch(spaWorkflow, /workflows\/non-spa-site\.md/);

  assert.match(spaWorkflow, /references\/design-aesthetics\.md/);
  assert.match(spaWorkflow, /references\/page-blueprints\.md/);
  assert.match(spaWorkflow, /references\/design-critique\.md/);
  assert.match(spaWorkflow, /capture-design-review\.js" --input - --axe/);
  assert.match(spaWorkflow, /Score the rubric/);
  assert.match(spaWorkflow, /mark every critical gate pass or fail/);
  assert.match(spaWorkflow, /\{"cleanup": "<outputDir>"\}/);
});

test('SPA creation retains typography, critique, and accessibility completion contracts', () => {
  const source = read('skills/create-site/SKILL.md');
  const routed = source.split('## Phase 2: Scaffold & Launch Dev Server');
  assert.equal(routed.length, 2);
  assert.match(routed[0], /Non-SPA \(Liquid \+ Web Template\)/);
  assert.doesNotMatch(routed[1], /edit-site\/references\/styling\/design-critique|workflows\/classic-site/);

  assert.match(source, /\| `TYPOGRAPHY_DATA` \|.*verified faces table in design-aesthetics\.md/);
  assert.match(source, /1\. \*\*Design foundations\*\*.*logical CSS properties/);
  assert.match(source, /Add the chosen Google Fonts to the entry HTML's font `<link>`/);

  const critiqueStart = source.indexOf('### 5.7 Design Critique Pass');
  const accessibilityStart = source.indexOf('## Phase 6: Accessibility Verification');
  assert.ok(critiqueStart >= 0 && accessibilityStart > critiqueStart);
  const critique = source.slice(critiqueStart, accessibilityStart);
  assert.match(critique, /capture-design-review\.js" --input -/);
  assert.match(critique, /Apply every fix from the scorecard/);
  assert.match(critique, /No critical gate fails and every category scores 3 or more/);
  assert.match(critique, /A critical design gate still fails after three critique rounds/);
  assert.match(critique, /Do NOT proceed to Phase 6 until ALL customization is complete and the 5\.7 critique pass is complete/);

  const accessibility = source.slice(accessibilityStart);
  assert.match(accessibility, /WCAG 2\.2 AA/);
  assert.match(accessibility, /axe-audit\.js" --input -/);
  assert.match(accessibility, /critical.*serious.*violation/);
  assert.match(source, /Chosen Google Fonts verified loaded by the font check/);
});

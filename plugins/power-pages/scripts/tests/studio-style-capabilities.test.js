'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./style-site-fixtures');
const { studioSupport, capabilityMap, createStudioSupport, requestSupport } = require('../lib/studio-style-capabilities');
const { preparePlan, validateRequest, compileStyles } = require('../lib/style-site-plan');
const { analyzeStyle } = require('../lib/style-site-css');
const { applyPlan } = require('../../skills/style-site/scripts/apply-style-plan');
const { verify } = require('../../skills/style-site/scripts/validate-style-site');
const { reviewPlan } = require('../lib/style-site-summary');

test('the supplied component/property examples retain their distinct capabilities', () => {
  for (const [component, property, status] of [
    ['Text', 'text-shadow', 'supported'], ['Button', 'text-shadow', 'unsupported'],
    ['Text', 'text-align', 'supported'], ['Button', 'text-align', 'unsupported'],
    ['Image', 'opacity', 'unsupported'], ['Section', 'opacity', 'supported'],
    ['Button', 'background-color', 'supported'], ['Image', 'background-color', 'unsupported'],
    ['Section', 'background-color', 'unsupported'], ['Section', 'Overlay', 'supported'],
    ['Flex container', 'box-shadow', 'supported'], ['Section', 'box-shadow', 'unsupported'],
    ['Text', 'flex-direction', 'unsupported'], ['Text', 'gap', 'conditional'],
    ['Form heading', 'font-size', 'supported'], ['Form instructions', 'font-size', 'supported'],
    ['Form section title', 'font-size', 'supported'], ['Linked image', 'border-radius', 'supported'],
    ['Video', 'border-radius', 'supported'], ['Heading 3', 'font-family', 'supported'],
    ['Heading 4', 'font-family', 'unknown'], ['Custom card', 'padding', 'unknown'],
    ['Form', 'font-size', 'unknown'], ['List', 'text-align', 'unknown'],
  ]) {
    assert.equal(studioSupport.lookup(component, property).status, status, `${component}: ${property}`);
  }
  for (const component of ['Text', 'Button', 'Image', 'Section', 'Flex container']) {
    assert.equal(studioSupport.lookup(component, 'transition').status, 'unsupported');
    for (const property of ['display', 'position', 'width', 'height', 'min-width', 'max-width', 'min-height',
      'max-height', 'margin', 'padding', 'top', 'right', 'bottom', 'left',
      'transform.rotate', 'transform.scale', 'transform.translateX', 'transform.translateY']) {
      assert.equal(studioSupport.lookup(component, property).status, 'supported', `${component}: ${property}`);
    }
  }
});

test('Flex availability is independent of family membership and never inferred from Bootstrap', () => {
  assert.equal(studioSupport.lookup('Text', 'gap', 'available').status, 'supported');
  assert.equal(studioSupport.lookup('Text', 'gap', 'unavailable').status, 'unsupported');
  assert.equal(studioSupport.lookup('Text', 'flex-direction', 'available').status, 'unsupported');
  assert.equal(studioSupport.lookup('Section', 'gap', 'available').status, 'unsupported');
  for (const property of ['flex-direction', 'justify-content', 'align-items', 'align-content', 'align-self',
    'gap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order']) {
    assert.equal(studioSupport.lookup('Flex container', property).status, 'conditional');
    assert.equal(studioSupport.lookup('Flex container', property, 'available').status, 'supported');
  }
  assert.throws(() => studioSupport.lookup('Text', 'gap', 'bootstrap5'), /Flex availability/);
});

test('normalize only documented expansions without conflating CSS properties or controls', () => {
  for (const [property, expected] of [
    ['padding-left', 'padding'], ['margin-top', 'margin'],
    ['border-width', 'border'], ['border-color', 'border'], ['border-style', 'border'],
    ['border-top-left-radius', 'border-radius'],
  ]) {
    const result = studioSupport.lookup('Button', property);
    assert.equal(result.canonicalProperty, expected);
    assert.equal(result.status, 'supported');
  }
  for (const property of ['outline', 'outline-color', 'stroke', 'border-top-color', 'margin-inline-start', 'transform', 'color']) {
    assert.equal(studioSupport.lookup('Button', property).status, 'unsupported', property);
  }
  assert.notEqual(studioSupport.lookup('Section', 'Overlay').canonicalProperty, 'background-color');
});

test('unknown families, states and other Studio surfaces never acquire invented support', () => {
  const base = { id: 'example', owner: 'custom', declarations: { 'background-color': '#fff' } };
  const unknown = studioSupport.assessStyle({ ...base, kind: 'button' });
  assert.equal(unknown.properties[0].status, 'unknown', 'Descriptor kind is not a native family.');
  assert.match(unknown.warnings[0], /unverified/);
  const hover = studioSupport.assessStyle({ ...base, studioComponent: 'Button', part: ' .btn:hover' });
  assert.equal(hover.properties[0].status, 'unknown');
  const theme = studioSupport.assessStyle({ ...base, owner: 'studio' });
  assert.deepEqual(theme.warnings, [], 'Do not classify a separate theme handoff as a Design-panel failure.');
});

test('missing or inconsistent canonical maps fail explicitly', () => {
  const map = structuredClone(capabilityMap);
  map.componentFamilies.button.editable.Standard.push('not-a-control');
  assert.throws(() => createStudioSupport(map), /mapping/);
  assert.throws(() => createStudioSupport({}), /capability map/);
  assert.throws(() => studioSupport.lookup('', 'padding'), /component/);
  assert.throws(() => studioSupport.assessStyle({ declarations: {} }), /1-100 properties/);
});

function warnedRequest(f) {
  f.request.styles[0] = {
    ...f.request.styles[0], studioComponent: 'Button', part: ' .btn',
    declarations: { 'text-shadow': '0 1px 2px #000000', 'text-align': 'left', opacity: '0.9', transition: 'opacity 150ms ease', cursor: 'pointer' },
    rationale: 'These properties have no Button Design-panel controls; maintain scoped CSS in VS Code.',
  };
}

test('unlisted properties prepare, review and apply with persistent Studio warnings', (t) => {
  const f = fixture(t);
  warnedRequest(f);
  const plan = preparePlan(f.root, f.request);
  const warning = plan.warnings.find((entry) => entry.includes('Not editable through'));
  assert.match(warning, /Button's Studio Design panel/);
  for (const property of Object.keys(f.request.styles[0].declarations)) assert.ok(warning.includes(property), property);
  const review = reviewPlan(plan);
  assert.ok(review.studioSupport[0].properties.every((entry) => entry.status === 'unsupported'));
  assert.match(plan.writes[0].after, /\.pp-card \.btn \{/);
  assert.match(plan.writes[0].after, /text-shadow: 0 1px 2px #000000;/);
  assert.ok(review.warnings.includes(warning));
  assert.equal(review.studioRuntime, 'pending-separate-live-verification');
  const receipt = path.join(f.work, 'receipt.json');
  const result = applyPlan(plan, { apply: true, approvedHash: plan.planHash, receipt });
  assert.equal(result.status, 'applied');
  assert.match(result.warnings.join('\n'), /Not editable through Button's Studio Design panel/);
  assert.equal(verify(plan, JSON.parse(fs.readFileSync(receipt))).status, 'verified-local-files');
  assert.equal(applyPlan(plan).status, 'already-applied');
  assert.deepEqual(applyPlan(plan).warnings, result.warnings);
});

test('unsupported and unavailable Design properties cannot be mislabeled as Studio handoffs', (t) => {
  const f = fixture(t);
  warnedRequest(f);
  f.request.styles[0].owner = 'studio';
  f.request.styles[0].handoffReason = 'user-requested';
  f.request.styles[0].studioAction = 'An invalid Design-panel instruction.';
  assert.throws(() => validateRequest(f.request), /custom CSS with its warning/);
  Object.assign(f.request.styles[0], { studioComponent: 'Text', part: '', declarations: { gap: '8px' }, studioFlex: 'unavailable' });
  assert.throws(() => validateRequest(f.request), /does not expose/);
  f.request.styles[0].studioFlex = 'available';
  assert.doesNotThrow(() => validateRequest(f.request));
  delete f.request.styles[0].studioFlex;
  assert.match(preparePlan(f.root, f.request).warnings.join('\n'), /Flex-tab support is unconfirmed/);
  f.request.styles[0].studioFlex = true;
  assert.throws(() => validateRequest(f.request), /studioFlex/);
});

test('conditional or unlisted flex controls remain usable as safe custom CSS', (t) => {
  const f = fixture(t);
  f.request.styles[0].studioComponent = 'Text';
  f.request.styles[0].declarations = { 'flex-direction': 'column', 'flex-grow': '1', 'align-self': 'center', order: '2' };
  assert.doesNotThrow(() => preparePlan(f.root, f.request));
  const support = requestSupport(f.request)[0];
  assert.equal(support.properties.find((entry) => entry.property === 'flex-grow').status, 'conditional');
  assert.equal(support.properties.find((entry) => entry.property === 'flex-direction').status, 'unsupported');
});

test('general CSS retains Studio warnings without treating the component map as a value allowlist', (t) => {
  const f = fixture(t);
  warnedRequest(f);
  const css = compileStyles(f.request)[0].css;
  assert.match(css, /transition: opacity 150ms ease;/);
  assert.match(css, /text-shadow: 0 1px 2px #000000;/);
  for (const [property, value] of [
    ['text-shadow', '0 1px 2px #000000'], ['text-shadow', '-1px 0 0 currentColor'],
    ['text-shadow', '0 1px 2px var(--shadow-color)'], ['text-shadow', 'none'],
    ['transition', 'background-color 0.15s ease-out'], ['cursor', 'pointer'],
    ['transition', 'all 1s ease'], ['box-shadow', 'inset 1px -2px 3px rgb(0 0 0 / 25%), 0 12px 32px #0002'],
    ['font-family', '"Contoso Sans", system-ui, sans-serif'], ['transform', 'translateY(-2px) scale(1.05)'],
  ]) {
    f.request.styles[0].declarations = { [property]: value };
    assert.doesNotThrow(() => validateRequest(f.request), value);
  }
  for (const [property, value] of [
    ['text-shadow', '0 1px 2px url(https://example.invalid)'],
    ['text-shadow', '0 1px 2px #000;display:none'], ['text-shadow', '0 1px 2px #000 !important'],
    ['cursor', 'url(https://example.invalid),pointer'], ['flex-direction', 'column;display:none'],
  ]) {
    f.request.styles[0].declarations = { [property]: value };
    assert.throws(() => validateRequest(f.request), undefined, value);
  }
  f.request.styles[0].declarations = { 'text-shadow': '0 1px 2px inherit' };
  const analysis = analyzeStyle(f.request.styles[0], f.request.components[0]);
  assert.ok(analysis.warnings.length, 'Unverified value grammar requires an explicit correction/compatibility review, not silent acceptance.');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sectionLayout } = require('../lib/classic-native-layout');
const { validateCustomizationPlan, planHash } = require('../lib/customize-declarative-site-plan');
const { renderCustomizationPlan } = require('../render-customize-declarative-site-plan');
const { renderDocument } = require('./customization-plan-test-helpers');

test('legacy names resolve without imposing their catalogue on explicit spans', () => {
  for (const [name, spans] of [
    ['one-column', [12]], ['two-equal-columns', [6, 6]], ['three-equal-columns', [4, 4, 4]],
    ['one-third-left', [4, 8]], ['one-third-right', [8, 4]],
  ]) {
    assert.deepEqual(sectionLayout({ layout: name, columns: spans.map(() => ({})) }), { source: 'preset', spans });
  }
  for (const spans of [[3, 3, 3, 3], [3, 9], [7, 5], [1, 11], [12, 12], [3, 3]]) {
    const layout = sectionLayout({ layout: 'requirement-led', columns: spans.map((span) => ({ span })) });
    assert.deepEqual(layout.spans, spans);
    assert.match(layout.warning, /Studio editing compatibility unverified/);
  }
  assert.deepEqual(sectionLayout({ layout: 'CSS grid', columns: [{}, {}] }),
    { source: 'unresolved', spans: null });
});

test('explicit grid positions preserve wrapping and unused space', () => {
  const layout = sectionLayout({ columns: [7, 5, 3, 3, 9].map((span) => ({ span })) });
  assert.deepEqual(layout.positions, [
    { row: 1, start: 1, span: 7 }, { row: 1, start: 8, span: 5 },
    { row: 2, start: 1, span: 3 }, { row: 2, start: 4, span: 3 },
    { row: 3, start: 1, span: 9 },
  ]);
});

test('malformed new descriptors fail rather than silently overriding a preset', () => {
  for (const span of [0, 13, -1, 1.5, '3', '3; color:red', null]) {
    assert.throws(() => sectionLayout({ columns: [{ span }] }), /integer span/);
  }
  assert.throws(() => sectionLayout({ columns: [{ span: 7 }, {}] }), /every column/);
  assert.throws(() => sectionLayout({ layout: 'two-equal-columns', columns: [{ span: 7 }, { span: 5 }] }), /conflict/);
  assert.equal(sectionLayout({ layout: 'three-equal-columns', columns: [{}] }).source, 'unresolved',
    'Old incomplete input retains its nonblocking presentation behavior.');
});

test('explicit spans and compatibility warnings survive the classic plan renderer and hash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'customize-declarative-site-plan.json')));
  const operation = plan.operations[1];
  operation.inputs.sections = [{
    layout: 'Bespoke <layout>', columns: [7, 5, 3, 3].map((span, index) => ({
      span, elements: index === 3 ? [] : [{ type: 'text', content: `Column ${index + 1}` }],
    })),
  }];
  const before = JSON.stringify(plan);
  const hash = planHash(plan);
  assert.equal(validateCustomizationPlan(plan), plan);
  const file = path.join(root, 'plan.html');
  renderCustomizationPlan(plan, file, { emitStatus: false });
  assert.equal(JSON.stringify(plan), before);
  const output = renderDocument(fs.readFileSync(file, 'utf8')).get('pageChanges').innerHTML;
  assert.match(output, /grid-template-columns:repeat\(12,minmax\(0,1fr\)\)/);
  assert.match(output, /grid-column:8\/span 5;grid-row:1/);
  assert.match(output, /grid-column:4\/span 3;grid-row:2/);
  assert.match(output, /Empty column/);
  assert.match(output, /Studio editing compatibility unverified/);
  assert.match(output, /Bespoke &lt;Layout&gt;/);
  assert.doesNotMatch(output, /Column widths unresolved/);
  operation.inputs.sections[0].columns[0].span = 6;
  assert.notEqual(planHash(plan), hash);
});

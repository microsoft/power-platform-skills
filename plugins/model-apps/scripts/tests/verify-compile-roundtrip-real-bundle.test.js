'use strict';
// COMPILE -> SERIALIZE -> VERIFY round trip against the REAL vendored bundle.
//
// `--verify` judges a deployed form against the spec; the compiler decides what that form should
// be. When the two derive the same rule separately they drift, and the verifier then fails forms
// that deployed exactly as compiled. That happened: the verifier read a section's raw `columns`
// while the compiler defaults an omitted value to 1 and caps QuickCreate sections at 1, so both
// shapes below were reported as wrong. Measured before the fix, on the real compiler and bundle:
//   omitted columns + colspan 2 -> "field 'new_notes' has colspan 1, the spec declares 2"
//   QuickCreate, columns: 2    -> "section 'sec_x' is deployed 1 column(s) wide, the spec declares 2"
//
// So the expectation here is not hand-written: every case is compiled by the real compiler,
// serialized by the real bundle, and must then verify. The negative control proves the oracle is
// not vacuous — the same pipeline with one span tampered must FAIL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const ai = require('../lib/artifact-intent.js');
const { verifySpec } = require('../lib/verify-spec.js');

const META = { new_ticket: { new_name: 'String', new_notes: 'Memo', new_code: 'String', new_area: 'String' } };
const NOTES_CLASS_ID = '06375649-C143-495E-A496-C962E5B4488E';
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const baseSpec = () => ({
  $schemaVersion: '1.0',
  solution: { uniqueName: 's', displayName: 'S', publisherPrefix: 'new' },
  app: { name: 'A', uniqueName: 'new_a' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [
      { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' },
      { schemaName: 'new_code', displayName: 'Code', type: 'Text' },
      { schemaName: 'new_area', displayName: 'Area', type: 'Text' },
    ] }],
});

// The formxml the real bundle would send for a compiled form — the engine's createFormShell order.
async function compiledFormXml(spec, form) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const cap = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rt-'));
  dirs.push(dir);
  const httpClient = {
    get: async (url) => {
      const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (m && META[m[1]]) {
        return { status: 200, headers: {}, body: { LogicalName: m[1], EntitySetName: `${m[1]}s`,
          Attributes: Object.entries(META[m[1]]).map(([LogicalName, AttributeType]) => ({ LogicalName, AttributeType })) } };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async (url, body) => { cap.push(body); return { status: 204, headers: { 'odata-entityid': 'https://x/y(11111111-1111-1111-1111-111111111111)' }, body: {} }; },
    patch: async (url, body) => { cap.push(body); return { status: 204, headers: {}, body: {} }; },
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://example.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  const intent = ai.compileFormIntent(spec, form, { notesClassId: NOTES_CLASS_ID });
  const art = await sdk.createArtifact('form', { name: intent.name, entityLogicalName: intent.entityLogicalName, formType: intent.formType, status: intent.status });
  for (const tab of intent.tabs) await sdk.addElement('form', art.id, '/tabs', tab);
  await sdk.removeElement('form', art.id, '/tabs/0');
  await sdk.pushArtifact('form', art.id);
  const xml = String((cap.find((c) => c && typeof c.formxml === 'string') || {}).formxml || '');
  assert.ok(xml.includes('<section'), 'the bundle must have serialized a form');
  return xml;
}

async function topologyVerdict(form, tamper) {
  const spec = baseSpec();
  spec.forms = [form];
  let xml = await compiledFormXml(spec, form);
  if (tamper) xml = tamper(xml);
  const read = {
    findTable: async () => ({ logicalName: 'new_ticket' }),
    findColumns: async () => [],
    sitemapXml: async () => '',
    queryRecords: async (set) => (set === 'systemform'
      ? [{ formid: 'f1', name: form.name, objecttypecode: 'new_ticket', type: form.formType === 'QuickCreate' ? 7 : 2, isdefault: true }] : []),
    formTopology: async () => xml,
  };
  const res = await verifySpec(spec, read);
  return (res.checks || []).find((c) => c.kind === 'form-topology');
}

const explicit = (section, extra = {}) => ({ entity: 'new_ticket', name: 'Main', ...extra,
  tabs: [{ name: 'tab_x', label: 'X', sections: [{ name: 'sec_x', label: 'X', ...section }] }] });

// Every display flag, form-column widths both declared and left to the compiler's equal split, and more
// than one tab and section to put in order — the attributes verify compares beyond placement and spans.
const STATEFUL = () => ({ entity: 'new_ticket', name: 'Main', tabs: [
  { name: 'tab_a', label: 'A', columns: [
    { width: '70%', sections: [
      { name: 'sec_a1', label: 'A1', fields: [{ name: 'new_name', readOnly: true }, { name: 'new_code', hidden: true }] },
      { name: 'sec_a2', label: 'A2', visible: false, showLabel: false, fields: ['new_area'] }] },
    { width: '30%', sections: [{ name: 'sec_a3', label: 'A3', fields: [] }] }] },
  { name: 'tab_b', label: 'B', expanded: false, columns: [{ sections: [{ name: 'sec_b1', label: 'B1', fields: ['new_notes'] }] }, { sections: [] }] },
  { name: 'tab_c', label: 'C', visible: false, sections: [{ name: 'sec_c1', label: 'C1', fields: [] }] },
] });

const CASES = [
  ['a section that omits columns, with a declared colspan', explicit({ fields: ['new_name', { name: 'new_notes', colspan: 2 }] })],
  ['a QuickCreate section that asks for 2 columns', explicit({ columns: 2, fields: ['new_name', 'new_code'] }, { name: 'Quick', formType: 'QuickCreate' })],
  ['a colspan wider than its section (clamped by the compiler)', explicit({ columns: 2, fields: [{ name: 'new_notes', colspan: 4 }, 'new_code'] })],
  ['a four-column section with a full-width field', explicit({ columns: 4, fields: [{ name: 'new_notes', colspan: 4 }, 'new_name', 'new_code', 'new_area'] })],
  ['a declared rowspan on the last field', explicit({ columns: 2, fields: ['new_name', 'new_code', { name: 'new_notes', rowspan: 3 }] })],
  ['a span declared through form-level fieldOptions on a plain string entry',
    { ...explicit({ columns: 2, fields: ['new_name', 'new_notes'] }), fieldOptions: { new_notes: { colspan: 2 } } }],
  ['display state: a collapsed and a hidden tab, a hidden section without its label, a hidden and a read-only field', STATEFUL()],
];

for (const [label, form] of CASES) {
  test(`compile -> verify round trip PASSES: ${label}`, async () => {
    const chk = await topologyVerdict(form);
    assert.ok(chk, 'an explicit layout must produce a form-topology check');
    assert.strictEqual(chk.present, true, `a form that deployed exactly as compiled must verify; got: ${chk.detail}`);
  });
}

test('compile -> verify round trip still FAILS a form that did not deploy as compiled (negative control)', async () => {
  // Same pipeline, one declared span tampered after serialization — the oracle must notice.
  const form = explicit({ columns: 2, fields: ['new_name', { name: 'new_notes', colspan: 2 }] });
  const chk = await topologyVerdict(form, (xml) => xml.replace(/(<cell\b[^>]*?)colspan="2"/, '$1colspan="1"'));
  assert.strictEqual(chk.present, false, 'a tampered span must fail verification');
  assert.match(chk.detail, /new_notes' has colspan 1, the spec declares 2/);
});

// The same control for a span declared through `fieldOptions`. Verify used to check inline objects
// only, so this tampered form PASSED — the span was simply never looked at, and a span change the
// build had to skip went unreported. The expectation now comes from the compiler's own merge.
test('compile -> verify round trip FAILS a tampered span that was declared through fieldOptions', async () => {
  const form = { ...explicit({ columns: 2, fields: ['new_name', 'new_notes'] }), fieldOptions: { new_notes: { colspan: 2 } } };
  const chk = await topologyVerdict(form, (xml) => xml.replace(/(<cell\b[^>]*?)colspan="2"/, '$1colspan="1"'));
  assert.strictEqual(chk.present, false, 'a fieldOptions span that did not deploy must fail verification');
  assert.match(chk.detail, /new_notes' has colspan 1, the spec declares 2/);
});

// The bundle's own FormXML for the stateful form, with ONE attribute changed after serialization — each
// is a difference the build converges, so each must fail. Replacements are scoped to one element by
// name, so a control proves the attribute it names and no other.
const inElement = (tag, name, fn) => (xml) => {
  const re = new RegExp(`<${tag}\\b[^>]*\\bname="${name}"[^>]*>`);
  assert.match(xml, re, `the serialized form has a ${tag} named ${name}`);
  return xml.replace(re, fn);
};
const cellOf = (field, fn) => (xml) => {
  const at = xml.search(new RegExp(`<control\\b[^>]*\\bdatafieldname="${field}"`));
  assert.ok(at > 0, `the serialized form has a control for ${field}`);
  const cellAt = xml.lastIndexOf('<cell', at);
  const cellEnd = xml.indexOf('>', cellAt) + 1;
  const controlEnd = xml.indexOf('>', at) + 1;
  return xml.slice(0, cellAt) + fn(xml.slice(cellAt, cellEnd), xml.slice(cellEnd, at), xml.slice(at, controlEnd)) + xml.slice(controlEnd);
};
const swapFirst = (tag) => (xml) => {
  const re = new RegExp(`(<${tag}\\b[\\s\\S]*?</${tag}>)(<${tag}\\b[\\s\\S]*?</${tag}>)`);
  assert.match(xml, re, `two adjacent ${tag}s to swap`);
  return xml.replace(re, '$2$1');
};
const TAMPER = [
  ['a form-column width', (xml) => xml.replace('width="70%"', 'width="50%"'), /form-column 1 is deployed 50% wide, the spec declares 70%/],
  ['an equal-split width', (xml) => xml.replace(/(<tab\b[^>]*name="tab_b"[\s\S]*?<column\b[^>]*?)width="50%"/, '$1width="60%"'), /tab 'tab_b' form-column 1 is deployed 60% wide, the spec declares 50%/],
  ['a collapsed tab', inElement('tab', 'tab_b', (t) => t.replace(/expanded="false"/, 'expanded="true"')), /tab 'tab_b' is deployed with expanded="true", the spec declares expanded: false/],
  ['a hidden tab', inElement('tab', 'tab_c', (t) => t.replace(/visible="false"/, 'visible="true"')), /tab 'tab_c' is deployed with visible="true", the spec declares visible: false/],
  ['a hidden section', inElement('section', 'sec_a2', (s) => s.replace(/visible="false"/, 'visible="true"')), /section 'sec_a2' is deployed with visible="true", the spec declares visible: false/],
  ['a section label display', inElement('section', 'sec_a2', (s) => s.replace(/showlabel="false"/, 'showlabel="true"')), /section 'sec_a2' is deployed with showlabel="true", the spec declares showLabel: false/],
  ['a hidden field', cellOf('new_code', (cell, labels, control) => cell.replace(/visible="false"/, 'visible="true"') + labels + control), /field 'new_code' is deployed with visible="true", the spec declares hidden: true/],
  ['a read-only field', cellOf('new_name', (cell, labels, control) => cell + labels + control.replace(/disabled="true"/, 'disabled="false"')), /field 'new_name' is deployed with disabled="false", the spec declares readOnly: true/],
  ['the order of two sections', swapFirst('section'), /the sections of tab 'tab_a' form-column 1 are deployed in the order sec_a2, sec_a1; the spec orders them sec_a1, sec_a2/],
  ['the order of two tabs', swapFirst('tab'), /the tabs are deployed in the order tab_b, tab_a, tab_c; the spec orders them tab_a, tab_b, tab_c/],
];
for (const [what, tamper, expected] of TAMPER) {
  test(`compile -> verify round trip FAILS the bundle's own form with ${what} changed`, async () => {
    const chk = await topologyVerdict(STATEFUL(), (xml) => {
      const changed = tamper(xml);
      assert.notStrictEqual(changed, xml, `the control must change the serialized form (${what})`);
      return changed;
    });
    assert.strictEqual(chk.present, false, `${what} that did not deploy as compiled must fail verification`);
    assert.match(chk.detail, expected);
  });
}

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

const CASES = [
  ['a section that omits columns, with a declared colspan', explicit({ fields: ['new_name', { name: 'new_notes', colspan: 2 }] })],
  ['a QuickCreate section that asks for 2 columns', explicit({ columns: 2, fields: ['new_name', 'new_code'] }, { name: 'Quick', formType: 'QuickCreate' })],
  ['a colspan wider than its section (clamped by the compiler)', explicit({ columns: 2, fields: [{ name: 'new_notes', colspan: 4 }, 'new_code'] })],
  ['a four-column section with a full-width field', explicit({ columns: 4, fields: [{ name: 'new_notes', colspan: 4 }, 'new_name', 'new_code', 'new_area'] })],
  ['a declared rowspan on the last field', explicit({ columns: 2, fields: ['new_name', 'new_code', { name: 'new_notes', rowspan: 3 }] })],
  ['a span declared through form-level fieldOptions on a plain string entry',
    { ...explicit({ columns: 2, fields: ['new_name', 'new_notes'] }), fieldOptions: { new_notes: { colspan: 2 } } }],
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

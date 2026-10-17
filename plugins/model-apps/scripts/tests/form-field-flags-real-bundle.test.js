'use strict';
// REAL BUNDLE: a field the spec makes read-only or hidden is flagged on EVERY cell the form holds of it, and `--verify` holds every
// one of them to it — the cells in the body's sections (a maker's own section or tab included) AND the cells in the form's header and
// footer and in a tab's own header and footer.
//
// The SDK models a form's tabs, sections, rows and cells. It does not model the header and the footer, nor a tab's own `tabheader` and
// `tabfooter`: it keeps their XML in the bag of the form (or of the tab) and writes it back as it read it. So the cells there are not in
// the topology the build walks and `--verify` parses for the body, and a field a maker had placed in the header kept its editable control
// and its visible cell after a build asked for the opposite — while verify, walking the same topology, passed it. The build now edits the
// one attribute (the control's `disabled`, the cell's `visible`) of each such cell, through the bag, and leaves every other attribute and
// child of the node as it was; verify reads those cells as well. This pins all of it against the real bundle's own serializer and fetch,
// for a Main form with an explicit and with an auto layout; the QuickCreate form (which has no header or footer) is the control.
const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/artifact-intent.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { guid, createHarness, seedForm, verifyForms } = require('./helpers/form-store-harness.js');

const TEXT_CLASS = '{4273EDBD-AC1D-40D3-9FB2-095C621B552D}';
const harnesses = [];
test.after(() => { for (const h of harnesses) h.cleanup(); });

function formSpec({ formType, layout }) {
  const form = { entity: 'new_ticket', name: 'Main', formType, layout, prune: false, notes: false };
  if (layout === 'explicit') {
    form.tabs = [{ name: 'tab_main', label: 'Overview', sections: [{ name: 'sec_main', label: 'Basics', columns: 1, fields: ['new_name', 'new_code', 'new_notes', 'new_area'] }] }];
  }
  return {
    solution: { uniqueName: 'FormProbe', displayName: 'Form Probe', publisherPrefix: 'new' },
    app: { name: 'Form Probe', uniqueName: 'new_formprobe' },
    entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [
      { schemaName: 'new_code', displayName: 'Code', type: 'Text' }, { schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }, { schemaName: 'new_area', displayName: 'Area', type: 'Text' },
    ] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
    forms: [form],
  };
}

// A header or a footer as a maker's form carries it: a cell of the field with attributes and a child the build knows nothing of
// (`data-keep`, `<events>`, `celllabelposition`), which a build that rewrote the part would lose.
const outerXml = (part, ids, { cellVisible = 'true', controlDisabled = 'false' } = {}) => `<${part} id="${ids[0]}" columns="1" celllabelposition="Top"><rows><row>`
  + `<cell id="${ids[1]}" visible="${cellVisible}" data-keep="yes"><labels><label description="Code" languagecode="1033" /></labels>`
  + `<control id="${part}_new_code" classid="${TEXT_CLASS}" datafieldname="new_code" disabled="${controlDisabled}" /><events keep="1" /></cell>`
  + `</row></rows></${part}>`;

// Every cell of `new_code` in the stored FormXML, wherever it sits, with the two states a flag sets.
const fieldCells = (xml, field = 'new_code') => [...xml.matchAll(/<cell\b[^>]*>[\s\S]*?<\/cell>/gi)]
  .filter(([cell]) => new RegExp(`datafieldname="${field}"`, 'i').test(cell))
  .map(([cell]) => ({
    id: /<control\b[^>]*\bid="([^"]+)"/i.exec(cell)[1],
    hidden: /<cell\b[^>]*\bvisible="(?:false|0)"/i.test(cell),
    readOnly: /<control\b[^>]*\bdisabled="(?:true|1)"/i.test(cell),
  }));

async function deployed({ formType = 'Main', layout, options = { readOnly: true, hidden: true }, outer = {}, makerBody = true, tabParts }) {
  const h = createHarness();
  harnesses.push(h);
  const spec = formSpec({ formType, layout });
  const validation = validateAppSpec(spec, { profile: 'plan' });
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors));
  // The form is deployed BEFORE the spec asks for the flags (the compiled cell would carry them otherwise), as a maker's would be.
  const tabs = ai.compileFormIntent(spec, spec.forms[0]).tabs;
  // The field is also in a maker's own section of the main tab and in a maker's own tab: the body placements the build already reached.
  // (A report names the first six problems only, so a test that reads the header's and footer's leaves them out.)
  if (makerBody) {
    tabs[0].columns[0].sections.push({ name: 'maker_section', label: 'Maker section', columns: 1, visible: true, showLabel: true,
      rows: [{ cells: [{ id: guid(901), control: { id: 'maker_section_new_code', fieldName: 'new_code' } }] }] });
    if (formType === 'Main') {
      tabs.push({ name: 'maker_tab', label: 'Maker tab', visible: true, expanded: true, columns: [{ width: '100%', sections: [{ name: 'maker_tab_section', label: 'Maker side', columns: 1, visible: true, showLabel: true,
        rows: [{ cells: [{ id: guid(902), control: { id: 'maker_tab_new_code', fieldName: 'new_code' } }] }] }] }] });
    }
  }
  await seedForm(h, tabs);
  if (formType === 'Main') {
    // The part the SDK serialized (an empty one) is replaced by the maker's, as the platform would hand it back.
    const stripped = h.store.row.formxml.replace(/<(header|footer)\b[^>]*\/>/g, '').replace(/<(header|footer)\b[^>]*>[\s\S]*?<\/\1>/g, '');
    h.store.row.formxml = stripped.replace('</form>', outerXml('header', [guid(911), guid(912)], outer.header) + outerXml('footer', [guid(913), guid(914)], outer.footer) + '</form>');
    if (tabParts) {
      // A tab's own header and footer sit after the tab's labels and before its columns, as the form's schema orders them.
      h.store.row.formxml = h.store.row.formxml.replace(/(<tab\b[^>]*>\s*<labels>[\s\S]*?<\/labels>)/,
        `$1${outerXml('tabheader', [guid(921), guid(922)], tabParts.header)}${outerXml('tabfooter', [guid(923), guid(924)], tabParts.footer)}`);
    }
  } else {
    h.store.row.type = 7; // QuickCreate
  }
  spec.forms[0].fieldOptions = { new_code: options };
  return { h, spec };
}

const rebuild = async (h, spec, warnings = []) => {
  const { sdk } = await h.freshSdk();
  return runSdkBuild(spec, { sdk, apply: true, phases: ['forms'], warn: (m) => warnings.push(m) });
};
const stateChecks = (verification) => verification.checks.filter((c) => ['form-topology', 'form-field-state'].includes(c.kind));

for (const layout of ['explicit', 'auto']) {
  test(`REAL BUNDLE: a Main form (${layout} layout) — the build flags the field in its header and footer too, and keeps every other attribute and child of those parts`, async () => {
    const { h, spec } = await deployed({ layout });
    const before = fieldCells(h.store.row.formxml);
    assert.deepStrictEqual(before.map((c) => c.id).filter((id) => /^(header|footer)_/.test(id)), ['header_new_code', 'footer_new_code'], 'the form holds the field in its header and footer');
    assert.ok(before.every((c) => !c.hidden && !c.readOnly), 'and nothing is flagged yet');

    const warnings = [];
    const result = await rebuild(h, spec, warnings);
    assert.strictEqual(result.ok, true, JSON.stringify(warnings));
    const xml = h.store.row.formxml;
    const after = fieldCells(xml);
    assert.strictEqual(after.length, before.length, 'no cell was added or lost');
    assert.ok(after.every((c) => c.hidden && c.readOnly), `every cell — body, maker section, maker tab, header, footer — is read-only and hidden: ${JSON.stringify(after)}`);

    // Nothing but the two attributes changed in the header and the footer: every id, every other attribute and the unmodeled child.
    for (const part of ['header', 'footer']) {
      const ids = part === 'header' ? [guid(911), guid(912)] : [guid(913), guid(914)];
      const got = new RegExp(`<${part}\\b[\\s\\S]*?</${part}>`).exec(xml)[0];
      assert.strictEqual(got, outerXml(part, ids, { cellVisible: 'false', controlDisabled: 'true' }), `${part}: only visible and disabled differ from the maker's markup`);
    }
  });

  test(`REAL BUNDLE: a Main form (${layout} layout) — verify reads the header and footer cells: it fails them unflagged, names where they are, and passes them once the build flagged them`, async () => {
    const { h, spec } = await deployed({ layout, makerBody: false });
    const unbuilt = stateChecks(await verifyForms(h, spec));
    assert.strictEqual(unbuilt.length, 1);
    assert.strictEqual(unbuilt[0].present, false, 'unflagged header and footer cells must not verify');
    assert.match(unbuilt[0].detail, /field 'new_code' \(another placement, in the form header\) is deployed with visible="true", the spec declares hidden: true/);
    assert.match(unbuilt[0].detail, /field 'new_code' \(another placement, in the form header\) is deployed with disabled="false", the spec declares readOnly: true/);
    assert.match(unbuilt[0].detail, /field 'new_code' \(another placement, in the form footer\) is deployed with visible="true", the spec declares hidden: true/);
    assert.match(unbuilt[0].detail, /field 'new_code' \(another placement, in the form footer\) is deployed with disabled="false", the spec declares readOnly: true/);
    const identities = (await verifyForms(h, spec)).checks.filter((c) => c.kind === 'form-identities');
    assert.ok(identities.every((c) => c.present), 'the form\u2019s identities are not what is wrong');

    await rebuild(h, spec);
    const built = stateChecks(await verifyForms(h, spec));
    assert.strictEqual(built[0].present, true, built[0].detail);
  });

  test(`REAL BUNDLE: a Main form (${layout} layout) — a second build finds the header and footer flagged and writes nothing to them`, async () => {
    const { h, spec } = await deployed({ layout });
    await rebuild(h, spec);
    const settled = h.store.row.formxml;
    h.writes.length = 0;
    await rebuild(h, spec);
    assert.strictEqual(h.store.row.formxml, settled, 'the stored FormXML is the same');
    assert.ok(!h.writes.some((w) => w.method === 'patch'), 'and no PATCH of the form is sent');
  });
}

// A TAB has a header and a footer of its own too (`<tabheader>` / `<tabfooter>`, the same markup as the form's), which the SDK keeps raw in the
// tab's bag. A field a maker placed there is a placement as much as a section's, so the build flags it and verify reads it.
for (const layout of ['explicit', 'auto']) {
  test(`REAL BUNDLE: a Main form (${layout} layout) — a tab's own header and footer are flagged and verified too, the build edits their two attributes only, and a second build writes nothing`, async () => {
    const { h, spec } = await deployed({ layout, makerBody: false, tabParts: {} });
    const before = fieldCells(h.store.row.formxml);
    assert.deepStrictEqual(before.map((c) => c.id).filter((id) => /^tab(header|footer)_/.test(id)), ['tabheader_new_code', 'tabfooter_new_code'], 'the first tab holds the field in its own header and footer');
    const tabName = /<tab\b[^>]*\bname="([^"]+)"/.exec(h.store.row.formxml)[1];

    const unbuilt = stateChecks(await verifyForms(h, spec));
    assert.strictEqual(unbuilt[0].present, false, 'unflagged tab header and footer cells must not verify');
    for (const word of ['header', 'footer']) {
      assert.match(unbuilt[0].detail, new RegExp(`field 'new_code' \\(another placement, in the ${word} of tab '${tabName}'\\) is deployed with visible="true", the spec declares hidden: true`));
      assert.match(unbuilt[0].detail, new RegExp(`field 'new_code' \\(another placement, in the ${word} of tab '${tabName}'\\) is deployed with disabled="false", the spec declares readOnly: true`));
    }

    const warnings = [];
    const result = await rebuild(h, spec, warnings);
    assert.strictEqual(result.ok, true, JSON.stringify(warnings));
    const xml = h.store.row.formxml;
    const after = fieldCells(xml);
    assert.strictEqual(after.length, before.length, 'no cell was added or lost');
    assert.ok(after.every((c) => c.hidden && c.readOnly), `every cell — body, tab header and footer, form header and footer — is read-only and hidden: ${JSON.stringify(after)}`);
    // Nothing but the two attributes changed in the tab's parts: every id, every other attribute and the unmodeled child.
    assert.strictEqual(/<tabheader\b[\s\S]*?<\/tabheader>/.exec(xml)[0], outerXml('tabheader', [guid(921), guid(922)], { cellVisible: 'false', controlDisabled: 'true' }));
    assert.strictEqual(/<tabfooter\b[\s\S]*?<\/tabfooter>/.exec(xml)[0], outerXml('tabfooter', [guid(923), guid(924)], { cellVisible: 'false', controlDisabled: 'true' }));
    const built = stateChecks(await verifyForms(h, spec));
    assert.strictEqual(built[0].present, true, built[0].detail);

    h.writes.length = 0;
    await rebuild(h, spec);
    assert.strictEqual(h.store.row.formxml, xml, 'the stored FormXML is the same');
    assert.ok(!h.writes.some((w) => w.method === 'patch'), 'and no PATCH of the form is sent');
  });
}

test('REAL BUNDLE: verify fails a header or footer cell a maker un-locked after the build, and a rebuild puts it right', async () => {
  const { h, spec } = await deployed({ layout: 'explicit' });
  await rebuild(h, spec);
  h.store.row.formxml = h.store.row.formxml.replace(/(<footer\b[\s\S]*?<control\b[^>]*datafieldname="new_code"[^>]*) disabled="true"/, '$1 disabled="false"');
  const broken = stateChecks(await verifyForms(h, spec))[0];
  assert.strictEqual(broken.present, false);
  assert.match(broken.detail, /field 'new_code' \(another placement, in the form footer\) is deployed with disabled="false", the spec declares readOnly: true/);
  assert.doesNotMatch(broken.detail, /in the form header/, 'only the cell that is wrong is named');
  await rebuild(h, spec);
  assert.strictEqual(stateChecks(await verifyForms(h, spec))[0].present, true);
});

test('REAL BUNDLE: a header or footer cell that is already flagged is left exactly as the maker wrote it', async () => {
  const { h, spec } = await deployed({ layout: 'explicit', outer: { header: { cellVisible: 'false', controlDisabled: 'true' }, footer: { cellVisible: '0', controlDisabled: '1' } } });
  const markup = (part) => new RegExp(`<${part}\\b[\\s\\S]*?</${part}>`).exec(h.store.row.formxml)[0];
  const [header, footer] = [markup('header'), markup('footer')];
  await rebuild(h, spec);
  assert.strictEqual(markup('header'), header, 'the xs:boolean spellings of the wanted state are the wanted state');
  assert.strictEqual(markup('footer'), footer);
});

test('REAL BUNDLE: each flag is applied on its own — a readOnly-only spec locks the header and footer controls and leaves their cells visible', async () => {
  const { h, spec } = await deployed({ layout: 'explicit', options: { readOnly: true } });
  await rebuild(h, spec);
  const cells = fieldCells(h.store.row.formxml);
  assert.ok(cells.every((c) => c.readOnly), JSON.stringify(cells));
  assert.ok(cells.every((c) => !c.hidden), 'nothing is hidden that the spec did not ask to hide');
  assert.strictEqual(stateChecks(await verifyForms(h, spec))[0].present, true);
});

for (const layout of ['explicit', 'auto']) {
  test(`REAL BUNDLE: a QuickCreate form (${layout} layout) is flagged on every body cell as before — the form the header and footer change does not touch`, async () => {
    const { h, spec } = await deployed({ formType: 'QuickCreate', layout });
    spec.forms[0].formType = 'QuickCreate';
    const result = await rebuild(h, spec);
    assert.strictEqual(result.ok, true);
    const cells = fieldCells(h.store.row.formxml);
    assert.ok(cells.length >= 2, 'the form holds the field in more than one body cell');
    assert.ok(cells.every((c) => c.hidden && c.readOnly), JSON.stringify(cells));
  });
}

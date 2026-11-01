'use strict';
// The guard every page delete runs first (lib/page-reference-guard.js): a page a form still embeds — in the form's saved layer or its published one, in a form of
// any table — is not deleted, and neither is a page when some form cannot be read, or holds a binding that could name any page. The standalone delete
// (genpage-sdk.js `delete`) is held to it here through the SDK stand-in; the reads it costs are pinned, and so is that nothing else reads a form.
const { test } = require('node:test');
const assert = require('node:assert');
const { embeddedPageReferences, pageDeletionReferences, assertPageDeletionSafe, readAllFormLayers, MAX_FORMS_PER_LAYER, MAX_READS_PER_LAYER } = require('../lib/page-reference-guard.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { FakeSdk } = require('./helpers/fake-genpage-sdk.js');

const ENV = 'https://contoso.crm.dynamics.com';
const P1 = '11111111-0000-4000-8000-000000000001';
const P2 = '11111111-0000-4000-8000-000000000002';
const PUBLISHED = '/systemforms?$select=formid,objecttypecode,name,type,formxml';
const SAVED = '/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode,name,type,formxml';

// The shape the SDK writes for a page in a form cell (cds-maker-sdk adapters/formGenPageEmbed.ts): a cell control, and a controlDescription per form factor.
const refId = (pageId, attrs = 'type="SingleLine.Text" static="true"') => `<RefId ${attrs}>${pageId}</RefId>`;
const embedXml = (pageId, { ref = refId(pageId), extra = '' } = {}) => `<form><tabs><tab name="general"><columns><column><sections><section name="s1"><rows><row>`
  + '<cell id="{aaaaaaaa-0000-4000-8000-000000000001}"><control id="page1" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}" uniqueid="{bbbbbbbb-0000-4000-8000-000000000001}"/></cell>'
  + `</row></rows></section></sections></column></columns></tab></tabs>${extra}<controlDescriptions>`
  + ['2', '0', '1'].map((ff) => `<controlDescription forControl="{bbbbbbbb-0000-4000-8000-000000000001}"><customControl name="MscrmControls.UxAgentControl" formFactor="${ff}"><parameters>${ref}<PageInput static="true">{"data":{"mode":"compact"}}</PageInput></parameters></customControl></controlDescription>`).join('')
  + '</controlDescriptions></form>';
const plainXml = '<form><tabs><tab name="general"/></tabs></form>';

function formsClient({ published = [], saved = [], fail = null, pages = 1, savedPages = 1 } = {}) {
  const reads = [];
  const prefer = [];
  const rowsOf = (forms) => forms.map((f, i) => ({ formid: f.formid || `cccccccc-0000-4000-8000-00000000000${i}`, objecttypecode: f.table || 'account', name: f.name || 'Information', type: 2, formxml: f.formxml }));
  const answer = (rows, url, pages) => {
    // `pages` answers split the rows over that many continuation pages, to hold the scan to reading each one.
    const m = /&page=(\d+)$/.exec(url);
    const at = m ? Number(m[1]) : 0;
    const per = Math.ceil(rows.length / pages) || 1;
    const body = { value: rows.slice(at * per, (at + 1) * per) };
    if (at + 1 < pages) body['@odata.nextLink'] = `${url.replace(/&page=\d+$/, '')}&page=${at + 1}`;
    return { status: 200, body };
  };
  return {
    reads,
    prefer,
    client: {
      get: async (url, options) => {
        reads.push(url);
        prefer.push(options && options.headers ? options.headers.Prefer : undefined);
        if (fail && fail(url)) return { status: 403, body: { error: { message: 'Principal user is missing prvReadSystemForm privilege' } } };
        if (url.startsWith('/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) return answer(rowsOf(saved), url, savedPages);
        if (url.startsWith('/systemforms?')) return answer(rowsOf(published), url, pages);
        throw new Error(`unexpected read ${url}`);
      },
    },
  };
}

test('a form\'s embed is read from its elements: the static page id of each UxAgentControl, whatever its letter case or braces — once', () => {
  assert.deepStrictEqual(embeddedPageReferences(embedXml(P1)), { ok: true, pageIds: [P1], unknown: [] });
  assert.deepStrictEqual(embeddedPageReferences(embedXml(`{${P1.toUpperCase()}}`)), { ok: true, pageIds: [P1], unknown: [] });
  assert.deepStrictEqual(embeddedPageReferences(plainXml), { ok: true, pageIds: [], unknown: [] });
});

test('a page id in a comment, a CDATA section, another control\'s parameter or a label is not a reference', () => {
  const comment = `<form><!-- <customControl name="MscrmControls.UxAgentControl"><parameters>${refId(P1)}</parameters></customControl> --><tabs/></form>`;
  const cdata = `<form><labels><label description="${P1}"/></labels><![CDATA[<customControl name="MscrmControls.UxAgentControl"><parameters>${refId(P1)}</parameters></customControl>]]></form>`;
  const other = `<form><controlDescriptions><controlDescription forControl="{x}"><customControl name="MscrmControls.Other"><parameters>${refId(P1)}</parameters></customControl></controlDescription></controlDescriptions></form>`;
  for (const xml of [comment, cdata, other]) assert.deepStrictEqual(embeddedPageReferences(xml), { ok: true, pageIds: [], unknown: [] }, xml);
});

test('a UxAgentControl whose page cannot be read as one fixed id is UNKNOWN — a column binding, a character reference, CDATA, an empty value, no RefId', () => {
  const cases = [
    refId('new_pagecolumn', 'type="SingleLine.Text"'),
    refId(`&#x31;${P1.slice(1)}`),
    `<RefId type="SingleLine.Text" static="true"><![CDATA[${P1}]]></RefId>`,
    '<RefId type="SingleLine.Text" static="true"/>',
    '',
  ];
  for (const ref of cases) {
    const read = embeddedPageReferences(embedXml(P1, { ref }));
    assert.strictEqual(read.ok, true, ref);
    assert.deepStrictEqual(read.pageIds, [], ref);
    assert.strictEqual(read.unknown.length, 3, `one per form factor: ${ref}`);
  }
});

test('a form whose XML the strict reader refuses is not readable — never "no reference"', () => {
  for (const xml of ['<form><tabs></form>', `<form>${refId(P1)}</form><form/>`, undefined, '']) {
    assert.strictEqual(embeddedPageReferences(xml).ok, false, String(xml));
  }
});

test('no page to delete reads no form', async () => {
  const { client, reads } = formsClient();
  const out = await pageDeletionReferences(client, []);
  assert.deepStrictEqual([out.safe, out.reads, reads], [true, 0, []]);
});

test('one delete reads every form of every table in both layers — two reads, no table filter, 100 forms a read asked for — and finds no reference where none is', async () => {
  const { client, reads, prefer } = formsClient({ published: [{ formxml: plainXml }, { formxml: embedXml(P2), table: 'contact' }], saved: [{ formxml: plainXml }] });
  assert.deepStrictEqual(await assertPageDeletionSafe(client, [P1.toUpperCase()]), { reads: 2, formsScanned: 3 });
  assert.deepStrictEqual(reads, [PUBLISHED, SAVED]);
  assert.deepStrictEqual(prefer, ['odata.maxpagesize=100', 'odata.maxpagesize=100']);
});

test('a reference only in the published layer, and one only in the saved layer, each block the delete and name the form', async () => {
  for (const [layer, world] of [['published', { published: [{ formxml: embedXml(P1), name: 'Ticket', table: 'new_ticket' }] }], ['saved', { saved: [{ formxml: embedXml(P1), name: 'Ticket', table: 'new_ticket' }] }]]) {
    const { client } = formsClient(world);
    await assert.rejects(assertPageDeletionSafe(client, [P1]), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_EMBEDDED_IN_FORM', layer);
      assert.strictEqual(e.outcome, 'nothing');
      assert.strictEqual(e.transient, false);
      assert.deepStrictEqual(e.references.map((r) => [r.pageId, r.forms.map((f) => [f.table, f.layer])]), [[P1, [['new_ticket', layer]]]]);
      assert.match(e.message, new RegExp(`page ${P1} is embedded in "Ticket" \\(form .* of table new_ticket, ${layer} layer\\)`));
      return true;
    });
  }
});

test('a binding that could name any page blocks; so does a malformed form — even when the page deleted is another one', async () => {
  const dynamic = formsClient({ saved: [{ formxml: embedXml(P2, { ref: refId('new_pagecolumn', 'type="SingleLine.Text"') }) }] });
  await assert.rejects(assertPageDeletionSafe(dynamic.client, [P1]), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && /takes its page from a column/.test(e.message));
  const malformed = formsClient({ published: [{ formxml: plainXml }, { formxml: '<form><tabs></form>' }] });
  await assert.rejects(assertPageDeletionSafe(malformed.client, [P1]), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && /its XML cannot be read/.test(e.message));
});

test('every continuation page is read; a refused read, a malformed second page and a scan past its budget each refuse — never a shorter list', async () => {
  const paged = formsClient({ published: [{ formxml: plainXml }, { formxml: plainXml }, { formxml: embedXml(P1) }], pages: 3 });
  await assert.rejects(assertPageDeletionSafe(paged.client, [P1]), (e) => e.code === 'GENPAGE_EMBEDDED_IN_FORM');
  assert.strictEqual(paged.reads.length, 4, 'the published layer read to its third page (where the reference is), then the saved one');
  assert.deepStrictEqual(paged.prefer, Array(4).fill('odata.maxpagesize=100'), 'a continuation read asks for the same page size as the first');

  const refused = formsClient({ fail: (url) => url === SAVED });
  await assert.rejects(assertPageDeletionSafe(refused.client, [P1]), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && /saved layer could not be read/.test(e.message) && /prvReadSystemForm/.test(e.message));

  const broken = { get: async (url) => (url === PUBLISHED ? { status: 200, body: { value: [], '@odata.nextLink': 42 } } : { status: 200, body: { value: [] } }) };
  await assert.rejects(assertPageDeletionSafe(broken, [P1]), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && /malformed @odata.nextLink/.test(e.message));

  const endless = formsClient({ published: Array.from({ length: 10 }, () => ({ formxml: plainXml })), pages: 10 });
  await assert.rejects(assertPageDeletionSafe(endless.client, [P1], { maxReads: 4 }), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && e.budgetExhausted === true && /published layer could not all be read within 4 reads/.test(e.message));
  assert.strictEqual(endless.reads.length, 4, 'the read past the budget is never sent');
  // The budget is per layer and the scan is shared: two pages cost what one does — the reads follow the forms, not the pages deleted.
  const two = formsClient({ published: Array.from({ length: 6 }, () => ({ formxml: plainXml })), pages: 6 });
  assert.deepStrictEqual(await assertPageDeletionSafe(two.client, [P1, P2], { maxReads: 6 }), { reads: 7, formsScanned: 6 });
  // A layer with more forms than the cap is refused once an answer takes it past the cap, and nothing after that is read.
  const many = formsClient({ saved: Array.from({ length: 6 }, () => ({ formxml: plainXml })), savedPages: 3 });
  await assert.rejects(assertPageDeletionSafe(many.client, [P1], { maxForms: 3, maxReads: 10 }), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && e.budgetExhausted === true && /saved layer .* more than 3 forms/.test(e.message));
  assert.deepStrictEqual(many.reads.length, 3, 'the published layer, then the saved one to the answer that went past the cap');
  assert.deepStrictEqual(await assertPageDeletionSafe(formsClient({ saved: Array.from({ length: 6 }, () => ({ formxml: plainXml })), savedPages: 3 }).client, [P1], { maxForms: 6, maxReads: 10 }), { reads: 4, formsScanned: 6 }, 'a layer AT the cap is read');
});

test('the default budget: at most MAX_FORMS_PER_LAYER forms in a layer, in at most MAX_READS_PER_LAYER reads — a layer that keeps answering full pages is refused, never cut short', async () => {
  assert.deepStrictEqual([MAX_FORMS_PER_LAYER, MAX_READS_PER_LAYER], [20000, 201]);
  const row = (n) => ({ formid: `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`, objecttypecode: 'account', name: 'Information', type: 2, formxml: plainXml });
  let reads = 0;
  // Full pages of forms never answered before: what is refused is the size of the layer, not a page that repeats another.
  const full = { get: async (url) => { const first = reads * 100; reads += 1; return { status: 200, body: { value: Array.from({ length: 100 }, (_, i) => row(first + i)), '@odata.nextLink': `${url.replace(/&n=\d+$/, '')}&n=${reads}` } }; } };
  await assert.rejects(assertPageDeletionSafe(full, [P1]), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && e.budgetExhausted === true && /published layer .* more than 20000 forms/.test(e.message));
  assert.strictEqual(reads, MAX_READS_PER_LAYER, 'the answer that took the layer past 20000 forms is the last read');
});

// An answer of `rows` (form ids), with `extra` annotations and a continuation to the next answer of `pages`.
function pagedClient(layers) {
  return {
    get: async (url) => {
      const layer = url.startsWith('/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()') ? 'saved' : 'published';
      const at = Number((/&n=(\d+)$/.exec(url) || [])[1] || 0);
      const pages = layers[layer] || [{ rows: [] }];
      const { rows, extra = {} } = pages[at];
      const body = { value: rows.map((formid) => ({ formid, objecttypecode: 'account', name: 'Information', type: 2, formxml: plainXml })), ...extra };
      if (at + 1 < pages.length) body['@odata.nextLink'] = `${url.replace(/&n=\d+$/, '')}&n=${at + 1}`;
      return { status: 200, body };
    },
  };
}
const F = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the pages of a layer are one list: a form twice — in any letter case or braces, on one page or two — or a form with no id is refused, never deduplicated', async () => {
  for (const [saved, why] of [
    [[{ rows: [F(1), F(2)] }, { rows: [F(2), F(3)] }], `form ${F(2)} came back twice`],
    [[{ rows: [F(1), `{${F(1).toUpperCase()}}`] }], `form ${F(1)} came back twice`],
    [[{ rows: [F(1)] }, { rows: [''] }], 'a form came back with no form id'],
  ]) {
    await assert.rejects(assertPageDeletionSafe(pagedClient({ published: [{ rows: [F(1)] }], saved }), [P1]), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_FORM_REFERENCES_UNREADABLE');
      assert.strictEqual(e.incompleteScan, true);
      assert.ok(e.message.includes(`saved layer could not all be read: ${why}`), e.message);
      return true;
    });
  }
  // The layers are two lists: the same form in both — or in only one — is what they hold as a rule.
  assert.deepStrictEqual(await assertPageDeletionSafe(pagedClient({ published: [{ rows: [F(1), F(2)] }], saved: [{ rows: [F(2)] }, { rows: [F(1), F(3)] }] }), [P1]), { reads: 3, formsScanned: 5 });
});

test('a count an answer declares is a lower bound (it stops at 5000): fewer forms than it is refused; as many or more — or no count, or -1 — is not', async () => {
  const count = (n, more = {}) => ({ '@odata.count': n, ...more });
  const refusals = [
    [[{ rows: [F(1), F(2)], extra: count(3) }], 'the answer counts 3 forms but its pages held 2'],
    // A later answer that counts more is believed: the count is never lowered by an answer that counts fewer.
    [[{ rows: [F(1)], extra: count(2) }, { rows: [F(2)], extra: count(4) }, { rows: [F(3)], extra: count(1) }], 'the answer counts 4 forms but its pages held 3'],
    [[{ rows: [F(1)], extra: { '@Microsoft.Dynamics.CRM.totalrecordcount': 2 } }], 'the answer counts 2 forms but its pages held 1'],
  ];
  for (const [saved, why] of refusals) {
    await assert.rejects(assertPageDeletionSafe(pagedClient({ saved }), [P1]), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && e.incompleteScan === true && e.message.includes(why));
  }
  const passes = [
    [{ rows: [F(1), F(2)], extra: count(2) }],
    // "5000 or more": the platform's cap, so more forms than it counts is no contradiction.
    [{ rows: Array.from({ length: 60 }, (_, i) => F(i)), extra: count(50, { '@Microsoft.Dynamics.CRM.totalrecordcount': 50, '@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded': true }) }],
    [{ rows: [F(1)], extra: { '@Microsoft.Dynamics.CRM.totalrecordcount': -1, '@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded': false } }],
    [{ rows: [F(1)], extra: { '@odata.count': 'many' } }],
  ];
  for (const saved of passes) {
    const out = await assertPageDeletionSafe(pagedClient({ saved }), [P1]);
    assert.strictEqual(out.formsScanned, saved.reduce((n, p) => n + p.rows.length, 0));
  }
});

test('readAllFormLayers keeps each row\'s layer and table', async () => {
  const { client } = formsClient({ published: [{ formxml: plainXml, table: 'account' }], saved: [{ formxml: plainXml, table: 'contact' }] });
  const out = await readAllFormLayers(client);
  assert.deepStrictEqual(out.forms.map((f) => [f.layer, f.table]), [['published', 'account'], ['saved', 'contact']]);
  assert.strictEqual(out.reads, 2);
});

// ── the standalone delete ───────────────────────────────────────────────────────────────────────────────────────────

const folder = { id: P1, name: 'Overview', source: 'export default function Page() { return null; }', dataSources: ['account'], conversation: [], bag: { rows: { source: 'row-1' } }, files: [] };
const SITEMAP = '44444444-0000-4000-8000-0000000000dd';
const APP_ROW = { appmoduleid: '22222222-0000-4000-8000-0000000000bb', appmoduleidunique: '33333333-0000-4000-8000-0000000000cc', uniquename: 'contoso_sales' };
const EMPTY_NAV = '<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" Entity="account"/></Group></Area></SiteMap>';
function deleteWorld(forms) {
  const world = formsClient(forms);
  const sdk = new FakeSdk({
    // One app, whose navigation names no page: the navigation check the delete makes first passes.
    records: { appmodule: () => [APP_ROW], appmodulecomponent: () => [{ objectid: SITEMAP, componenttype: 62 }], sitemap: () => [{ sitemapxml: EMPTY_NAV }] },
    onGet: async (url) => {
      if (url.startsWith('/systemforms')) return world.client.get(url);
      if (url.startsWith('/appmodules/')) return { status: 200, body: { value: [{ ...APP_ROW, name: 'Sales', componentstate: 0 }] } };
      if (url.startsWith('/sitemaps/')) return { status: 200, body: { value: [{ sitemapid: SITEMAP, sitemapnameunique: 'contoso_sales', sitemapxml: EMPTY_NAV, componentstate: 0 }] } };
      return { status: 404, body: null };
    },
  }).seedPage(folder);
  return { sdk, reads: world.reads };
}

test('delete: a page a form embeds is NOT deleted — refused before the confirmation is even asked for, the form named, the page still there', async () => {
  for (const confirm of [{}, { allowDestructive: true }]) {
    const { sdk } = deleteWorld({ published: [{ formxml: embedXml(P1), name: 'Ticket', table: 'new_ticket' }] });
    await assert.rejects(makeGenpageSdk(ENV, { sdk }).delete(P1, confirm), (e) => {
      assert.strictEqual(e.code, 'GENPAGE_EMBEDDED_IN_FORM');
      assert.strictEqual(e.outcome, 'nothing');
      assert.match(e.message, /^page "Overview" \(11111111-0000-4000-8000-000000000001\) was not deleted: page 11111111-0000-4000-8000-000000000001 is embedded in "Ticket"/);
      assert.deepStrictEqual(e.references.map((r) => r.pageId), [P1]);
      return true;
    });
    assert.strictEqual(sdk.count('deleteRemoteArtifact'), 0);
    assert.ok(sdk.pages.has(P1));
  }
});

test('delete: forms that cannot be read refuse the delete; with no form embedding the page it is deleted, after exactly two form reads', async () => {
  const unreadable = deleteWorld({ fail: (url) => url === PUBLISHED });
  await assert.rejects(makeGenpageSdk(ENV, { sdk: unreadable.sdk }).delete(P1, { allowDestructive: true }), (e) => e.code === 'GENPAGE_FORM_REFERENCES_UNREADABLE' && e.outcome === 'nothing');
  assert.strictEqual(unreadable.sdk.count('deleteRemoteArtifact'), 0);

  const clean = deleteWorld({ published: [{ formxml: plainXml }], saved: [{ formxml: embedXml(P2) }] });
  const out = await makeGenpageSdk(ENV, { sdk: clean.sdk }).delete(P1, { allowDestructive: true });
  assert.strictEqual(out.deleted, true);
  assert.deepStrictEqual(clean.reads, [PUBLISHED, SAVED]);
  const order = clean.sdk.calls.map((c) => (c.name === 'dataverse.get' && c.args[0].startsWith('/systemforms') ? 'forms' : c.name));
  assert.ok(order.lastIndexOf('forms') < order.indexOf('deleteRemoteArtifact'), 'the forms are read before the delete');
});

test('the operations that do not delete a page read no form: describe, read', async () => {
  const { sdk, reads } = deleteWorld({ published: [{ formxml: embedXml(P1) }] });
  const genpage = makeGenpageSdk(ENV, { sdk });
  await genpage.describe(P1);
  await genpage.read(P1);
  assert.deepStrictEqual(reads, []);
});

// ── the real bundle ─────────────────────────────────────────────────────────────────────────────────────────────────

test('REAL BUNDLE: delete through the vendored SDK reads the forms twice (published, saved) and is refused by a form that embeds the page — no DELETE sent; with the reference gone it deletes', async () => {
  const fs = require('node:fs');
  const { FakeGenPageServer, INSTANCE, ACCOUNT_TABLE, appTransport } = require('./helpers/fake-genpage-server.js');
  const OTHER = '77777777-7777-4777-8777-777777777777';
  const server = new FakeGenPageServer();
  server.serveTable(ACCOUNT_TABLE);
  server.seedPage(OTHER, { name: 'Other', config: { dataSources: ['account'], model: '' }, prompt: 'Make it' });
  server.forms = [{ formid: 'dddddddd-0000-4000-8000-000000000001', objecttypecode: 'account', name: 'Account', type: 2, formxml: embedXml(OTHER), layer: 'saved' }];
  const made = [];
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: appTransport(server).http, mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; } });
  const formReads = () => server.requests.filter((r) => r.method === 'GET' && /^\/systemforms/.test(r.path)).map((r) => r.path);
  try {
    await assert.rejects(genpage.delete(OTHER, { allowDestructive: true }), (e) => e.code === 'GENPAGE_EMBEDDED_IN_FORM' && e.references[0].forms[0].layer === 'saved');
    assert.deepStrictEqual(formReads(), [PUBLISHED, SAVED]);
    assert.deepStrictEqual(server.writes().filter((w) => /DELETE/.test(w)), []);
    assert.ok(server.state.projects.has(OTHER));

    server.forms = [{ ...server.forms[0], formxml: plainXml }];
    const out = await genpage.delete(OTHER, { allowDestructive: true });
    assert.strictEqual(out.deleted, true);
    assert.strictEqual(formReads().length, 4, 'two more reads for the second delete, and no other');
    assert.ok(!server.state.projects.has(OTHER));
  } finally {
    await genpage.dispose();
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
});
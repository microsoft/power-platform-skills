'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDownload, preserveAuthoredLanguageCode } = require('../download-model-app.js');
const { APP, PUBLISHED, CURRENT, PAGE, FORM_A, FORM_B, DASHBOARD } = require('./helpers/app-membership-sdk.js');
const FORM_C = '33333333-0000-4000-8000-000000000004';
const UNKNOWN = '33333333-0000-4000-8000-000000000005';
const SITEMAP = '55555555-0000-4000-8000-000000000001';
const NINE = ['account', 'contact', 'task', 'email', 'appointment', 'phonecall', 'systemuser', 'team', 'annotation'];
const metadataId = (index) => `66666666-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const catalogForm = (formid, name, activation = 1, table = 'account') =>
  ({ formid, name, type: 2, objecttypecode: table, formactivationstate: activation, formxml: '<form/>' });

function downloadSdk({
  navigation = ['account', 'contact'], tables = NINE, custom = [], assetTables = [], members = [],
  catalog = [catalogForm(FORM_A, 'Summary'), catalogForm(FORM_B, 'Alternate')],
  placeholder = false, deleted = false, draft = false, page = false,
  sdkNavigation = navigation, sdkPage = page, missingSitemap = false, unpublishedOnly = false,
  identity = 'contoso_membership', identitySpelling = 'uniqueName', displayName = 'Membership', unknownCustom = [],
  currentExtraXml = '', sdkExtraSubAreas = [],
} = {}) {
  const calls = [];
  const metadataReads = [];
  const names = [...new Set([...navigation, ...tables, ...assetTables, ...(placeholder ? ['entity'] : [])])];
  const ids = Object.fromEntries(names.map((name, index) => [name, metadataId(index)]));
  const logicalOfId = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, name]));
  const viewIds = Object.fromEntries(assetTables.map((name, index) => [name, `77777777-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
  const xmlFor = (names, hasPage, extra = '') => '<SiteMap><Area><Group>'
    + names.map((name) => `<SubArea Entity="${name}" Title="${name}"/>`).join('')
    + (hasPage ? `<SubArea GenPageId="${PAGE}" Title="Draft Overview"/>` : '') + extra + '</Group></Area></SiteMap>';
  const xml = xmlFor(navigation, page, currentExtraXml);
  const publishedXml = draft ? xmlFor(['account'], false) : xml;
  const currentLayer = draft ? CURRENT : PUBLISHED;
  const sdk = {
    fetchArtifact: async () => ({
      name: displayName, [identitySpelling]: identity, description: '',
      ...(missingSitemap ? { siteMap: { areas: [] } } : { siteMap: { areas: [{ title: 'Main', groups: [{ title: 'Records', subAreas: [
        ...sdkNavigation.map((entity) => ({ type: 'Entity', entity, title: entity })),
        ...(sdkPage ? [{ type: 'GenPage', genPageId: PAGE, title: 'Draft Overview' }] : []),
        ...sdkExtraSubAreas,
      ] }] }] } }),
    }),
    fetchEntityMetadata: async (logical) => {
      metadataReads.push(logical);
      return {
        logicalName: logical, schemaName: logical, displayName: logical, isCustomEntity: custom.includes(logical),
        primaryNameAttribute: logical === 'annotation' ? '' : 'name',
        attributes: [{ logicalName: 'contoso_unrelated', attributeType: 'String', isCustomAttribute: true }], relationships: [],
      };
    },
    queryRecords: async (set, opts = {}) => {
      calls.push({ set, opts });
      const filter = opts.filter || '';
      if (set === 'appmodule') return unpublishedOnly ? [] : [{ appmoduleid: APP, appmoduleidunique: PUBLISHED, uniquename: 'contoso_membership' }];
      if (set === 'appmodulecomponent') {
        const type = Number((/componenttype eq (\d+)/.exec(filter) || [])[1]);
        if (type === 62) return [{ objectid: SITEMAP, componenttype: 62 }];
        assert.equal(opts.paginate, true);
        assert.equal(opts.top, undefined);
        const published = draft && filter.includes(PUBLISHED);
        if (type === 1) return [...(published ? ['account'] : tables).map((name) => ids[name]), ...(placeholder ? [ids.entity] : []), ...(deleted ? [UNKNOWN] : [])]
          .map((objectid) => ({ objectid, componenttype: 1 }));
        if (type === 26) return (published ? [] : assetTables).map((name) => ({ objectid: viewIds[name], componenttype: 26 }));
        if (type === 60) return (published ? [] : members).map((objectid) => ({ objectid, componenttype: 60 }));
        return [];
      }
      if (set === 'sitemap') return [{ sitemapxml: publishedXml }];
      if (set === 'savedquery') return assetTables.filter((name) => filter.includes(viewIds[name]))
        .map((name) => ({ savedqueryid: viewIds[name], name: `${name} view`, returnedtypecode: name }));
      if (set === 'systemform') return catalog.filter((row) => filter.includes(`formid eq ${row.formid}`));
      return [];
    },
    dataverse: { get: async (url) => {
      calls.push({ url });
      if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
        const published = { appmoduleid: APP, appmoduleidunique: PUBLISHED, componentstate: 0 };
        if (unpublishedOnly) return { status: 200, body: { value: [{ appmoduleid: APP, appmoduleidunique: CURRENT, componentstate: 1 }] } };
        return { status: 200, body: { value: draft
          ? [published, { appmoduleid: APP, appmoduleidunique: CURRENT, componentstate: 1 }] : [published] } };
      }
      if (url.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
        const current = { sitemapid: SITEMAP, sitemapxml: xml, componentstate: draft || unpublishedOnly ? 1 : 0 };
        return { status: 200, body: { value: draft
          ? [{ sitemapid: SITEMAP, sitemapxml: publishedXml, componentstate: 0 }, current] : [current] } };
      }
      const byId = /^\/EntityDefinitions\(([0-9a-f-]+)\)/i.exec(url);
      if (byId) {
        const logical = logicalOfId[byId[1].toLowerCase()];
        return logical ? { status: 200, body: { LogicalName: logical,
          ...(unknownCustom.includes(logical) ? {} : { IsCustomEntity: custom.includes(logical) }) } } : { status: 404, body: null };
      }
      if (url.includes('/Relationships') || /\/(?:ManyToOne|OneToMany|ManyToMany)Relationships/.test(url)) return { status: 200, body: { value: [] } };
      if (url.includes('/Attributes')) return { status: 200, body: { value: [] } };
      if (url.includes('/EntityDefinitions(')) return { status: 200, body: {} };
      if (url.startsWith('/systemforms')) {
        const table = /objecttypecode eq '([^']+)'/.exec(url);
        return { status: 200, body: { value: table
          ? catalog.filter((row) => row.type === 2 && row.objecttypecode === table[1])
          : catalog.filter((row) => url.includes(`formid eq ${row.formid}`)) } };
      }
      if (url.startsWith('/appmodulecomponents')) {
        assert.ok(url.includes(unpublishedOnly ? CURRENT : currentLayer), 'download describes the server-current membership');
        return { status: 200, body: { value: members.map((objectid) => ({ objectid, componenttype: 60 })) } };
      }
      throw new Error(`unexpected download read ${url}`);
    } },
  };
  return { sdk, calls, metadataReads };
}

async function download(t, options = {}, priorFloor) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-membership-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (priorFloor) fs.writeFileSync(path.join(directory, 'app-spec.json'), JSON.stringify({ minimumPluginVersion: priorFloor }));
  const fake = downloadSdk(options);
  const warnings = [];
  const original = process.stderr.write;
  process.stderr.write = (text) => { warnings.push(String(text)); return true; };
  let result;
  try {
    result = await runDownload({
      sdk: fake.sdk, appId: APP, appUnique: options.unpublishedOnly ? undefined : 'contoso_membership', outDir: directory,
      genpageCli: {
        enumerateEnv: async () => ({ ok: true, ids: options.page ? [PAGE] : [], pages: options.page ? [{ pageId: PAGE, name: 'Draft Overview' }] : [] }),
        download: async ({ outputDir, pageIds }) => {
          for (const id of pageIds) {
            const dir = path.join(outputDir, id);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'page.tsx'), 'export default function Page() { return null; }');
            fs.writeFileSync(path.join(dir, 'config.json'), '{"dataSources":[]}');
          }
          return true;
        },
      },
    });
  } finally { process.stderr.write = original; }
  assert.equal(result.ok, options.expectRefusal ? false : true, JSON.stringify(result));
  return { ...fake, result, warnings };
}

test('nine type-1 members round-trip seven hidden stock references without adopting their schema', async (t) => {
  const { result, metadataReads } = await download(t);
  assert.deepEqual(result.spec.app.tables, NINE.slice(2).sort());
  assert.deepEqual(result.spec.entities.map((entity) => entity.schemaName).sort(), ['account', 'contact']);
  assert.deepEqual(metadataReads.sort(), ['account', 'contact'], 'hidden stock tables must not read/copy unrelated custom columns or relationships');
  assert.equal(result.spec.minimumPluginVersion, '2.13.0');
});

test('custom hidden tables go to entities and app.tables, while stock tables without a primary name still remain references', async (t) => {
  const { result, metadataReads } = await download(t, { tables: ['account', 'contact', 'contoso_hidden', 'annotation'], custom: ['contoso_hidden'] });
  assert.deepEqual(result.spec.app.tables, ['annotation', 'contoso_hidden']);
  assert.ok(result.spec.entities.some((entity) => entity.schemaName === 'contoso_hidden' && entity.existing === true));
  assert.ok(!result.spec.entities.some((entity) => entity.schemaName === 'annotation'));
  assert.ok(!metadataReads.includes('annotation'), 'membership-only tables do not require a primary-name column');
});

test('view-derived hidden stock tables keep the existing schema hydration behavior', async (t) => {
  const { result } = await download(t, { tables: ['account', 'contact'], assetTables: ['task'] });
  const task = result.spec.entities.find((entity) => entity.schemaName === 'task');
  assert.ok(task);
  assert.ok(task.columns.some((column) => column.schemaName === 'contoso_unrelated'));
  assert.equal(result.spec.app.tables, undefined, 'an asset-only table has no type-1 membership to round-trip');
});

test('a hidden stock type-1 table remains membership-only even when a view references it', async (t) => {
  const { result, metadataReads } = await download(t, {
    navigation: ['account'], tables: ['account', 'task'], assetTables: ['task'],
  });
  assert.deepEqual(result.spec.app.tables, ['task']);
  assert.deepEqual(result.spec.entities.map((entity) => entity.schemaName), ['account']);
  assert.deepEqual(metadataReads, ['account'], 'the Task view is a reference, not permission to adopt unrelated custom columns');
});

test('download preserves draft navigation and its Main restriction from the same current layer', async (t) => {
  const { result, calls } = await download(t, {
    draft: true, navigation: ['account', 'task'], tables: ['account', 'task', 'email'], members: [FORM_A],
    catalog: [catalogForm(FORM_A, 'Task Summary', 1, 'task'), catalogForm(FORM_B, 'Task Alternate', 1, 'task')],
  });
  assert.deepEqual(result.spec.app.mainForms, { task: ['Task Summary'] });
  assert.deepEqual(result.spec.app.tables, ['email']);
  assert.deepEqual(result.spec.entities.map((entity) => entity.schemaName).sort(), ['account', 'task']);
  for (const call of calls.filter((entry) => entry.set === 'appmodulecomponent')) {
    assert.ok(call.opts.filter.includes(CURRENT), 'navigation, type-1 and type-60 reads must not use the old published layer');
  }
});

test('a draft Help URL absent from the older SDK navigation refuses download', async (t) => {
  const { result, metadataReads } = await download(t, {
    draft: true, navigation: ['account'], tables: ['account'],
    currentExtraXml: '<SubArea Url="https://contoso.example/Help" Title="Help"/>', expectRefusal: true,
  });
  assert.match(result.error, /sitemap.*SDK.*publish.*download again/i);
  assert.equal(result.spec, undefined, 'no rebuildable spec may silently omit Help');
  assert.deepEqual(metadataReads, [], 'refuse before hydration rather than reporting droppedSubareas: 0');
});

test('a draft dashboard absent from the older SDK navigation refuses download', async (t) => {
  const { result, metadataReads } = await download(t, {
    draft: true, navigation: ['account'], tables: ['account'],
    currentExtraXml: `<SubArea DefaultDashboard="${DASHBOARD}" Url="/workplace/home_dashboards.aspx" Title="Overview"/>`,
    expectRefusal: true,
  });
  assert.match(result.error, /sitemap.*SDK.*publish.*download again/i);
  assert.equal(result.spec, undefined, 'no rebuildable spec may silently omit the dashboard');
  assert.deepEqual(metadataReads, []);
});

test('published-first SDK navigation cannot be combined with the selected draft tables and Main restriction', async (t) => {
  const { result, metadataReads } = await download(t, {
    draft: true, navigation: ['account', 'task'], sdkNavigation: ['account'], tables: ['account', 'task'],
    members: [FORM_A], catalog: [catalogForm(FORM_A, 'Task Summary', 1, 'task'), catalogForm(FORM_B, 'Task Alternate', 1, 'task')],
    expectRefusal: true,
  });
  assert.match(result.error, /sitemap.*unpublished change.*SDK.*consistently.*publish.*download again/i);
  assert.equal(result.spec, undefined, 'a mixed snapshot must never become a rebuildable spec');
  assert.deepEqual(metadataReads, [], 'refuse before misclassifying the draft navigation table as hidden');
});

test('a never-published app with current XML but no SDK sitemap is refused', async (t) => {
  const { result } = await download(t, {
    unpublishedOnly: true, navigation: ['account'], tables: ['account'], missingSitemap: true,
    identity: 'contoso_original', displayName: 'Renamed Draft', expectRefusal: true,
  });
  assert.match(result.error, /sitemap.*SDK.*publish.*download again/i);
  assert.equal(result.spec, undefined);
});

test('a draft-only generative page missing from the SDK navigation cannot be silently dropped', async (t) => {
  const { result } = await download(t, {
    draft: true, page: true, sdkPage: false, navigation: ['account'], tables: ['account'], expectRefusal: true,
  });
  assert.match(result.error, /sitemap.*SDK.*publish.*download again/i);
  assert.equal(result.spec, undefined);
});

test('a draft GUID download recovers the SDK immutable uniqueName before manifest, prefix and hydration', async (t) => {
  const { result, calls } = await download(t, {
    unpublishedOnly: true, navigation: ['account'], tables: ['account'], page: true,
    identity: 'contoso_original', displayName: 'Renamed Draft',
  });
  assert.equal(result.spec.app.uniqueName, 'contoso_original');
  assert.equal(result.spec.app.name, 'Renamed Draft');
  assert.equal(result.spec.solution.publisherPrefix, 'contoso');
  assert.ok(calls.some((call) => call.set === 'webresource' && /contoso_original_pagemanifest/.test(call.opts.filter)),
    'manifest lookup must use the fetched immutable identity, not a derived display-name identity');
});

test('a draft GUID download also recovers the legacy uniquename spelling', async (t) => {
  const { result } = await download(t, {
    unpublishedOnly: true, navigation: ['account'], tables: ['account'],
    identity: 'contoso_original', identitySpelling: 'uniquename', displayName: 'Renamed Draft',
  });
  assert.equal(result.spec.app.uniqueName, 'contoso_original');
  assert.equal(result.spec.solution.publisherPrefix, 'contoso');
});

test('a download without an immutable server identity is refused rather than deriving one from display name', async (t) => {
  const { result } = await download(t, {
    unpublishedOnly: true, navigation: ['account'], tables: ['account'], identity: null,
    displayName: 'Renamed Draft', expectRefusal: true,
  });
  assert.match(result.error, /immutable.*unique name.*(resolve|read)|identity.*(resolve|read)/i);
  assert.equal(result.spec, undefined);
});

test('unknown custom classification keeps a hidden type-1 table as a reference even with a companion view', async (t) => {
  const { result, warnings, metadataReads } = await download(t, {
    navigation: ['account'], tables: ['account', 'task'], assetTables: ['task'], unknownCustom: ['task'],
  });
  assert.deepEqual(result.spec.app.tables, ['task']);
  assert.deepEqual(result.spec.entities.map((entity) => entity.schemaName), ['account']);
  assert.deepEqual(metadataReads, ['account']);
  assert.ok(result.notRoundTripped.appMembership.some((note) => note.table === 'task' && /custom\/stock status.*without adopting its schema/.test(note.reason)));
  assert.match(warnings.join(''), /task.*custom\/stock|custom\/stock.*task/);
});

test('draft-only generative navigation uses the current sitemap rather than the published page set', async (t) => {
  const { result, calls } = await download(t, { draft: true, page: true, navigation: ['account'], tables: ['account'] });
  assert.deepEqual(result.spec.pages.map((entry) => entry.pageId), [PAGE]);
  assert.equal(result.droppedSubareas, 0);
  assert.ok(calls.some((call) => call.url && call.url.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')));
});

test('placeholder and deleted type-1 components are omitted with explicit not-round-tripped notes', async (t) => {
  const { result, warnings } = await download(t, { tables: ['account', 'contact', 'task'], placeholder: true, deleted: true });
  assert.deepEqual(result.spec.app.tables, ['task']);
  assert.ok(!result.spec.entities.some((entity) => entity.schemaName === 'entity'));
  assert.match(warnings.join(''), /entity.*(placeholder|corrupt)/i);
  assert.match(warnings.join(''), /404|no longer exists/);
  assert.ok(result.notRoundTripped.appMembership.some((note) => /entity/.test(note.reason)));
});

test('download shares the current component inventory across membership and description reads', async (t) => {
  const { calls } = await download(t, { members: [FORM_A] });
  for (const type of [1, 26, 59, 60]) {
    const queries = calls.filter((call) => call.set === 'appmodulecomponent' && new RegExp(`componenttype eq ${type}$`).test(call.opts.filter));
    assert.equal(queries.length, 1, `component type ${type} should be inventoried once`);
  }
});

test('a non-empty strict active Main subset emits names and the capability floor', async (t) => {
  const { result } = await download(t, { tables: ['account', 'contact'], members: [FORM_A] });
  assert.deepEqual(result.spec.app.mainForms, { account: ['Summary'] });
  assert.equal(result.spec.minimumPluginVersion, '2.13.0');
  assert.deepEqual(result.spec.forms, [], 'membership capture must not invent a lossy form layout');
});

test('full active Main membership is omitted instead of inventing a restriction', async (t) => {
  const { result } = await download(t, { tables: ['account', 'contact'], members: [FORM_A, FORM_B] });
  assert.equal(result.spec.app.mainForms, undefined);
  assert.equal(result.spec.app.tables, undefined);
  assert.equal(result.spec.minimumPluginVersion, undefined);
});

test('empty active Main membership is omitted with a not-round-tripped explanation', async (t) => {
  const { result, warnings } = await download(t, { tables: ['account', 'contact'], members: [] });
  assert.equal(result.spec.app.mainForms, undefined);
  assert.ok(result.notRoundTripped.appMembership.some((note) => note.table === 'account' && /no active Main/.test(note.reason)));
  assert.match(warnings.join(''), /not.round.tripped.*no active Main/i);
});

test('ambiguous Main names, including inactive normalized twins, are not emitted by name', async (t) => {
  const { result, warnings } = await download(t, {
    tables: ['account', 'contact'], members: [FORM_A],
    catalog: [catalogForm(FORM_A, 'Resume'), catalogForm(FORM_B, 'R\u00e9sum\u00e9', 0), catalogForm(FORM_C, 'Other')],
  });
  assert.equal(result.spec.app.mainForms, undefined);
  assert.match(warnings.join(''), /not.round.tripped.*ambiguous.*Resume/i);
});

test('inactive and deleted pins do not erase the active restriction; their losses are named', async (t) => {
  const { result, warnings } = await download(t, {
    tables: ['account', 'contact'], members: [FORM_A, FORM_B, UNKNOWN],
    catalog: [catalogForm(FORM_A, 'Summary'), catalogForm(FORM_B, 'Retired', 0), catalogForm(FORM_C, 'Other')],
  });
  assert.deepEqual(result.spec.app.mainForms, { account: ['Summary'] });
  assert.match(warnings.join(''), /not.round.tripped.*Retired.*inactive/i);
  assert.match(warnings.join(''), new RegExp(UNKNOWN));
  assert.ok(result.notRoundTripped.appMembership.some((note) => note.id === UNKNOWN));
});

test('unclassifiable form pins retain any readable name in the loss report', async (t) => {
  const { result, warnings } = await download(t, {
    tables: ['account', 'contact'], members: [FORM_A, FORM_C],
    catalog: [
      catalogForm(FORM_A, 'Summary'), catalogForm(FORM_B, 'Alternate'),
      { formid: FORM_C, name: 'Unclassified form', objecttypecode: 'account' },
    ],
  });
  assert.deepEqual(result.spec.app.mainForms, { account: ['Summary'] });
  const note = result.notRoundTripped.appMembership.find((entry) => entry.id === FORM_C);
  assert.equal(note.name, 'Unclassified form');
  assert.match(warnings.join(''), /Unclassified form.*could not be classified/);
});

test('malformed or missing form component ids do not erase an encodable active restriction', async (t) => {
  for (const id of ['not-a-form-id', null]) {
    const { result, warnings } = await download(t, {
      tables: ['account', 'contact'], members: [FORM_A, id],
    });
    assert.deepEqual(result.spec.app.mainForms, { account: ['Summary'] });
    assert.ok(result.notRoundTripped.appMembership.some((note) => note.kind === 'mainForms' && /objectid|GUID/.test(note.reason)));
    assert.match(warnings.join(''), /not.round.tripped.*(objectid|GUID)/);
  }
});

test('dashboard and same-named QuickView pins do not count as Main membership', async (t) => {
  const { result } = await download(t, {
    tables: ['account', 'contact'], members: [FORM_A, DASHBOARD, FORM_C],
    catalog: [
      catalogForm(FORM_A, 'Summary'), catalogForm(FORM_B, 'Alternate'),
      { formid: DASHBOARD, name: 'Overview', type: 0, objecttypecode: 'none' },
      { formid: FORM_C, name: 'Summary', type: 6, objecttypecode: 'account' },
    ],
  });
  assert.deepEqual(result.spec.app.mainForms, { account: ['Summary'] });
});

test('membership emission never downgrades a higher authored capability floor', async (t) => {
  const { result } = await download(t, {}, '2.14.0');
  assert.equal(result.spec.minimumPluginVersion, '2.14.0');
});

test('authored-option preservation also protects the membership floor without inventing one for legacy specs', () => {
  const deps = { existsSync: () => true, readFileSync: () => '{"languageCode":1031,"minimumPluginVersion":"2.15.0"}' };
  const spec = { app: { tables: ['task'] }, minimumPluginVersion: '2.13.0' };
  preserveAuthoredLanguageCode(spec, 'app-spec.json', deps);
  assert.equal(spec.minimumPluginVersion, '2.15.0');
  assert.equal(spec.languageCode, 1031);
  const legacy = { app: {} };
  preserveAuthoredLanguageCode(legacy, 'app-spec.json', deps);
  assert.equal(legacy.minimumPluginVersion, undefined);
});

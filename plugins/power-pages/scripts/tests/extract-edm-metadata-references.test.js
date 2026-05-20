const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractEdmReferences } = require('../extract-edm-metadata-references');

// Inline fixture builder — each test creates a minimal EDM source tree under a temp dir.
// We avoid the shared createTempProject helper because that one sets up `.powerpages-site/`
// (post-deploy SPA shape), which is unrelated to the source-side extractor.
function makeEdmRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edm-extract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

// Returns the set of names extracted for a given kind so assertions can do .has() checks
// instead of order-sensitive deep-equal.
function namesFor(refs, kind) {
  return new Set((refs[kind] || []).map((r) => r.name));
}

// -- Tables --------------------------------------------------------------------

test('extracts table logical names from entity-list YAML records', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'lists/Article List.entitylist.yml',
    [
      'adx_name: Article List',
      'entitylogicalname: faq_article',
      'adx_columns: faq_articleid,faq_articletitle,faq_articlebody',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const tables = namesFor(refs, 'table');
  // `faq_article` appears via entitylogicalname. The columns alone do not raise tables;
  // that's by design — columns can also appear in adx_columns without a sibling table key.
  assert.ok(tables.has('faq_article'));
});

test('extracts table refs from basic-forms entityname', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'basic-forms/Edit Article.basicform.yml',
    ['adx_name: Edit Article', 'entityname: faq_article', ''].join('\n'),
  );
  const refs = extractEdmReferences(root);
  assert.ok(namesFor(refs, 'table').has('faq_article'));
});

test('extracts table refs from FetchXML <entity name="..."> in web-templates', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'web-templates/All Articles.webtemplate.yml', 'adx_name: All Articles\n');
  write(
    root,
    'web-templates/All Articles.webtemplate.html',
    [
      '{% fetchxml articles %}',
      '<fetch>',
      '  <entity name="faq_article">',
      '    <attribute name="faq_articletitle" />',
      '    <attribute name="faq_articlebody" />',
      '  </entity>',
      '</fetch>',
      '{% endfetchxml %}',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  assert.ok(namesFor(refs, 'table').has('faq_article'));
  const cols = namesFor(refs, 'column');
  assert.ok(cols.has('faq_articletitle'));
  // This is exactly the column that was hallucinated in the screenshot the user shared
  // (faq_body vs faq_articlebody). If the extractor missed it, the verify script would
  // have no way to flag the static analyzer's invented column.
  assert.ok(cols.has('faq_articlebody'));
});

test('extracts table refs across many-to-many keys (entity1, entity2, intersectentityname)', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'table-permissions/Article-Topic.tablepermission.yml',
    [
      'adx_name: Article-Topic',
      'entity1: faq_article',
      'entity2: faq_topic',
      'intersectentityname: faq_article_faq_topic',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const tables = namesFor(refs, 'table');
  assert.ok(tables.has('faq_article'));
  assert.ok(tables.has('faq_topic'));
  assert.ok(tables.has('faq_article_faq_topic'));
});

// -- Columns -------------------------------------------------------------------

test('extracts column names from a bare comma-separated adx_columns list', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'lists/Article List.entitylist.yml',
    [
      'entitylogicalname: faq_article',
      'adx_columns: faq_articleid,faq_articletitle,faq_articlebody,createdon',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const cols = namesFor(refs, 'column');
  for (const expected of ['faq_articleid', 'faq_articletitle', 'faq_articlebody', 'createdon']) {
    assert.ok(cols.has(expected), `expected column ${expected} to be extracted`);
  }
});

test('extracts column names from a JSON-array adx_columns shape', (t) => {
  const root = makeEdmRoot(t);
  // Some PAC exports persist the column list as a JSON array embedded in the YAML value.
  // Both shapes are common in the wild so the extractor has to handle both.
  write(
    root,
    'lists/Article List.entitylist.yml',
    [
      'entitylogicalname: faq_article',
      'adx_columns: \'[{"name":"faq_articleid"},{"name":"faq_articletitle"},{"name":"faq_articlebody"}]\'',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const cols = namesFor(refs, 'column');
  assert.ok(cols.has('faq_articleid'));
  assert.ok(cols.has('faq_articletitle'));
  assert.ok(cols.has('faq_articlebody'));
});

test('extracts column refs from Liquid `{{ entity.<column> }}` tokens in web-pages', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'web-pages/article-detail/Article Detail.webpage.copy.html',
    [
      '<h1>{{ entity.faq_articletitle }}</h1>',
      '<div>{{ entity.faq_articlebody | escape }}</div>',
      '<small>{{ entity.createdon | date: "MMMM d, yyyy" }}</small>',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const cols = namesFor(refs, 'column');
  assert.ok(cols.has('faq_articletitle'));
  assert.ok(cols.has('faq_articlebody'));
  assert.ok(cols.has('createdon'));
});

test('extracts column refs from FetchXML <attribute name="..."/> tags', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'web-templates/Search.webtemplate.html',
    [
      '<fetch>',
      '  <entity name="faq_article">',
      '    <attribute name="faq_articletitle" />',
      '    <attribute name="faq_publishedstatus" />',
      '  </entity>',
      '</fetch>',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const cols = namesFor(refs, 'column');
  assert.ok(cols.has('faq_articletitle'));
  assert.ok(cols.has('faq_publishedstatus'));
});

// -- Relationships -------------------------------------------------------------

test('extracts relationship names from table-permission records', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'table-permissions/Article via Contact.tablepermission.yml',
    [
      'adx_name: Article via Contact',
      'entitylogicalname: faq_article',
      'contactrelationship: faq_article_contact',
      '',
    ].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const rels = namesFor(refs, 'relationship');
  assert.ok(rels.has('faq_article_contact'));
});

// -- Evidence rollup -----------------------------------------------------------

test('dedupes the same column referenced from multiple files into one finding with up to five evidence rows', (t) => {
  const root = makeEdmRoot(t);
  for (let i = 1; i <= 7; i++) {
    write(
      root,
      `web-pages/p${i}/Page ${i}.webpage.copy.html`,
      `<p>{{ entity.faq_articlebody }}</p>\n`,
    );
  }
  const refs = extractEdmReferences(root);
  const articleBody = (refs.column || []).find((r) => r.name === 'faq_articlebody');
  assert.ok(articleBody, 'expected a finding for faq_articlebody');
  // 7 referencing files but evidence is capped at 5 to keep the JSON output bounded on
  // wide migrations.
  assert.equal(articleBody.evidence.length, 5);
});

test('sorts findings by (parentTable, name) so analyze re-runs produce stable diffs', (t) => {
  const root = makeEdmRoot(t);
  write(
    root,
    'lists/X.entitylist.yml',
    ['entitylogicalname: zebra', 'adx_columns: zeta,alpha,beta', ''].join('\n'),
  );
  const refs = extractEdmReferences(root);
  const cols = (refs.column || []).map((c) => c.name);
  // alpha < beta < zeta — sorting matters for git-friendly artifacts.
  assert.deepEqual(cols, ['alpha', 'beta', 'zeta']);
});

// -- Robustness ----------------------------------------------------------------

test('returns empty groups when the EDM root has none of the expected folders', (t) => {
  const root = makeEdmRoot(t);
  write(root, 'something-unrelated.txt', 'noise');
  const refs = extractEdmReferences(root);
  assert.deepEqual(refs, {});
});

test('skips binary / unreadable files in web-files without crashing', (t) => {
  const root = makeEdmRoot(t);
  // Write a fake-binary asset under web-templates to ensure the walker doesn't try to
  // regex-scan it as text. The expected outcome is that the rest of the extraction still
  // succeeds for the surrounding YAML and template files.
  write(root, 'web-templates/Layout.webtemplate.yml', 'adx_name: Layout\n');
  fs.writeFileSync(path.join(root, 'web-templates/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(
    root,
    'web-templates/Layout.webtemplate.html',
    '<header>{{ entity.faq_articletitle }}</header>\n',
  );
  const refs = extractEdmReferences(root);
  assert.ok(namesFor(refs, 'column').has('faq_articletitle'));
});

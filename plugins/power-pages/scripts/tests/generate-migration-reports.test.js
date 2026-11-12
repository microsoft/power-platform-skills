const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  parseCSV, normalizeLocationPath, fillPlaceholders, generateCustomizationSection,
  rewriteFetchXmlInContent, annotateLiquidEntitiesInContent,
  buildDataModelExtensionChecklists, categorizePlugin,
} = require('../../skills/migrate-datamodel/scripts/generate-migration-reports');

const script = path.join(__dirname, '../../skills/migrate-datamodel/scripts/generate-migration-reports.js');
const fetchXml = '<fetch><entity name="adx_webpage"><attribute name="adx_name" /></entity></fetch>';
const liquid = "{{ entities['adx_contentsnippet'] }}";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-remediation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  const output = path.join(root, 'reports');
  fs.mkdirSync(site);
  const run = (...flags) => spawnSync(process.execPath, [
    script, '--site-name', 'Contoso', '--website-id', '00000000-0000-0000-0000-000000000001',
    '--site-path', site, '--output-dir', output, ...flags,
  ], { encoding: 'utf8', timeout: 10000 });
  const manifestPath = path.join(output, 'remediation-diff.json');
  const manifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { site, output, run, manifestPath, manifest };
}

test('both diff formats terminate on reordered/repeated lines and preserve the inputs', () => {
  // Run in a bounded child: a regression in the cursor loop must fail this test
  // rather than hang the entire test runner.
  const worker = `
    const assert = require('node:assert/strict');
    const {diffLines, unifiedDiff, structuredDiff} = require(${JSON.stringify(script)});
    for (const [before, after] of [
      ['A\\nB', 'B\\nA'], ['A\\nB\\nA', 'B\\nA\\nB'],
      ['A', 'A\\nB'], ['A\\nB', 'A'], ['', 'A'], ['A', ''], ['A', 'A'],
    ]) {
      const lines = diffLines(before, after);
      assert.equal(lines.filter(l => l.type !== 'added').map(l => l.text).join('\\n'), before);
      assert.equal(lines.filter(l => l.type !== 'removed').map(l => l.text).join('\\n'), after);
      const structured = structuredDiff(before, after);
      assert.equal(structured.linesAdded, lines.filter(l => l.type === 'added').length);
      assert.equal(structured.linesRemoved, lines.filter(l => l.type === 'removed').length);
      assert.equal(unifiedDiff(before, after, 'sample').length > 0, before !== after);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('separate remediation passes retain every file without changing live source', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'fetch.html'), fetchXml);
  fs.writeFileSync(path.join(fixture.site, 'liquid.html'), liquid);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.deepEqual(fixture.manifest().files.map((entry) => entry.relativePath), ['fetch.html']);
  const second = fixture.run('--automate-liquid');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fixture.manifest().files.map((entry) => entry.relativePath), ['fetch.html', 'liquid.html']);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'fetch.html'), 'utf8'), fetchXml);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'liquid.html'), 'utf8'), liquid);
});

test('both passes on one file preserve FetchXML and Liquid changes and reruns are idempotent', (t) => {
  const fixture = setup(t);
  const original = `${fetchXml}\n${liquid}`;
  fs.writeFileSync(path.join(fixture.site, 'combined.html'), original);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.equal(fixture.run('--automate-liquid').status, 0);
  const stagedPath = path.join(fixture.output, 'remediation-staged', 'combined.html');
  const staged = fs.readFileSync(stagedPath, 'utf8');
  assert.match(staged, /name="powerpagecomponent"/);
  assert.match(staged, /SDM\u2192EDM SUGGESTION/);
  assert.equal(fixture.manifest().files[0].kind, 'fetchxml+liquid');
  const repeated = fixture.run('--automate-liquid');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), staged);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'combined.html'), 'utf8'), original);
});

test('zero-rewrite rerun removes obsolete manifest and staged proposals', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.ok(fs.existsSync(fixture.manifestPath));
  fs.writeFileSync(path.join(fixture.site, 'page.html'), '<p>Already remediated</p>');
  const rerun = fixture.run('--automate-fetchxml');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
  assert.equal(fs.existsSync(path.join(fixture.output, 'remediation-staged', 'page.html')), false);
});

test('a different site cannot reuse an existing remediation manifest', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  const original = fs.readFileSync(fixture.manifestPath, 'utf8');
  const otherSite = path.join(fixture.site, 'other');
  fs.mkdirSync(otherSite);
  const result = fixture.run('--automate-liquid', '--site-path', otherSite);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the selected site root/);
  assert.equal(fs.readFileSync(fixture.manifestPath, 'utf8'), original);
});

test('null saved remediation inputs produce clear errors before proposals are removed', (t) => {
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  const stagedPath = path.join(fixture.output, 'remediation-staged', 'page.html');
  const staged = fs.readFileSync(stagedPath, 'utf8');
  for (const payload of [null, { siteRoot: fixture.site, files: [null] }]) {
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(payload));
    const result = fixture.run('--automate-fetchxml');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match|Unknown remediation kind/);
    assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
    assert.equal(fs.readFileSync(stagedPath, 'utf8'), staged);
  }
});

test('CSV parser preserves quoted commas, escaped quotes, multiline fields and CRLF', () => {
  assert.deepEqual(parseCSV('type,snippet,location\r\nLiquid,"say ""hi"",\nthen go",header.html\r\n'), [
    ['type', 'snippet', 'location'], ['Liquid', 'say "hi",\nthen go', 'header.html'],
  ]);
});

test('retry requests request headers so Retry-After is available', () => {
  const helper = path.join(__dirname, '../lib/validation-helpers.js');
  const worker = `
    const assert = require('node:assert/strict');
    let attempts = 0;
    require(${JSON.stringify(helper)}).makeRequest = async (options) => {
      assert.equal(options.includeHeaders, true);
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      return ++attempts === 1 ? { statusCode: 429, headers: { 'retry-after': '0' } } : { statusCode: 200 };
    };
    require(${JSON.stringify(script)}).makeRequestWithRetry({ headers: { Accept: 'application/json' } }, 1)
      .then(result => { assert.equal(result.statusCode, 200); assert.equal(attempts, 2); });
  `;
  const result = spawnSync(process.execPath, ['-e', worker], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test('location cleanup handles PAC temp paths and UNC extended paths', () => {
  assert.equal(normalizeLocationPath('\\\\?\\C:\\Temp\\portal\\web-templates\\Header.html'),
    'web-templates\\Header.html');
  assert.equal(normalizeLocationPath('\\\\?\\UNC\\server\\share\\Header.html'),
    '\\\\server\\share\\Header.html');
});

test('all repeated placeholders are filled and replacement dollar sequences stay literal', () => {
  assert.equal(fillPlaceholders('{{REPORT_DATE}} {{REPORT_DATE}} {{SITE_NAME}}', {
    '{{REPORT_DATE}}': '2026-01-01', '{{SITE_NAME}}': '$& $$ $1',
  }), '2026-01-01 2026-01-01 $& $$ $1');
});

test('CSV-derived report text is escaped and only HTTP(S) guidance becomes a link', () => {
  const html = generateCustomizationSection('<img src=x onerror=alert(1)>', [
    { location: '<script>location</script>', snippet: '<svg/onload=alert(2)>', guidance: 'javascript:alert(3)' },
    { location: 'safe', snippet: 'x'.repeat(250), guidance: 'https://learn.microsoft.com/?a=1&b=2' },
    { location: 'safe', guidance: 'not a URL <img src=x>' },
  ]);
  assert.doesNotMatch(html, /<img|<script>|<svg|href="javascript:/);
  assert.match(html, /&lt;script&gt;location&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /href="https:\/\/learn\.microsoft\.com\/\?a=1&amp;b=2"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.ok(html.includes('x'.repeat(200) + '...'));
  assert.ok(!html.includes('x'.repeat(201)));
});

test('link-entity-only FetchXML is staged, including Cloud Flow consumers', (t) => {
  const fixture = setup(t);
  const original = '<fetch><entity name="contoso_record"><link-entity name="adx_cloudflowconsumer"><attribute name="adx_name" /></link-entity></entity></fetch>';
  fs.writeFileSync(path.join(fixture.site, 'flow.html'), original);
  const result = fixture.run('--automate-fetchxml');
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(fixture.output, 'remediation-staged', 'flow.html'), 'utf8'),
    /powerpagecomponenttype" operator="eq" value="33"/);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'flow.html'), 'utf8'), original);
  assert.ok(result.stdout.includes(pathToFileURL(path.join(fixture.output, 'customization-report.html')).href));
});

test('printable rewrite sentinels do not collide with literal source or leak into output', () => {
  const original = '<fetch><entity name="adx_webpage">__MIGRATION_LINK_ENTITY_0__<link-entity name="adx_webtemplate"><attribute name="adx_name" /></link-entity></entity></fetch>';
  const result = rewriteFetchXmlInContent(original);
  assert.equal(result.changes.length, 2);
  assert.ok(result.newContent.includes('__MIGRATION_LINK_ENTITY_0__'));
  assert.match(result.newContent, /<link-entity name="powerpagecomponent">/);
  assert.equal(result.newContent.includes('\0'), false);
  assert.equal(fs.readFileSync(script).includes(0), false);
});

test('Liquid singular weblink receives guidance and summaries include the source entity', (t) => {
  const annotated = annotateLiquidEntitiesInContent("{{ entities['adx_weblink'] }}");
  assert.match(annotated.suggestions[0].suggestion, /weblinks/);
  const fixture = setup(t);
  fs.writeFileSync(path.join(fixture.site, 'link.html'), "{{ entities['adx_weblink'] }}");
  assert.equal(fixture.run('--automate-liquid').status, 0);
  assert.match(fixture.manifest().files[0].changeSummary[0], /^adx_weblink /);
});

test('DME transformation is limited to mapped metadata, and plugin guidance preserves logical attributes', () => {
  const items = ['adx_webpage', 'annotation', 'adx_invitation'].map((table) => ({
    snippet: `Table name : ${table}   Column name : contoso_value`,
  }));
  const checklists = buildDataModelExtensionChecklists(items);
  assert.deepEqual(checklists.map((item) => item.sourceTable), ['adx_webpage']);
  const plugin = categorizePlugin('Plugin name : Contoso.Plugin   Step name : Update  Entity Name : adx_webpage');
  assert.match(plugin.action, /preserve existing `adx_\*` logical attribute names/);
  const prompt = fs.readFileSync(path.join(path.dirname(script), 'prompts', 'dme-remediation.template.txt'), 'utf8');
  assert.match(prompt, /PageInfo = new PagingInfo \{ Count = 5000, PageNumber = 1 \}/);
  assert.match(prompt, /sourceQuery\.AddOrder/);
  assert.match(prompt, /if \(!sourceRows\.MoreRecords\) break/);
  assert.match(prompt, /sourceQuery\.PageInfo\.PagingCookie = sourceRows\.PagingCookie/);
  assert.match(prompt, /response\.IsFaulted/);
  assert.match(prompt, /confirm the approved metadata\s+migration has completed/);
  assert.match(prompt, /read-only preflight across ALL source rows/);
  assert.match(prompt, /verifiedComponentIds\.TryGetValue\(src\.Id, out var componentId\)/);
  assert.match(prompt, /"powerpagecomponent", componentId/);
  assert.doesNotMatch(prompt, /Then run the actual SDM.to.EDM migration/);
  assert.doesNotMatch(prompt, /"powerpagecomponent", src\.Id/);
});

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
  classifyCustomizationFinding, assessCustomizations, executeAutomatedRemediation,
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
  fs.writeFileSync(path.join(site, 'website.yml'), 'adx_websiteid: 00000000-0000-0000-0000-000000000001\n');
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
  fs.writeFileSync(path.join(otherSite, 'website.yml'), 'adx_websiteid: 00000000-0000-0000-0000-000000000002\n');
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

test('remediation rejects arbitrary roots before creating reports or altering existing proposals', (t) => {
  const fixture = setup(t);
  const empty = path.join(fixture.site, 'not-a-site');
  fs.mkdirSync(empty);
  for (const flag of ['--automate-fetchxml', '--automate-liquid']) {
    const result = fixture.run(flag, '--site-path', empty);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /downloaded Power Pages site containing website\.yml/);
    assert.equal(fs.existsSync(fixture.output), false);
  }
  fs.writeFileSync(path.join(fixture.site, 'page.html'), fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  const manifest = fs.readFileSync(fixture.manifestPath, 'utf8');
  const stagedPath = path.join(fixture.output, 'remediation-staged', 'page.html');
  const staged = fs.readFileSync(stagedPath, 'utf8');
  const result = fixture.run('--automate-liquid', '--site-path', empty);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(fixture.manifestPath, 'utf8'), manifest);
  assert.equal(fs.readFileSync(stagedPath, 'utf8'), staged);
});

test('remediation resolves managed metadata roots before scanning and binding the manifest', (t) => {
  const fixture = setup(t);
  const metadata = path.join(fixture.site, '.powerpages-site');
  fs.mkdirSync(metadata);
  fs.writeFileSync(path.join(metadata, 'website.yml'), 'adx_websiteid: 00000000-0000-0000-0000-000000000001\n');
  fs.writeFileSync(path.join(metadata, 'page.html'), `${fetchXml}\n${liquid}`);
  fs.writeFileSync(path.join(fixture.site, 'outside.html'), fetchXml);
  const result = fixture.run('--automate-fetchxml', '--automate-liquid');
  assert.equal(result.status, 0, result.stderr);
  const manifest = fixture.manifest();
  assert.equal(manifest.siteRoot, metadata);
  assert.deepEqual(manifest.files.map((file) => file.relativePath), ['page.html']);
  const staged = fs.readFileSync(path.join(fixture.output, 'remediation-staged', 'page.html'), 'utf8');
  assert.match(staged, /name="powerpagecomponent"/);
  assert.match(staged, /SDM\u2192EDM SUGGESTION/);
});

test('CSV parser preserves quoted commas, escaped quotes, multiline fields and CRLF', () => {
  assert.deepEqual(parseCSV('type,snippet,location\r\nLiquid,"say ""hi"",\nthen go",header.html\r\n'), [
    ['type', 'snippet', 'location'], ['Liquid', 'say "hi",\nthen go', 'header.html'],
  ]);
});

test('expected Liquid references are informational, but mixed or unknown usage is not suppressed', () => {
  const liquidType = 'Liquid contains adx references';
  for (const snippet of [
    '{{ page.adx_copy }}', '{{ website.adx_partialurl }}',
    "{% editable page 'adx_copy' %}", "{{ snippets['adx_name'] }}",
    '{{ botconsumer.adx_configjson }} {{ botconsumer.adx_botschemaname }}',
    '{{ incident.adx_resolutiondate }} {{ forums_sm.adx_name }}',
  ]) {
    assert.equal(classifyCustomizationFinding(liquidType, { snippet }).status, 'informational', snippet);
  }
  for (const snippet of [
    '', '{{ page.adx_copy }} adx_unknown',
    '{{ page.adx_copy }} <entity name="adx_webpage">',
    '{{ page.adx_copy }} {{ entities[adx_webpage] }}',
    '{{ entities.adx_webpage }}', '{{ page.adx_copy }} {{ entities[tableName] }}',
    "{{#label entityLogicalName 'adx_event'}}",
    "{{ entities['adx_communityforumthread'] }}",
  ]) {
    assert.equal(classifyCustomizationFinding(liquidType, { snippet }).status, 'needsReview', snippet);
  }
  for (const snippet of [
    liquid, `{{ page.adx_copy }} ${liquid}`,
    `{% fetchxml query %}${fetchXml}{% endfetchxml %}`,
    '{% fetchxml query %}<fetch><entity name="category"><link-entity name="adx_webpage"/></entity></fetch>{% endfetchxml %}',
  ]) {
    assert.equal(classifyCustomizationFinding(liquidType, { snippet }).status, 'actionable', snippet);
  }
  assert.equal(classifyCustomizationFinding(liquidType, {
    snippet: '{% fetchxml query %}<fetch><entity name="adx_communityforumthread"/></fetch>{% endfetchxml %}',
  }).status, 'needsReview');
});

test('FetchXML category variants share conservative target-aware assessment', () => {
  for (const type of ['Fetch Xml contains adx references', 'FetchXml contains adx references',
    'FetchXML contains adx references']) {
    assert.equal(classifyCustomizationFinding(type, { snippet: fetchXml }).status, 'actionable');
    assert.equal(classifyCustomizationFinding(type, {
      snippet: '<fetch><entity name="category"><link-entity name="knowledgearticle"/></entity></fetch>',
    }).status, 'informational');
    for (const snippet of [
      '<fetch><entity name="category">',
      '<fetch><entity name="adx_communityforumthread"><attribute name="adx_postcount"/></entity></fetch>',
      '<fetch><entity name="knowledgearticle"><attribute name="adx_custom"/></entity></fetch>',
    ]) {
      assert.equal(classifyCustomizationFinding(type, { snippet }).status, 'needsReview', snippet);
    }
  }
});

test('analysis and report counts separate expected references, actual manual work and investigation', async () => {
  const customizations = {
    'Liquid contains adx references': [
      { snippet: '{{ page.adx_copy }}', location: 'page.html' },
      { snippet: liquid, location: 'snippet.html' },
      { snippet: 'adx_unknown', location: 'unknown.html' },
    ],
    'Data Model Extension': [
      { snippet: 'Table name : adx_webpage   Column name : contoso_value' },
      { snippet: 'Table name : adx_invitation   Column name : contoso_value' },
    ],
    'Plugins registered on adx entities': [
      { snippet: 'Plugin name : Contoso.Plugin   Step name : Update  Entity Name : adx_webpage' },
      { snippet: 'Plugin name : Microsoft.Plugin   Step name : Update  Entity Name : adx_webpage' },
    ],
  };
  const assessment = assessCustomizations(customizations);
  assert.deepEqual(assessment.summary, { informational: 1, actionable: 3, needsReview: 3 });
  assert.equal(assessment.findings.length, 7);
  assert.equal(assessment.findings[0].location, 'page.html');
  assert.ok(assessment.findings.every((finding) => finding.reason.length > 0));
  const results = await executeAutomatedRemediation(customizations);
  assert.equal(results.informational.length, 1);
  assert.equal(results.manual.length, 3);
  assert.equal(results.needsReview.length, 3);
  assert.equal(results.automated.length, 0);
  assert.ok(results.manual.every((finding) => finding.assessment.status === 'actionable'));
});

test('CLI retains assessments with no proposals and does not report unknown work as completed', (t) => {
  const fixture = setup(t);
  const csv = path.join(fixture.site, 'SiteCustomization.csv');
  const assessmentPath = path.join(fixture.output, 'customization-assessment.json');
  const htmlPath = path.join(fixture.output, 'customization-report.html');
  const writeFinding = (snippet) => fs.writeFileSync(csv,
    'Type of customization,Snippet,Location,Guidance\n' +
    ['Liquid contains adx references', snippet, 'page.html', ''].map(
      (field) => `"${field.replace(/"/g, '""')}"`,
    ).join(',') + '\n');
  const expected = '{{ page.adx_copy }}';
  fs.writeFileSync(path.join(fixture.site, 'page.html'), expected);
  writeFinding(expected);
  let result = fixture.run('--customization-report', csv, '--automate-fetchxml', '--automate-liquid');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 informational, 0 actionable, 0 need context review/);
  assert.deepEqual(JSON.parse(fs.readFileSync(assessmentPath, 'utf8')).summary,
    { informational: 1, actionable: 0, needsReview: 0 });
  assert.equal(fs.existsSync(fixture.manifestPath), false);
  let html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /1 informational \(no rewrite identified\), 0 actionable, 0 need context review/);
  assert.match(html, /Informational - no rewrite identified/);
  assert.doesNotMatch(html, /Each customization will need|without post-migration remediation|Migration should proceed/);
  assert.equal(fs.readFileSync(path.join(fixture.site, 'page.html'), 'utf8'), expected);

  writeFinding('{{ page.adx_copy }} adx_unknown');
  result = fixture.run('--customization-report', csv, '--automate-fetchxml', '--automate-liquid');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(assessmentPath, 'utf8')).summary,
    { informational: 0, actionable: 0, needsReview: 1 });
  html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /Context review needed - not a confirmed defect/);
  assert.match(html, /0 informational \(no rewrite identified\), 0 actionable, 1 need context review/);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
});

test('workflow gates only real proposals and distinguishes expected review from named-risk deferral on both tracks', () => {
  const skill = fs.readFileSync(path.join(path.dirname(script), '..', 'SKILL.md'), 'utf8');
  const authoring = skill.slice(skill.indexOf('### 2.4 Remediate Customizations'),
    skill.indexOf('## Phase 2 — Downstream Track'));
  const downstream = skill.slice(skill.indexOf('### 3.4 Remediate Customizations'),
    skill.indexOf('### 3.5 Activate EDM'));
  assert.match(authoring, /Configuration metadata has migrated\./);
  assert.match(authoring, /Only show this checkpoint and approval question when `files\[\]` is nonempty/);
  assert.match(authoring, /missing\/empty manifest means skip steps 6–7/);
  assert.match(authoring, /Review expected references \(optional\)/);
  assert.match(authoring, /Defer these named items and proceed \(acknowledge their risk\)/);
  assert.match(authoring, /--add-decision/);
  assert.match(authoring, /No unresolved actionable items and no unresolved context review/);
  assert.match(downstream, /Raw references on Prod\/Test\/UAT do not by themselves establish an ALM gap/);
  assert.match(downstream, /only a valid nonempty manifest with existing staged files triggers/);
  assert.doesNotMatch(authoring, /Configuration is migrated|One or more findings.*proceed with auto-rewriters/);
  assert.doesNotMatch(downstream, /finding them here indicates an ALM gap/);
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

test('review regression: skipped FetchXML containers never retain partial nested rewrites', () => {
  const nested = '<link-entity name="adx_webtemplate"><attribute name="adx_name" /></link-entity>';
  for (const original of [
    `<fetch><entity name="adx_webpage"><filter type="or"><condition attribute="adx_name" operator="eq" value="Home" /></filter>${nested}</entity></fetch>`,
    `<fetch><entity name="adx_unmapped">${nested}</entity></fetch>`,
    '<fetch><entity name="adx_webpage"><link-entity name="adx_webtemplate"><filter type="or"><condition attribute="adx_name" operator="eq" value="Header" /></filter></link-entity></entity></fetch>',
  ]) {
    const result = rewriteFetchXmlInContent(original);
    assert.equal(result.newContent, original);
    assert.deepEqual(result.changes, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /manual review|No powerpagecomponenttype mapping/);
  }
});

test('review regression: a skipped FetchXML query does not prevent independent supported queries', () => {
  const skipped = '<fetch><entity name="adx_webpage"><filter type="or"></filter><link-entity name="adx_webtemplate"></link-entity></entity></fetch>';
  const result = rewriteFetchXmlInContent(`${skipped}\n${fetchXml}`);
  assert.ok(result.newContent.startsWith(skipped + '\n'));
  assert.match(result.newContent.slice(skipped.length), /name="powerpagecomponent"/);
  assert.deepEqual(result.changes, [{ tag: 'entity', entity: 'adx_webpage', typeValue: 2 }]);
  assert.equal(result.skipped.length, 1);
  const standalone = rewriteFetchXmlInContent('<link-entity name="adx_webtemplate"></link-entity>');
  assert.equal(standalone.changes.length, 1);
  assert.match(standalone.newContent, /name="powerpagecomponent"/);
});

test('review regression: skipped FetchXML removes obsolete proposals without changing live source', (t) => {
  const fixture = setup(t);
  const livePath = path.join(fixture.site, 'page.html');
  fs.writeFileSync(livePath, fetchXml);
  assert.equal(fixture.run('--automate-fetchxml').status, 0);
  assert.ok(fs.existsSync(fixture.manifestPath));
  const original = '<fetch><entity name="adx_webpage"><filter type="or"></filter><link-entity name="adx_webtemplate"></link-entity></entity></fetch>';
  fs.writeFileSync(livePath, original);
  const result = fixture.run('--automate-fetchxml');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(livePath, 'utf8'), original);
  assert.equal(fs.existsSync(fixture.manifestPath), false);
  assert.equal(fs.existsSync(path.join(fixture.output, 'remediation-staged', 'page.html')), false);
});

test('review regression: plugin actions and generated prompts restrict rewrites to mapped metadata', (t) => {
  const fixture = setup(t);
  const targets = ['adx_webpage', 'adx_invitation', 'adx_externalidentity', 'adx_portalcomment',
    'adx_unmapped', 'contoso_record', 'constructor', ''];
  const findings = targets.map((entity) => ({
    snippet: `Plugin name : Contoso.Plugin   Step name : Update  Entity Name : ${entity}`,
  }));
  const mapped = categorizePlugin(findings[0].snippet);
  assert.equal(mapped.componentType, 2);
  assert.match(mapped.action, /refactor the plugin code to target/);
  for (const item of findings.slice(1)) {
    const plugin = categorizePlugin(item.snippet);
    assert.equal(plugin.componentType, null);
    assert.match(plugin.action, /manual review/i);
    assert.match(plugin.action, /unchanged/);
    assert.doesNotMatch(plugin.action, /refactor the plugin code to target|re-register/);
    assert.equal(classifyCustomizationFinding('Plugins registered on adx entities', item).status, 'needsReview');
  }
  const csv = path.join(fixture.site, 'SiteCustomization.csv');
  fs.writeFileSync(csv, 'Type of customization,Snippet\n' + findings.map(({ snippet }) =>
    ['Plugins registered on adx entities', snippet]
      .map((field) => `"${field.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');
  const result = fixture.run('--customization-report', csv);
  assert.equal(result.status, 0, result.stderr);
  const prompt = fs.readFileSync(path.join(fixture.output, 'plugin-remediation-prompt.txt'), 'utf8');
  assert.match(prompt, /Supported metadata targets only/);
  assert.match(prompt, /\| `adx_webpage` \| 2 \|/);
  assert.match(prompt, /adx_invitation.*manual review/i);
  assert.match(prompt, /adx_portalcomment.*manual review/i);
  assert.doesNotMatch(prompt, /Custom plugins \(everything else\) need code-level\s+refactoring/);
  assert.doesNotMatch(prompt, /\{\{PLUGIN_METADATA_MAPPING_BLOCK\}\}/);
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

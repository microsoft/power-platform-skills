'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  analyze,
  scanFetchXmlContent,
  scanListContent,
  scanWebpageApiContent,
  scanWebApiContent,
  scanClientScript,
  scanHtmlHead,
  scanCssContent,
  scanSiteSettings,
  evaluateCounts,
  scanLargeAssets,
  FETCHXML_MAX_COUNT,
  FETCHXML_MAX_ATTRIBUTES,
  WEBAPI_MAX_TOP,
  WEBAPI_MAX_SELECT_COLUMNS,
  WEB_FILE_WARN_THRESHOLD,
  WEB_ROLE_WARN_THRESHOLD,
  LARGE_ASSET_BYTES,
  SHORT_POLL_INTERVAL_MS,
} = require('../../skills/perf-checker/scripts/analyze-perf');

// Collect the `tag`s a rule function produced — every assertion below is about
// which anti-pattern tags fire (or don't) for a given input, so this keeps the
// tests focused on behavior rather than message wording.
function tags(findings) {
  return findings.map((f) => f.tag);
}

// ── FetchXML rules ───────────────────────────────────────────────────────────

test('scanFetchXmlContent flags <all-attributes/> as PERF-FETCHXML-ALLATTR', () => {
  const xml = '<fetch count="10"><entity name="contact"><all-attributes /></entity></fetch>';
  const found = tags(scanFetchXmlContent(xml, 'a.html'));
  assert.ok(found.includes('PERF-FETCHXML-ALLATTR'));
  // all-attributes is present, so the "no explicit columns" rule must NOT also fire.
  assert.ok(!found.includes('PERF-FETCHXML-NO-COLUMNS'));
});

test('scanFetchXmlContent flags an entity with no attributes as PERF-FETCHXML-NO-COLUMNS', () => {
  const xml = '<fetch count="10"><entity name="contact"><filter><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch>';
  assert.ok(tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-NO-COLUMNS'));
});

test('scanFetchXmlContent flags a fetch with no count as PERF-FETCHXML-NO-PAGING', () => {
  const xml = '<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>';
  assert.ok(tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-NO-PAGING'));
});

test('scanFetchXmlContent flags a large count as PERF-FETCHXML-LARGE-COUNT', () => {
  const xml = `<fetch count="${FETCHXML_MAX_COUNT + 1}"><entity name="contact"><attribute name="fullname"/></entity></fetch>`;
  const found = tags(scanFetchXmlContent(xml, 'a.html'));
  assert.ok(found.includes('PERF-FETCHXML-LARGE-COUNT'));
  assert.ok(!found.includes('PERF-FETCHXML-NO-PAGING')); // a count is present
});

test('scanFetchXmlContent does NOT flag a reasonable count', () => {
  const xml = `<fetch count="${FETCHXML_MAX_COUNT}"><entity name="contact"><attribute name="fullname"/></entity></fetch>`;
  const found = tags(scanFetchXmlContent(xml, 'a.html'));
  assert.ok(!found.includes('PERF-FETCHXML-LARGE-COUNT'));
  assert.ok(!found.includes('PERF-FETCHXML-NO-PAGING'));
});

test('scanFetchXmlContent exempts aggregate fetches from paging/columns rules', () => {
  // Aggregate queries return a single summary row — no paging or projection needed.
  const xml = '<fetch aggregate="true"><entity name="contact"><attribute name="contactid" alias="c" aggregate="count"/></entity></fetch>';
  const found = tags(scanFetchXmlContent(xml, 'a.html'));
  assert.deepEqual(found, []);
});

test('scanFetchXmlContent flags a fetch inside a Liquid for-loop as PERF-FETCHXML-IN-LOOP', () => {
  const liquid = '{% for c in contacts %}<fetch count="5"><entity name="task"><attribute name="subject"/></entity></fetch>{% endfor %}';
  assert.ok(tags(scanFetchXmlContent(liquid, 'a.liquid')).includes('PERF-FETCHXML-IN-LOOP'));
});

test('scanFetchXmlContent does NOT flag a fetch after a closed for-loop', () => {
  const liquid = '{% for c in contacts %}{{ c.name }}{% endfor %}<fetch count="5"><entity name="task"><attribute name="subject"/></entity></fetch>';
  assert.ok(!tags(scanFetchXmlContent(liquid, 'a.liquid')).includes('PERF-FETCHXML-IN-LOOP'));
});

test('scanFetchXmlContent returns nothing for content without a fetch element', () => {
  assert.deepEqual(scanFetchXmlContent('<div>no fetch here</div>', 'a.html'), []);
});

test('scanFetchXmlContent flags returntotalrecordcount="true" as PERF-FETCHXML-TOTALRECORDCOUNT', () => {
  const xml = '<fetch count="10" returntotalrecordcount="true"><entity name="contact"><attribute name="fullname"/></entity></fetch>';
  const found = tags(scanFetchXmlContent(xml, 'a.html'));
  assert.ok(found.includes('PERF-FETCHXML-TOTALRECORDCOUNT'));
});

test('scanFetchXmlContent does NOT flag returntotalrecordcount when absent', () => {
  const xml = '<fetch count="10"><entity name="contact"><attribute name="fullname"/></entity></fetch>';
  assert.ok(!tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-TOTALRECORDCOUNT'));
});

test('scanFetchXmlContent flags advanced query hints for review', () => {
  const xml = [
    '<fetch count="10" options="ForceOrder" latematerialize="true">',
    '<entity name="contact"><attribute name="fullname"/>',
    '<filter type="or" hint="union"><condition attribute="statecode" operator="eq" value="0"/></filter>',
    '</entity></fetch>',
  ].join('');
  const found = scanFetchXmlContent(xml, 'a.html');
  const hint = found.find((f) => f.tag === 'PERF-FETCHXML-QUERY-HINT');
  assert.ok(hint);
  assert.match(hint.details, /ForceOrder/);
  assert.match(hint.details, /latematerialize/);
  assert.match(hint.details, /union/);
});

test('scanFetchXmlContent flags request-time cache busting', () => {
  const xml = [
    '<fetch count="10"><entity name="contact"><attribute name="fullname"/>',
    '<filter><condition attribute="createdon" operator="lt" ',
    'value="{{ \"now\" | date: \"yyyy-MM-dd HH:mm:ss\" }}"/></filter>',
    '</entity></fetch>',
  ].join('');
  assert.ok(tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-CACHE-BYPASS'));
});

test('scanFetchXmlContent does not flag a static date filter as cache bypassing', () => {
  const xml = [
    '<fetch count="10"><entity name="contact"><attribute name="fullname"/>',
    '<filter><condition attribute="createdon" operator="lt" value="2026-01-01"/></filter>',
    '</entity></fetch>',
  ].join('');
  assert.ok(!tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-CACHE-BYPASS'));
});

test('scanFetchXmlContent flags wide projections as PERF-FETCHXML-MANY-COLUMNS', () => {
  const attrs = Array.from(
    { length: FETCHXML_MAX_ATTRIBUTES + 1 },
    (_, i) => `<attribute name="field${i}" />`,
  ).join('');
  const xml = `<fetch count="10"><entity name="contact">${attrs}</entity></fetch>`;
  assert.ok(tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-MANY-COLUMNS'));
});

test('scanFetchXmlContent flags leading-wildcard like filters', () => {
  const xml = [
    '<fetch count="10"><entity name="contact"><attribute name="fullname"/>',
    '<filter><condition attribute="fullname" operator="like" value="%smith"/></filter>',
    '</entity></fetch>',
  ].join('');
  assert.ok(tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-LEADING-WILDCARD'));
});

test('scanFetchXmlContent flags related-column ordering', () => {
  const xml = [
    '<fetch count="10"><entity name="account"><attribute name="name"/>',
    '<link-entity name="contact" from="contactid" to="primarycontactid" alias="pc">',
    '<order attribute="fullname" />',
    '</link-entity></entity></fetch>',
  ].join('');
  assert.ok(tags(scanFetchXmlContent(xml, 'a.html')).includes('PERF-FETCHXML-ORDER-RELATED'));
});

// ── Power Pages list and webpage-as-API rules ───────────────────────────────

test('scanListContent flags a list with no page size', () => {
  const yaml = 'adx_entitylistid: 11111111-1111-4111-8111-111111111111\nadx_name: Cases\n';
  const found = scanListContent(yaml, 'lists/Cases.list.yml');
  assert.equal(found.length, 1);
  assert.equal(found[0].tag, 'PERF-LIST-NO-PAGING');
});

test('scanListContent accepts a positive page size', () => {
  const yaml = [
    'adx_entitylistid: 11111111-1111-4111-8111-111111111111',
    'adx_name: Cases',
    'adx_pagesize: 10',
    '',
  ].join('\n');
  assert.deepEqual(scanListContent(yaml, 'lists/Cases.list.yml'), []);
});

test('scanWebpageApiContent flags a FetchXML-backed JSON web template', () => {
  const template = [
    '{% fetchxml rows %}',
    '<fetch count="10"><entity name="contact"><attribute name="fullname"/></entity></fetch>',
    '{% endfetchxml %}',
    '{ "items": [{% for row in rows.results.entities %}',
    '{ "name": "{{ row.fullname }}" }{% unless forloop.last %},{% endunless %}',
    '{% endfor %}] }',
  ].join('\n');
  const found = scanWebpageApiContent(
    template,
    'web-templates/contact-api/Contact-API.webtemplate.source.html',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].tag, 'PERF-WEBPAGE-AS-API');
});

test('scanWebpageApiContent ignores a normal HTML web template', () => {
  const template = [
    '{% fetchxml rows %}',
    '<fetch count="10"><entity name="contact"><attribute name="fullname"/></entity></fetch>',
    '{% endfetchxml %}',
    '<section><ul>{% for row in rows.results.entities %}<li>{{ row.fullname }}</li>{% endfor %}</ul></section>',
  ].join('\n');
  assert.deepEqual(
    scanWebpageApiContent(template, 'web-templates/list/List.webtemplate.source.html'),
    [],
  );
});

// ── Client-side script rules (blocking / anti-pattern JS) ────────────────────

test('scanClientScript flags a synchronous XMLHttpRequest as PERF-SYNC-XHR', () => {
  const code = 'const xhr = new XMLHttpRequest(); xhr.open("GET", url, false); xhr.send();';
  const found = scanClientScript(code, 'a.js');
  const hit = found.find((f) => f.tag === 'PERF-SYNC-XHR');
  assert.ok(hit);
  assert.equal(hit.severity, 'high');
});

test('scanClientScript does NOT flag an async XMLHttpRequest', () => {
  const code = 'xhr.open("GET", url, true); xhr.open("POST", url);';
  assert.ok(!tags(scanClientScript(code, 'a.js')).includes('PERF-SYNC-XHR'));
});

test('scanClientScript flags jQuery async:false as PERF-JQUERY-SYNC-AJAX only when an .ajax( call is present', () => {
  const ajax = '$.ajax({ url: "/x", async: false, success: fn });';
  assert.ok(tags(scanClientScript(ajax, 'a.js')).includes('PERF-JQUERY-SYNC-AJAX'));
  // No .ajax( call ⇒ a stray async:false in another config object is not flagged.
  const other = 'const opts = { async: false };';
  assert.ok(!tags(scanClientScript(other, 'a.js')).includes('PERF-JQUERY-SYNC-AJAX'));
  // `isAsync: false` must not be mistaken for the async option.
  const substr = '$.ajax({ url: "/x" }); const isAsync = false;';
  assert.ok(!tags(scanClientScript(substr, 'a.js')).includes('PERF-JQUERY-SYNC-AJAX'));
});

test('scanClientScript flags document.write as PERF-DOCUMENT-WRITE', () => {
  assert.ok(tags(scanClientScript('document.write("<b>x</b>");', 'a.js')).includes('PERF-DOCUMENT-WRITE'));
  assert.ok(tags(scanClientScript('document.writeln("x");', 'a.js')).includes('PERF-DOCUMENT-WRITE'));
});

test('scanClientScript flags short-interval Web API polling as PERF-SHORT-POLL', () => {
  const code = `setInterval(() => { fetch("/_api/tasks?$select=subject"); }, ${SHORT_POLL_INTERVAL_MS - 1});`;
  assert.ok(tags(scanClientScript(code, 'a.js')).includes('PERF-SHORT-POLL'));
});

test('scanClientScript does NOT flag polling at/above the interval threshold or without a Web API call', () => {
  const slow = `setInterval(() => { fetch("/_api/tasks"); }, ${SHORT_POLL_INTERVAL_MS});`;
  assert.ok(!tags(scanClientScript(slow, 'a.js')).includes('PERF-SHORT-POLL'));
  // A tight interval that doesn't touch the Web API is out of scope for this rule.
  const noApi = 'setInterval(() => { updateClock(); }, 1000);';
  assert.ok(!tags(scanClientScript(noApi, 'a.js')).includes('PERF-SHORT-POLL'));
});

test('scanClientScript returns nothing for clean client code', () => {
  assert.deepEqual(scanClientScript('const x = await fetch("/_api/c?$select=n&$top=5");', 'a.js'), []);
});

// ── Render-blocking <head> script rule ───────────────────────────────────────

test('scanHtmlHead flags a render-blocking script in <head> as PERF-RENDER-BLOCKING-SCRIPT', () => {
  const html = '<html><head><script src="/lib/big.js"></script></head><body></body></html>';
  assert.ok(tags(scanHtmlHead(html, 'index.html')).includes('PERF-RENDER-BLOCKING-SCRIPT'));
});

test('scanHtmlHead does NOT flag async/defer/module head scripts or scripts outside <head>', () => {
  assert.deepEqual(scanHtmlHead('<head><script src="/a.js" defer></script></head>', 'p.html'), []);
  assert.deepEqual(scanHtmlHead('<head><script src="/a.js" async></script></head>', 'p.html'), []);
  assert.deepEqual(scanHtmlHead('<head><script type="module" src="/a.js"></script></head>', 'p.html'), []);
  // A blocking script in <body> is not this rule's concern.
  assert.deepEqual(scanHtmlHead('<head></head><body><script src="/a.js"></script></body>', 'p.html'), []);
});

// ── Runtime CSS rule (render-blocking @import) ───────────────────────────────

test('scanCssContent flags @import as PERF-CSS-IMPORT', () => {
  assert.ok(tags(scanCssContent('@import url("base.css");\nbody { color: red; }', 'site.css')).includes('PERF-CSS-IMPORT'));
});

test('scanCssContent does NOT flag a commented-out @import and keeps accurate line numbers', () => {
  const css = 'body { color: red; }\n/* @import "old.css"; */\n@import "real.css";';
  const found = scanCssContent(css, 'site.css');
  // Only the real (uncommented) @import is flagged.
  assert.equal(found.length, 1);
  // It sits on line 3 of the source, not line 2 (the comment).
  assert.equal(found[0].location, 'site.css:3');
});

// ── Web API rules ────────────────────────────────────────────────────────────

test('scanWebApiContent flags $select=* as PERF-WEBAPI-SELECT-STAR', () => {
  const code = 'fetch("/_api/contacts?$select=*&$filter=statecode eq 0")';
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-SELECT-STAR'));
});

test('scanWebApiContent flags a query with options but no $select as PERF-WEBAPI-NO-SELECT', () => {
  const code = 'fetch("/_api/contacts?$filter=statecode eq 0&$top=10")';
  const found = tags(scanWebApiContent(code, 'a.js'));
  assert.ok(found.includes('PERF-WEBAPI-NO-SELECT'));
  assert.ok(!found.includes('PERF-WEBAPI-NO-TOP')); // $top present
});

test('scanWebApiContent flags a collection query with no $top as PERF-WEBAPI-NO-TOP', () => {
  const code = 'fetch("/_api/contacts?$select=fullname&$orderby=createdon desc")';
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-NO-TOP'));
});

test('scanWebApiContent flags large $top values as PERF-WEBAPI-LARGE-TOP', () => {
  const code = `fetch("/_api/contacts?$select=fullname&$top=${WEBAPI_MAX_TOP + 1}")`;
  const found = tags(scanWebApiContent(code, 'a.js'));
  assert.ok(found.includes('PERF-WEBAPI-LARGE-TOP'));
  assert.ok(!found.includes('PERF-WEBAPI-NO-TOP'));
});

test('scanWebApiContent flags $count=true as PERF-WEBAPI-COUNT', () => {
  const code = 'fetch("/_api/contacts?$select=fullname&$top=20&$count=true")';
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-COUNT'));
});

test('scanWebApiContent flags $expand without nested $select', () => {
  const missingNestedSelect = 'fetch("/_api/accounts?$select=name&$top=10&$expand=primarycontactid")';
  assert.ok(tags(scanWebApiContent(missingNestedSelect, 'a.js')).includes('PERF-WEBAPI-EXPAND-NO-SELECT'));

  const nestedSelect = 'fetch("/_api/accounts?$select=name&$top=10&$expand=primarycontactid($select=fullname)")';
  assert.ok(!tags(scanWebApiContent(nestedSelect, 'a.js')).includes('PERF-WEBAPI-EXPAND-NO-SELECT'));
});

test('scanWebApiContent flags wide $select lists as PERF-WEBAPI-MANY-COLUMNS', () => {
  const columns = Array.from({ length: WEBAPI_MAX_SELECT_COLUMNS + 1 }, (_, i) => `field${i}`).join(',');
  const code = `fetch("/_api/contacts?$select=${columns}&$top=20")`;
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-MANY-COLUMNS'));
});

test('scanWebApiContent flags contains and endswith filters', () => {
  const contains = 'fetch("/_api/contacts?$select=fullname&$top=20&$filter=contains(fullname,\\\'smith\\\')")';
  assert.ok(tags(scanWebApiContent(contains, 'a.js')).includes('PERF-WEBAPI-WILDCARD-FILTER'));

  const startswith = 'fetch("/_api/contacts?$select=fullname&$top=20&$filter=startswith(fullname,\\\'s\\\')")';
  assert.ok(!tags(scanWebApiContent(startswith, 'a.js')).includes('PERF-WEBAPI-WILDCARD-FILTER'));
});

test('scanWebApiContent flags request-time date filters as cache bypassing', () => {
  const code = 'fetch(`/_api/tasks?$select=subject&$top=20&$filter=createdon ge ${new Date().toISOString()}`)';
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-CACHE-BYPASS'));
});

test('scanWebApiContent flags related-column ordering', () => {
  const code = 'fetch("/_api/accounts?$select=name&$top=20&$orderby=primarycontactid/fullname asc")';
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-ORDER-RELATED'));
});

test('scanWebApiContent does NOT flag a well-formed bounded query', () => {
  const code = 'fetch("/_api/contacts?$select=fullname&$top=20")';
  const found = tags(scanWebApiContent(code, 'a.js'));
  assert.ok(!found.includes('PERF-WEBAPI-SELECT-STAR'));
  assert.ok(!found.includes('PERF-WEBAPI-NO-SELECT'));
  // No $filter/$orderby/$expand/$apply ⇒ not treated as an unbounded collection query.
  assert.ok(!found.includes('PERF-WEBAPI-NO-TOP'));
});

test('scanWebApiContent flags an async map calling the Web API as PERF-WEBAPI-IN-LOOP', () => {
  const code = 'ids.map(async (id) => { return fetch(`/_api/contacts(${id})?$select=fullname`); })';
  assert.ok(tags(scanWebApiContent(code, 'a.js')).includes('PERF-WEBAPI-IN-LOOP'));
});

test('scanWebApiContent does NOT flag a plain map over already-fetched results', () => {
  const code = 'rows.map((r) => r.fullname).join(", ")';
  assert.deepEqual(scanWebApiContent(code, 'a.js'), []);
});

test('scanWebApiContent returns nothing for code without /_api/', () => {
  assert.deepEqual(scanWebApiContent('const x = fetch("/other/endpoint")', 'a.js'), []);
});

// ── Site-settings rules ──────────────────────────────────────────────────────

function settingsMap(entries) {
  const m = new Map();
  for (const [name, value] of entries) {
    m.set(name.toLowerCase(), { name, value, filePath: `.powerpages-site/site-settings/${name.replace(/\//g, '-')}.sitesetting.yml` });
  }
  return m;
}

test('scanSiteSettings returns nothing when the site-settings dir is absent', () => {
  assert.deepEqual(scanSiteSettings(new Map(), null), []);
});

test('scanSiteSettings flags header cache present-and-false as a warning with a set-site-setting autofix', () => {
  const found = scanSiteSettings(settingsMap([['Header/OutputCache/Enabled', false]]), '.powerpages-site/site-settings');
  const header = found.find((f) => f.tag === 'PERF-HEADER-OUTPUTCACHE');
  assert.ok(header);
  assert.equal(header.severity, 'warning');
  assert.equal(header.autoFixAvailable, true);
  assert.equal(header.fixAction.type, 'set-site-setting');
  assert.equal(header.fixAction.value, 'true');
});

test('scanSiteSettings flags absent footer cache as info with a create-site-setting autofix', () => {
  const found = scanSiteSettings(settingsMap([['Header/OutputCache/Enabled', true]]), '.powerpages-site/site-settings');
  const footer = found.find((f) => f.tag === 'PERF-FOOTER-OUTPUTCACHE');
  assert.ok(footer);
  assert.equal(footer.severity, 'info');
  assert.equal(footer.fixAction.type, 'create-site-setting');
});

test('scanSiteSettings does not flag caching when both are explicitly enabled', () => {
  const found = scanSiteSettings(
    settingsMap([['Header/OutputCache/Enabled', true], ['Footer/OutputCache/Enabled', 'true']]),
    '.powerpages-site/site-settings',
  );
  assert.ok(!tags(found).includes('PERF-HEADER-OUTPUTCACHE'));
  assert.ok(!tags(found).includes('PERF-FOOTER-OUTPUTCACHE'));
});

test('scanSiteSettings flags sign-in tracking enabled as PERF-SIGNIN-TRACKING', () => {
  const found = scanSiteSettings(
    settingsMap([
      ['Header/OutputCache/Enabled', true],
      ['Footer/OutputCache/Enabled', true],
      ['Authentication/LoginTrackingEnabled', true],
    ]),
    '.powerpages-site/site-settings',
  );
  const signin = found.find((f) => f.tag === 'PERF-SIGNIN-TRACKING');
  assert.ok(signin);
  assert.equal(signin.fixAction.value, 'false');
});

test('scanSiteSettings keeps absent classic aggregate settings manual-only', () => {
  const found = scanSiteSettings(new Map(), 'sitesetting.yml', 'classic');
  const header = found.find((f) => f.tag === 'PERF-HEADER-OUTPUTCACHE');
  assert.ok(header);
  assert.equal(header.autoFixAvailable, false);
  assert.equal(header.fixAction, null);
  assert.match(header.fix, /classic sitesetting\.yml export/);
});

// ── Count rules ──────────────────────────────────────────────────────────────

test('evaluateCounts flags web-file and web-role counts over threshold', () => {
  const found = tags(evaluateCounts({
    webFileCount: WEB_FILE_WARN_THRESHOLD + 1,
    webRoleCount: WEB_ROLE_WARN_THRESHOLD + 1,
  }));
  assert.ok(found.includes('PERF-WEBFILE-COUNT'));
  assert.ok(found.includes('PERF-WEBROLE-COUNT'));
});

test('evaluateCounts does not flag counts at or below threshold', () => {
  const found = evaluateCounts({ webFileCount: WEB_FILE_WARN_THRESHOLD, webRoleCount: WEB_ROLE_WARN_THRESHOLD });
  assert.deepEqual(found, []);
});

// ── Large asset rule ─────────────────────────────────────────────────────────

test('scanLargeAssets flags oversized assets and caps/sorts the output', () => {
  const found = scanLargeAssets([
    { relPath: 'small.png', size: 1024 },
    { relPath: 'big.png', size: LARGE_ASSET_BYTES * 3 },
    { relPath: 'medium.png', size: LARGE_ASSET_BYTES * 2 },
  ]);
  assert.equal(found.length, 2);
  assert.equal(found[0].location, 'big.png'); // largest first
  assert.ok(found.every((f) => f.tag === 'PERF-LARGE-STATIC-ASSET'));
});

// ── analyze() integration over a temp project ────────────────────────────────

test('analyze() walks a project, assigns perf-N ids, and aggregates findings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-analyze-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, '.powerpages-site', 'web-templates', 'home'), { recursive: true });
  fs.mkdirSync(path.join(root, '.powerpages-site', 'site-settings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  fs.writeFileSync(
    path.join(root, '.powerpages-site', 'web-templates', 'home', 'Home.webtemplate.source.html'),
    '{% for i in items %}<fetch><entity name="p"><all-attributes /></entity></fetch>{% endfor %}',
  );
  fs.writeFileSync(
    path.join(root, '.powerpages-site', 'site-settings', 'Header-OutputCache-Enabled.sitesetting.yml'),
    'name: Header/OutputCache/Enabled\nvalue: false\n',
  );
  fs.writeFileSync(path.join(root, 'src', 'api.js'), 'fetch("/_api/products?$select=*")');
  fs.writeFileSync(path.join(root, 'src', 'legacy.js'), 'var xhr=new XMLHttpRequest();xhr.open("GET", u, false);xhr.send();');
  fs.writeFileSync(path.join(root, 'src', 'site.css'), '@import "reset.css";\nbody{color:red}');
  fs.writeFileSync(path.join(root, 'index.html'), '<html><head><script src="/lib/big.js"></script></head><body></body></html>');

  const result = analyze(root);
  assert.equal(result.status, 'ok');
  const found = tags(result.findings);
  assert.ok(found.includes('PERF-FETCHXML-ALLATTR'));
  assert.ok(found.includes('PERF-FETCHXML-IN-LOOP'));
  assert.ok(found.includes('PERF-HEADER-OUTPUTCACHE'));
  assert.ok(found.includes('PERF-WEBAPI-SELECT-STAR'));
  assert.ok(found.includes('PERF-SYNC-XHR'));
  assert.ok(found.includes('PERF-CSS-IMPORT'));
  assert.ok(found.includes('PERF-RENDER-BLOCKING-SCRIPT'));
  // Ids are sequential perf-1, perf-2, ...
  result.findings.forEach((f, i) => assert.equal(f.id, `perf-${i + 1}`));
  // details is the kv envelope the shared report pipeline expects.
  assert.equal(result.details.kind, 'kv');
});

test('analyze() supports a classic PAC download with root-level metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-classic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, '.portalconfig'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web-files'), { recursive: true });
  fs.writeFileSync(path.join(root, 'website.yml'), 'adx_name: Example Site\n');
  fs.writeFileSync(
    path.join(root, 'sitesetting.yml'),
    [
      '- adx_name: Header/OutputCache/Enabled',
      '  adx_sitesettingid: 11111111-1111-4111-8111-111111111111',
      '  adx_value: false',
      '- adx_name: Footer/OutputCache/Enabled',
      '  adx_sitesettingid: 22222222-2222-4222-8222-222222222222',
      '  adx_value: true',
      '- adx_name: Authentication/LoginTrackingEnabled',
      '  adx_sitesettingid: 33333333-3333-4333-8333-333333333333',
      '  adx_value: true',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'webrole.yml'),
    [
      '- adx_name: Anonymous Users',
      '  adx_webroleid: 44444444-4444-4444-8444-444444444444',
      '- adx_name: Authenticated Users',
      '  adx_webroleid: 55555555-5555-4555-8555-555555555555',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'web-files', 'one.webfile.yml'), 'adx_name: one\n');
  fs.writeFileSync(path.join(root, 'web-files', 'two.webfile.yml'), 'adx_name: two\n');

  const result = analyze(root);
  const found = tags(result.findings);
  assert.ok(found.includes('PERF-HEADER-OUTPUTCACHE'));
  assert.ok(found.includes('PERF-SIGNIN-TRACKING'));
  assert.ok(!found.includes('PERF-FOOTER-OUTPUTCACHE'));

  const header = result.findings.find((f) => f.tag === 'PERF-HEADER-OUTPUTCACHE');
  assert.equal(header.location, 'sitesetting.yml:3');
  assert.equal(header.fixAction.type, 'set-yaml-field');
  assert.equal(header.fixAction.field, 'adx_value');
  assert.equal(header.fixAction.recordName, 'Header/OutputCache/Enabled');

  const coverage = Object.fromEntries(
    result.details.entries.map((entry) => [entry.key, entry.value]),
  );
  assert.equal(coverage['Web files'], '2');
  assert.equal(coverage['Web roles'], '2');
});

test('analyze() wires list pagination and webpage-as-API checks into the project scan', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-new-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'lists'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web-templates', 'data-api'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'lists', 'Unpaged.list.yml'),
    'adx_entitylistid: 11111111-1111-4111-8111-111111111111\nadx_name: Unpaged\n',
  );
  fs.writeFileSync(
    path.join(root, 'web-templates', 'data-api', 'Data.webtemplate.source.html'),
    [
      '{% fetchxml rows %}',
      '<fetch count="10"><entity name="contact"><attribute name="fullname"/></entity></fetch>',
      '{% endfetchxml %}',
      '{ "items": [{% for row in rows.results.entities %}"{{ row.fullname }}"{% unless forloop.last %},{% endunless %}{% endfor %}] }',
    ].join('\n'),
  );

  const result = analyze(root);
  const found = tags(result.findings);
  assert.ok(found.includes('PERF-LIST-NO-PAGING'));
  assert.ok(found.includes('PERF-WEBPAGE-AS-API'));
  const coverage = Object.fromEntries(
    result.details.entries.map((entry) => [entry.key, entry.value]),
  );
  assert.equal(coverage['Power Pages list files scanned'], '1');
});

test('analyze() emits a single PERF-NONE finding for a clean project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const x = 1;');

  const result = analyze(root);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].tag, 'PERF-NONE');
});

test('analyze() skips build-output directories', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-dist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.powerpages-site'), { recursive: true }); // makes it a PP project root
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  // A select-star call that lives ONLY in build output must not be reported.
  fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'fetch("/_api/products?$select=*")');

  const result = analyze(root);
  assert.ok(!tags(result.findings).includes('PERF-WEBAPI-SELECT-STAR'));
});

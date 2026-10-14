'use strict';
// Every generative-page operation goes through the bundled SDK, by way of lib/genpage-sdk.js: the plugin has no `pac model genpage` page
// wrapper any more. These scans fail when one comes back — a script that composes a page command (as an argument list, or as text in code),
// the retired wrapper module or a require of it, or a second place that builds the sub-area a page is in an app's navigation. They read CODE,
// not comments (helpers/production-scripts.js), so a sentence that says what pac used to do stays free to say it.
//
// Not every `pac model genpage` verb is a page verb: `list-connector-operations` and `get-connector-schema` read a connector, not a page, and
// stay on pac. So the first scan is an allowlist of exactly those two — the page verbs (upload, download, list, add, generate-types) and any verb
// pac adds later are forbidden — and an option such as `--help` names no verb at all.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { SCRIPTS_DIR, scriptsMatching } = require('./helpers/production-scripts.js');

const CONNECTOR_VERB = '(?:list-connector-operations|get-connector-schema)';
// The command as text — `pac model genpage upload --environment …`, or `model genpage upload` split into an argument list later — and as an
// argument list: `['model', 'genpage', 'upload', …]`. `(?![\w-])` keeps `list` from being read as the start of `list-connector-operations`.
const PAGE_VERB_AS_TEXT = new RegExp(`\\bmodel\\s+genpage\\s+(?!${CONNECTOR_VERB}(?![\\w-]))[A-Za-z][\\w-]*`);
const PAGE_VERB_AS_ARGV = new RegExp(`['"]model['"]\\s*,\\s*['"]genpage['"]\\s*,\\s*['"](?!${CONNECTOR_VERB}['"])[A-Za-z][\\w-]*['"]`);

test('the scan itself: every page verb is found, the two connector verbs and an option are not', () => {
  for (const verb of ['upload', 'download', 'list', 'add', 'generate-types', 'delete']) {
    assert.match(`pac model genpage ${verb} --environment x`, PAGE_VERB_AS_TEXT, verb);
    assert.match(`['model', 'genpage', '${verb}', '--environment', 'x']`, PAGE_VERB_AS_ARGV, verb);
    assert.match(`['model',\n  'genpage',\n  "${verb}"]`, PAGE_VERB_AS_ARGV, `${verb}, over several lines`);
  }
  for (const verb of ['list-connector-operations', 'get-connector-schema']) {
    assert.doesNotMatch(`pac model genpage ${verb} --connector-id c`, PAGE_VERB_AS_TEXT, verb);
    assert.doesNotMatch(`['model', 'genpage', '${verb}', '--connector-id', 'c']`, PAGE_VERB_AS_ARGV, verb);
  }
  assert.doesNotMatch('pac model genpage --help', PAGE_VERB_AS_TEXT);
  assert.doesNotMatch("['model', 'genpage', '--help']", PAGE_VERB_AS_ARGV);
  assert.match('pac model genpage list-connector-operations-v2', PAGE_VERB_AS_TEXT, 'a verb that only starts like a connector verb is another verb');
});

test('no production script runs a page verb of `pac model genpage` — only the connector verbs stay on pac — as text or as an argument list', () => {
  assert.deepStrictEqual(scriptsMatching(PAGE_VERB_AS_TEXT), []);
  assert.deepStrictEqual(scriptsMatching(PAGE_VERB_AS_ARGV), []);
});

test('the pac page wrapper is gone, and no script names it', () => {
  assert.strictEqual(fs.existsSync(path.join(SCRIPTS_DIR, 'lib', 'genpage-cli.js')), false);
  assert.deepStrictEqual(scriptsMatching(/genpage-cli|makeGenpageCli|\bgenpageCli\b/), []);
});

test('a page is a sub-area of ONE shape: the build and the placement of a page into an app both build it with genPageSubArea', () => {
  const read = (rel) => fs.readFileSync(path.join(SCRIPTS_DIR, rel), 'utf8');
  for (const rel of ['lib/sdk-build.js', 'lib/genpage-sdk.js']) {
    assert.match(read(rel), /require\('\.\/genpage-subarea\.js'\)/, `${rel} builds the sub-area with genPageSubArea`);
  }
  // An object literal of that shape is spelled out in lib/genpage-subarea.js — and, as a lookup key rather than a sub-area, in lib/sitemap-merge.js
  // (`subAreaTargetKey({ type: 'GenPage', genPageId })`). A third place would be a second shape.
  assert.deepStrictEqual(scriptsMatching(/type:\s*'GenPage'\s*,\s*genPageId/), ['lib/genpage-subarea.js', 'lib/sitemap-merge.js']);
});

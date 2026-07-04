'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeComponentType,
  typeFromComponentName,
  mergeStrategyForType,
  isEligibleForSelectiveMerge,
  isWebFileType,
  isSourceFileType,
  isSourceFileComponent,
  labelForType,
  SOURCEFILE_TYPE,
} = require('../lib/component-type-map');

test('normalizeComponentType: numbers and numeric strings pass through when known', () => {
  assert.equal(normalizeComponentType(8), 8);
  assert.equal(normalizeComponentType('8'), 8);
  assert.equal(normalizeComponentType(2), 2);
  assert.equal(normalizeComponentType(9), 9);
  assert.equal(normalizeComponentType(3), 3);
});

test('normalizeComponentType: unknown numbers → null', () => {
  assert.equal(normalizeComponentType(9999), null);
  assert.equal(normalizeComponentType('9999'), null);
});

test('normalizeComponentType: type names (labels + suffix tokens, any casing/spacing)', () => {
  assert.equal(normalizeComponentType('Web Template'), 8);
  assert.equal(normalizeComponentType('webtemplate'), 8);
  assert.equal(normalizeComponentType('WEB_TEMPLATE'), 8);
  assert.equal(normalizeComponentType('Web Page'), 2);
  assert.equal(normalizeComponentType('webpage'), 2);
  assert.equal(normalizeComponentType('Content Snippet'), 7);
  assert.equal(normalizeComponentType('contentsnippet'), 7);
  assert.equal(normalizeComponentType('Site Setting'), 9);
  assert.equal(normalizeComponentType('Web File'), 3);
});

test('normalizeComponentType: string and numeric forms are equivalent (A1 acceptance)', () => {
  for (const [name, num] of [['webtemplate', 8], ['webpage', 2], ['contentsnippet', 7], ['sitesetting', 9], ['webfile', 3]]) {
    assert.equal(normalizeComponentType(name), normalizeComponentType(num), `${name} should equal ${num}`);
  }
});

test('normalizeComponentType: serialized component-name leaf suffixes', () => {
  assert.equal(normalizeComponentType('Search Results.webtemplate'), 8);
  assert.equal(normalizeComponentType('Access Denied.webpage'), 2);
  assert.equal(normalizeComponentType('Footer.contentsnippet'), 7);
  assert.equal(normalizeComponentType('HTTP/X-Frame-Options.sitesetting'), 9);
  assert.equal(normalizeComponentType('Cat-PC.png.webfile'), 3);
});

test('normalizeComponentType: null/empty/garbage → null', () => {
  assert.equal(normalizeComponentType(null), null);
  assert.equal(normalizeComponentType(undefined), null);
  assert.equal(normalizeComponentType(''), null);
  assert.equal(normalizeComponentType('   '), null);
  assert.equal(normalizeComponentType('not-a-type'), null);
});

test('typeFromComponentName: longest suffix token wins (weblinkset over weblink)', () => {
  assert.equal(typeFromComponentName('Default.weblinkset'), 4);
  assert.equal(typeFromComponentName('Home.weblink'), 5);
});

test('typeFromComponentName: trailing serialized suffix is authoritative (Issue 4 — embedded token must not win)', () => {
  // A Site Setting whose NAME embeds another type token is still type 9 (its real
  // trailing suffix), NOT the embedded "content snippet" / "web template".
  assert.equal(typeFromComponentName('Content Snippet Cache.sitesetting'), 9);
  assert.equal(typeFromComponentName('Web Template Path.sitesetting'), 9);
  assert.equal(typeFromComponentName('Cat-PC.png.webfile'), 3);
  // and eligibility follows the type: a Site Setting (9) is now selective-merge-eligible
  // via the whole-`.sitesetting.yml` flat-yml merge (only the `value:` line conflicts)
  assert.equal(isEligibleForSelectiveMerge(normalizeComponentType('Content Snippet Cache.sitesetting')), true);
  // a structured PATH with no trailing suffix still resolves via the type-folder token
  assert.equal(typeFromComponentName('/solutions/RetailOS/powerpagesites/RetailOS/web-templates/Foo'), 8);
});

test('mergeStrategyForType: text/scalar/webfile/unsupported', () => {
  assert.equal(mergeStrategyForType(2), 'text');
  assert.equal(mergeStrategyForType(7), 'text');
  assert.equal(mergeStrategyForType(8), 'text');
  assert.equal(mergeStrategyForType('webtemplate'), 'text');
  assert.equal(mergeStrategyForType(9), 'scalar');
  assert.equal(mergeStrategyForType(3), 'webfile');
  assert.equal(mergeStrategyForType('webfile'), 'webfile');
  assert.equal(mergeStrategyForType(11), 'unsupported'); // Web Role
  assert.equal(mergeStrategyForType('garbage'), 'unsupported');
});

test('isEligibleForSelectiveMerge: text types + flat-yml site settings + web files', () => {
  assert.equal(isEligibleForSelectiveMerge(2), true);
  assert.equal(isEligibleForSelectiveMerge('webtemplate'), true);
  assert.equal(isEligibleForSelectiveMerge(9), true); // flat-yml whole-file merge
  assert.equal(isEligibleForSelectiveMerge(3), true); // webfile — runtime sniff decides text vs binary
  assert.equal(isEligibleForSelectiveMerge(11), false); // unsupported
});

test('labelForType: canonical labels and unknown fallback', () => {
  assert.equal(labelForType(8), 'Web Template');
  assert.equal(labelForType('webpage'), 'Web Page');
  assert.equal(labelForType(9999), 'Unknown (9999)');
});

test('primaryFieldForType: per-type field, null for web file / unknown', () => {
  const { primaryFieldForType } = require('../lib/component-type-map');
  assert.equal(primaryFieldForType(2), 'copy');
  assert.equal(primaryFieldForType(7), 'value');
  assert.equal(primaryFieldForType(8), 'source');
  assert.equal(primaryFieldForType('webtemplate'), 'source');
  assert.equal(primaryFieldForType(9), 'value');
  assert.equal(primaryFieldForType(3), null); // web file: bytes, no envelope field
  assert.equal(primaryFieldForType(11), null); // unsupported
});

test('stripSerializedSuffix: removes a trailing .type suffix, leaves plain names', () => {
  const { stripSerializedSuffix } = require('../lib/component-type-map');
  assert.equal(stripSerializedSuffix('Search Results.webtemplate'), 'Search Results');
  assert.equal(stripSerializedSuffix('HTTP/X-Frame-Options.sitesetting'), 'HTTP/X-Frame-Options');
  assert.equal(stripSerializedSuffix('Cat-PC.png.webfile'), 'Cat-PC.png');
  assert.equal(stripSerializedSuffix('Plain Name'), 'Plain Name');
});

test('isWebFileType: true only for type 3 Web File', () => {
  assert.equal(isWebFileType(3), true);
  assert.equal(isWebFileType('webfile'), true);
  assert.equal(isWebFileType('Web File'), true);
  assert.equal(isWebFileType(8), false);
  assert.equal(isWebFileType(9), false);
  assert.equal(isWebFileType('webtemplate'), false);
  assert.equal(isWebFileType(null), false);
});

// ── Bug 1: code-site source files are first-class text-mergeable units ──────────
test('normalizeComponentType: .sourcefile suffix → SOURCEFILE_TYPE sentinel', () => {
  assert.equal(normalizeComponentType('Home.tsx.sourcefile'), SOURCEFILE_TYPE);
  assert.equal(normalizeComponentType('styles/app.css.sourcefile'), SOURCEFILE_TYPE);
  assert.equal(normalizeComponentType('sourcefile'), SOURCEFILE_TYPE);
});

test('normalizeComponentType: /powerpagescodesites/<site>/src/ path → SOURCEFILE_TYPE', () => {
  assert.equal(normalizeComponentType('/powerpagescodesites/QuickFix/src/pages/Home.tsx'), SOURCEFILE_TYPE);
  // path without the code-site src marker is NOT a source file
  assert.equal(normalizeComponentType('/powerpagesites/QuickFix/web-templates/Foo'), 8);
});

test('typeFromComponentName: source file by name and by path', () => {
  assert.equal(typeFromComponentName('Home.tsx.sourcefile'), SOURCEFILE_TYPE);
  assert.equal(typeFromComponentName('/powerpagescodesites/QuickFix/src/components/App.tsx'), SOURCEFILE_TYPE);
});

test('mergeStrategyForType / eligibility: source files are text-mergeable', () => {
  assert.equal(mergeStrategyForType(SOURCEFILE_TYPE), 'text');
  assert.equal(mergeStrategyForType('Home.tsx.sourcefile'), 'text');
  assert.equal(isEligibleForSelectiveMerge(SOURCEFILE_TYPE), true);
  assert.equal(isEligibleForSelectiveMerge('/powerpagescodesites/QuickFix/src/pages/Home.tsx'), true);
  // a source file is NOT a web file (different env-side byte source)
  assert.equal(isWebFileType(SOURCEFILE_TYPE), false);
});

test('labelForType + isSourceFileType: friendly label and predicate', () => {
  assert.equal(labelForType(SOURCEFILE_TYPE), 'Code Site Source File');
  assert.equal(labelForType('Home.tsx.sourcefile'), 'Code Site Source File');
  assert.equal(isSourceFileType('Home.tsx.sourcefile'), true);
  assert.equal(isSourceFileType('/powerpagescodesites/QuickFix/src/pages/Home.tsx'), true);
  assert.equal(isSourceFileType(8), false);
  assert.equal(isSourceFileType(3), false);
});

test('isSourceFileComponent: recognizes by name OR path, rejects other components', () => {
  assert.equal(isSourceFileComponent({ componentName: 'Home.tsx.sourcefile', componentPath: '/powerpagescodesites/QuickFix/src/pages/Home.tsx' }), true);
  assert.equal(isSourceFileComponent({ componentName: 'Home.tsx', componentPath: '/powerpagescodesites/QuickFix/src/pages/Home.tsx' }), true);
  assert.equal(isSourceFileComponent({ componentName: 'Search Results.webtemplate', componentPath: '/powerpagesites/QuickFix/web-templates/Search-Results' }), false);
});

test('stripSerializedSuffix / primaryFieldForType: source file handling', () => {
  const { stripSerializedSuffix, primaryFieldForType } = require('../lib/component-type-map');
  assert.equal(stripSerializedSuffix('Home.tsx.sourcefile'), 'Home.tsx');
  assert.equal(primaryFieldForType(SOURCEFILE_TYPE), null);
});

'use strict';
// #585 item 6: the localization reference must never decide text direction from a hand-kept LCID list.
// It named five Arabic LCIDs and Hebrew, so every other right-to-left culture — the remaining Arabic
// regions, Persian, Urdu, Pashto and more — rendered left-to-right. Direction now comes from the `rtl`
// field of scripts/list-languages.js (which read PAC's RTL column before that script replaced `pac model
// list-languages`), with a script-based fallback; these tests pin that fallback's data against culture metadata.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOC = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'localization.md'), 'utf8');

// Every SPECIFIC right-to-left culture in Windows culture metadata (CultureInfo.GetCultures filtered on
// TextInfo.IsRightToLeft). Neutral cultures are left out on purpose: Windows' neutral `ku` is Central
// Kurdish (Arabic script) while CLDR's `ku` is Kurmanji (Latin script), and PAC reports specific codes.
const RTL_CULTURES = [
  'ar-SA', 'ar-IQ', 'ar-EG', 'ar-LY', 'ar-DZ', 'ar-MA', 'ar-TN', 'ar-OM', 'ar-YE', 'ar-SY', 'ar-JO',
  'ar-LB', 'ar-KW', 'ar-AE', 'ar-BH', 'ar-QA', 'he-IL', 'yi-001', 'fa-IR', 'fa-AF', 'ur-PK', 'ur-IN',
  'ps-AF', 'sd-Arab-PK', 'sd-Arab', 'ug-CN', 'dv-MV', 'syr-SY', 'ku-Arab-IQ', 'ku-Arab', 'ks-Arab',
  'pa-Arab-PK', 'pa-Arab', 'tzm-Arab-MA',
];
const LTR_CULTURES = [
  'en-US', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU', 'el-GR', 'tr-TR', 'ku-TR', 'az-Latn-AZ', 'hi-IN',
  'pa-IN', 'th-TH', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'vi-VN', 'id-ID', 'ms-MY', 'kk-KZ',
];

// The fallback's script set, read from the reference itself, so the test checks what page authors are told.
function docRtlScripts() {
  const m = DOC.match(/const RTL_SCRIPTS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'the reference defines RTL_SCRIPTS');
  return new Set([...m[1].matchAll(/"([A-Z][a-z]{3})"/g)].map((x) => x[1]));
}

test('the localization reference takes text direction from the languages script, not from a hand-kept LCID list', () => {
  const section = DOC.slice(DOC.indexOf('### RTL Layout Support'), DOC.indexOf('### User Settings for Formatting'));
  assert.ok(section.length > 0, 'the RTL section exists');
  assert.match(section, /`rtl` field of `scripts\/list-languages\.js`/);
  assert.doesNotMatch(section, /\b(1025|1037|2049|3073|4097|5121)\b/, 'no LCIDs are given as the rule');
});

test('the script fallback in the reference classifies every right-to-left culture as RTL and the controls as LTR', () => {
  const scripts = docRtlScripts();
  // The same expression the reference gives page authors: the likely script from CLDR.
  const isRtl = (code) => scripts.has(new Intl.Locale(code).maximize().script || '');
  for (const code of RTL_CULTURES) assert.strictEqual(isRtl(code), true, `${code} is right-to-left`);
  for (const code of LTR_CULTURES) assert.strictEqual(isRtl(code), false, `${code} is left-to-right`);
});

// The page error contract's localized copy (references/rules.md, "Missing Error Handling"). PageErrorBar and
// PageErrorBoundary are top-level, hook-free components: they cannot read a `language` that lives in a component's
// closure, so the reference resolves the UI language in a top-level resolvePageLanguage() and makes translate() top
// level too. These tests run that ACTUAL code — transpiled with the vendored TypeScript, a transpile and not a type
// check — against a stand-in Xrm global.
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');

const blocksOf = (text) => [...text.replace(/\r\n/g, '\n').matchAll(/```(?:typescript|tsx)\n([\s\S]*?)\n```/g)].map((match) => match[1]);
function localizedPage(dictionary) {
  const blocks = blocksOf(DOC);
  const language = blocks.find((block) => /^function resolvePageLanguage\(\)/m.test(block));
  assert.ok(language, 'the reference defines a top-level resolvePageLanguage()');
  const words = blocks.find((block) => /^const translations\b/m.test(block) && /^function translate\(/m.test(block));
  assert.ok(words, 'the reference defines a top-level translate() over its translations dictionary');
  let source = `${language}\n${words}\n`;
  if (dictionary) {
    source = source.replace(/^const translations[^=]*=\s*\{[\s\S]*?\n\};/m, () => `const translations: Record<string, Record<string, string>> = ${JSON.stringify(dictionary)};`);
  }
  const ts = loadVendoredTypeScript();
  const { outputText } = ts.transpileModule(`${source}\nexport { resolvePageLanguage, translate, translations };\n`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  return (xrm) => {
    const module = { exports: {} };
    new Function('module', 'exports', 'Xrm', outputText)(module, module.exports, xrm);
    return module.exports;
  };
}
const hostWithLanguage = (languageId) => ({ Utility: { getGlobalContext: () => ({ userSettings: { languageId } }) } });
const brokenHost = { Utility: { getGlobalContext: () => { throw new Error('no context'); } } };

test('the UI language is resolved at the top level without hooks, and a missing or failing host falls back to English', () => {
  const page = localizedPage();
  const language = blocksOf(DOC).find((block) => /^function resolvePageLanguage\(\)/m.test(block));
  assert.doesNotMatch(language, /\buse(?:Memo|State|Effect|Callback)\b/, 'the resolver needs no React hook');
  assert.deepEqual({ ...page(undefined).resolvePageLanguage() }, { code: 'en-US', name: 'English', isRtl: false }, 'no Xrm global');
  assert.deepEqual({ ...page(hostWithLanguage(1025)).resolvePageLanguage() }, { code: 'ar-SA', name: 'Arabic (Saudi Arabia)', isRtl: true });
  assert.equal(page(hostWithLanguage(1036)).resolvePageLanguage().code, 'en-US', 'a language the plan does not list');
  assert.equal(page(brokenHost).resolvePageLanguage().code, 'en-US', 'a host that throws does not crash the fallback UI');
});

test('translate is top level: it picks the user\u2019s language, then English, then the key, and carries the error keys', () => {
  const arabic = localizedPage()(hostWithLanguage(1025));
  assert.equal(arabic.translate('save'), arabic.translations['ar-SA'].save, 'the non-default language is used');
  assert.equal(arabic.translate('error.read'), 'Unable to load data. Please try again.', 'a key the language lacks falls back to English');
  assert.equal(arabic.translate('missing.key'), 'missing.key');
  assert.deepEqual(Object.fromEntries(Object.entries(arabic.translations['en-US']).filter(([key]) => key.startsWith('error.'))), {
    'error.read': 'Unable to load data. Please try again.',
    'error.write': 'The change could not be saved. Refresh before trying again.',
    'error.network': 'The request did not go through. You can try again.',
    'error.indeterminate': "We couldn't confirm this completed \u2014 refresh before retrying.",
    'error.render': 'This page hit a problem and could not render. Refresh the page.',
    'error.tryAgain': 'Try again',
  }, 'the dictionary carries the error keys, with the copy rules.md publishes');
});

test('the boundary and error bar fallbacks resolve localized copy with no component closure', () => {
  const page = localizedPage({ 'en-US': { 'error.render': 'EN render', 'error.tryAgain': 'EN retry' }, 'ar-SA': { 'error.render': 'AR render' } });
  assert.equal(page(hostWithLanguage(1025)).translate('error.render'), 'AR render');
  assert.equal(page(hostWithLanguage(1025)).translate('error.tryAgain'), 'EN retry', 'an untranslated key still shows English copy, never a raw key');
  assert.equal(page(hostWithLanguage(1033)).translate('error.render'), 'EN render');
  assert.equal(page(brokenHost).translate('error.render'), 'EN render', 'the render fallback survives a failing host');
});
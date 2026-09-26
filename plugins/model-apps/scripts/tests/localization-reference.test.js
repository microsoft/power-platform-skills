'use strict';
// #585 item 6: the localization reference must never decide text direction from a hand-kept LCID list.
// It named five Arabic LCIDs and Hebrew, so every other right-to-left culture — the remaining Arabic
// regions, Persian, Urdu, Pashto and more — rendered left-to-right. Direction now comes from PAC's RTL
// column, with a script-based fallback; these tests pin that fallback's data against culture metadata.
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

test('the localization reference takes text direction from PAC, not from a hand-kept LCID list', () => {
  const section = DOC.slice(DOC.indexOf('### RTL Layout Support'), DOC.indexOf('### User Settings for Formatting'));
  assert.ok(section.length > 0, 'the RTL section exists');
  assert.match(section, /\*\*RTL\*\* column of `pac model list-languages`/);
  assert.doesNotMatch(section, /\b(1025|1037|2049|3073|4097|5121)\b/, 'no LCIDs are given as the rule');
});

test('the script fallback in the reference classifies every right-to-left culture as RTL and the controls as LTR', () => {
  const scripts = docRtlScripts();
  // The same expression the reference gives page authors: the likely script from CLDR.
  const isRtl = (code) => scripts.has(new Intl.Locale(code).maximize().script || '');
  for (const code of RTL_CULTURES) assert.strictEqual(isRtl(code), true, `${code} is right-to-left`);
  for (const code of LTR_CULTURES) assert.strictEqual(isRtl(code), false, `${code} is left-to-right`);
});

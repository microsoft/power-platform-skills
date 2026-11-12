'use strict';
// The LCID -> culture mapping the languages script reports with (lib/lcid-cultures.js).
//
// The SDK answers LCIDs only; the planner needs a culture code and a text direction for each, and a page keys its
// translations and its `dir` on them. So the table must be exact where it answers, and silent where it does not: an
// unknown LCID stays numeric and is reported, never mapped to a neighbour's code or given a guessed direction.
const test = require('node:test');
const assert = require('node:assert');
const {
  CODES, RTL_LCIDS, cultureForLcid, languageName, describeLanguage, languageLine, describeEnvironmentLanguages,
} = require('../lib/lcid-cultures.js');

// The languages Dataverse provisions, by LCID, as [MS-LCID] names them.
// See: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/70feba9f-294e-491e-b6eb-56532684c37f
const KNOWN = {
  1025: 'ar-SA', 1026: 'bg-BG', 1027: 'ca-ES', 1028: 'zh-TW', 1029: 'cs-CZ', 1030: 'da-DK', 1031: 'de-DE', 1032: 'el-GR',
  1033: 'en-US', 1035: 'fi-FI', 1036: 'fr-FR', 1037: 'he-IL', 1038: 'hu-HU', 1040: 'it-IT', 1041: 'ja-JP', 1042: 'ko-KR',
  1043: 'nl-NL', 1044: 'nb-NO', 1045: 'pl-PL', 1046: 'pt-BR', 1048: 'ro-RO', 1049: 'ru-RU', 1050: 'hr-HR', 1051: 'sk-SK',
  1053: 'sv-SE', 1054: 'th-TH', 1055: 'tr-TR', 1057: 'id-ID', 1058: 'uk-UA', 1060: 'sl-SI', 1061: 'et-EE', 1062: 'lv-LV',
  1063: 'lt-LT', 1066: 'vi-VN', 1069: 'eu-ES', 1081: 'hi-IN', 1086: 'ms-MY', 1087: 'kk-KZ', 1110: 'gl-ES', 2052: 'zh-CN',
  2070: 'pt-PT', 2074: 'sr-Latn-CS', 3076: 'zh-HK', 3082: 'es-ES', 3098: 'sr-Cyrl-CS',
};

// Every SPECIFIC right-to-left culture in Windows culture metadata (CultureInfo.GetCultures filtered on
// TextInfo.IsRightToLeft) — the list localization-reference.test.js pins the page-side fallback against.
const RTL_CODES = [
  'ar-SA', 'ar-IQ', 'ar-EG', 'ar-LY', 'ar-DZ', 'ar-MA', 'ar-TN', 'ar-OM', 'ar-YE', 'ar-SY', 'ar-JO',
  'ar-LB', 'ar-KW', 'ar-AE', 'ar-BH', 'ar-QA', 'he-IL', 'yi-001', 'fa-IR', 'fa-AF', 'ur-PK', 'ur-IN',
  'ps-AF', 'sd-Arab-PK', 'ug-CN', 'dv-MV', 'syr-SY', 'ku-Arab-IQ', 'pa-Arab-PK', 'tzm-Arab-MA',
];

test('the table is sorted by LCID, holds each LCID once, and every LCID is a positive 16-bit integer', () => {
  const lcids = CODES.map(([lcid]) => lcid);
  assert.ok(lcids.length > 200, `${lcids.length} cultures`);
  assert.deepStrictEqual(lcids, [...lcids].sort((a, b) => a - b), 'sorted');
  assert.strictEqual(new Set(lcids).size, lcids.length, 'no LCID twice');
  for (const lcid of lcids) assert.ok(Number.isInteger(lcid) && lcid > 0 && lcid <= 0xffff, `${lcid}`);
});

test('every code is a well-formed language tag Intl accepts', () => {
  for (const [lcid, code] of CODES) {
    assert.match(code, /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?(?:-valencia)?$/, `${lcid} ${code}`);
    assert.doesNotThrow(() => new Intl.Locale(code), `${lcid} ${code}`);
  }
});

test('it names the languages Dataverse provisions, by the code .NET gives them', () => {
  for (const [lcid, code] of Object.entries(KNOWN)) {
    assert.deepStrictEqual(cultureForLcid(Number(lcid)), { lcid: Number(lcid), code, rtl: code === 'ar-SA' || code === 'he-IL' }, `${lcid}`);
  }
});

test('direction: exactly the right-to-left cultures Windows marks, and no other', () => {
  const rtl = CODES.filter(([lcid]) => cultureForLcid(lcid).rtl).map(([, code]) => code);
  assert.deepStrictEqual([...rtl].sort(), [...RTL_CODES].sort());
  assert.strictEqual(RTL_LCIDS.size, RTL_CODES.length);
  // Every Arabic region, not the five or six a hand-kept list names.
  assert.strictEqual(CODES.filter(([, code]) => code.startsWith('ar-')).length, 16);
  for (const [lcid, code] of CODES) if (code.startsWith('ar-')) assert.strictEqual(cultureForLcid(lcid).rtl, true, code);
  // Left-to-right controls, including scripts that are easy to mistake for right-to-left.
  for (const code of ['en-US', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU', 'el-GR', 'tr-TR', 'az-Latn-AZ', 'hi-IN', 'pa-IN', 'th-TH', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'vi-VN', 'sd-Deva-IN', 'ks-Deva-IN', 'mn-Mong-CN']) {
    const row = CODES.find(([, c]) => c === code);
    assert.ok(row, `${code} is in the table`);
    assert.strictEqual(cultureForLcid(row[0]).rtl, false, code);
  }
});

// Where the host's Intl has its script data, the table's direction must be what CLDR derives from the code — the
// computation localization.md gives page authors as a fallback. A Node without full ICU answers no script for Arabic,
// which is exactly why the table, and not this computation, is what the script reports.
const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr']);
const hasScriptData = (() => {
  try { return new Intl.Locale('ar-SA').maximize().script === 'Arab'; } catch { return false; }
})();

test('direction agrees with the script CLDR derives from each code', { skip: !hasScriptData && 'this Node has no ICU script data' }, () => {
  for (const [lcid, code] of CODES) {
    const script = new Intl.Locale(code).maximize().script || '';
    assert.strictEqual(cultureForLcid(lcid).rtl, RTL_SCRIPTS.has(script), `${lcid} ${code} (${script})`);
  }
});

test('an LCID the table does not name stays numeric: null, never a neighbour\u2019s code or a guessed direction', () => {
  const unknown = [
    0, -1, 1.5, NaN, Infinity, '1033', '', null, undefined, {}, [1033], true,
    4096, // a custom locale
    127, // the invariant culture
    4, 7, 9, 31748, // neutral cultures (zh-CHS, de, en, zh-CHT)
    1084, 99999, 65535,
    0x10409, // en-US with a sort id — a different id, not a variant to read as en-US
    1033 + 0x400 * 60, // a sublanguage no culture holds, under a primary language that has others
  ];
  for (const lcid of unknown) assert.strictEqual(cultureForLcid(lcid), null, `${String(lcid)}`);
  assert.deepStrictEqual(describeLanguage(4096), { lcid: 4096, code: null, name: null, rtl: null });
});

test('languageName gives the English name Intl has, and null where it has none', { skip: typeof Intl.DisplayNames !== 'function' && 'this Node has no Intl.DisplayNames' }, () => {
  assert.strictEqual(languageName('ar-SA'), 'Arabic (Saudi Arabia)');
  assert.strictEqual(languageName('en-US'), 'English (United States)');
  assert.strictEqual(languageName('pt-BR'), 'Portuguese (Brazil)');
  assert.strictEqual(languageName('xx-XX'), null, 'no name is null, not the code echoed back');
  assert.strictEqual(languageName(1033), null);
  assert.strictEqual(languageName(undefined), null);
});

test('languageName never throws and never invents a name when the host cannot name languages', () => {
  assert.strictEqual(languageName('ar-SA', null), null, 'no DisplayNames at all');
  assert.strictEqual(languageName('ar-SA', { of: () => { throw new RangeError('bad tag'); } }), null);
  assert.strictEqual(languageName('ar-SA', { of: () => '' }), null);
  assert.strictEqual(languageName('ar-SA', { of: () => undefined }), null);
  // The code and the direction do not depend on a name.
  assert.deepStrictEqual(describeLanguage(1025, null), { lcid: 1025, code: 'ar-SA', name: null, rtl: true });
});

test('languageLine is the planner\u2019s `<LCID> <Code> \u2014 RTL: Yes|No`, and says unknown for an unmapped LCID', () => {
  assert.strictEqual(languageLine(describeLanguage(1025, null)), '1025 ar-SA \u2014 RTL: Yes');
  assert.strictEqual(languageLine(describeLanguage(1033, null)), '1033 en-US \u2014 RTL: No');
  assert.strictEqual(languageLine(describeLanguage(4096, null)), '4096 unknown \u2014 RTL: unknown');
});

test('describeEnvironmentLanguages: the base, every provisioned language in order, the unmapped LCIDs, and a line each', () => {
  const out = describeEnvironmentLanguages({ baseLanguage: 1033, provisioned: [1033, 1025, 4096, 1036] }, null);
  assert.deepStrictEqual(out.baseLanguage, { lcid: 1033, code: 'en-US', name: null, rtl: false });
  assert.deepStrictEqual(out.languages.map((l) => l.lcid), [1033, 1025, 4096, 1036], 'server order is kept');
  assert.deepStrictEqual(out.languages.map((l) => l.code), ['en-US', 'ar-SA', null, 'fr-FR']);
  assert.deepStrictEqual(out.languages.map((l) => l.rtl), [false, true, null, false]);
  assert.deepStrictEqual(out.unmapped, [4096]);
  assert.deepStrictEqual(out.summary, ['1033 en-US \u2014 RTL: No', '1025 ar-SA \u2014 RTL: Yes', '4096 unknown \u2014 RTL: unknown', '1036 fr-FR \u2014 RTL: No']);
});

test('describeEnvironmentLanguages describes the base on its own: the SDK checks no relation between its reads', () => {
  // A base language that is not among the provisioned ones (unproven beyond the organizations measured) is reported
  // as the base, and is neither dropped nor added to the provisioned list.
  const out = describeEnvironmentLanguages({ baseLanguage: 3082, provisioned: [1033] }, null);
  assert.strictEqual(out.baseLanguage.code, 'es-ES');
  assert.deepStrictEqual(out.languages.map((l) => l.lcid), [1033]);
  // An unmapped base is reported once, even when it is also provisioned.
  const unmappedBase = describeEnvironmentLanguages({ baseLanguage: 4096, provisioned: [4096, 4096, 1033] }, null);
  assert.deepStrictEqual(unmappedBase.unmapped, [4096]);
});

test('describeEnvironmentLanguages reports an unknown BASE language in `unmapped` although it is not provisioned', () => {
  // `unmapped` is what the planner tells the user about: a base language the table cannot name is as unknown as a
  // provisioned one, and a provisioned list that names it not is no reason to leave it out.
  const baseOnly = describeEnvironmentLanguages({ baseLanguage: 4096, provisioned: [1033] }, null);
  assert.deepStrictEqual(baseOnly.baseLanguage, { lcid: 4096, code: null, name: null, rtl: null });
  assert.deepStrictEqual(baseOnly.unmapped, [4096]);
  assert.deepStrictEqual(baseOnly.languages.map((l) => l.lcid), [1033], 'it is not added to the provisioned languages');
  assert.deepStrictEqual(baseOnly.summary, ['1033 en-US \u2014 RTL: No'], 'and gets no summary line: the lines are the provisioned languages\u2019');
  // The base first, then the provisioned ones in the server's order, each LCID once.
  const both = describeEnvironmentLanguages({ baseLanguage: 4096, provisioned: [1033, 5000, 4096, 5000] }, null);
  assert.deepStrictEqual(both.unmapped, [4096, 5000]);
  // A base the table names adds nothing.
  assert.deepStrictEqual(describeEnvironmentLanguages({ baseLanguage: 1033, provisioned: [1033] }, null).unmapped, []);
});

test('describeEnvironmentLanguages refuses an answer that is not the SDK\u2019s shape', () => {
  for (const bad of [null, undefined, {}, { baseLanguage: '1033', provisioned: [1033] }, { baseLanguage: 1033, provisioned: 1033 }, { baseLanguage: 1033 }]) {
    assert.throws(() => describeEnvironmentLanguages(bad), TypeError, JSON.stringify(bad));
  }
});

'use strict';
// Which culture an environment language is, and which way it is written — the host's half of the SDK's
// `getEnvironmentLanguages()`.
//
// The SDK answers LCIDs only ("culture names, display names and text direction are NOT SDK output"): `pac`
// printed them from .NET's `CultureInfo`, and no Intl API maps an LCID to a locale. So the mapping lives here, as
// data, and an LCID it does not name STAYS NUMERIC — `cultureForLcid` answers null, never a neighbouring language's
// code or a guessed direction. A page that keys its translations by culture code, and sets `dir` from the
// direction, must not be handed a wrong answer in place of an unknown one.
//
// The data is Windows' own, because that is where PAC's `Code` and `RTL` columns came from: every specific
// (language + region) culture it names, by LCID, with the name `CultureInfo.Name` gives it and the direction
// `TextInfo.IsRightToLeft` gives it. Left out on purpose: neutral cultures (an environment provisions a language
// under a specific LCID), the invariant culture, the pseudo-locales (`qps-*`) and custom LCIDs (4096). Sort-order
// variants whose id carries a sort id above 0xFFFF (the German phone book, 0x10407) are no 16-bit LCID an
// environment reports; 1034 (Spanish, traditional sort) is in, and Windows names it `es-ES`, like 3082.
// See: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/70feba9f-294e-491e-b6eb-56532684c37f
//      https://learn.microsoft.com/en-us/dotnet/api/system.globalization.cultureinfo.name
//      https://learn.microsoft.com/en-us/dotnet/api/system.globalization.textinfo.isrighttoleft
//
// Regenerate in Windows PowerShell 5.1 (.NET Framework, so the data is Windows' and not ICU's), then diff:
//   foreach ($l in 1..65535) {
//     try { $c = [Globalization.CultureInfo]::GetCultureInfo($l) } catch { continue }
//     if ($c.LCID -eq $l -and -not $c.IsNeutralCulture -and $c.Name -and $c.Name -notlike 'qps-*') {
//       "[$l, '$($c.Name)'], rtl=$($c.TextInfo.IsRightToLeft)"
//     }
//   }
// Windows still names 2074 and 3098 `sr-Latn-CS` and `sr-Cyrl-CS` (Serbia and Montenegro, a region that no longer
// exists): that is what `CultureInfo.Name` gave PAC for them, so it is what the table holds.
//
// Direction is a table and not `Intl.Locale#maximize().script`, on purpose: a Node built without full ICU data
// answers no script for Arabic, so a computed direction would read an Arabic environment as left-to-right with no
// error. The tests check the two against each other where the host has the data.

const CODES = [
  [1025, 'ar-SA'], [1026, 'bg-BG'], [1027, 'ca-ES'], [1028, 'zh-TW'], [1029, 'cs-CZ'],
  [1030, 'da-DK'], [1031, 'de-DE'], [1032, 'el-GR'], [1033, 'en-US'], [1034, 'es-ES'],
  [1035, 'fi-FI'], [1036, 'fr-FR'], [1037, 'he-IL'], [1038, 'hu-HU'], [1039, 'is-IS'],
  [1040, 'it-IT'], [1041, 'ja-JP'], [1042, 'ko-KR'], [1043, 'nl-NL'], [1044, 'nb-NO'],
  [1045, 'pl-PL'], [1046, 'pt-BR'], [1047, 'rm-CH'], [1048, 'ro-RO'], [1049, 'ru-RU'],
  [1050, 'hr-HR'], [1051, 'sk-SK'], [1052, 'sq-AL'], [1053, 'sv-SE'], [1054, 'th-TH'],
  [1055, 'tr-TR'], [1056, 'ur-PK'], [1057, 'id-ID'], [1058, 'uk-UA'], [1059, 'be-BY'],
  [1060, 'sl-SI'], [1061, 'et-EE'], [1062, 'lv-LV'], [1063, 'lt-LT'], [1064, 'tg-Cyrl-TJ'],
  [1065, 'fa-IR'], [1066, 'vi-VN'], [1067, 'hy-AM'], [1068, 'az-Latn-AZ'], [1069, 'eu-ES'],
  [1070, 'hsb-DE'], [1071, 'mk-MK'], [1072, 'st-ZA'], [1073, 'ts-ZA'], [1074, 'tn-ZA'],
  [1075, 've-ZA'], [1076, 'xh-ZA'], [1077, 'zu-ZA'], [1078, 'af-ZA'], [1079, 'ka-GE'],
  [1080, 'fo-FO'], [1081, 'hi-IN'], [1082, 'mt-MT'], [1083, 'se-NO'], [1085, 'yi-001'],
  [1086, 'ms-MY'], [1087, 'kk-KZ'], [1088, 'ky-KG'], [1089, 'sw-KE'], [1090, 'tk-TM'],
  [1091, 'uz-Latn-UZ'], [1092, 'tt-RU'], [1093, 'bn-IN'], [1094, 'pa-IN'], [1095, 'gu-IN'],
  [1096, 'or-IN'], [1097, 'ta-IN'], [1098, 'te-IN'], [1099, 'kn-IN'], [1100, 'ml-IN'],
  [1101, 'as-IN'], [1102, 'mr-IN'], [1103, 'sa-IN'], [1104, 'mn-MN'], [1105, 'bo-CN'],
  [1106, 'cy-GB'], [1107, 'km-KH'], [1108, 'lo-LA'], [1109, 'my-MM'], [1110, 'gl-ES'],
  [1111, 'kok-IN'], [1112, 'mni-IN'], [1113, 'sd-Deva-IN'], [1114, 'syr-SY'], [1115, 'si-LK'],
  [1116, 'chr-Cher-US'], [1117, 'iu-Cans-CA'], [1118, 'am-ET'], [1119, 'tzm-Arab-MA'], [1121, 'ne-NP'],
  [1122, 'fy-NL'], [1123, 'ps-AF'], [1124, 'fil-PH'], [1125, 'dv-MV'], [1126, 'bin-NG'],
  [1127, 'ff-Latn-NG'], [1128, 'ha-Latn-NG'], [1129, 'ibb-NG'], [1130, 'yo-NG'], [1131, 'quz-BO'],
  [1132, 'nso-ZA'], [1133, 'ba-RU'], [1134, 'lb-LU'], [1135, 'kl-GL'], [1136, 'ig-NG'],
  [1137, 'kr-Latn-NG'], [1138, 'om-ET'], [1139, 'ti-ET'], [1140, 'gn-PY'], [1141, 'haw-US'],
  [1142, 'la-VA'], [1143, 'so-SO'], [1144, 'ii-CN'], [1145, 'pap-029'], [1146, 'arn-CL'],
  [1148, 'moh-CA'], [1150, 'br-FR'], [1152, 'ug-CN'], [1153, 'mi-NZ'], [1154, 'oc-FR'],
  [1155, 'co-FR'], [1156, 'gsw-FR'], [1157, 'sah-RU'], [1158, 'quc-Latn-GT'], [1159, 'rw-RW'],
  [1160, 'wo-SN'], [1164, 'fa-AF'], [1169, 'gd-GB'], [1170, 'ku-Arab-IQ'], [2049, 'ar-IQ'],
  [2051, 'ca-ES-valencia'], [2052, 'zh-CN'], [2055, 'de-CH'], [2057, 'en-GB'], [2058, 'es-MX'],
  [2060, 'fr-BE'], [2064, 'it-CH'], [2067, 'nl-BE'], [2068, 'nn-NO'], [2070, 'pt-PT'],
  [2072, 'ro-MD'], [2073, 'ru-MD'], [2074, 'sr-Latn-CS'], [2077, 'sv-FI'], [2080, 'ur-IN'],
  [2092, 'az-Cyrl-AZ'], [2094, 'dsb-DE'], [2098, 'tn-BW'], [2107, 'se-SE'], [2108, 'ga-IE'],
  [2110, 'ms-BN'], [2115, 'uz-Cyrl-UZ'], [2117, 'bn-BD'], [2118, 'pa-Arab-PK'], [2121, 'ta-LK'],
  [2128, 'mn-Mong-CN'], [2137, 'sd-Arab-PK'], [2141, 'iu-Latn-CA'], [2143, 'tzm-Latn-DZ'], [2144, 'ks-Deva-IN'],
  [2145, 'ne-IN'], [2151, 'ff-Latn-SN'], [2155, 'quz-EC'], [2163, 'ti-ER'], [3073, 'ar-EG'],
  [3076, 'zh-HK'], [3079, 'de-AT'], [3081, 'en-AU'], [3082, 'es-ES'], [3084, 'fr-CA'],
  [3098, 'sr-Cyrl-CS'], [3131, 'se-FI'], [3152, 'mn-Mong-MN'], [3153, 'dz-BT'], [3179, 'quz-PE'],
  [4097, 'ar-LY'], [4100, 'zh-SG'], [4103, 'de-LU'], [4105, 'en-CA'], [4106, 'es-GT'],
  [4108, 'fr-CH'], [4122, 'hr-BA'], [4155, 'smj-NO'], [4191, 'tzm-Tfng-MA'], [5121, 'ar-DZ'],
  [5124, 'zh-MO'], [5127, 'de-LI'], [5129, 'en-NZ'], [5130, 'es-CR'], [5132, 'fr-LU'],
  [5146, 'bs-Latn-BA'], [5179, 'smj-SE'], [6145, 'ar-MA'], [6153, 'en-IE'], [6154, 'es-PA'],
  [6156, 'fr-MC'], [6170, 'sr-Latn-BA'], [6203, 'sma-NO'], [7169, 'ar-TN'], [7177, 'en-ZA'],
  [7178, 'es-DO'], [7180, 'fr-029'], [7194, 'sr-Cyrl-BA'], [7227, 'sma-SE'], [8193, 'ar-OM'],
  [8201, 'en-JM'], [8202, 'es-VE'], [8204, 'fr-RE'], [8218, 'bs-Cyrl-BA'], [8251, 'sms-FI'],
  [9217, 'ar-YE'], [9225, 'en-029'], [9226, 'es-CO'], [9228, 'fr-CD'], [9242, 'sr-Latn-RS'],
  [9275, 'smn-FI'], [10241, 'ar-SY'], [10249, 'en-BZ'], [10250, 'es-PE'], [10252, 'fr-SN'],
  [10266, 'sr-Cyrl-RS'], [11265, 'ar-JO'], [11273, 'en-TT'], [11274, 'es-AR'], [11276, 'fr-CM'],
  [11290, 'sr-Latn-ME'], [12289, 'ar-LB'], [12297, 'en-ZW'], [12298, 'es-EC'], [12300, 'fr-CI'],
  [12314, 'sr-Cyrl-ME'], [13313, 'ar-KW'], [13321, 'en-PH'], [13322, 'es-CL'], [13324, 'fr-ML'],
  [14337, 'ar-AE'], [14345, 'en-ID'], [14346, 'es-UY'], [14348, 'fr-MA'], [15361, 'ar-BH'],
  [15369, 'en-HK'], [15370, 'es-PY'], [15372, 'fr-HT'], [16385, 'ar-QA'], [16393, 'en-IN'],
  [16394, 'es-BO'], [17417, 'en-MY'], [17418, 'es-SV'], [18441, 'en-SG'], [18442, 'es-HN'],
  [19465, 'en-AE'], [19466, 'es-NI'], [20490, 'es-PR'], [21514, 'es-US'], [22538, 'es-419'],
  [23562, 'es-CU'],
];

// The LCIDs of the cultures above that `TextInfo.IsRightToLeft` marks right-to-left: every Arabic region, Hebrew,
// Persian and Dari, Urdu, Yiddish, Syriac, Pashto, Divehi, Uyghur, Central Kurdish and the Arabic-script
// Tamazight, Punjabi and Sindhi.
const RTL_LCIDS = new Set([
  1025, 1037, 1056, 1065, 1085, 1114, 1119, 1123, 1125, 1152,
  1164, 1170, 2049, 2080, 2118, 2137, 3073, 4097, 5121, 6145,
  7169, 8193, 9217, 10241, 11265, 12289, 13313, 14337, 15361, 16385,
]);

const CODE_BY_LCID = new Map(CODES);

/**
 * The culture an LCID names, or null when this table does not name it.
 * @param {number} lcid - a positive integer, as the SDK reports it (e.g. 1025)
 * @returns {{ lcid: number, code: string, rtl: boolean } | null} e.g. { lcid: 1025, code: 'ar-SA', rtl: true }
 */
function cultureForLcid(lcid) {
  // Only a number the SDK could have read: a numeric string, a fraction, a negative or a custom id is no LCID here,
  // and an unknown one must not coerce into a neighbour's.
  if (!Number.isInteger(lcid) || lcid <= 0) return null;
  const code = CODE_BY_LCID.get(lcid);
  return code === undefined ? null : { lcid, code, rtl: RTL_LCIDS.has(lcid) };
}

// Built once, and not at all where Intl has no DisplayNames (a Node without ICU) — the name is a courtesy and the
// code and direction above never depend on it. `languageDisplay: 'standard'` gives "English (United States)", the form
// PAC's Language column had, where the default 'dialect' gives "American English".
// See: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/DisplayNames/DisplayNames
let displayNames;
function englishNames() {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none', languageDisplay: 'standard' });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

/**
 * The English name of a culture code ("Arabic (Saudi Arabia)"), or null when this host's Intl has none for it.
 * `fallback: 'none'` is what makes "has none" visible: the default would answer the code itself, which is no name.
 */
function languageName(code, names = englishNames()) {
  if (!names || typeof code !== 'string') return null;
  try {
    const name = names.of(code);
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * One language as the planner reads it. An LCID this table does not name keeps its number and has no code, name or
 * direction (`null`, never a default).
 * @returns {{ lcid: number, code: string|null, name: string|null, rtl: boolean|null }}
 */
function describeLanguage(lcid, names) {
  const culture = cultureForLcid(lcid);
  return {
    lcid,
    code: culture ? culture.code : null,
    name: culture ? languageName(culture.code, names) : null,
    rtl: culture ? culture.rtl : null,
  };
}

/**
 * The line the plan's Localization section carries for a language: `<LCID> <Code> — RTL: Yes|No`, the columns PAC
 * printed. An LCID without a culture reads `<LCID> unknown — RTL: unknown`.
 */
function languageLine(language) {
  const direction = language.rtl === null ? 'unknown' : language.rtl ? 'Yes' : 'No';
  return `${language.lcid} ${language.code === null ? 'unknown' : language.code} — RTL: ${direction}`;
}

/**
 * What the SDK's `getEnvironmentLanguages()` answered, in the planner's terms: the base language, every PROVISIONED
 * language in the server's order, the LCIDs no culture is known for, and a line per provisioned language. The base
 * language is described on its own, not looked for among the provisioned ones: the SDK checks no relation between its
 * reads, so the base can be absent from them.
 * @param {{ baseLanguage: number, provisioned: number[] }} reads
 */
function describeEnvironmentLanguages(reads, names) {
  if (!reads || !Number.isInteger(reads.baseLanguage) || !Array.isArray(reads.provisioned)) {
    throw new TypeError('describeEnvironmentLanguages expects { baseLanguage: number, provisioned: number[] }');
  }
  const baseLanguage = describeLanguage(reads.baseLanguage, names);
  // A local, not a call straight on the read's provisioned list: the SDK-surface scan takes any receiver whose name
  // holds "provision" for an SDK handle, and would list `map` as an SDK method.
  const lcids = reads.provisioned;
  const languages = lcids.map((lcid) => describeLanguage(lcid, names));
  const unmapped = [...new Set([baseLanguage, ...languages].filter((language) => language.code === null).map((language) => language.lcid))];
  return { baseLanguage, languages, unmapped, summary: languages.map(languageLine) };
}

module.exports = { cultureForLcid, languageName, describeLanguage, languageLine, describeEnvironmentLanguages, CODES, RTL_LCIDS };

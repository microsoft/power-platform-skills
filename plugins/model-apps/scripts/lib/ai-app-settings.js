'use strict';
// SINGLE SOURCE OF TRUTH for the per-app AI feature contract.
//
// Before this module the same knowledge lived in four parallel places — the validation allow-list
// (app-spec.js), the setting-name map (verify-spec.js), the build's requested flag set
// (sdk-build.js) and the SDK's own module-private map — and they had already drifted in a way that
// re-opened the bug this area exists to fix: the BUILD writes a default for every feature whenever
// `spec.ai` is present, but verify only reconciled the features a spec DECLARED. A spec carrying
// `ai.summaries` and no `ai.appFeatures` therefore had three features written and ZERO verified,
// so `--verify` reported a clean PASS for features the platform may never have stored — exactly the
// false PASS of ADO 6603383, just narrowed rather than removed.
//
// Everything here is pure except the two `read`-driven proof helpers, which take an injected reader
// so both the build engine and the verifier can share one implementation of the authoritative query.

const { odataLit } = require('./odata.js');

// The PER-APP setting each AI feature writes — mirrors the SDK's `APP_SETTING` map (api/AiApi.ts).
// These are deliberately DISTINCT from the org readiness gates in the SDK's `AI_GATE`: e.g. the
// `nlSearch` org gate is the boolean `EnableNLGridSearch`, but the per-app setting is the numeric
// `NLGridSearchSetting`. Verify must read the PER-APP setting, because that is what the build wrote
// and what is in force for this app. Conflating the two is exactly the bug that made NL grid search
// report "applied" while writing nothing (ADO 6560699 / 6603383).
// Keep in sync with the vendored SDK; `sdk-surface-contract.test.js` guards the method surface and
// `verify-spec.test.js` pins these names.
const AI_APP_SETTING = {
  // The AI form-fill FAMILY. `FormFillBarUXEnabled` is only the assist toolbar; the SDK now models
  // the three siblings as first-class features too, so the App Spec exposes them rather than
  // pretending "form fill" is one switch.
  //
  // Note `formFillSmartPaste` writes `FormPredictSmartPasteEnabledOnByDefault` per app while its ORG
  // GATE is `FormPredictSmartPasteEnabled` — a different row, like nlSearch. Mirrors the SDK's
  // `APP_SETTING`; the gate names live in the SDK's `AI_GATE`.
  formFill: 'FormFillBarUXEnabled',
  formFillSuggestions: 'FormPredictEnabled',
  formFillSmartPaste: 'FormPredictSmartPasteEnabledOnByDefault',
  formFillFiles: 'FormFillFileUploadEnabled',
  nlSearch: 'NLGridSearchSetting',
  nlChart: 'NLChartDataVisualizationSetting',
  m365: 'm365copilotmodelappenabled',
};

// ON/OFF values are NOT uniform across these settings, and `1` is not universally "on".
//
// MIRRORS the SDK's `SETTING_CODEC` (api/AiApi.ts), which cites the first-party admin UI:
//     FormFillBarUXEnabled / formPredictEnabled / smart-paste-on-by-default:
//        0 = default (defer to flighting)   1 = DISABLED   2 = ENABLED
// So the obvious `true -> '1'` mapping writes DISABLED for every one of them, and `0` means
// "platform default", which is NOT the same as off. Settings absent from this table keep the plain
// numeric convention ('1' on, '0' off) — deliberately, because their semantics are not evidenced
// the same way.
const AI_SETTING_CODEC = {
  formFill: { enabled: '2', disabled: '1' },
  formFillSuggestions: { enabled: '2', disabled: '1' },
  formFillSmartPaste: { enabled: '2', disabled: '1' },
  formFillFiles: { enabled: '2', disabled: '1' },
};

// Derived, never hand-maintained: the validator's allow-list IS the set of features we can write.
const AI_FEATURE_KEYS = new Set(Object.keys(AI_APP_SETTING));

// Upper bound for a per-app AI feature setting value. MIRRORS `MAX_SETTING_VALUE` in the SDK's
// api/AiApi.ts, which THROWS an InvalidArgumentError outside this range — validating against the
// same bound turns a mid-build abort into an up-front spec error naming the offending field.
const AI_FEATURE_MAX_VALUE = 1000000;

// What the build requests when a spec opts into `ai` without naming a feature. `m365` is off by
// default because it surfaces the app inside M365 Copilot, which is a deliberate choice rather
// than a sensible default.
const DEFAULT_APP_FEATURES = { formFill: true, nlSearch: true, nlChart: true, m365: false };

/**
 * The EXACT flag set the build writes for a spec — and therefore the exact set verify must
 * reconcile. Both callers MUST go through this; that equality is the whole point of the module.
 * Returns null when the spec opts out of `ai` entirely (no features are written, none are checked).
 */
function resolveAiFlags(spec) {
  if (!spec || spec.ai === undefined || spec.ai === null) return null;
  const flags = Object.assign({}, DEFAULT_APP_FEATURES, spec.ai.appFeatures || {});
  // Drop keys the SDK has no setting for: it ignores them, so verifying them would invent a
  // permanent failure for a spec the validator already reports on.
  const out = {};
  for (const [k, v] of Object.entries(flags)) if (AI_FEATURE_KEYS.has(k)) out[k] = v;
  return out;
}

/**
 * Normalize a requested flag to the string the setting actually stores.
 *
 * `true`/`false` are ergonomic spellings, but what they MEAN is per setting: for the AI form-fill
 * family on is `'2'` and off is `'1'` (`'0'` is the platform default, not off), while everything else
 * keeps the plain `'1'`/`'0'` convention. Any explicit integer is used verbatim.
 *
 * `feature` is required for a codec-governed setting. Without it a boolean maps to `'1'`, which for
 * the form-fill family means DISABLED — and since the build writes through the SDK (which applies
 * the codec), a verifier using the wrong spelling reports a correctly-applied feature as missing.
 * That mismatch is the reason this takes a feature at all.
 */
function featureWantValue(requested, feature) {
  if (typeof requested !== 'boolean') return String(requested).trim();
  const codec = feature && AI_SETTING_CODEC[feature];
  if (codec) return requested ? codec.enabled : codec.disabled;
  return requested ? '1' : '0';
}

/**
 * Compare a stored setting value against a requested one.
 *
 * Deliberately NOT dependent on the setting's `dataType`. A Dataverse Boolean setting (dataType 2)
 * reports `'true'`/`'false'` rather than `'1'`/`'0'`, so the two spellings must be reconciled — but
 * branching on a dataType read makes the comparison depend on a SECOND request that can fail
 * independently, which silently turned a correctly-applied feature into a FAIL when that read
 * errored. Normalizing both sides unconditionally is a no-op for the numeric values these settings
 * actually store (live: the override rows hold '1'/'0'), while still accepting the boolean
 * spelling — so it is strictly safer and has no hidden dependency.
 */
function sameSettingValue(a, b) {
  const onOff = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    return s === 'true' ? '1' : s === 'false' ? '0' : s;
  };
  return onOff(a) === onOff(b);
}

/**
 * Resolve the `appmoduleid` for an app's unique name via an injected reader.
 *
 * Deliberately NOT cached beyond one call: an app can be deleted and re-imported under the same
 * unique name with a NEW id, and a stale id would prove an override against the wrong app.
 * Returns `{ appModuleId }` on success or `{ error }` when it could not be resolved — the caller
 * must fail CLOSED on `error` rather than assume absence.
 */
async function resolveAppModuleId(read, appUniqueName) {
  try {
    const rows = await read.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUniqueName)}'`, top: 1 });
    const appModuleId = rows && rows[0] && rows[0].appmoduleid;
    if (!appModuleId) return { error: `no app module with unique name '${appUniqueName}' was found` };
    return { appModuleId };
  } catch (e) {
    return { error: `the app module could not be read: ${e && e.message}` };
  }
}

/**
 * Prove whether an APP-SCOPE override row exists for `setting` on this app, and what it holds.
 *
 * This is the ONLY authoritative signal. `RetrieveSetting(name, { appUniqueName })` FALLS BACK to
 * the ENVIRONMENT value when the app has no override, so a matching read-back does NOT prove the
 * app-scope write landed: if the environment already holds the requested value, a write the
 * platform silently ignored reads back as a perfect match. (Live-verified: RetrieveSetting returned
 * the env value while `appsettings` held zero rows for that app+setting.)
 *
 * Returns `{ exists, value }`, or `{ error }` when the proof could not be RUN — the caller must
 * distinguish "verifiably absent" from "could not look" and never report the latter as success.
 */
async function proveAppOverride(read, appModuleId, setting, opts = {}) {
  let defId;
  try {
    const defs = await read.queryRecords('settingdefinition', { select: ['settingdefinitionid'], filter: `uniquename eq '${odataLit(setting)}'`, top: 1 });
    defId = defs && defs[0] && defs[0].settingdefinitionid;
  } catch (e) {
    return { error: `the setting definition could not be read: ${e && e.message}` };
  }
  // A setting the environment has never heard of is NOT the same as an app missing an override:
  // e.g. `m365copilotmodelappenabled` simply does not exist in an org where M365 Copilot was never
  // provisioned, and there is no action a maker could take to satisfy it. Report it as unprovable
  // so the caller can say so precisely instead of alleging a missing override.
  if (!defId) return { error: `no setting definition named '${setting}' exists in this environment`, unsupported: true };
  // Retry ONLY the absent case, and only when the caller asks. An override row can lag briefly
  // behind the write that created it (observed live: the SDK reported a feature not persisted on
  // first apply and clean on a re-run, with the value correct all along), and a verifier that reads
  // once turns that lag into a false FAIL on the build's exit code. A read ERROR is not retried —
  // that is a different condition the caller must surface as "could not look", not "not there yet".
  const attempts = Math.max(1, Math.min(10, opts.attempts || 1));
  const delayMs = Math.max(0, Math.min(5000, opts.delayMs === undefined ? 500 : opts.delayMs));
  let last = { exists: false };
  for (let i = 0; i < attempts; i += 1) {
    if (i > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    try {
      // `appsetting` rows carry the app and definition as lookups; GUID lookup values are compared
      // UNQUOTED in an OData $filter (…?$filter=_parentappmoduleid_value eq 0000…-0000), matching
      // the SDK's own query for the same proof.
      const rows = await read.queryRecords('appsetting', { select: ['value'], filter: `_parentappmoduleid_value eq ${odataGuid(appModuleId)} and _settingdefinitionid_value eq ${odataGuid(defId)}`, top: 1 });
      if (rows && rows.length) return { exists: true, value: rows[0].value };
      last = { exists: false };
    } catch (e) {
      return { error: `the app-scope override row could not be read: ${e && e.message}` };
    }
  }
  return last;
}

/**
 * Resolve the EFFECTIVE value of a per-app AI setting: the most specific scope that holds a value
 * wins — app-scope override, then the ENVIRONMENT-scope value, then the definition's default.
 *
 * This exists because the org READINESS GATE and the feature's actual setting are different rows,
 * and reading only the gate is actively misleading. Live-measured on a real environment:
 *   gate `EnableNLGridSearch`          = "false"   ← what the readiness report shows
 *   setting `NLGridSearchSetting`      = "2" at ENVIRONMENT scope  ← the feature is ON for every app
 * Reporting that feature as simply "disabled" sends an operator to the admin centre to switch on
 * something already in effect. The gate governs only whether the BUILD will write an app-scope
 * override; it does not decide whether the feature runs.
 *
 * `appModuleId` may be null (no app in scope) — the app layer is then skipped and the answer is the
 * environment/default value, which is exactly what a not-yet-created app would inherit.
 *
 * Returns `{ value, scope }` where scope is 'app' | 'environment' | 'default', or `{ error }` when
 * the lookup could not be RUN. Never conflates "could not look" with "not set".
 */
async function effectiveSettingValue(read, appModuleId, setting) {
  let def;
  try {
    const defs = await read.queryRecords('settingdefinition', { select: ['settingdefinitionid', 'defaultvalue'], filter: `uniquename eq '${odataLit(setting)}'`, top: 1 });
    def = defs && defs[0];
  } catch (e) {
    return { error: `the setting definition could not be read: ${e && e.message}` };
  }
  if (!def || !def.settingdefinitionid) {
    // Not provisioned in this environment at all — distinct from "set to off".
    return { error: `no setting definition named '${setting}' exists in this environment`, unsupported: true };
  }

  if (appModuleId) {
    try {
      const rows = await read.queryRecords('appsetting', { select: ['value'], filter: `_parentappmoduleid_value eq ${odataGuid(appModuleId)} and _settingdefinitionid_value eq ${odataGuid(def.settingdefinitionid)}`, top: 1 });
      if (rows && rows.length) return { value: rows[0].value, scope: 'app' };
    } catch (e) {
      return { error: `the app-scope override row could not be read: ${e && e.message}` };
    }
  }

  try {
    const rows = await read.queryRecords('organizationsetting', { select: ['value'], filter: `_settingdefinitionid_value eq ${odataGuid(def.settingdefinitionid)}`, top: 1 });
    if (rows && rows.length) return { value: rows[0].value, scope: 'environment' };
  } catch (e) {
    return { error: `the environment-scope value could not be read: ${e && e.message}` };
  }

  return { value: def.defaultvalue, scope: 'default' };
}

/**
 * Is a setting value "on" FOR THIS FEATURE?
 *
 * Values are stored as STRINGS ("0"/"1"/"2"/"true"/"false"), so plain JS truthiness is wrong twice
 * over — it calls "0" true and "false" true. Worse, the numeric meaning is not uniform: for the
 * AI form-fill family `1` means DISABLED and `2` means ENABLED, so a "non-zero is on" rule reports a
 * deliberately disabled feature as running. `0` there means "platform default" (defer to flighting),
 * which is genuinely UNKNOWN rather than off — reporting it as off overstates what we know.
 *
 * `feature` is optional so existing callers keep the plain numeric convention; pass it whenever the
 * feature is known, which is every caller inside this plugin.
 */
function settingIsOn(value, feature) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  const codec = feature && AI_SETTING_CODEC[feature];
  if (codec) {
    if (s === codec.enabled) return true;
    if (s === codec.disabled) return false;
    // '0' = platform default: not a claim either way.
    return undefined;
  }
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n !== 0;
}

/**
 * Normalize a GUID for use as an UNQUOTED OData lookup comparand. Dataverse returns bare GUIDs, but
 * a caller-supplied id can arrive `{braced}` (the form `normalizeGuid` also accepts); interpolating
 * that raw produces `_x_value eq {0000…}`, a malformed filter that 400s and — because the proof
 * fails closed — reports every feature as unprovable. Stripping braces keeps a legitimate id
 * working; anything else is passed through so a genuinely bad id still fails loudly.
 */
function odataGuid(id) {
  return String(id === undefined || id === null ? '' : id).replace(/[{}]/g, '');
}

module.exports = {
  AI_APP_SETTING,
  AI_SETTING_CODEC,
  AI_FEATURE_KEYS,
  AI_FEATURE_MAX_VALUE,
  DEFAULT_APP_FEATURES,
  resolveAiFlags,
  featureWantValue,
  sameSettingValue,
  resolveAppModuleId,
  proveAppOverride,
  effectiveSettingValue,
  settingIsOn,
  odataGuid,
};

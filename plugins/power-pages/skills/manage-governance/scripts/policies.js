#!/usr/bin/env node

// Single source of truth for the governance policy strings this skill supports.
// Adding a new policy here is the only change required to expose it to the
// other scripts in this skill (assertPolicy is the gate every script calls).

'use strict';

const SUPPORTED_POLICIES = Object.freeze([
  'EnableMakerCopilotForExistingSites',
  'EnableProtocolOpenIdConnect',
  'EnableProtocolSAML20',
  'EnableProtocolWsFederation',
  'EnableProtocolOpenAuth',
  'EnableIdpOAuthFacebook',
  'EnableIdpOAuthGoogle',
  'EnableIdpOAuthMicrosoft',
  'EnableAuthenticationLocalLogin',
  'EnableExternalAuthProviders',
]);

// Some policies (env-level ones such as EnableMakerCopilotForExistingSites)
// report their env-level state on read using the `applyTo` enum vocabulary
// (e.g. "AllSites" / "IncludeSites" / "ExcludeSites") rather than the short
// canonical policyValue vocabulary ("All" / "Include" / "Exclude"). This map
// normalizes any read value back to the canonical
// policyValue string so every render path can treat them the same. Values
// already in canonical form pass through unchanged. The mapping mirrors
// `apiBehavior.applyTo` in references/governance-mapping.json.
//
// Verified empirically against Preprod: after a portal-scoped enable the env
// READS BACK as "IncludeSites" (and "ExcludeSites" for a block-list), so both
// the `IncludeSites`/`ExcludeSites` enum forms AND the older
// `IncludedSites`/`ExcludedSites`/`AllSitesExceptExcluded` spellings are
// accepted here for forward/backward compatibility. (These were also the WRITE
// tokens until the 2026-07 A059 shift moved writes to the short canonical
// forms — see WRITE_VALUE_ALIASES below — but the read side must still fold
// them because the env can continue to read them back.)
const ENV_VALUE_ALIASES = Object.freeze({
  allsites: 'All',
  includesites: 'Include',
  excludesites: 'Exclude',
  includedsites: 'Include',
  allsitesexceptexcluded: 'Exclude',
  excludedsites: 'Exclude',
});

// WRITE vocabulary — the inverse of the read normalization above. This map
// forward-maps the canonical policyValue (`All` / `None` / `Include` /
// `Exclude`) to the token the Power Apps Core Services Gateway accepts on a
// POST /governance upsert. It is an identity map today, but the seam is kept
// (a) so call sites don't special-case per policy, and (b) because the wire
// vocabulary has already shifted once under us (see history below) and may
// shift again — this is the single place to re-pin it.
//
// HISTORY — the `*Sites` -> short-form migration (WHY this is an identity map
// now, when it used to forward-map to `*Sites` enums):
//
//   * Originally the gateway (applyTo API version 2024-10-01) REQUIRED the
//     `*Sites` enum forms on write for env-level (uniformGovernance) policies:
//     POSTing the short `policyValue:"All"` / `"Include"` / `"Exclude"` was
//     rejected with the plain body "Website id cannot be null or empty" and the
//     env was left unchanged. So the write path forward-mapped
//     All->AllSites, Include->IncludeSites, Exclude->ExcludeSites.
//   * As of 2026-07 the gateway INVERTED that contract for the sign-in
//     protocol policies (observed on EnableProtocolOpenAuth): it now REJECTS
//     the `*Sites` enum forms with HTTP 400
//     `{ "error": { "code": "A059", "message": "The provided policy value is
//     not a valid governance policy value." } }` and ACCEPTS the SHORT
//     canonical forms (-> 200 "Policy upserts accepted."). The short forms also
//     match the READ vocabulary the env reads back, so mapping to them keeps
//     read and write symmetric.
//
// Verified empirically against Preprod on EnableProtocolOpenAuth (2026-07):
//   - "AllSites"     -> 400 A059      | "All"     -> 200 "Policy upserts accepted."
//   - "IncludeSites" -> 400 A059      | "Include" -> 200 "Policy upserts accepted."
//   - "ExcludeSites" -> 400 A059      | "Exclude" -> 200 "Policy upserts accepted."
//   (a short-form POST while a prior rollout is still InProgress returns code
//    D006 with an empty message — that is a concurrency lock, NOT value
//    rejection; retry once the status endpoint reports Succeeded.)
//
// "None" (full env-wide disable) was always the literal "None" on the wire (the
// disabled state is conveyed by the value itself), so it is unaffected by the
// shift. All four values are therefore now the canonical short form.
const WRITE_VALUE_ALIASES = Object.freeze({
  All: 'All',
  Include: 'Include',
  Exclude: 'Exclude',
  None: 'None',
});

// Terminal status values the polling helpers treat as "done". The Power Pages
// runtime is known to report `Succeeded` / `Completed` on success and `Failed`
// on failure; the skill is tolerant of casing differences.
const TERMINAL_SUCCESS = Object.freeze(['succeeded', 'completed', 'created', 'ok']);
const TERMINAL_FAILURE = Object.freeze(['failed', 'error']);

function isSupportedPolicy(name) {
  return SUPPORTED_POLICIES.includes(name);
}

function assertPolicy(name) {
  if (!isSupportedPolicy(name)) {
    const supported = SUPPORTED_POLICIES.join(', ');
    process.stderr.write(
      `Unsupported policy "${name}". Supported: ${supported}\n`
    );
    process.exit(1);
  }
}

function classifyStatus(rawValue) {
  const v = String(rawValue || '').toLowerCase().trim();
  if (!v) return 'unknown';
  if (TERMINAL_SUCCESS.includes(v)) return 'success';
  if (TERMINAL_FAILURE.includes(v)) return 'failure';
  return 'in-progress';
}

// Map a raw env-level governance read value to the canonical policyValue
// vocabulary (`All` / `None` / `Include` / `Exclude`). Env-level policies may
// return the `applyTo` enum form ("AllSites") on read, which this map folds
// back to the canonical form. Anything unrecognized passes through
// unchanged so callers can still render/inspect it.
function normalizeEnvValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return rawValue;
  const raw = String(rawValue).trim();
  const alias = ENV_VALUE_ALIASES[raw.toLowerCase()];
  return alias || raw;
}

// Forward-map a canonical policyValue (`All` / `None` / `Include` / `Exclude`)
// to the value that actually goes on the wire for a POST /governance upsert.
// Every supported policy is an env-level (uniformGovernance) policy that
// requires the applyTo enum vocabulary ("AllSites" etc.), so the canonical
// short form is always forward-mapped before POSTing. Unknown values pass
// through unchanged so callers can still forward experimental / future values
// without this helper silently dropping them. `policyName` is retained in the
// signature for call-site compatibility and possible future per-policy
// exemptions. See WRITE_VALUE_ALIASES above for the WHY and the empirical
// Preprod verification.
function toWritePolicyValue(canonicalValue, policyName) {
  const alias = WRITE_VALUE_ALIASES[canonicalValue];
  return alias || canonicalValue;
}

module.exports = {
  SUPPORTED_POLICIES,
  ENV_VALUE_ALIASES,
  WRITE_VALUE_ALIASES,
  TERMINAL_SUCCESS,
  TERMINAL_FAILURE,
  assertPolicy,
  isSupportedPolicy,
  classifyStatus,
  normalizeEnvValue,
  toWritePolicyValue,
};

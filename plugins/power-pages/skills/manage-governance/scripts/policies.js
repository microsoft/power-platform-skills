#!/usr/bin/env node

// Single source of truth for the governance policy strings this skill supports.
// Adding a new policy here is the only change required to expose it to the
// other scripts in this skill (assertPolicy is the gate every script calls).

'use strict';

const SUPPORTED_POLICIES = Object.freeze([
  'PowerPages_DisableAuthenticationOpenIdConnect',
  'PowerPages_DisableAuthenticationSAML20',
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
// policyValue vocabulary the auth Disable* policies use ("All" / "Include" /
// "Exclude"). This map normalizes any read value back to the canonical
// policyValue string so every render path can treat them the same. Values
// already in canonical form pass through unchanged. The mapping mirrors
// `apiBehavior.applyTo` in references/governance-mapping.json.
//
// Verified empirically against Preprod (2024-10-01 gateway): after a portal-
// scoped enable the env READS BACK as "IncludeSites" (and "ExcludeSites" for a
// block-list), so both the `IncludeSites`/`ExcludeSites` write tokens AND the
// older `IncludedSites`/`ExcludedSites`/`AllSitesExceptExcluded` spellings are
// accepted here for forward/backward compatibility.
const ENV_VALUE_ALIASES = Object.freeze({
  allsites: 'All',
  includesites: 'Include',
  excludesites: 'Exclude',
  includedsites: 'Include',
  allsitesexceptexcluded: 'Exclude',
  excludedsites: 'Exclude',
});

// WRITE vocabulary — the inverse of the read normalization above. The Power
// Apps Core Services Gateway (applyTo API version 2024-10-01) does NOT accept
// the short canonical policyValue on WRITE for env-level (uniformGovernance)
// policies: POSTing `policyValue:"All"` (or "Include"/"Exclude") is rejected
// with the plain body "Website id cannot be null or empty" and the env is left
// unchanged. The gateway's native write tokens are the `*Sites` enum forms, so
// the write path MUST forward-map canonical -> *Sites before POSTing. This
// mirrors `policyModes.uniformGovernance[].apiBehavior.applyTo` in
// references/governance-mapping.json.
//
// "None" is the exception: its apiBehavior is applyTo=AllSites + enabled=false,
// but the wire form for a full disable is the literal "None" (the disabled
// state is conveyed by the value itself), so None maps to None.
//
// Verified empirically against Preprod (2024-10-01 gateway):
//   - `policyValue:"AllSites"` (env-wide enable) -> 200 "Policy upserts
//     accepted.", env flips None -> AllSites.
//   - `policyValue:"IncludeSites"` + ToBeAdded=[siteIds] -> 200, env reads back
//     "IncludeSites" and details.IncludedSites lists those sites.
//   The short forms ("All" / "Include" / "Exclude") are rejected.
const WRITE_VALUE_ALIASES = Object.freeze({
  All: 'AllSites',
  Include: 'IncludeSites',
  Exclude: 'ExcludeSites',
  None: 'None',
});

// The two legacy admin-portal auth toggles predate the applyTo enum and both
// READ and WRITE the short canonical vocabulary ("All"/"None"/"Include"/
// "Exclude"). They are the only policies exempt from the applyTo forward-map
// above — mirroring the read-side note on ENV_VALUE_ALIASES that "the auth
// Disable* policies already return the canonical form".
const LEGACY_SHORT_FORM_POLICIES = Object.freeze([
  'PowerPages_DisableAuthenticationOpenIdConnect',
  'PowerPages_DisableAuthenticationSAML20',
]);

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
// return the `applyTo` enum form ("AllSites"); the auth Disable* policies
// already return the canonical form. Anything unrecognized passes through
// unchanged so callers can still render/inspect it.
function normalizeEnvValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return rawValue;
  const raw = String(rawValue).trim();
  const alias = ENV_VALUE_ALIASES[raw.toLowerCase()];
  return alias || raw;
}

// Forward-map a canonical policyValue (`All` / `None` / `Include` / `Exclude`)
// to the value that actually goes on the wire for a POST /governance upsert.
// Env-level (uniformGovernance) policies require the applyTo enum vocabulary
// ("AllSites" etc.); the two legacy Disable* auth policies keep the canonical
// short form. Unknown values pass through unchanged so callers can still
// forward experimental / future values without this helper silently dropping
// them. See WRITE_VALUE_ALIASES / LEGACY_SHORT_FORM_POLICIES above for the WHY
// and the empirical Preprod verification.
function toWritePolicyValue(canonicalValue, policyName) {
  if (LEGACY_SHORT_FORM_POLICIES.includes(policyName)) return canonicalValue;
  const alias = WRITE_VALUE_ALIASES[canonicalValue];
  return alias || canonicalValue;
}

module.exports = {
  SUPPORTED_POLICIES,
  ENV_VALUE_ALIASES,
  WRITE_VALUE_ALIASES,
  LEGACY_SHORT_FORM_POLICIES,
  TERMINAL_SUCCESS,
  TERMINAL_FAILURE,
  assertPolicy,
  isSupportedPolicy,
  classifyStatus,
  normalizeEnvValue,
  toWritePolicyValue,
};

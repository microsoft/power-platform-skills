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
// (e.g. "AllSites") rather than the short policyValue vocabulary the auth
// Disable* policies use ("All"). This map normalizes any read value back to
// the canonical policyValue string so every render path can treat them the
// same. Values already in canonical form pass through unchanged. The mapping
// mirrors `apiBehavior.applyTo` in references/governance-mapping.json.
const ENV_VALUE_ALIASES = Object.freeze({
  allsites: 'All',
  includedsites: 'Include',
  allsitesexceptexcluded: 'Exclude',
  excludedsites: 'Exclude',
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
// return the `applyTo` enum form ("AllSites"); the auth Disable* policies
// already return the canonical form. Anything unrecognized passes through
// unchanged so callers can still render/inspect it.
function normalizeEnvValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return rawValue;
  const raw = String(rawValue).trim();
  const alias = ENV_VALUE_ALIASES[raw.toLowerCase()];
  return alias || raw;
}

module.exports = {
  SUPPORTED_POLICIES,
  ENV_VALUE_ALIASES,
  TERMINAL_SUCCESS,
  TERMINAL_FAILURE,
  assertPolicy,
  isSupportedPolicy,
  classifyStatus,
  normalizeEnvValue,
};

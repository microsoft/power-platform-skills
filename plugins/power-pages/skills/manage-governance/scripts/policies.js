#!/usr/bin/env node

// Single source of truth for the governance policy strings this skill supports.
// Adding a new policy here is the only change required to expose it to the
// other scripts in this skill (assertPolicy is the gate every script calls).

'use strict';

const SUPPORTED_POLICIES = Object.freeze([
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

module.exports = {
  SUPPORTED_POLICIES,
  TERMINAL_SUCCESS,
  TERMINAL_FAILURE,
  assertPolicy,
  isSupportedPolicy,
  classifyStatus,
};

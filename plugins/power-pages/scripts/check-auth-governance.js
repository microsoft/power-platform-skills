#!/usr/bin/env node
'use strict';

const { resolveContext, parseCliArgs, emitJson, runCli } = require('./lib/power-platform-api');
const { UUID_REGEX, CLOUD_TO_API } = require('./lib/validation-helpers');
const { tenantIdFromToken } = require('./lib/cli-tenant-alignment');
const { callGovernance } = require('../skills/manage-governance/scripts/governance-transport');
const { isSupportedPolicy } = require('../skills/manage-governance/scripts/policies');

const ROOT = 'EnableExternalAuthProviders';
const OAUTH = 'EnableProtocolOpenAuth';
const POLICY_LABELS = Object.freeze({
  [ROOT]: 'External authentication',
  [OAUTH]: 'OAuth protocol',
  EnableProtocolOpenIdConnect: 'OpenID Connect protocol',
  EnableProtocolSAML20: 'SAML protocol',
  EnableProtocolWsFederation: 'WS-Federation protocol',
  EnableIdpOAuthFacebook: 'Facebook OAuth',
  EnableIdpOAuthGoogle: 'Google OAuth',
  EnableIdpOAuthMicrosoft: 'Microsoft Account OAuth',
  EnableAuthenticationLocalLogin: 'Local login',
});
// Local login also requires External Auth; do not inherit the archived management
// workflow's different dependency graph. Governance overrides site settings.
// https://learn.microsoft.com/en-us/power-pages/security/external-auth-control
const PROVIDERS = Object.freeze({
  facebook: { label: 'Facebook', policies: [ROOT, OAUTH, 'EnableIdpOAuthFacebook'] },
  google: { label: 'Google', policies: [ROOT, OAUTH, 'EnableIdpOAuthGoogle'] },
  microsoft: { label: 'Microsoft Account', policies: [ROOT, OAUTH, 'EnableIdpOAuthMicrosoft'] },
  oidc: { label: 'OpenID Connect', policies: [ROOT, 'EnableProtocolOpenIdConnect'] },
  saml: { label: 'SAML', policies: [ROOT, 'EnableProtocolSAML20'] },
  'ws-federation': { label: 'WS-Federation', policies: [ROOT, 'EnableProtocolWsFederation'] },
  local: { label: 'Local login', policies: [ROOT, 'EnableAuthenticationLocalLogin'] },
});

function assertId(value, name) {
  if (typeof value !== 'string' || !UUID_REGEX.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new TypeError(`${name} must be a non-empty, non-zero GUID.`);
  }
}

function contextProblem(context, envId, tenantId) {
  if (!context || context.error || typeof context.token !== 'string' || !context.token.trim()) {
    return 'CLI authentication could not be resolved. Sign in with PAC and Azure CLI, then retry.';
  }
  if (typeof context.tenantId !== 'string' || !UUID_REGEX.test(context.tenantId)) {
    return 'The authenticated tenant could not be determined. Sign in to the confirmed portal tenant and retry. No governance requests were sent.';
  }
  if (context.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
    return 'Authentication tenant mismatch. The signed-in Azure CLI tenant does not match the portal owning tenant. Sign in to the expected tenant and retry. No governance requests were sent.';
  }
  // Account metadata and token acquisition are separate CLI calls: an account
  // switch between them must not route a token from another tenant. Reuse the
  // existing tid reader as a local routing guard, not signature validation;
  // the Power Platform API still authenticates the bearer.
  const tokenTenantId = tenantIdFromToken(context.token);
  if (!tokenTenantId) {
    return 'The bearer token tenant could not be determined. Sign in to the confirmed portal tenant and retry. No governance requests were sent.';
  }
  if (tokenTenantId !== tenantId.toLowerCase()) {
    return 'Authentication tenant mismatch. The bearer token does not belong to the portal owning tenant. Sign in to the expected tenant and retry. No governance requests were sent.';
  }
  if (typeof context.environmentId !== 'string' || context.environmentId.toLowerCase() !== envId.toLowerCase()) {
    return 'The signed-in environment does not match the requested environment. Select the target environment, then retry.';
  }
  const host = context.apiHost;
  if (!Object.values(CLOUD_TO_API).includes(host) ||
      typeof context.baseUrl !== 'string' ||
      context.baseUrl.toLowerCase() !== `${host}/powerpages/environments/${envId}`.toLowerCase()) {
    return 'The API context does not match the target environment and cloud. Resolve the CLI context again.';
  }
  return null;
}

function readState(body) {
  // getPortal returns one boolean, not All/None/Include/Exclude or membership
  // lists (manage-governance/references/commands.md). The shared HTTP parser
  // leaves text/plain JSON primitives as strings, e.g. "true" or "false".
  // Accept only those exact primitives; unknown shapes never authorize setup.
  if (body === true || body === false) return body ? 'enabled' : 'disabled';
  if (typeof body === 'string' && /^(true|false)$/.test(body.trim())) {
    return body.trim() === 'true' ? 'enabled' : 'disabled';
  }
  return 'unknown';
}

function decisionMessage(label, policies) {
  const blockedPolicies = policies.filter((item) => item.state === 'disabled');
  const verificationErrors = policies.filter((item) => item.state === 'unknown');
  if (!blockedPolicies.length && !verificationErrors.length) {
    return `${label} setup is allowed by portal governance.`;
  }
  const sections = [];
  if (blockedPolicies.length) {
    sections.push(`Your administrator has restricted the use of ${blockedPolicies.map((item) => item.label).join(', ')} for this website. ` +
      'Contact your administrator if you need this setting enabled.');
  }
  if (verificationErrors.length) {
    sections.push(`${label} setup stopped because portal governance could not be verified.\n\n` +
      verificationErrors.map((item) => `- ${item.label} (${item.policy}): ${item.error.message}`).join('\n'));
    sections.push('Resolve the verification errors and retry before changing provider settings or the login page.');
  }
  sections.push('This read-only check made no provider settings or login-page changes.');
  return sections.join('\n\n');
}

function providerResult(provider, policies) {
  const definition = PROVIDERS[provider];
  const required = definition.policies.map((policy) => policies.find((item) => item.policy === policy));
  const blockedPolicies = required.filter((item) => item.state === 'disabled');
  const verificationErrors = required.filter((item) => item.state === 'unknown');
  const status = verificationErrors.length ? 'unverified' : blockedPolicies.length ? 'blocked' : 'enabled';
  const message = decisionMessage(definition.label, required);
  return { provider, label: definition.label, status, allowed: status === 'enabled', blockedPolicies, verificationErrors, message };
}

/**
 * Setup-time only. Resolve CLI auth once, then read all unique portal policies
 * concurrently. No persistent cache, membership reads, policy writes, or visitor
 * credentials. Inject dependencies only for offline tests.
 */
async function checkAuthGovernance(options, dependencies = {}) {
  const { tenantId, envId, portalId, websiteRecordId } = options || {};
  assertId(envId, 'envId');
  assertId(portalId, 'portalId (Power Platform host ID, not websiteRecordId)');
  if (websiteRecordId !== undefined) {
    assertId(websiteRecordId, 'websiteRecordId');
    if (portalId.toLowerCase() === websiteRecordId.toLowerCase()) {
      throw new TypeError('portalId must be the Power Platform host ID, not the Dataverse websiteRecordId.');
    }
  }
  let problem;
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    // Never infer the expected owner from the current account: doing so would
    // make the drift check tautological. Missing ownership stops before auth.
    problem = 'The portal owning tenant ID is required. Confirm it from the target environment or user input, supply --tenantId, and retry. No governance requests were sent.';
  } else {
    assertId(tenantId, 'tenantId (expected portal owning tenant)');
  }
  const selected = options.providers || [options.provider];
  if (!Array.isArray(selected) || !selected.length ||
      selected.some((provider) => typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider))) {
    throw new TypeError(`Select one or more providers: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  const providers = [...new Set(selected)];
  const keys = [...new Set(providers.flatMap((provider) => PROVIDERS[provider].policies))];
  if (keys.some((policy) => !isSupportedPolicy(policy))) throw new Error('Unsupported authentication governance policy.');
  const resolve = dependencies.resolveContext || resolveContext;
  const read = dependencies.callGovernance || callGovernance;
  let context;
  if (!problem) {
    try {
      // Never let callGovernance select its implicit TIP/configured environment.
      context = options.context || await resolve();
      problem = contextProblem(context, envId, tenantId);
    } catch {
      // Do not echo exception/API bodies: they can contain bearer tokens or PII.
      problem = 'CLI authentication context resolution failed. Sign in again and retry.';
    }
  }
  const policies = await Promise.all(keys.map(async (policy) => {
    const item = { policy, label: POLICY_LABELS[policy], state: 'unknown' };
    if (problem) return { ...item, error: { code: 'ContextError', message: problem } };
    try {
      const response = await read({ op: 'getPortal', envId, portalId, policy, context });
      if (!response?.ok || !Number.isInteger(response.statusCode) ||
          response.statusCode < 200 || response.statusCode >= 300) {
        const statusCode = Number.isInteger(response?.statusCode) ? response.statusCode : 0;
        const message = statusCode === 401 || statusCode === 403
          ? `Governance access was rejected (HTTP ${statusCode}). Check CLI sign-in and administrator permissions.`
          : statusCode === 404
            ? 'Portal-level governance was not found (HTTP 404). Verify the host ID and API availability in the target environment.'
            : `Portal-level governance read failed (${statusCode ? `HTTP ${statusCode}` : 'no response'}). Retry after resolving service or network errors.`;
        return { ...item, error: { code: 'ReadFailed', statusCode, message } };
      }
      const state = readState(response.body);
      return state === 'unknown'
        ? { ...item, error: { code: 'UnknownResponse', message: 'The portal-level response was not a boolean. Verify the API response contract before retrying.' } }
        : { ...item, state };
    } catch {
      return { ...item, error: { code: 'ReadFailed', statusCode: 0, message: 'Portal-level governance read failed without a response. Check connectivity and retry.' } };
    }
  }));
  const results = providers.map((provider) => providerResult(provider, policies));
  const status = results.some((result) => result.status === 'unverified') ? 'unverified'
    : results.some((result) => result.status === 'blocked') ? 'blocked' : 'enabled';
  return {
    tenantId: tenantId ?? null, envId, portalId, status, allowed: status === 'enabled', policies, providers: results,
    // Summarize denied batches from unique policies, not provider order: allowed
    // siblings must not lead the message or repeat a shared parent's restriction.
    message: status === 'enabled' ? results.map((result) => result.message).join('\n\n')
      : decisionMessage(results.length === 1 ? results[0].label : 'Authentication', policies),
  };
}

class AuthGovernanceVerificationError extends Error {
  constructor(result) {
    super(result.message);
    this.name = 'AuthGovernanceVerificationError';
    this.code = 'AuthGovernanceUnverified';
    this.result = result;
  }
}

function enabledCheck(provider) {
  return async (options, dependencies) => {
    const result = await checkAuthGovernance({ ...options, provider, providers: [provider] }, dependencies);
    if (result.status === 'unverified') throw new AuthGovernanceVerificationError(result);
    return result.allowed;
  };
}

async function main() {
  const args = parseCliArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node check-auth-governance.js --tenantId <owning-tenant-guid> --envId <guid> --portalId <host-guid> --providers facebook,google\n' +
      'Optional: --websiteRecordId <guid> (rejects using the record ID as the host ID)\n' +
      `Providers: ${Object.keys(PROVIDERS).join(', ')}\n` +
      'Read-only, setup-time gate. Exit 0: allowed; 1: blocked; 2: unverifiable. Invalid input exits 1.\n'
    );
    return;
  }
  const result = await checkAuthGovernance({
    tenantId: args.tenantId, envId: args.envId, portalId: args.portalId, websiteRecordId: args.websiteRecordId,
    providers: typeof args.providers === 'string' ? args.providers.split(',').map((value) => value.trim()) : [],
  });
  emitJson(result);
  process.exitCode = result.allowed ? 0 : result.status === 'unverified' ? 2 : 1;
}

runCli(module, main);

module.exports = {
  checkAuthGovernance,
  AuthGovernanceVerificationError,
  isFacebookOAuthEnabled: enabledCheck('facebook'),
  isGoogleOAuthEnabled: enabledCheck('google'),
  isMicrosoftOAuthEnabled: enabledCheck('microsoft'),
  isOidcEnabled: enabledCheck('oidc'),
  isSamlEnabled: enabledCheck('saml'),
  isWsFederationEnabled: enabledCheck('ws-federation'),
  isLocalLoginEnabled: enabledCheck('local'),
};

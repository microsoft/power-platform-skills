#!/usr/bin/env node
'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { resolveContext, request, parseCliArgs, emitJson, runCli } = require('./lib/power-platform-api');
const { UUID_REGEX, CLOUD_TO_API } = require('./lib/validation-helpers');
const { tenantIdFromToken } = require('./lib/cli-tenant-alignment');

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
  // The built-in workforce provider (legacy AzureAD settings) is independent
  // of these controls; Entra External ID remains governed through `oidc`.
  'entra-id': { label: 'Microsoft Entra ID', policies: [] },
  facebook: { label: 'Facebook', policies: [ROOT, OAUTH, 'EnableIdpOAuthFacebook'] },
  google: { label: 'Google', policies: [ROOT, OAUTH, 'EnableIdpOAuthGoogle'] },
  microsoft: { label: 'Microsoft Account', policies: [ROOT, OAUTH, 'EnableIdpOAuthMicrosoft'] },
  oidc: { label: 'OpenID Connect', policies: [ROOT, 'EnableProtocolOpenIdConnect'] },
  saml: { label: 'SAML', policies: [ROOT, 'EnableProtocolSAML20'] },
  'ws-federation': { label: 'WS-Federation', policies: [ROOT, 'EnableProtocolWsFederation'] },
  local: { label: 'Local login', policies: [ROOT, 'EnableAuthenticationLocalLogin'] },
});

class AuthGovernanceInputError extends TypeError {}

function assertId(value, name) {
  if (typeof value !== 'string' || !UUID_REGEX.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new AuthGovernanceInputError(`${name} must be a non-empty, non-zero GUID.`);
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

function readState(body, scope) {
  if (scope === 'environment') {
    // Only for a confirmed never-provisioned host: it cannot already belong to
    // an Include/Exclude host list. Preferences also apply to future sites.
    // GET returns a scope string, e.g. "All" or its enum spelling "AllSites";
    // unknown values/envelopes and unset policies must remain unverified.
    // https://learn.microsoft.com/en-us/power-pages/security/external-auth-control
    if (typeof body !== 'string') return 'unknown';
    const value = body.trim().toLowerCase();
    if (['all', 'allsites', 'exclude', 'excludesites', 'excludedsites', 'allsitesexceptexcluded'].includes(value)) return 'enabled';
    if (['none', 'include', 'includesites', 'includedsites'].includes(value)) return 'disabled';
    return 'unknown';
  }
  // The portal-level endpoint returns one boolean, not environment-level
  // All/None/Include/Exclude or membership lists. The shared HTTP parser
  // leaves text/plain primitives as strings, e.g. "true" or .NET's "True".
  // Accept only boolean text, ignoring case; unknown shapes never authorize setup.
  if (body === true || body === false) return body ? 'enabled' : 'disabled';
  if (typeof body === 'string' && /^(true|false)$/i.test(body.trim())) {
    return body.trim().toLowerCase() === 'true' ? 'enabled' : 'disabled';
  }
  return 'unknown';
}

function canContinueSetup(policies) {
  return policies.every((item) => item.state === 'enabled' ||
    (item.state === 'unknown' && item.error.code === 'ReadUnavailable'));
}

function isTransientStatus(status) {
  return status === 0 || status === 429 || (status >= 500 && status <= 599 && status !== 501);
}

async function readWithRetry(args, read, wait) {
  // Retry only unavailable reads, never auth/target errors or malformed results.
  // Three attempts with 500ms/1000ms backoff bound repeated service failures.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await read(args);
    } catch (error) {
      // Generic thrown errors can be programming/route failures, not outages.
      // Only recognized network failures may enter warning-and-continue.
      if (!['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
        'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)) throw error;
      response = { ok: false, statusCode: 0 };
    }
    if (attempt === 3 || response?.ok !== false || !Number.isInteger(response.statusCode) ||
        response.error?.code === 'ContextError' ||
        !isTransientStatus(response.statusCode)) {
      return response;
    }
    await wait(500 * attempt);
  }
}

function decisionMessage(label, policies, scope = 'portal') {
  const blockedPolicies = policies.filter((item) => item.state === 'disabled');
  const verificationErrors = policies.filter((item) => item.state === 'unknown');
  if (!blockedPolicies.length && !verificationErrors.length) {
    return `${label} setup is allowed by ${scope} governance.`;
  }
  const sections = [];
  if (blockedPolicies.length) {
    sections.push(`Your administrator has restricted the use of ${blockedPolicies.map((item) => item.label).join(', ')} for this website. ` +
      'Contact your administrator if you need this setting enabled.');
  }
  if (verificationErrors.length) {
    const canContinue = canContinueSetup(policies);
    sections.push((canContinue
      ? `Warning: ${label} ${scope} governance could not be verified.\n\n`
      : `${label} setup stopped because ${scope} governance could not be verified.\n\n`) +
      verificationErrors.map((item) => `- ${item.label} (${item.policy}): ${item.error.message}`).join('\n'));
    sections.push(canContinue
      ? 'Continue setup with this warning, without treating these policies as enabled. Power Pages runtime governance still applies; the configured sign-in methods may not work.'
      : 'Resolve the verification errors and retry before changing provider settings or the login page.');
  }
  sections.push('This read-only check made no provider settings or login-page changes.');
  return sections.join('\n\n');
}

function providerResult(provider, policies, scope = 'portal') {
  const definition = PROVIDERS[provider];
  const required = definition.policies.map((policy) => policies.find((item) => item.policy === policy));
  const blockedPolicies = required.filter((item) => item.state === 'disabled');
  const verificationErrors = required.filter((item) => item.state === 'unknown');
  const status = verificationErrors.length ? 'unverified' : blockedPolicies.length ? 'blocked' : 'enabled';
  const message = required.length ? decisionMessage(definition.label, required, scope)
    : `${definition.label} setup is independent of authentication governance settings.`;
  return {
    provider, label: definition.label, status, allowed: status === 'enabled',
    canContinue: canContinueSetup(required), blockedPolicies, verificationErrors, message,
  };
}

/**
 * Setup-time only. Resolve CLI auth once, then read all unique scoped policies
 * concurrently. No persistent cache, membership reads, policy writes, or visitor
 * credentials. Inject dependencies only for offline tests.
 */
async function checkAuthGovernance(options, dependencies = {}) {
  const { tenantId, envId, portalId, websiteRecordId } = options || {};
  const scope = options?.scope ?? 'portal';
  const selected = options?.providers || [options?.provider];
  if (!Array.isArray(selected) || !selected.length ||
      selected.some((provider) => typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider))) {
    throw new AuthGovernanceInputError(`Select one or more providers: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  const providers = [...new Set(selected)];
  const keys = [...new Set(providers.flatMap((provider) => PROVIDERS[provider].policies))];
  // Workforce-only setup must not gain governance-specific target or CLI
  // authentication prerequisites. Mixed batches still pass every guard below.
  if (!keys.length) {
    const results = providers.map((provider) => providerResult(provider, []));
    return {
      tenantId: tenantId ?? null, envId: envId ?? null, portalId: portalId ?? null,
      status: 'enabled', allowed: true, canContinue: true, policies: [], providers: results,
      message: results.map((result) => result.message).join('\n\n'),
    };
  }
  if (scope !== 'portal' && scope !== 'environment') {
    throw new AuthGovernanceInputError('scope must be portal or environment.');
  }
  assertId(envId, 'envId');
  if (scope === 'portal') {
    assertId(portalId, 'portalId (Power Platform host ID, not websiteRecordId)');
  } else if (portalId !== undefined && portalId !== null) {
    // A caller with a known host must use its effective portal policy instead.
    // Explicit scope prevents accidental missing IDs from changing API routes.
    throw new AuthGovernanceInputError('Environment scope requires confirmed absence of a provisioned host; do not supply portalId.');
  }
  if (websiteRecordId !== undefined) {
    assertId(websiteRecordId, 'websiteRecordId');
    if (scope === 'portal' && portalId.toLowerCase() === websiteRecordId.toLowerCase()) {
      throw new AuthGovernanceInputError('portalId must be the Power Platform host ID, not the Dataverse websiteRecordId.');
    }
  }
  const scopeLabel = scope === 'environment' ? 'Environment-level' : 'Portal-level';
  let problem;
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    // Never infer the expected owner from the current account: doing so would
    // make the drift check tautological. Missing ownership stops before auth.
    problem = 'The portal owning tenant ID is required. Confirm it from the target environment or user input, supply --tenantId, and retry. No governance requests were sent.';
  } else {
    assertId(tenantId, 'tenantId (expected portal owning tenant)');
  }
  const resolve = dependencies.resolveContext || resolveContext;
  const read = dependencies.request || request;
  const wait = dependencies.sleep || sleep;
  let context;
  if (!problem) {
    try {
      // Resolve the normal CLI context explicitly; no archived-skill routing.
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
      // IDs are validated above; policy keys come only from the fixed provider
      // mapping, never a caller-supplied policy or archived skill registry.
      const response = await readWithRetry({
        context, method: 'GET', path: scope === 'environment'
          ? `/governance/${policy}` : `/websites/${portalId}/governance/${policy}`,
      }, read, wait);
      if (!response?.ok || !Number.isInteger(response.statusCode) ||
          response.statusCode < 200 || response.statusCode >= 300) {
        const statusCode = Number.isInteger(response?.statusCode) ? response.statusCode : 0;
        // 404 does not establish an unsupported endpoint or a default policy.
        // Only explicit unavailable-read envelopes permit setup continuation.
        const unavailable = response?.ok === false && Number.isInteger(response.statusCode) &&
          (statusCode === 403 || statusCode === 405 || statusCode === 501 || isTransientStatus(statusCode)) &&
          response.error?.code !== 'ContextError';
        const message = statusCode === 401 || statusCode === 403
          ? `Governance access was rejected (HTTP ${statusCode}). Check CLI sign-in and administrator permissions.`
          : statusCode === 404
            ? `${scopeLabel} governance was not found (HTTP 404). Verify ${scope === 'portal' ? 'the host ID and API availability in the target environment' : 'the environment and API availability; an unset policy is not a verified restriction or approval'}.`
            : statusCode === 405 || statusCode === 501
              ? `The ${scopeLabel.toLowerCase()} governance endpoint is unavailable (HTTP ${statusCode}). Its policies could not be verified.`
              : `${scopeLabel} governance read failed (${statusCode ? `HTTP ${statusCode}` : 'no response'}). Retry after resolving service or network errors.`;
        return { ...item, error: { code: unavailable ? 'ReadUnavailable' : 'ReadFailed', statusCode, message } };
      }
      const state = readState(response.body, scope);
      return state === 'unknown'
        ? { ...item, error: { code: 'UnknownResponse', message: scope === 'environment'
          ? 'The environment-level response was not a recognized All/None/Include/Exclude scope. Verify the API response contract before retrying.'
          : 'The portal-level response was not a boolean. Verify the API response contract before retrying.' } }
        : { ...item, state };
    } catch {
      return { ...item, error: { code: 'ReadFailed', statusCode: 0, message: `${scopeLabel} governance read failed without a response. Check connectivity and retry.` } };
    }
  }));
  const results = providers.map((provider) => providerResult(provider, policies, scope));
  const status = results.some((result) => result.status === 'unverified') ? 'unverified'
    : results.some((result) => result.status === 'blocked') ? 'blocked' : 'enabled';
  return {
    tenantId: tenantId ?? null, envId, portalId: portalId ?? null, scope, status, allowed: status === 'enabled',
    canContinue: canContinueSetup(policies), policies, providers: results,
    // Summarize denied batches from unique policies, not provider order: allowed
    // siblings must not lead the message or repeat a shared parent's restriction.
    message: status === 'enabled' ? results.map((result) => result.message).join('\n\n')
      : decisionMessage(results.length === 1 ? results[0].label : 'Authentication', policies, scope),
  };
}

async function main() {
  const args = parseCliArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node check-auth-governance.js --tenantId <owning-tenant-guid> --envId <guid> --portalId <host-guid> --providers facebook,google\n' +
      'Optional: --websiteRecordId <guid> (rejects using the record ID as the host ID)\n' +
      'For a confirmed never-provisioned host: --scope environment --tenantId <owning-tenant-guid> --envId <guid> --providers facebook,google (no --portalId)\n' +
      'Workforce Microsoft Entra ID: --providers entra-id needs no target IDs or CLI authentication for this check.\n' +
      `Providers: ${Object.keys(PROVIDERS).join(', ')}\n` +
      'Read-only, setup-time gate. Exit 0: allowed; 1: blocked; 2: unverifiable; 3: invalid input or execution failure.\n' +
      'On exit 2, inspect canContinue: true means warn and continue setup, not verified policy approval.\n'
    );
    return;
  }
  const result = await checkAuthGovernance({
    tenantId: args.tenantId, envId: args.envId, portalId: args.portalId, websiteRecordId: args.websiteRecordId, scope: args.scope,
    providers: typeof args.providers === 'string' ? args.providers.split(',').map((value) => value.trim()) : [],
  });
  emitJson(result);
  process.exitCode = result.allowed ? 0 : result.status === 'unverified' ? 2 : 1;
}

runCli(module, async () => {
  try {
    await main();
  } catch (error) {
    // Reserve 1 for verified policy blocks without changing shared CLI defaults.
    // Only checker-authored input errors are safe to echo; crashes may contain secrets.
    process.stderr.write((error instanceof AuthGovernanceInputError ? error.message
      : 'Authentication governance check failed unexpectedly. Retry the check before continuing setup.') + '\n');
    process.exitCode = 3;
  }
});

module.exports = { checkAuthGovernance };

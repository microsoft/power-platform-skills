#!/usr/bin/env node
'use strict';

const { resolveContext, request, parseCliArgs, emitJson, runCli } = require('./lib/power-platform-api');
const {
  getEnvironmentUrl, validateDataverseEnvironmentUrl, makeRequest, CLOUD_TO_API, UUID_REGEX,
} = require('./lib/validation-helpers');

const API_VERSION = '2024-10-01';
const MAX_ATTEMPTS = 20;
const INTERVAL_MS = 15000;

function siteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Website URL must be HTTPS without credentials or a nonstandard port.');
  }
  return url.origin;
}

function validateWebsite(body, portalId, websiteUrl) {
  // The documented WebsiteDto uses camelCase; older API clients also receive
  // PascalCase. The API id is the Portal ID, NOT the Dataverse website record ID.
  // https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/get-website-by-id
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof (body.id || body.Id) !== 'string' ||
      (body.id || body.Id).toLowerCase() !== portalId.toLowerCase()) {
    throw new Error('Website API response does not match the approved Portal ID.');
  }
  if (siteOrigin(body.websiteUrl || body.WebsiteUrl) !== websiteUrl) {
    throw new Error('Website API URL does not match the approved site URL. Verify site identity before restarting.');
  }
  const status = body.status || body.Status;
  if (!['OperationComplete', 'OperationFailed', 'OperationInProgress', 'OperationNotStarted'].includes(status)) {
    throw new Error('Website API response has no recognized operation status.');
  }
  return status;
}

function apiError(label, response) {
  return `${label} failed (HTTP ${response.statusCode}): ${response.error?.message || response.error?.code || 'unexpected response'}`;
}

async function restartSite({ portalId, environmentUrl, websiteUrl, approved = false, verifyOnly = false }, deps = {}) {
  if (typeof portalId !== 'string' || !UUID_REGEX.test(portalId)) throw new Error('--portal-id must be a valid Portal ID GUID.');
  if (typeof environmentUrl !== 'string' || !environmentUrl.trim()) throw new Error('--env-url is required.');
  if (typeof websiteUrl !== 'string' || !websiteUrl.trim()) throw new Error('--website-url is required.');
  if (typeof approved !== 'boolean' || typeof verifyOnly !== 'boolean') throw new Error('Restart approval and verification flags must be booleans.');
  if (approved !== true && verifyOnly !== true) throw new Error('Explicit user approval (--approved) is required before restarting.');
  if (approved === true && verifyOnly === true) throw new Error('Use either --approved or --verify-only, not both.');
  const expectedEnvironment = validateDataverseEnvironmentUrl(environmentUrl);
  const expectedSite = siteOrigin(websiteUrl);
  const activeEnvironment = (deps.getEnvironmentUrl || getEnvironmentUrl)();
  if (!activeEnvironment || validateDataverseEnvironmentUrl(activeEnvironment) !== expectedEnvironment) {
    throw new Error('Active PAC environment does not match the migration environment. No restart was requested.');
  }
  const context = (deps.resolveContext || resolveContext)();
  if (!context || context.error) throw new Error(context?.error || 'Power Platform API context is unavailable.');
  if (typeof context.token !== 'string' || !context.token ||
      !UUID_REGEX.test(context.environmentId || '') || !Object.values(CLOUD_TO_API).includes(context.apiHost) ||
      context.baseUrl !== `${context.apiHost}/powerpages/environments/${context.environmentId}`) {
    throw new Error('Invalid Power Platform API environment context.');
  }
  const callApi = deps.request || request;
  const checkHttp = deps.makeRequest || makeRequest;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const progress = deps.onProgress || ((record) => console.error(JSON.stringify(record)));
  const path = `/websites/${portalId}`;
  const getWebsite = () => callApi({
    context, method: 'GET', path, query: { 'api-version': API_VERSION }, timeout: 15000,
  });
  const identity = { portalId, environmentId: context.environmentId, websiteUrl: expectedSite };
  const failure = (outcome, error, restartSubmitted, extra = {}) => ({
    success: false, outcome, error, restartSubmitted, verificationOnly: verifyOnly,
    manualFallbackRequired: true, ...identity, ...extra,
  });
  const initial = await getWebsite();
  if (!initial.ok) return failure('PreflightFailed', apiError('Get website', initial), false);
  const initialStatus = validateWebsite(initial.body, portalId, expectedSite);

  let restartSubmitted = false;
  if (!verifyOnly) {
    if (initialStatus !== 'OperationComplete') {
      return failure('PreflightFailed', `Website operation is ${initialStatus}; resolve it before requesting a restart.`, false);
    }
    // Exactly one approved POST. Network failures/5xx can be ambiguous: do not
    // retry a mutation that might already have reached the service.
    // https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/restart-website
    const restarted = await callApi({
      context, method: 'POST', path: `${path}/restart`,
      query: { 'api-version': API_VERSION }, timeout: 30000,
    });
    if (!restarted.ok) {
      const submitted = restarted.statusCode >= 400 && restarted.statusCode < 500 && restarted.statusCode !== 408
        ? false : null;
      return failure('RestartFailed', apiError('Restart website', restarted), submitted);
    }
    restartSubmitted = true;
    progress({ event: 'restart-submitted', ...identity });
    // Only 200 is documented as restart success. An unexpected accepted/async
    // response must not be interpreted as a completed restart.
    if (restarted.statusCode !== 200) {
      return failure('RestartUnconfirmed', `Restart returned HTTP ${restarted.statusCode}; confirm completion before continuing.`, true);
    }
    await sleep(INTERVAL_MS);
  }

  let consecutiveReady = 0;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const statusResult = await getWebsite();
    if (!statusResult.ok) return failure('VerificationFailed', apiError('Check website status', statusResult), restartSubmitted, { attempts: attempt });
    const status = validateWebsite(statusResult.body, portalId, expectedSite);
    if (status === 'OperationFailed') return failure('VerificationFailed', 'Website API reports OperationFailed.', restartSubmitted, { attempts: attempt });
    let reachable = false;
    let httpStatus = null;
    if (status === 'OperationComplete') {
      // Only probe the API-verified, approved origin. Never send management
      // tokens/cookies or follow redirects to a site or an external sign-in page.
      const health = await checkHttp({
        url: `${expectedSite}/`, method: 'GET',
        headers: { Accept: 'text/html', 'Cache-Control': 'no-cache' }, timeout: 15000,
      });
      httpStatus = health.statusCode || null;
      reachable = !health.error && httpStatus >= 200 && httpStatus < 400;
      lastError = reachable ? null : health.error || `Website returned HTTP ${httpStatus}`;
    } else {
      lastError = `Website operation is ${status}`;
    }
    consecutiveReady = reachable ? consecutiveReady + 1 : 0;
    progress({ event: 'readiness-check', attempt, maxAttempts: MAX_ATTEMPTS, status, httpStatus, reachable });
    // Two consecutive checks avoid treating one transient response as readiness.
    // Reachability is not proof of EDM functionality; Phase 4 owns runtime testing.
    if (consecutiveReady >= 2) {
      return {
        success: true, outcome: 'Ready', restartSubmitted, verificationOnly: verifyOnly,
        websiteReachable: true, attempts: attempt, ...identity,
      };
    }
    if (attempt < MAX_ATTEMPTS) await sleep(INTERVAL_MS);
  }
  return failure('VerificationTimedOut', `Site readiness was not confirmed after ${MAX_ATTEMPTS} checks. ${lastError || 'Two consecutive healthy responses are required.'}`,
    restartSubmitted, { attempts: MAX_ATTEMPTS });
}

async function main() {
  const args = parseCliArgs(process.argv);
  try {
    const result = await restartSite({
      portalId: args['portal-id'], environmentUrl: args['env-url'], websiteUrl: args['website-url'],
      approved: args.approved === true, verifyOnly: args['verify-only'] === true,
    });
    emitJson(result);
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    // An unexpected exception can happen after the request was sent. Preserve
    // that uncertainty rather than encouraging an unsafe automatic POST retry.
    emitJson({ success: false, outcome: 'Error', restartSubmitted: null, manualFallbackRequired: true, error: error.message });
    process.exitCode = 1;
  }
}

module.exports = { restartSite };
runCli(module, main);

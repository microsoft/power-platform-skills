#!/usr/bin/env node

// Provisions a Power Pages website through the documented Power Platform API.
// The create-site EDM workflow reuses this script with an explicit template and
// language; activate-site keeps its existing default-template behavior.

const {
  getAuthToken,
  makeRequest,
  validateAuthenticatedRequestUrl,
  CLOUD_TO_API,
  CLOUD_TO_SITE_DOMAIN,
  UUID_REGEX,
} = require('../../../scripts/lib/validation-helpers');
const {
  CREATE_WEBSITE_TEMPLATE_NAMES,
} = require('../../../scripts/lib/site-templates');

const API_VERSION = '2024-10-01';
const DEFAULT_TEMPLATE = 'DefaultPortalTemplate';
const DEFAULT_LANGUAGE = 1033;
const DEFAULT_MAX_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const TOKEN_REFRESH_INTERVAL_MS = 60_000;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const next = argv[index + 1];
    args[current.slice(2)] = next && !next.startsWith('--') ? next : true;
    if (next && !next.startsWith('--')) index += 1;
  }
  return args;
}

function normalizeOptions(options) {
  const siteName = typeof options.siteName === 'string' ? options.siteName.trim() : '';
  const subdomain = typeof options.subdomain === 'string' ? options.subdomain.trim().toLowerCase() : '';
  const organizationId = typeof options.organizationId === 'string' ? options.organizationId.trim() : '';
  const environmentId = typeof options.environmentId === 'string' ? options.environmentId.trim() : '';
  const websiteRecordId = typeof options.websiteRecordId === 'string'
    ? options.websiteRecordId.trim()
    : null;
  const operationLocation = typeof options.operationLocation === 'string'
    ? options.operationLocation.trim()
    : null;
  const templateName = options.templateName || DEFAULT_TEMPLATE;
  const selectedBaseLanguage = Number(options.selectedBaseLanguage || DEFAULT_LANGUAGE);
  const cloud = options.cloud || 'Public';

  if (!siteName) throw new Error('Missing required argument: --siteName');
  if (siteName.length > 200) throw new Error('--siteName must be 200 characters or fewer.');
  if (
    subdomain.length < 2 ||
    subdomain.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(subdomain)
  ) {
    throw new Error('--subdomain must contain 2-63 lowercase letters, numbers, or hyphens.');
  }
  if (!UUID_REGEX.test(organizationId)) {
    throw new Error('--organizationId must be a valid GUID.');
  }
  if (!UUID_REGEX.test(environmentId)) {
    throw new Error('--environmentId must be a valid GUID.');
  }
  if (websiteRecordId && !UUID_REGEX.test(websiteRecordId)) {
    throw new Error('--websiteRecordId must be a valid GUID when provided.');
  }
  if (!CREATE_WEBSITE_TEMPLATE_NAMES.has(templateName)) {
    throw new Error(
      `Unsupported --templateName "${templateName}". Use a template returned by list-site-templates.js.`,
    );
  }
  if (!Number.isInteger(selectedBaseLanguage) || selectedBaseLanguage <= 0) {
    throw new Error('--selectedBaseLanguage must be a positive integer LCID.');
  }
  if (!Object.prototype.hasOwnProperty.call(CLOUD_TO_API, cloud)) {
    throw new Error(`Unsupported --cloud "${cloud}".`);
  }

  return {
    siteName,
    subdomain,
    organizationId,
    environmentId,
    websiteRecordId,
    operationLocation,
    templateName,
    selectedBaseLanguage,
    cloud,
  };
}

function parseResponseBody(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractOperationStatus(body) {
  if (!body || typeof body !== 'object') return null;
  return body.operationStatus || body.status || body.Status || null;
}

function isSucceeded(status) {
  return ['OperationComplete', 'Succeeded', 'Completed'].includes(status);
}

function isFailed(status) {
  return ['OperationFailed', 'Failed', 'Canceled', 'Cancelled'].includes(status);
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return match ? match[1] : null;
}

function validateOperationLocation(location, initiatingUrl) {
  let resolved;
  try {
    resolved = new URL(location, initiatingUrl);
  } catch {
    throw new Error('Create Website returned an invalid Operation-Location header.');
  }
  const trusted = validateAuthenticatedRequestUrl(resolved.href);
  if (new URL(trusted).origin !== new URL(initiatingUrl).origin) {
    throw new Error('Create Website returned an Operation-Location on a different host.');
  }
  if (!resolved.searchParams.has('api-version')) {
    resolved.searchParams.set('api-version', API_VERSION);
  }
  return validateAuthenticatedRequestUrl(resolved.href);
}

function extractServiceError(result) {
  const body = parseResponseBody(result.body);
  const error = body && typeof body === 'object' ? (body.error || body.Error || body) : null;
  return {
    status: 'Failed',
    statusCode: result.statusCode,
    errorCode: error && typeof error === 'object' ? (error.code || null) : null,
    error: error && typeof error === 'object'
      ? (error.message || JSON.stringify(error))
      : String(body || result.error || 'Unknown error'),
  };
}

async function provisionWebsite(options, dependencies = {}) {
  const normalized = normalizeOptions(options);
  const acquireToken = dependencies.getAuthToken || getAuthToken;
  const request = dependencies.makeRequest || makeRequest;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = dependencies.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const pollIntervalMs = dependencies.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

  const apiHost = CLOUD_TO_API[normalized.cloud];
  const siteDomain = CLOUD_TO_SITE_DOMAIN[normalized.cloud];
  const expectedSiteUrl = `https://${normalized.subdomain}.${siteDomain}`;
  const createUrl =
    `${apiHost}/powerpages/environments/${normalized.environmentId}/websites` +
    `?api-version=${API_VERSION}`;

  let token = acquireToken(apiHost);
  if (!token) {
    return { error: 'Azure CLI token not available. Run "az login" and retry.' };
  }

  const body = {
    name: normalized.siteName,
    subdomain: normalized.subdomain,
    templateName: normalized.templateName,
    dataverseOrganizationId: normalized.organizationId,
    selectedBaseLanguage: normalized.selectedBaseLanguage,
  };
  if (normalized.websiteRecordId) body.websiteRecordId = normalized.websiteRecordId;

  let operationLocation;
  if (normalized.operationLocation) {
    try {
      operationLocation = validateOperationLocation(normalized.operationLocation, createUrl);
    } catch (error) {
      return { error: error.message };
    }
  } else {
    const postResult = await request({
      method: 'POST',
      url: createUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      includeHeaders: true,
      timeout: 30_000,
    });

    if (postResult.error && !postResult.statusCode) {
      return { error: `POST request failed: ${postResult.error}` };
    }
    if (postResult.statusCode !== 202) return extractServiceError(postResult);

    const operationHeader = readHeader(postResult.headers, 'operation-location');
    if (!operationHeader) {
      return { error: 'POST returned 202 but no Operation-Location header was found.' };
    }

    try {
      operationLocation = validateOperationLocation(operationHeader, createUrl);
    } catch (error) {
      return { error: error.message };
    }
  }

  let lastTokenRefresh = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs);

    if (Date.now() - lastTokenRefresh >= TOKEN_REFRESH_INTERVAL_MS) {
      const refreshed = acquireToken(apiHost);
      if (refreshed) token = refreshed;
      lastTokenRefresh = Date.now();
    }

    const pollResult = await request({
      url: operationLocation,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      includeHeaders: true,
      timeout: 15_000,
    });

    if (pollResult.error || pollResult.statusCode < 200 || pollResult.statusCode >= 300) {
      continue;
    }

    const pollBody = parseResponseBody(pollResult.body);
    const status = extractOperationStatus(pollBody);
    if (isSucceeded(status)) {
      return {
        status: 'Succeeded',
        siteUrl: pollBody.websiteUrl || pollBody.WebsiteUrl || expectedSiteUrl,
        siteName: normalized.siteName,
        subdomain: normalized.subdomain,
        templateName: normalized.templateName,
        selectedBaseLanguage: normalized.selectedBaseLanguage,
        websiteRecordId:
          pollBody.websiteRecordId ||
          pollBody.WebsiteRecordId ||
          normalized.websiteRecordId ||
          null,
      };
    }
    if (isFailed(status)) {
      const error = pollBody.error || pollBody.Error || pollBody;
      return {
        status: 'Failed',
        statusCode: 200,
        errorCode: error.code || null,
        error: `Provisioning failed: ${error.message || JSON.stringify(error)}`,
      };
    }
  }

  return {
    status: 'Running',
    message: 'Provisioning is still in progress. Resume by checking the saved operation URL.',
    operationLocation,
    siteUrl: expectedSiteUrl,
    siteName: normalized.siteName,
    subdomain: normalized.subdomain,
    templateName: normalized.templateName,
    websiteRecordId: normalized.websiteRecordId,
  };
}

async function main() {
  try {
    const result = await provisionWebsite(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  API_VERSION,
  parseArgs,
  normalizeOptions,
  parseResponseBody,
  extractOperationStatus,
  validateOperationLocation,
  provisionWebsite,
};

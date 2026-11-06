// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BridgeError, abortable, invalid, isObject } from './errors.mjs';
import { isGuid, profile, tryParseEnvironmentId, validateEnvironmentId } from './configuration.mjs';
import {
  currentAzureCliTenant,
  IdentityClient,
  ENVIRONMENT_DISCOVERY_RESOURCE
} from './authentication.mjs';

const environmentPath = '/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/';

const failure = (message, code = 'INVALID_CONFIGURATION') =>
  new BridgeError(
    `${message} Environment discovery made no configuration changes. Use an explicitly confirmed --tenant with config if discovery is unavailable.`,
    3,
    code
  );

async function get(url, accessToken, consume, fetchImpl, signal) {
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(
    () => deadline.abort(failure('Environment discovery timed out.', 'NETWORK_FAILURE')),
    20000
  );
  let response;
  try {
    const headers = new Headers({ accept: 'application/json' });
    if (accessToken) {
      headers.set('authorization', `Bearer ${accessToken}`);
    }
    combined.throwIfAborted();
    const request = new Request(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: combined
    });
    // Attach rejection/cancellation handlers before a fetch implementation can abort synchronously.
    response = await abortable(
      Promise.resolve().then(() => fetchImpl(request)),
      combined
    );
    if (response.status >= 300 && response.status < 400) {
      throw failure(
        `Environment discovery returned HTTP ${response.status}; redirects are blocked.`,
        'REDIRECT_BLOCKED'
      );
    }
    return await consume(response, combined);
  } catch (error) {
    if (combined.aborted) {
      throw combined.reason;
    }
    throw error instanceof BridgeError
      ? error
      : failure('Environment discovery failed while reading the response.', 'NETWORK_FAILURE');
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) {
      await response.body.cancel();
    }
  }
}

async function readMetadata(response, signal) {
  if (response.status !== 200) {
    throw failure(
      `Environment metadata lookup returned HTTP ${response.status}. Check directory-read access and the selected environment.`,
      'HTTP_FAILURE'
    );
  }
  if (!response.body) {
    throw failure('Environment metadata is empty.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortable(
        Promise.resolve().then(() => reader.read()),
        signal
      );
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 1024 * 1024) {
        throw failure('Environment metadata exceeds the one-MiB size limit.');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw failure('Environment metadata is not valid JSON.');
  }
}

function selectedRecord(payload, environmentId) {
  // BAP returns {name:"<id>", id:"/providers/.../environments/<id>", properties:{...}}
  // or {value:[...]}. Compare canonical whole IDs, retaining prefixes; different spellings
  // of the same GUID are equivalent, but a bare GUID is not a prefixed environment.
  // See: https://learn.microsoft.com/power-platform/admin/list-environments
  const candidates = Array.isArray(payload?.value) ? payload.value : [payload];
  const ids = record =>
    [
      record?.name,
      record?.environmentId,
      record?.properties?.environmentId,
      typeof record?.id === 'string' &&
      record.id.toLowerCase().startsWith(environmentPath.toLowerCase())
        ? record.id.slice(environmentPath.length)
        : record?.id
    ].filter(value => value !== undefined);
  const matches = candidates.filter(
    record =>
      isObject(record) &&
      ids(record).some(id => tryParseEnvironmentId(id) === environmentId)
  );
  if (
    matches.length !== 1 ||
    ids(matches[0]).some(id => tryParseEnvironmentId(id) !== environmentId)
  ) {
    throw failure('Environment metadata did not identify exactly the requested environment.');
  }
  if (!isObject(matches[0].properties)) {
    throw failure('Environment metadata has no valid properties.');
  }
  return matches[0];
}

function metadataTenant(record) {
  const values = [
    record.tenantId,
    record.properties.tenantId,
    record.properties.linkedEnvironmentMetadata?.tenantId
  ].filter(value => value !== undefined && value !== null);
  if (
    values.some(value => !isGuid(value)) ||
    new Set(values.map(value => value.toLowerCase())).size > 1
  ) {
    throw failure('Environment metadata contains invalid or conflicting tenant identifiers.');
  }
  // createdBy.tenantId describes the creator, not necessarily the resource tenant.
  // Missing tenant metadata requires an actual challenge, not the CLI tenant or an ID suffix.
  return values[0]?.toLowerCase();
}

function dataverseEndpoint(record) {
  const value = record.properties.linkedEnvironmentMetadata?.instanceUrl;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure('Environment metadata has no valid Dataverse URL for tenant discovery.');
  }
  // Directory-supplied URLs are data, not authority to send credentials elsewhere.
  // The fallback is token-free and limited to commercial Dataverse instance roots.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.crm\d{0,2}\.dynamics\.com$/i.test(url.hostname)
  ) {
    throw failure('Environment metadata returned an unsupported Dataverse URL.');
  }
  return new URL('/api/data/v9.2/', url).href;
}

function challengeTenant(response) {
  if (response.status !== 401) {
    throw failure(
      `Dataverse tenant discovery returned HTTP ${response.status}, not an authentication challenge.`,
      'HTTP_FAILURE'
    );
  }
  const header = response.headers.get('www-authenticate');
  if (!header || header.length > 32768) {
    throw failure('Dataverse tenant challenge is missing or too large.');
  }
  // e.g. Bearer authorization_uri="https://login.microsoftonline.com/<guid>/oauth2/authorize",
  // resource_id="https://contoso.crm.dynamics.com". Only Bearer authority parameters
  // count; quoted commas and other schemes cannot select another authority.
  const parts = header.match(/(?:[^,"\\]|\\.|"(?:\\.|[^"\\])*")+/g) ?? [];
  let bearer = false;
  const tenants = [];
  for (let part of parts) {
    part = part.trim();
    // Whitespace before '=' belongs to an auth-param, not a new scheme (RFC 9110 section 11.2).
    // https://www.rfc-editor.org/rfc/rfc9110.html#section-11.2
    const scheme = /^[A-Za-z][A-Za-z0-9_-]*\s*=/.test(part)
      ? null
      : /^([A-Za-z][A-Za-z0-9_-]*)\s+(.*)$/.exec(part);
    if (scheme) {
      bearer = scheme[1].toLowerCase() === 'bearer';
      part = scheme[2];
    }
    if (!bearer) {
      continue;
    }
    if (!/^(?:authorization_uri|authorization)\s*=/i.test(part)) {
      continue;
    }
    const match = /^(?:authorization_uri|authorization)\s*=\s*"([^"\\]+)"$/i.exec(part);
    if (!match) {
      throw failure('Dataverse tenant challenge has a malformed authority parameter.');
    }
    const authority =
      /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]+)\/oauth2\/authorize\/?$/i.exec(match[1]);
    if (!authority || !isGuid(authority[1])) {
      throw failure('Dataverse tenant challenge has an invalid authority.');
    }
    tenants.push(authority[1].toLowerCase());
  }
  if (tenants.length !== 1) {
    throw failure('Dataverse tenant challenge is missing or ambiguous.');
  }
  return tenants[0];
}

export async function resolveEnvironment(
  { cloud, environmentId },
  { cli, fetchImpl = globalThis.fetch, signal } = {}
) {
  signal?.throwIfAborted();
  environmentId = validateEnvironmentId(environmentId);
  if (typeof cloud !== 'string' || cloud.toLowerCase() !== 'public') {
    throw invalid(
      'Environment discovery is available only for Public. For other clouds, use config with an explicitly confirmed --tenant.'
    );
  }
  const selected = profile({
    Name: 'environment-discovery',
    Cloud: 'Public',
    EnvironmentId: environmentId,
    TenantId: await currentAzureCliTenant(cli, signal)
  });
  const identity = new IdentityClient(selected, cli);
  try {
    const credential = await identity.environmentDiscoveryToken(signal);
    const url = `${ENVIRONMENT_DISCOVERY_RESOURCE}${environmentPath}${encodeURIComponent(environmentId)}?api-version=2020-10-01`;
    const record = selectedRecord(
      await get(url, credential.token, readMetadata, fetchImpl, signal),
      environmentId
    );
    let tenantId = metadataTenant(record);
    let source = 'environment-metadata';
    if (!tenantId) {
      tenantId = await get(dataverseEndpoint(record), null, challengeTenant, fetchImpl, signal);
      source = 'dataverse-challenge';
    }
    await identity.checkSession(signal);
    return { cloud: 'Public', environmentId, tenantId, source };
  } finally {
    identity.dispose();
  }
}

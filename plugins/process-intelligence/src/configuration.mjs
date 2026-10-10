// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { invalid, isObject } from './errors.mjs';

export const CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

export const isGuid = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value.length === 36;

export function tryParseEnvironmentId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  let prefix = '';
  const prefixMatch = /^(Default|Legacy|Primary)-?/i.exec(value);
  if (prefixMatch) {
    const name = prefixMatch[1];
    prefix = name[0].toUpperCase() + name.slice(1).toLowerCase() + '-';
    value = value.slice(prefixMatch[0].length);
  }

  const guidMatch = /^\p{White_Space}*([^\p{White_Space}]{32,36})\p{White_Space}*$/u.exec(value);
  if (!guidMatch) {
    return null;
  }
  let guid = guidMatch[1].toLowerCase();
  if (/^[0-9a-f]{32}$/.test(guid)) {
    guid = guid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  } else {
    const parts = /^(.{8})-(.{4})-(.{4})-(.{4})-(.{4})([0-9a-f]{8})$/.exec(guid)?.slice(1);
    if (!parts) {
      return null;
    }
    for (let index = 0; index < 5; index++) {
      const digits = parts[index].replace(/^\+?(?:0x)?/, '');
      if (!/^[0-9a-f]+$/.test(digits)) {
        return null;
      }
      parts[index] = digits.padStart(parts[index].length, '0');
    }
    const lastDigits = parts.pop();
    parts[4] += lastDigits;
    guid = parts.join('-');
  }
  if (guid === '00000000-0000-0000-0000-000000000000') {
    return null;
  }
  return prefix + guid;
}

export function validateEnvironmentId(value) {
  const environmentId = tryParseEnvironmentId(value);
  if (environmentId === null) {
    throw invalid(
      'Environment ID must be a nonzero GUID (with or without hyphens), optionally prefixed ' +
        'with Default, Legacy or Primary and an optional separating hyphen.'
    );
  }
  return environmentId;
}

export function validateName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(name) || name.includes('\n')) {
    throw invalid(
      'Profile name must be 1-40 lowercase letters, digits or hyphens, starting with a letter.'
    );
  }
}

/** Profile files use PascalCase keys; preserve this on-disk format when validating input. */
export function profile(value) {
  if (!isObject(value)) {
    throw invalid('Profile JSON must be an object.');
  }
  const result = {
    Name: value.Name,
    Cloud: value.Cloud,
    TenantId: value.TenantId,
    EnvironmentId: validateEnvironmentId(value.EnvironmentId),
    Audience: value.Audience ?? null,
    HomeAccountId: value.HomeAccountId ?? null,
    Revision: value.Revision ?? ''
  };
  resolveConnection(result);
  if (result.HomeAccountId !== null && !isGuid(result.HomeAccountId)) {
    throw invalid('Profile account selection must be a tenant-local OID GUID or null.');
  }
  if (typeof result.Revision !== 'string') {
    throw invalid('Profile revision is invalid.');
  }
  return result;
}

/** @param {{Name:string,Cloud:string,TenantId:string,EnvironmentId:string,Audience?:string|null}} p */
export function resolveConnection(p) {
  validateName(p.Name);
  if (!isGuid(p.TenantId)) {
    throw invalid(
      'Tenant ID must be an explicit GUID; Azure CLI tenant selection is not implicit.'
    );
  }
  const environmentId = validateEnvironmentId(p.EnvironmentId);
  const mapping = {
    public: ['api.powerplatform.com', 'login.microsoftonline.com', 2, 'AzureCloud'],
    gcc: ['api.gov.powerplatform.microsoft.us', 'login.microsoftonline.com', 1, 'AzureCloud'],
    gcchigh: [
      'api.high.powerplatform.microsoft.us',
      'login.microsoftonline.us',
      1,
      'AzureUSGovernment'
    ],
    dod: ['api.appsplatform.us', 'login.microsoftonline.us', 1, 'AzureUSGovernment'],
    mooncake: [
      'api.powerplatform.partner.microsoftonline.cn',
      'login.partner.microsoftonline.cn',
      1,
      'AzureChinaCloud'
    ]
  };
  const cloud = typeof p.Cloud === 'string' ? p.Cloud.toLowerCase() : '';
  if (!Object.hasOwn(mapping, cloud)) {
    throw invalid(
      'Unknown or unsupported cloud. Choose Public, Gcc, GccHigh, DoD or Mooncake.'
    );
  }
  const [suffix, authorityHost, shard, cliCloud] = mapping[cloud];
  const resource = p.Audience ?? `https://${suffix}`;
  if (resource !== `https://${suffix}`) {
    throw invalid(
      'Audience is not allowlisted for this cloud. No automatic resource fallback is permitted.'
    );
  }
  const normalized = environmentId.replaceAll('-', '').toLowerCase();
  return {
    endpoint: `https://${normalized.slice(0, -shard)}.${normalized.slice(-shard)}.environment.${suffix}/processmining/mcp?api-version=2024-10-01`,
    authority: `https://${authorityHost}/${p.TenantId.toLowerCase()}`,
    authorityHost,
    resource,
    scope: `${resource}/.default`,
    cliCloud
  };
}

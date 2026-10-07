// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inspect } from 'node:util';
import { BridgeError, Gate, isObject } from './errors.mjs';
import { CLIENT_ID, isGuid, resolveConnection } from './configuration.mjs';

const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export const ENVIRONMENT_DISCOVERY_RESOURCE = 'https://api.bap.microsoft.com';

const authError = (code, message) => new BridgeError(message, 3, code);

const invalidToken = () =>
  authError(
    'TOKEN_INVALID',
    'Azure CLI returned an invalid token response or inconsistent user/tenant/client/audience claims; no authentication output was logged.'
  );

function json(text) {
  try {
    const value = JSON.parse(text);
    if (isObject(value)) {
      return value;
    }
  } catch {}
  throw authError(
    'CLI_AUTHENTICATION_FAILED',
    'Azure CLI returned invalid or missing JSON; authentication output was not logged.'
  );
}

function unix(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799) {
    throw invalidToken();
  }
  return value * 1000;
}

function safeCliError(raw) {
  const code = /AADSTS[0-9]{4,12}/.exec(raw)?.[0] ?? '';
  const reasons = {
    AADSTS65001:
      'User/admin consent is required; ask the tenant owner to review access. No consent was attempted.',
    AADSTS65002:
      'Client/resource preauthorization or consent is missing. No registration was changed.',
    AADSTS650052:
      'Client/resource preauthorization or consent is missing. No registration was changed.',
    AADSTS650057:
      'Client/resource preauthorization or consent is missing. No registration was changed.',
    AADSTS700082:
      'Azure CLI session expired or was revoked. Run az login explicitly in a terminal.',
    AADSTS700084:
      'Azure CLI session expired or was revoked. Run az login explicitly in a terminal.',
    AADSTS50173: 'Azure CLI session expired or was revoked. Run az login explicitly in a terminal.',
    AADSTS50076: 'Conditional access requires explicit reauthentication or tenant policy review.',
    AADSTS50079: 'Conditional access requires explicit reauthentication or tenant policy review.',
    AADSTS53000: 'Conditional access requires explicit reauthentication or tenant policy review.',
    AADSTS53003: 'Conditional access requires explicit reauthentication or tenant policy review.'
  };
  const message =
    reasons[code] ??
    (/az login/i.test(raw)
      ? 'Azure CLI login is required. Run az login explicitly in a terminal.'
      : /Connection|TLS|timed out/i.test(raw)
        ? 'Azure CLI transport failed. Verify connectivity; no fallback was attempted.'
        : 'Azure CLI authentication/command failed. Verify session, tenant, cloud and resource; no fallback was attempted.');
  return new BridgeError(
    message + (code ? ` (${code})` : ''),
    3,
    code ? 'AADSTS_FAILURE' : 'CLI_AUTHENTICATION_FAILED'
  );
}

async function readAzureCliAccount(cli, signal) {
  const output = await cli.run(['account', 'show', '--output', 'json', '--only-show-errors'], {
    signal
  });
  if (output.code !== 0) {
    throw safeCliError(output.stderr);
  }
  return json(output.stdout);
}

export async function currentAzureCliTenant(cli, signal) {
  const account = await readAzureCliAccount(cli, signal);
  if (!isGuid(account.tenantId)) {
    throw authError(
      'TOKEN_INVALID',
      'Azure CLI has no valid tenant. Sign in explicitly before environment discovery.'
    );
  }
  return account.tenantId;
}

export class IdentityResult {
  constructor(token, accountId, tenantId, accountUsername) {
    Object.assign(this, { token, accountId, tenantId, accountUsername });
  }

  toString() {
    return '[authentication result redacted]';
  }

  toJSON() {
    return this.toString();
  }

  [inspect.custom]() {
    return this.toString();
  }
}

export function validateIdentity(profile, result, selecting = false) {
  if (
    !result.token ||
    !isGuid(result.accountId) ||
    !isGuid(result.tenantId) ||
    !result.accountUsername?.trim()
  ) {
    throw invalidToken();
  }
  if (!same(profile.TenantId, result.tenantId)) {
    throw authError(
      'TENANT_MISMATCH',
      'Azure CLI returned a different tenant. Reconfigure explicitly; tenant switching is never automatic.'
    );
  }
  if (!selecting && !same(profile.HomeAccountId, result.accountId)) {
    throw authError(
      'ACCOUNT_CHANGED',
      'Azure CLI returned a different account. Use login --switch-account true to explicitly bind it.'
    );
  }
}

export class ProfileTokenProvider {
  constructor(profile, store, identity) {
    Object.assign(this, { profile, store, identity });
  }

  async getToken(force = false, signal) {
    const p = this.profile;
    await this.store.ensureCurrent(p);
    if (!p.HomeAccountId) {
      throw authError(
        'LOGIN_REQUIRED',
        'No account is selected. Run login --profile explicitly in a terminal; serve never opens sign-in UI.'
      );
    }
    resolveConnection(p);
    const result = await this.identity.silent(p.HomeAccountId, force, signal);
    validateIdentity(p, result);
    await this.store.ensureCurrent(p);
    return result.token;
  }
}

const loginGate = new Gate();

export async function login(
  selected,
  store,
  identity,
  { switchAccount = false, signIn = false, signal } = {}
) {
  return loginGate.run(async () => {
    await store.ensureCurrent(selected);
    const result = await identity.bind(signIn, signal);
    validateIdentity(selected, result, switchAccount || selected.HomeAccountId === null);
    await store.ensureCurrent(selected);
    const saved = await store.save(
      {
        ...selected,
        HomeAccountId: result.accountId.toLowerCase()
      },
      selected.Revision
    );
    return saved;
  }, signal);
}

/** Acquire credentials through Azure CLI; cache tokens only in memory. */
export class IdentityClient {
  #gate = new Gate();
  #cached;
  #cachedResource;
  #expires = 0;
  #version;
  // Username continuity is RAM-only and outlives token eviction/expiry. A cold process
  // verifies the saved tenant/OID from the token before establishing this pin.
  #accountUsername;

  constructor(profile, cli, now = Date.now) {
    this.profile = profile;
    this.cli = cli;
    this.now = now;
  }

  async silent(account, force = false, signal) {
    return this.#gate.run(async () => {
      if (force) {
        this.#cached = undefined;
      }
      const result = await this.#acquire(false, signal);
      if (!same(account, result.accountId)) {
        throw authError(
          'ACCOUNT_CHANGED',
          'Azure CLI account changed. Explicitly bind the intended account and restart MCP.'
        );
      }
      return result;
    }, signal);
  }

  async bind(signIn = false, signal) {
    return this.#gate.run(async () => {
      this.#cached = undefined;
      // Explicit binding can select a new CLI session; login still requires switch-account
      // before it will persist a different OID.
      this.#accountUsername = undefined;
      await this.#ensureVersion(signal);
      await this.#cloud(signal);
      if (signIn) {
        const args = [
          'login',
          '--tenant',
          this.profile.TenantId,
          '--allow-no-subscriptions',
          '--scope',
          resolveConnection(this.profile).scope,
          '--output',
          'none',
          '--only-show-errors'
        ];
        await this.#run(args, signal, true);
      }
      return this.#acquire(true, signal);
    }, signal);
  }

  async environmentDiscoveryToken(signal) {
    // Setup has one additional, fixed audience. It must never change MCP's audience
    // or turn a failed directory lookup into resource/account probing.
    if (this.profile.Cloud.toLowerCase() !== 'public') {
      throw authError(
        'CLOUD_MISMATCH',
        'Environment discovery is available only for Public. Configure the tenant explicitly for this cloud.'
      );
    }
    return this.#gate.run(
      () => this.#acquire(true, signal, ENVIRONMENT_DISCOVERY_RESOURCE),
      signal
    );
  }

  async checkSession(signal) {
    await this.#ensureVersion(signal);
    // account show has no user OID. Without a validated RAM pin this checks only
    // cloud, tenant and delegated-user shape, not the saved account binding.
    await this.#snapshot(signal);
  }

  async #run(args, signal, interactive = false) {
    const output = await this.cli.run(args, { signal, interactive });
    if (output.code !== 0) {
      throw safeCliError(output.stderr);
    }
    return output.stdout;
  }

  async #ensureVersion(signal) {
    if (this.#version !== undefined) {
      return;
    }
    const version = json(
      await this.#run(['version', '--output', 'json', '--only-show-errors'], signal)
    )['azure-cli'];
    const match = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    const numeric = match
      ? Number(match[1]) * 1000000 + Number(match[2]) * 1000 + Number(match[3])
      : 0;
    if (numeric < 2054000) {
      throw authError(
        'AZ_CLI_UNSUPPORTED',
        'Azure CLI 2.54+ is required for unambiguous expires_on timestamps; local expiresOn is not used.'
      );
    }
    this.#version = numeric;
  }

  async #cloud(signal) {
    const r = resolveConnection(this.profile);
    const cloud = json(
      await this.#run(['cloud', 'show', '--output', 'json', '--only-show-errors'], signal)
    );
    const authority =
      typeof cloud.endpoints?.activeDirectory === 'string'
        ? cloud.endpoints.activeDirectory.replace(/\/+$/, '')
        : '';
    if (
      cloud.name !== r.cliCloud ||
      (!same(authority, `https://${r.authorityHost}`) &&
        !(r.cliCloud === 'AzureChinaCloud' && authority === 'https://login.chinacloudapi.cn'))
    ) {
      throw authError(
        'CLOUD_MISMATCH',
        'Wrong Azure CLI cloud or authority. Select the intended official cloud explicitly; no global cloud switch was attempted.'
      );
    }
  }

  async #snapshot(signal) {
    await this.#cloud(signal);
    const account = await readAzureCliAccount(this.cli, signal);
    if (!same(account.user?.type, 'user')) {
      throw authError(
        'TOKEN_INVALID',
        'Azure CLI must use a delegated organizational user, not a service principal, managed identity or Cloud Shell identity.'
      );
    }
    const user = account.user?.name;
    if (
      typeof user !== 'string' ||
      !user.trim() ||
      user.length > 320 ||
      /[\x00-\x1f\x7f]/.test(user)
    ) {
      throw authError(
        'LOGIN_REQUIRED',
        'Azure CLI returned no usable user account. Run az login explicitly in a terminal.'
      );
    }
    if (!same(account.tenantId, this.profile.TenantId)) {
      throw authError(
        'TENANT_MISMATCH',
        'Wrong Azure CLI tenant; the bridge will not switch accounts or tenants.'
      );
    }
    if (account.environmentName !== resolveConnection(this.profile).cliCloud) {
      throw authError(
        'CLOUD_MISMATCH',
        'Azure CLI account cloud does not match the profile cloud.'
      );
    }
    if (
      this.#accountUsername !== undefined &&
      !same(user, this.#accountUsername)
    ) {
      throw authError(
        'ACCOUNT_CHANGED',
        'Azure CLI account changed, including within the same tenant. Use login --switch-account true only if intended.'
      );
    }
    return user.toLowerCase();
  }

  #parse(output, username, resource) {
    try {
      const envelope = JSON.parse(output);
      if (
        !isObject(envelope) ||
        typeof envelope.accessToken !== 'string' ||
        envelope.accessToken.length > 65536 ||
        !same(envelope.tokenType, 'Bearer') ||
        !same(envelope.tenant, this.profile.TenantId)
      ) {
        throw invalidToken();
      }
      const parts = envelope.accessToken.split('.');
      if (parts.length !== 3 || parts.some(p => !/^[a-zA-Z0-9_-]+$/.test(p))) {
        throw invalidToken();
      }
      const claims = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64url'))
      );
      if (
        !isObject(claims) ||
        !isGuid(claims.oid) ||
        !same(claims.tid, this.profile.TenantId) ||
        typeof claims.aud !== 'string' ||
        claims.aud.replace(/\/+$/, '') !== resource ||
        !same(claims.appid ?? claims.azp, CLIENT_ID) ||
        typeof claims.scp !== 'string' ||
        !claims.scp.trim() ||
        claims.idtyp === 'app' ||
        !['preferred_username', 'upn', 'unique_name'].some(k => same(claims[k], username))
      ) {
        throw invalidToken();
      }
      const expires = Math.min(unix(envelope.expires_on), unix(claims.exp));
      if (expires <= this.now() + 120000) {
        throw authError(
          'TOKEN_EXPIRED',
          'Azure CLI token is expired or too close to expiry. Run az login explicitly; CLI cache refresh cannot be forced by this bridge.'
        );
      }
      return {
        result: new IdentityResult(
          envelope.accessToken,
          claims.oid,
          this.profile.TenantId,
          username
        ),
        expires
      };
    } catch (error) {
      throw error instanceof BridgeError ? error : invalidToken();
    }
  }

  async #acquire(selecting, signal, resource = resolveConnection(this.profile).resource) {
    await this.#ensureVersion(signal);
    const before = await this.#snapshot(signal);

    let result = this.#cached;
    if (!result || this.#cachedResource !== resource || this.#expires <= this.now() + 120000) {
      this.#cached = undefined;
      const parsed = this.#parse(
        await this.#run(
          [
            'account',
            'get-access-token',
            '--tenant',
            this.profile.TenantId,
            '--resource',
            resource,
            '--output',
            'json',
            '--only-show-errors'
          ],
          signal
        ),
        before,
        resource
      );
      result = parsed.result;
      this.#expires = parsed.expires;
    }

    if (before !== (await this.#snapshot(signal))) {
      throw authError(
        'ACCOUNT_CHANGED',
        'Azure CLI account/cloud changed during acquisition. Bind again; no token was sent.'
      );
    }

    validateIdentity(this.profile, result, selecting);
    this.#accountUsername = result.accountUsername;
    this.#cached = result;
    this.#cachedResource = resource;
    return result;
  }

  dispose() {
    this.#cached = undefined;
    this.#accountUsername = undefined;
  }
}

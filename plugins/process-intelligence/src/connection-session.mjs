// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BridgeError, Gate, safeFailure } from './errors.mjs';
import { validateName } from './configuration.mjs';
import { StateStore, ProfilePreferences, preferenceScope } from './state.mjs';
import { AzureCliProcess } from './process.mjs';
import { IdentityClient, ProfileTokenProvider } from './authentication.mjs';
import { CorrelationSession } from './correlation.mjs';
import { RemoteBridge } from './bridge.mjs';

export const CONNECTION_TOOLS = [
  {
    name: 'pi_connection_status',
    description: 'Report session connection state and safe recovery guidance. Never signs in or binds an account.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'pi_activate_profile',
    description: 'After explicit user approval for this host and environment, activate a named, configured and bound profile. By default remember it for future sessions of this client/installation. Never signs in or binds an account.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Explicit configured profile name.' },
        remember: { type: 'boolean', default: true }
      },
      required: ['profile'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'pi_deactivate_profile',
    description: 'Disconnect this session and cancel its outstanding requests without logging out of Azure CLI or changing the remembered profile for future sessions. Remote cancellation is not guaranteed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }
];

const localNames = new Set(CONNECTION_TOOLS.map(tool => tool.name));
const activation = z.strictObject({ profile: z.string(), remember: z.boolean().optional() });
const empty = z.strictObject({});
const identityFailures = new Set([
  'PROFILE_CHANGED', 'PROFILE_MISSING', 'STATE_INVALID', 'STATE_ACCESS_DENIED',
  'ACCOUNT_CHANGED', 'TENANT_MISMATCH', 'CLOUD_MISMATCH', 'TOKEN_INVALID',
  'TOKEN_EXPIRED', 'LOGIN_REQUIRED', 'AADSTS_FAILURE', 'CLI_AUTHENTICATION_FAILED',
  'CLAIMS_LOGIN_REQUIRED', 'TOOL_NAME_CONFLICT'
]);
const unavailable = () => new BridgeError(
  'No active connection. Complete setup and explicitly call pi_activate_profile.',
  3,
  'CONNECTION_INACTIVE'
);

export class ConnectionSession {
  #activation = new Gate();
  #shutdown = new AbortController();
  #initialization;
  #active;
  #state = { state: 'setup-required', message: 'Complete setup, then call pi_activate_profile.' };

  constructor({
    store = new StateStore(),
    cli = new AzureCliProcess(),
    profileName,
    installationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env = process.env,
    correlation = new CorrelationSession(),
    fetchImpl,
    reportError = message => process.stderr.write(message + '\n')
  } = {}) {
    Object.assign(this, { store, cli, profileName, installationRoot, env, correlation, fetchImpl, reportError });
    this.localLifecycle = true;
  }

  initialize(client) {
    this.#initialization ??= (async () => {
      try {
        this.preferences = new ProfilePreferences(
          path.join(this.store.root, 'clients'),
          preferenceScope(client, this.installationRoot, this.env)
        );
        // Selection is captured once. Preference changes in other sessions never
        // retarget this session, and an invalid explicit selection never falls back.
        const name = this.profileName ?? await this.preferences.load();
        if (name) {
          await this.#activate(name, false, this.#shutdown.signal, false);
        }
      } catch (error) {
        this.#failure(error);
      }
    })();
    return this.#initialization;
  }

  #failure(error, profile = this.#state.profile) {
    this.#state = {
      state: 'recovery-required',
      ...(profile ? { profile } : {}),
      errorCode: error.errorCode ?? 'CONNECTION_FAILED',
      message: safeFailure(error)
    };
  }

  #status() {
    const state = { ...this.#state };
    return { content: [{ type: 'text', text: JSON.stringify(state) }], structuredContent: state };
  }

  async #dispose(context, reason = unavailable()) {
    context.lifetime.abort(reason);
    context.identity.dispose();
    await context.bridge.close();
  }

  async #invalidate(context, error) {
    if (this.#active !== context) {
      return;
    }
    this.#active = undefined;
    this.#failure(error, context.selected.Name);
    await this.#dispose(context, error);
    await this.toolsChanged?.();
  }

  #checkNames(page) {
    if (page.tools.some(tool => localNames.has(tool.name))) {
      throw new BridgeError(
        'Remote tool name conflicts with a local connection tool. Ask the service owner to resolve the conflict.',
        3,
        'TOOL_NAME_CONFLICT'
      );
    }
    return page;
  }

  async #activate(name, remember, signal, notify = true) {
    validateName(name);
    return this.#activation.run(async () => {
      const requestSignal = AbortSignal.any([this.#shutdown.signal, ...(signal ? [signal] : [])]);
      requestSignal.throwIfAborted();
      const current = this.#active;
      if (current?.selected.Name === name) {
        try {
          await current.tokens.getToken(false, requestSignal);
          if (remember) {
            await this.store.withLock(name, async () => {
              await this.store.ensureCurrent(current.selected);
              requestSignal.throwIfAborted();
              await this.preferences.save(name);
            });
          }
          requestSignal.throwIfAborted();
          return this.#status();
        } catch (error) {
          await this.#invalidate(current, error);
          // This request explicitly selected the profile again. A new revision
          // may therefore be loaded; identity failures never imply rebinding.
          if (error.errorCode !== 'PROFILE_CHANGED') {
            throw error;
          }
        }
      }
      if (current && this.#active === current) {
        this.#active = undefined;
        await this.#dispose(current);
        await this.toolsChanged?.();
      }
      this.#state = { state: 'activating', profile: name };
      let candidate;
      try {
        const selected = await this.store.load(name);
        if (!selected.HomeAccountId) {
          throw new BridgeError(
            'Run login --profile NAME to bind the existing Azure CLI session, then call pi_activate_profile.',
            3,
            'LOGIN_REQUIRED'
          );
        }
        const identity = new IdentityClient(selected, this.cli);
        const tokens = new ProfileTokenProvider(selected, this.store, identity);
        const lifetime = new AbortController();
        const bridge = new RemoteBridge(selected, tokens, {
          correlation: this.correlation,
          fetchImpl: this.fetchImpl,
          checkCurrent: () => this.store.ensureCurrent(selected)
        });
        candidate = { selected, identity, tokens, lifetime, bridge };
        bridge.progress = notification => {
          if (this.#active === candidate && !lifetime.signal.aborted) {
            return this.progress?.(notification);
          }
        };
        this.#checkNames(await bridge.list({}, requestSignal));
        await this.store.withLock(name, async () => {
          await this.store.ensureCurrent(selected);
          requestSignal.throwIfAborted();
          if (remember) {
            await this.preferences.save(name);
          }
          requestSignal.throwIfAborted();
          // Publication is the activation commit point. Tokens stay in this context;
          // a preference contains only the name, never binding or credential data.
          this.#active = candidate;
          this.#state = { state: 'active', profile: name };
        });
        this.#monitor(candidate);
        if (notify) {
          await this.toolsChanged?.();
        }
        return this.#status();
      } catch (error) {
        if (this.#active === candidate) {
          this.#active = undefined;
        }
        if (candidate) {
          await this.#dispose(candidate, error);
        }
        this.#failure(error, name);
        throw error;
      }
    }, signal);
  }

  #monitor(context) {
    const signal = context.lifetime.signal;
    void (async () => {
      try {
        while (!signal.aborted) {
          await delay(250, null, { signal });
          await this.store.ensureCurrent(context.selected);
        }
      } catch (error) {
        if (!signal.aborted) {
          await this.#invalidate(context, error);
        }
      }
    })().catch(error => this.reportError(safeFailure(error)));
  }

  async #request(method, params, signal) {
    const context = this.#active;
    if (!context) {
      throw unavailable();
    }
    const requestSignal = AbortSignal.any([
      context.lifetime.signal, this.#shutdown.signal, ...(signal ? [signal] : [])
    ]);
    try {
      const result = await context.bridge[method](params, requestSignal);
      requestSignal.throwIfAborted();
      await this.store.ensureCurrent(context.selected);
      requestSignal.throwIfAborted();
      return method === 'list' ? this.#checkNames(result) : result;
    } catch (error) {
      if (identityFailures.has(error.errorCode)) {
        await this.#invalidate(context, error);
      }
      throw error;
    }
  }

  async list(params = {}, signal) {
    await this.#initialization;
    if (!this.#active) {
      return { tools: CONNECTION_TOOLS };
    }
    const page = await this.#request('list', params, signal);
    return params.cursor === undefined ? { ...page, tools: [...CONNECTION_TOOLS, ...page.tools] } : page;
  }

  async call(params, signal) {
    await this.#initialization;
    if (localNames.has(params.name)) {
      const parsed = (params.name === 'pi_activate_profile' ? activation : empty)
        .safeParse(params.arguments ?? {});
      if (!parsed.success) {
        throw new BridgeError('Invalid local connection tool arguments.', 2, 'INVALID_ARGUMENTS');
      }
      signal?.throwIfAborted();
      if (params.name === 'pi_activate_profile') {
        return this.#activate(parsed.data.profile, parsed.data.remember !== false, signal);
      }
      if (params.name === 'pi_deactivate_profile') {
        return this.#activation.run(async () => {
          const current = this.#active;
          this.#active = undefined;
          this.#state = { state: 'inactive', message: 'Explicitly activate a profile to reconnect.' };
          if (current) {
            await this.#dispose(current);
            await this.toolsChanged?.();
          }
          return this.#status();
        }, signal);
      }
      return this.#status();
    }
    return this.#request('call', params, signal);
  }

  async close() {
    this.#shutdown.abort(unavailable());
    const current = this.#active;
    this.#active = undefined;
    if (current) {
      await this.#dispose(current);
    }
  }
}

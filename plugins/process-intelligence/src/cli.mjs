// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, invalid as invalidConfiguration, safeFailure } from './errors.mjs';
import { CLIENT_ID, resolveConnection, validateName } from './configuration.mjs';
import { StateStore } from './state.mjs';
import { AzureCliProcess } from './process.mjs';
import { IdentityClient, ProfileTokenProvider, login } from './authentication.mjs';
import { RemoteBridge, serve, MCP_TRANSPORT_MODE } from './bridge.mjs';
import { CorrelationSession } from './correlation.mjs';
import { resolveEnvironment } from './environment-resolution.mjs';

const invalid = message => invalidConfiguration(message, 'INVALID_ARGUMENTS');

export const usage = `Process Intelligence Azure CLI bridge (Node.js 22/24). Diagnostics go to stderr; serve reserves stdout for MCP.
resolve-environment --cloud Public --environment ENVIRONMENT-ID
config --profile NAME --cloud CLOUD --tenant GUID --environment ENVIRONMENT-ID
       [--audience HTTPS-RESOURCE]
login --profile NAME [--sign-in true] [--switch-account true]
logout --profile NAME
diagnostics --profile NAME [--remote true]
serve --profile NAME
Cloud values: Public, Gcc, GccHigh, DoD or Mooncake.
Environment IDs: nonzero GUID, with or without hyphens; optional Default, Legacy or Primary prefix.
Prefixes are case-insensitive and may have a separating hyphen. IDs are canonicalized before use.
Azure CLI 2.54+ is required. Login binds the existing CLI organizational user by default.
Environment discovery reads metadata using the existing CLI session; it does not configure or sign in.
Config remains offline; pass the resolved tenant GUID, or an explicitly confirmed tenant if discovery is unavailable.
--sign-in true explicitly permits tenant-scoped az login in a normal terminal.
Conditional Access / CAE claims challenges require manual sign-in; their payload is not stored or forwarded.
Azure CLI owns shared credentials; logout invalidates only this profile, never az logout.
MCP uses POST-only transport; standalone GET streaming and GET resumption are disabled.
No custom client/browser/redirect options, admin consent or implicit cloud/account switching.`;

function parse(args) {
  const permitted = {
    'resolve-environment': ['cloud', 'environment'],
    config: ['profile', 'cloud', 'tenant', 'environment', 'audience'],
    login: ['profile', 'switch-account', 'sign-in'],
    diagnostics: ['profile', 'remote'],
    logout: ['profile'],
    serve: ['profile']
  };
  const [command, ...rest] = args;
  if (!Object.hasOwn(permitted, command)) {
    throw invalid('Unknown command. Use --help.');
  }
  const options = Object.create(null);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    const value = rest[i + 1];
    if (
      !rest[i].startsWith('--') ||
      !permitted[command].includes(key) ||
      Object.hasOwn(options, key) ||
      typeof value !== 'string' ||
      !value.trim() ||
      value.startsWith('--')
    ) {
      throw invalid(
        'Invalid, duplicate, unknown or missing command option. Use --help' +
          (permitted[command].includes('profile') ? '; an explicit --profile is required.' : '.')
      );
    }
    options[key] = value;
  }
  for (const key of ['sign-in', 'switch-account', 'remote']) {
    if (options[key] !== undefined && !['true', 'false'].includes(options[key])) {
      throw invalid(`--${key} must be true or false.`);
    }
  }
  return { command, options };
}

const required = (options, key) => {
  if (!options[key]) {
    throw invalid(`Missing --${key}. Use --help.`);
  }
  return options[key];
};

async function execute(
  args,
  {
    store,
    cli = new AzureCliProcess(),
    stderr = process.stderr,
    stdout = process.stdout,
    stdin = process.stdin,
    terminalAvailable = !!process.stdin.isTTY,
    signal,
    fetchImpl,
    correlation,
    onReady
  } = {}
) {
  let identity;
  let bridge;
  const write = message => stderr.write(message + '\n');

  try {
    signal?.throwIfAborted();
    if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
      write(usage);
      return args.length ? 0 : 2;
    }

    const { command, options } = parse(args);
    if (command === 'resolve-environment') {
      // Discovery is an explicit setup operation, not MCP startup.
      write(
        JSON.stringify(
          await resolveEnvironment(
            { cloud: required(options, 'cloud'), environmentId: required(options, 'environment') },
            { cli, fetchImpl, signal }
          )
        )
      );
      return 0;
    }

    const name = required(options, 'profile');
    validateName(name);
    store ??= new StateStore();

    if (command === 'config') {
      const configured = {
        Name: name,
        Cloud: required(options, 'cloud'),
        TenantId: required(options, 'tenant'),
        EnvironmentId: required(options, 'environment'),
        Audience: options.audience
      };
      await store.save(configured);
      write('Profile configured; no tokens acquired. Run login --profile before connecting.');
      return 0;
    }

    const selected = await store.load(name);
    if (command === 'logout') {
      await store.save({ ...selected, HomeAccountId: null }, selected.Revision);
      write(
        'Bridge profile signed out and active connections invalidated. Shared Azure CLI credentials and other applications were not changed.'
      );
      return 0;
    }

    identity = new IdentityClient(selected, cli);
    if (command === 'diagnostics' && options.remote !== 'true') {
      const resolved = resolveConnection(selected);
      await identity.checkSession(signal);
      write(
        JSON.stringify({
          cloud: selected.Cloud,
          clientId: CLIENT_ID,
          scope: resolved.scope,
          azureCliCloud: resolved.cliCloud,
          authentication: 'azure-cli',
          transportMode: MCP_TRANSPORT_MODE,
          state: selected.HomeAccountId === null ? 'login-required' : 'account-selected',
          credentialOwner: 'Azure CLI (shared; no bridge disk token cache)',
          sessionChecked: true,
          sessionCheckScope: 'cloud-tenant-user-shape',
          boundAccountVerified: false,
          tokenAcquired: false,
          remoteChecked: false
        })
      );
      return 0;
    }

    if (command === 'login') {
      if (!terminalAvailable) {
        throw new BridgeError(
          'Run login explicitly in a normal user terminal; headless MCP hosts cannot initiate or bind sign-in.',
          3,
          'LOGIN_REQUIRED'
        );
      }
      write(
        options['sign-in'] === 'true'
          ? 'Starting explicit Azure CLI sign-in; this can update its shared session. Complete browser interaction within five minutes. For device-code input, run az login directly in your terminal.'
          : 'Binding the existing Azure CLI organizational session; no sign-in UI will be opened.'
      );
      await login(selected, store, identity, {
        switchAccount: options['switch-account'] === 'true',
        signIn: options['sign-in'] === 'true',
        signal
      });
      write(
        'TOKEN_ACQUIRED: selected user/tenant bound. Credentials remain owned by Azure CLI; MCP authorization is not yet verified.'
      );
      return 0;
    }

    if (!selected.HomeAccountId) {
      throw new BridgeError(
        'Run login --profile first to select and bind an account and tenant.',
        3,
        'LOGIN_REQUIRED'
      );
    }

    const tokens = new ProfileTokenProvider(selected, store, identity);
    bridge = new RemoteBridge(selected, tokens, {
      correlation,
      fetchImpl,
      checkCurrent: () => store.ensureCurrent(selected)
    });

    if (command === 'diagnostics') {
      write(
        `MCP_TRANSPORT: ${MCP_TRANSPORT_MODE}; standalone GET streaming and GET resumption are disabled.`
      );
      await tokens.getToken(false, signal);
      write('TOKEN_ACQUIRED: silent token acquisition succeeded for the configured resource.');
      let cursor;
      let count = 0;
      const seen = new Set();
      do {
        const page = await bridge.list(cursor === undefined ? {} : { cursor }, signal);
        count += page.tools.length;
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (seen.has(cursor) || seen.size >= 1000) {
            throw new BridgeError(
              'Remote tool pagination is cyclic or exceeds 1000 pages; discovery stopped.'
            );
          }
          seen.add(cursor);
        }
      } while (cursor !== undefined);
      write(
        `MCP_INITIALIZE_AND_LIST_OK: ${count} remote tools discovered. No business tools were called.`
      );
      return 0;
    }

    const lifetime = new AbortController();
    const stop = () => lifetime.abort(signal.reason);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) {
      stop();
    }

    let invalidated = false;
    const monitor = (async () => {
      try {
        while (!lifetime.signal.aborted) {
          await delay(250, null, { signal: lifetime.signal });
          await store.ensureCurrent(selected);
        }
      } catch (error) {
        if (!lifetime.signal.aborted) {
          invalidated = true;
          write(safeFailure(error));
          lifetime.abort(error);
        }
      }
    })();

    try {
      await serve(bridge, { signal: lifetime.signal, stdin, stdout, stderr, onReady });
    } finally {
      lifetime.abort();
      await monitor;
      signal?.removeEventListener('abort', stop);
    }
    return signal?.aborted || invalidated ? 130 : 0;
  } catch (error) {
    write(safeFailure(error));
    return signal?.aborted || error?.name === 'AbortError'
      ? 130
      : error instanceof BridgeError
        ? error.exitCode
        : 4;
  } finally {
    identity?.dispose();
    await bridge?.close();
  }
}

export async function run(args, options = {}) {
  const correlation = options.correlation ?? new CorrelationSession();
  return correlation.request(() => execute(args, { ...options, correlation }));
}

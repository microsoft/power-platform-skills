// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ErrorCode,
  isJSONRPCErrorResponse
} from '@modelcontextprotocol/sdk/types.js';
import { authenticatedFetch } from './http-auth.mjs';
import { resolveConnection } from './configuration.mjs';
import { BridgeError, TransportError, Gate, safeFailure, abortable } from './errors.mjs';
import { CorrelationSession } from './correlation.mjs';
import { adaptTool, OPERATION_POLICY } from './tool-contracts.mjs';
import manifest from '../package.json' with { type: 'json' };

export const MCP_TRANSPORT_MODE = 'post-only';

// Validate with the official schemas, but return the original wire value. Parsing into
// the SDK's convenience models strips unknown nested tool/content extension fields.
const preserve = schema =>
  z.unknown().superRefine((value, ctx) => {
    if (!schema.safeParse(value).success) {
      ctx.addIssue({ code: 'custom', message: 'Invalid remote MCP result.' });
    }
  });

const listResult = preserve(ListToolsResultSchema);
const callResult = preserve(CallToolResultSchema);

const notificationSchema = method =>
  z.looseObject({ method: z.literal(method), params: z.looseObject({}).optional() });

const transient = error =>
  (error instanceof TransportError &&
    (error.status === undefined || error.status === 408 || error.status >= 500)) ||
  (error instanceof McpError && error.code === ErrorCode.RequestTimeout);

const protocolFailure = error =>
  error instanceof RemoteProtocolError ||
  (error instanceof McpError &&
    ![ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code));

class RemoteProtocolError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

// Observe already-parsed SDK messages, not raw JSON. This preserves wire code/data
// before McpError.fromError can reinterpret reserved codes or elicitation payloads.
export class ObservedTransport {
  #owners = new Map();

  constructor(inner, correlation) {
    this.inner = inner;
    this.correlation = correlation;
  }

  get sessionId() {
    return this.inner.sessionId;
  }

  set onclose(handler) {
    this.inner.onclose = () => {
      this.#owners.clear();
      this.correlation.sessionOnly(() => handler?.());
    };
  }

  set onerror(handler) {
    this.inner.onerror = error => this.correlation.sessionOnly(() => handler?.(error));
  }

  set onmessage(handler) {
    this.inner.onmessage = (message, extra) => {
      if (isJSONRPCErrorResponse(message) && message.id === this.requestId) {
        this.remoteError = new RemoteProtocolError(message.error);
      }
      if (message.id !== undefined && !message.method) {
        this.#owners.delete(message.id);
      }
      this.correlation.sessionOnly(() => handler?.(message, extra));
    };
  }

  start() {
    return this.inner.start();
  }

  close() {
    this.#owners.clear();
    return this.correlation.sessionOnly(() => this.inner.close());
  }

  setProtocolVersion(version) {
    this.inner.setProtocolVersion(version);
  }

  send(message, options) {
    let owner = this.correlation.sessionOwner;
    if (message.id !== undefined && message.method) {
      this.requestId = message.id;
      this.remoteError = undefined;
      owner = this.correlation.capture();
      this.#owners.set(message.id, owner);
    } else if (message.method === 'notifications/cancelled') {
      owner = this.#owners.get(message.params?.requestId) ?? owner;
      this.#owners.delete(message.params?.requestId);
    } else if (message.method === 'notifications/initialized') {
      owner = this.correlation.capture();
    }
    return this.correlation.run(owner, () => this.inner.send(message, options));
  }
}

export class RemoteBridge {
  #gate = new Gate();
  #connection;

  constructor(
    profile,
    tokens,
    {
      fetchImpl = globalThis.fetch,
      checkCurrent = async () => {},
      timeout = 300000,
      connectTimeout = 30000,
      correlation = new CorrelationSession()
    } = {}
  ) {
    Object.assign(this, {
      profile,
      tokens,
      fetchImpl,
      checkCurrent,
      timeout,
      connectTimeout,
      correlation
    });
  }

  async #disconnect() {
    const previous = this.#connection;
    this.#connection = undefined;
    if (previous) {
      previous.dead = true;
      await previous.client.close();
    }
  }

  async #connect(signal) {
    signal?.throwIfAborted();
    await this.checkCurrent();
    if (this.#connection && !this.#connection.dead) {
      return this.#connection;
    }
    await this.#disconnect();
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const endpoint = resolveConnection(this.profile).endpoint;
      const transport = new ObservedTransport(
        new StreamableHTTPClientTransport(new URL(endpoint), {
          fetch: authenticatedFetch(
            endpoint,
            (force, requestSignal) => this.tokens.getToken(force, requestSignal),
            this.fetchImpl,
            { correlation: this.correlation, transportMode: MCP_TRANSPORT_MODE }
          ),
          reconnectionOptions: { maxRetries: 0 }
          // No authProvider: no SDK OAuth discovery, sign-in, upscope or automatic auth replay.
        }),
        this.correlation
      );
      const client = new Client(
        { name: 'local-process-intelligence-bridge', version: manifest.version },
        { capabilities: {} }
      );
      const connection = { client, transport, dead: false, failure: null };
      this.#connection = connection;
      client.onclose = () => {
        connection.dead = true;
      };
      client.onerror = error => {
        connection.failure =
          error instanceof BridgeError || error instanceof TransportError
            ? error
            : new TransportError();
        connection.dead = true;
        void client.close();
      };
      client.setNotificationHandler(notificationSchema('notifications/progress'), value =>
        this.progress?.(value)
      );
      const deadline = new AbortController();
      const connecting = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const timer = setTimeout(
        () => deadline.abort(new TransportError(408, 'MCP_INITIALIZE_TIMEOUT')),
        this.connectTimeout
      );
      const abort = () => {
        void client.close();
      };
      connecting.addEventListener('abort', abort, { once: true });
      try {
        await abortable(
          client.connect(transport, { signal: connecting, timeout: this.connectTimeout }),
          connecting
        );
        connecting.throwIfAborted();
        if (connection.dead) {
          throw connection.failure ?? new TransportError();
        }
        return connection;
      } catch (error) {
        const failure = connecting.aborted
          ? connecting.reason
          : (transport.remoteError ?? connection.failure ?? error);
        await this.#disconnect();
        signal?.throwIfAborted();
        if (attempt === 0 && transient(failure)) {
          continue;
        }
        throw failure;
      } finally {
        clearTimeout(timer);
        connecting.removeEventListener('abort', abort);
      }
    }
    throw new TransportError();
  }

  async #request(method, params, schema, signal) {
    return this.#gate.run(async () => {
      let connection;
      const abort = () => {
        if (connection) {
          void connection.client.close();
        }
      };
      try {
        connection = await this.#connect(signal);
        connection.transport.remoteError = undefined;
        connection.transport.requestId = undefined;
        signal?.addEventListener('abort', abort, { once: true });
        signal?.throwIfAborted();
        return await connection.client.request({ method, params }, schema, {
          signal,
          timeout: this.timeout
        });
      } catch (error) {
        const failure = connection?.transport.remoteError ?? connection?.failure ?? error;
        if (signal?.aborted || !protocolFailure(failure)) {
          await this.#disconnect();
        }
        signal?.throwIfAborted();
        throw failure;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }, signal);
  }

  async list(params = {}, signal) {
    const result = await this.#request('tools/list', params, listResult, signal);
    return { ...result, tools: result.tools.map(adaptTool) };
  }

  async call(params, signal) {
    signal?.throwIfAborted();
    return this.#request('tools/call', params, callResult, signal);
  }

  async close() {
    await this.#disconnect();
  }
}

export function createBridgeServer(bridge, { signal: lifetime } = {}) {
  const server = new Server(
    { name: 'local-process-intelligence-bridge', version: manifest.version },
    {
      capabilities: { tools: bridge.localLifecycle ? { listChanged: true } : {} },
      instructions:
        'Discover tools at the start of each MCP session. ' +
        'Never invent tool names, schemas or process IDs. ' +
        'Advertised input schemas take precedence over conflicting remote examples; never add undocumented parameters. ' +
        OPERATION_POLICY +
        ' Cancellation stops this request, not necessarily the remote operation; use a discovered cancellation tool only with user approval. ' +
        'Authorization is enforced by the remote service.'
    }
  );
  // The official low-level fallback API avoids Server.setRequestHandler's destructive
  // tools/call result conversion. The SDK still owns framing, cancellation and errors.
  server.fallbackRequestHandler = async (request, extra) => {
    const schema =
      request.method === 'tools/list'
        ? ListToolsRequestSchema
        : request.method === 'tools/call'
          ? CallToolRequestSchema
          : null;
    if (!schema) {
      throw new McpError(ErrorCode.MethodNotFound, 'Method not supported by this tools bridge.');
    }
    const signal =
      lifetime && extra.signal
        ? AbortSignal.any([lifetime, extra.signal])
        : (lifetime ?? extra.signal);
    try {
      await bridge.initialize?.(server.getClientVersion());
      return await bridge.correlation.request(async () => {
        if (!schema.safeParse(request).success || request.params?.task !== undefined) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid tool request; task-augmented execution is not advertised.'
          );
        }
        return request.method === 'tools/list'
          ? await bridge.list(request.params ?? {}, signal)
          : await bridge.call(request.params, signal);
      });
    } catch (error) {
      if (protocolFailure(error)) {
        throw error;
      }
      throw new McpError(ErrorCode.InternalError, safeFailure(error));
    }
  };
  bridge.progress = notification => server.notification(notification);
  if (bridge.localLifecycle) {
    bridge.toolsChanged = () => server.sendToolListChanged();
  }
  return server;
}

export async function serve(
  bridge,
  { signal, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, onReady } = {}
) {
  signal?.throwIfAborted();
  const shutdown = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
  const server = createBridgeServer(bridge, { signal: lifetime });
  server.onerror = error => {
    stderr.write(safeFailure(error) + '\n');
  };
  const transport = new StdioServerTransport(stdin, stdout);
  let finish;
  const ended = new Promise(resolve => {
    finish = resolve;
  });
  const stop = () => {
    shutdown.abort(new DOMException('Session ended.', 'AbortError'));
    finish();
  };
  stdin.once('end', stop);
  signal?.addEventListener('abort', stop, { once: true });
  server.onclose = stop;
  try {
    await server.connect(transport);
    onReady?.();
    if (stdin.readableEnded || signal?.aborted) {
      stop();
    }
    await ended;
  } finally {
    stdin.off('end', stop);
    signal?.removeEventListener('abort', stop);
    bridge.progress = null;
    await server.close();
    await bridge.close();
  }
}

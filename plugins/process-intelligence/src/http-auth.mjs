// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BridgeError, TransportError } from './errors.mjs';

const PLUGIN_CLIENT_REQUEST_ID = '11111111-1111-1111-1111-111111111111';

/** @param {string} endpoint @param {(force:boolean,signal?:AbortSignal)=>Promise<string>} token */
export function authenticatedFetch(
  endpoint,
  token,
  fetchImpl = globalThis.fetch,
  { correlation, transportMode = 'streamable-http' } = {}
) {
  if (!['streamable-http', 'post-only'].includes(transportMode)) {
    throw new BridgeError('Unsupported MCP transport mode.', 2, 'INVALID_CONFIGURATION');
  }
  return async (input, init) => {
    const original = new Request(input, init);
    if (
      !endpoint.startsWith('https://') ||
      new URL(endpoint).username ||
      original.url !== endpoint ||
      (original.headers.has('host') &&
        original.headers.get('host').toLowerCase() !== new URL(endpoint).host.toLowerCase())
    ) {
      throw new BridgeError(
        'Refusing to send a token outside the configured HTTPS MCP endpoint.',
        3,
        'ENDPOINT_REJECTED'
      );
    }
    original.signal.throwIfAborted();
    if (transportMode === 'post-only' && original.method === 'GET') {
      if (original.headers.has('last-event-id')) {
        throw new BridgeError(
          'MCP stream resumption via GET is unavailable in POST-only mode; uncertain calls were not replayed.',
          4,
          'MCP_RESUMPTION_UNSUPPORTED'
        );
      }
      if (original.headers.get('accept')?.trim().toLowerCase() !== 'text/event-stream') {
        throw new BridgeError(
          'MCP GET requests are unavailable in POST-only mode.',
          4,
          'MCP_GET_UNSUPPORTED'
        );
      }
      // SDK 1.30.0 probes GET + Accept: text/event-stream after initialized202.
      // Explicit POST-only policy answers locally, before auth/network; it never
      // translates a real 404 (which can mean an invalid route or expired session).
      // The SDK treats 405 as unsupported standalone SSE; POST SSE remains enabled.
      // https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#listening-for-messages-from-the-server
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    }
    const owner = original.method === 'POST' ? correlation?.capture() : correlation?.sessionOwner;
    for (let attempt = 0; attempt < 2; attempt++) {
      original.signal.throwIfAborted();
      const outgoing = new Request(original.clone(), {
        redirect: 'manual',
        signal: original.signal
      });
      // Shared plugin marker, deliberately not a unique request correlation ID.
      outgoing.headers.set('x-ms-client-request-id', PLUGIN_CLIENT_REQUEST_ID);
      if (correlation) {
        outgoing.headers.set('x-ms-client-session-id', correlation.clientSessionId);
      }
      const acquire = () => token(attempt !== 0, original.signal);
      const accessToken = owner?.clientRequestId
        ? await acquire()
        : correlation
          ? await correlation.sessionOnly(acquire)
          : await acquire();
      outgoing.headers.set('authorization', `Bearer ${accessToken}`);
      let response;
      try {
        response = await fetchImpl(outgoing);
      } catch (error) {
        if (original.signal.aborted) {
          throw original.signal.reason;
        }
        throw error instanceof BridgeError ? error : new TransportError();
      }
      if (response.status === 401) {
        // Detect e.g. Bearer error="insufficient_claims", claims="..." only to
        // explain the failure. Never decode, log, persist or forward its payload.
        // https://learn.microsoft.com/en-us/entra/identity-platform/claims-challenge
        const challenged = /insufficient_claims|\bclaims\s*=/i.test(
          response.headers.get('www-authenticate') ?? ''
        );
        await response.body?.cancel();
        if (challenged) {
          throw new BridgeError(
            'MCP returned a Conditional Access / Continuous Access Evaluation (CAE) claims challenge. ' +
              'Sign in again with login --profile NAME --sign-in true in a normal terminal, then call pi_activate_profile. ' +
              'If the problem persists, ask your administrator to review the policy; this is not evidence of a wrong tenant.',
            3,
            'CLAIMS_LOGIN_REQUIRED'
          );
        }
        if (attempt === 0) {
          continue;
        }
        throw new BridgeError(
          'MCP returned HTTP 401 after token reacquisition. Check client grants/audience and run login; no identity or resource was substituted.',
          3,
          'HTTP_FAILURE'
        );
      }
      if ((response.status >= 300 && response.status < 400) || response.status === 403) {
        await response.body?.cancel();
        throw new BridgeError(
          `MCP returned HTTP ${response.status}. Redirects are blocked; verify route, permissions and deployment.`,
          3,
          response.status === 403 ? 'HTTP_FAILURE' : 'REDIRECT_BLOCKED'
        );
      }
      if (!response.ok && !(original.method === 'GET' && response.status === 405)) {
        await response.body?.cancel();
        throw new TransportError(response.status);
      }
      return response;
    }
    throw new BridgeError('Authentication retry bound exceeded.');
  };
}

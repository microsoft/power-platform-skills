// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const richTool = { name: 'fixture_query', description: 'Synthetic fixture', inputSchema: { type: 'object',
  properties: { value: { type: ['string', 'null'] } }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { answer: { type: 'number' } } },
  annotations: { readOnlyHint: true, custom: 'preserved' }, _meta: { vendor: 'test' }, vendor: { extra: true } };
export const richResult = { content: [{ type: 'text', text: 'fixture', _meta: { fixture: true }, vendor: 'kept' },
  { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }, { type: 'audio', data: 'ZmFrZQ==', mimeType: 'audio/wav' },
  { type: 'resource_link', name: 'fixture', uri: 'fixture://synthetic' },
  { type: 'resource', resource: { uri: 'fixture://text', text: 'fixture', mimeType: 'text/plain' } }],
  structuredContent: { answer: 42, nested: { a: 1 } }, isError: true, _meta: { vendor: 'result' }, vendor: 'kept' };
export const contractTools = [
  { ...richTool, name: 'get_operation_result',
    description: 'After six polls retry the original operation later with the same parameters; completed results are cached.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] } },
  { ...richTool, name: 'get_custom_metric_language_reference',
    description: 'Use exact functionNames for overloads.',
    inputSchema: { type: 'object', properties: {
      search: { type: 'string', maxLength: 512 }, category: { enum: ['Math', 'Other', null] },
      index: { type: 'boolean', default: false, description: 'Do not combine with functionNames.' },
      cursor: { type: 'string', description: 'Repeat functionNames with this cursor.' }
    } } },
  { ...richTool, name: 'get_cases_with_metrics_v2',
    inputSchema: { type: 'object', properties: { processId: { type: 'string' }, filterOptions: { type: 'object' },
      metricToSortBy: { type: 'string', enum: ['Index', 'Name', 'Duration'], default: 'Duration', vendor: 'keep' },
      sortOrder: { enum: ['Ascending', 'Descending'] }, itemsPerPage: { type: 'integer' }, itemsToSkip: { type: 'integer' } } } },
  richTool
];
export class FakeRemote {
  sessions = new Map(); requests = []; servers = []; initializeFailures = []; tools = [richTool]; result = richResult;
  getRequests = []; responses = [];
  calls = 0; lists = 0; initializations = 0; callFailure; duringList; duringCall; latest;
  constructor({ stateless = false, postOnly = false, enableJsonResponse = false } = {}) {
    Object.assign(this, { stateless, postOnly, enableJsonResponse });
  }
  async fetch(request) {
    if (request.method === 'GET') {
      this.getRequests.push(request);
      if (this.postOnly) return Response.json({ error: { code: 'RouteNotFound' } }, { status: 404 });
      const session = this.sessions.get(request.headers.get('mcp-session-id'));
      return session ? session.transport.handleRequest(request) : new Response('', { status: 405 });
    }
    const message = await request.clone().json();
    this.requests.push({ message, headers: new Headers(request.headers) });
    if (message.method === 'initialize') {
      this.initializations++;
      const status = this.initializeFailures.shift();
      if (status) return new Response('private raw auth/transport details', { status });
    }
    let session = this.sessions.get(request.headers.get('mcp-session-id'));
    if (!session) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: this.stateless ? undefined : randomUUID, enableJsonResponse: this.enableJsonResponse
      });
      const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } });
      server.fallbackRequestHandler = async (req, extra) => {
        if (req.method === 'tools/list') {
          this.lists++; await this.duringList?.(server, req, extra);
          return { tools: this.tools, ...(req.params?.cursor ? {} : { nextCursor: 'upstream-cursor' }), _meta: { fixture: 'page' } };
        }
        if (req.method === 'tools/call') {
          this.calls++; await this.duringCall?.(server, req, extra);
          if (this.callFailure instanceof Error) throw this.callFailure;
          return this.result;
        }
        throw new McpError(ErrorCode.MethodNotFound, 'Fixture method missing', { fixture: 'data' });
      };
      // Exercise negotiation and request headers for service protocol 2025-06-18.
      const { InitializeRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
      server.setRequestHandler(InitializeRequestSchema, () => ({
        protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' }
      }));
      await server.connect(transport); session = { server, transport }; this.servers.push(session); this.latest = session;
    }
    if (message.method === 'tools/call' && this.callFailure === 'transport') throw new Error('private socket failure');
    const response = await session.transport.handleRequest(request);
    this.responses.push({ method: message.method, status: response.status, contentType: response.headers.get('content-type') });
    if (session.transport.sessionId) this.sessions.set(session.transport.sessionId, session);
    return response;
  }
  async close() { await Promise.all(this.servers.map(s => s.server.close())); }
}

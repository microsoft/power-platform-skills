'use strict';

// Minimal HTTP mock for Dataverse OData responses used by integration tests.
//
// Built once per test: give it a map of URL-path → response body (or a handler
// function that returns { statusCode, body }). Start it, use the URL it binds
// to, stop it when done.
//
// Why this exists: `discover-site-components.js`, `resolve-target-solution.js`,
// and `estimate-solution-size.js` are exercised via unit tests with injected
// makeRequest, but the real code paths go through Node's https module + an
// actual URL. An integration test running against a real HTTP surface catches
// regressions like accidental URL-encoding bugs, missing Authorization header
// handling, and token-refresh patterns that injected-mock tests can't surface.

const http = require('http');

/**
 * Starts a localhost http server that responds to OData-like requests.
 *
 * @param {Array<{
 *   matcher: string | RegExp | ((req) => boolean),
 *   status?: number,
 *   headers?: object,
 *   body?: any
 * } | ((req) => any)>} routes
 *   Each route either matches by path fragment (string), regex, or predicate.
 *   `body` can be a plain object (serialized to JSON) or a function that
 *   receives the request and returns a body.
 * @returns {Promise<{ baseUrl: string, port: number, close: () => Promise<void>, calls: Array }>}
 */
async function startMock(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = req.url;
    const authHeader = req.headers.authorization;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url, authorization: authHeader, body });
      for (const route of routes) {
        const match =
          typeof route === 'function'
            ? route({ method: req.method, url, body })
            : routeMatches(route, req.method, url);
        if (match) {
          const r = typeof route === 'function' ? route({ method: req.method, url, body }) : route;
          const status = r.status || 200;
          const respBody =
            typeof r.body === 'function'
              ? r.body({ method: req.method, url, body })
              : r.body || {};
          const headers = { 'Content-Type': 'application/json', ...(r.headers || {}) };
          res.writeHead(status, headers);
          res.end(typeof respBody === 'string' ? respBody : JSON.stringify(respBody));
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Mock: no route matched ${req.method} ${url}` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function routeMatches(route, method, url) {
  if (route.method && route.method !== method) return false;
  const m = route.matcher;
  if (typeof m === 'string') return url.includes(m);
  if (m instanceof RegExp) return m.test(url);
  if (typeof m === 'function') return m({ method, url });
  return false;
}

module.exports = { startMock };

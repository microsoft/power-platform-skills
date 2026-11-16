import { readFile } from 'node:fs/promises';
import { confinedPath } from './paths.mjs';
import { getBrowser } from './browser-checks.mjs';

export async function inspectServerLogic({ spec, workDir, signal }) {
  const server = await readFile(await confinedPath(workDir, spec.server), 'utf8');
  const client = await readFile(await confinedPath(workDir, spec.client), 'utf8');
  if ([server, client].some(source => Buffer.byteLength(source) > 512_000)) throw new Error('Server logic evidence too large');
  const context = await (await getBrowser()).newContext({
    serviceWorkers: 'block', permissions: [], acceptDownloads: false,
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void context.close(); }, 5000);
  const abort = () => { void context.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // Agent-authored JS runs only inside sandboxed Chromium, never Node's vm or
    // a host subprocess. No host bindings, credentials, or real requests exist.
    await context.route('**/*', route => route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', route => route.close());
    const page = await context.newPage();
    return await page.evaluate(async ({ server, client, exercise }) => {
      const checks = [];
      const add = (name, passed) => checks.push({ name, passed: Boolean(passed) });
      const domainFailure = value => {
        if (typeof value !== 'string') return false;
        let payload;
        try { payload = JSON.parse(value); }
        catch { return false; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
        const status = payload.statusCode ?? payload.StatusCode ?? payload.status;
        return payload.success === false || payload.ok === false || payload.valid === false ||
          (typeof status === 'string' && ['error', 'failed', 'failure'].includes(status.toLowerCase())) ||
          (typeof status === 'number' && status >= 400 && status <= 599) ||
          (typeof payload.error === 'string' && payload.error.trim().length > 0) ||
          (typeof payload.error?.message === 'string' && payload.error.message.trim().length > 0) ||
          (Array.isArray(payload.errors) && payload.errors.length > 0);
      };
      const scenarios = exercise === 'sum'
        ? [
          { name: 'numeric strings', query: { a: '2.5', b: '-1' }, expected: 1.5 },
          { name: 'zero is valid', query: { a: '0', b: '4' }, expected: 4 },
          ...['a', 'b'].flatMap(field => ['', ' ', 'nope', 'Infinity', '1x'].map(value => ({
            name: `invalid ${field} ${JSON.stringify(value)}`, query: { a: '2', b: '3', [field]: value }, error: true,
          }))),
          { name: 'missing input', query: { b: '3' }, error: true },
          { name: 'missing second input', query: { a: '2' }, error: true },
        ]
        : [
          { name: 'provider value A', query: { latitude: '0', longitude: '12' }, temperature: 7.25 },
          { name: 'provider value B', query: { latitude: '-23', longitude: '0' }, temperature: -4.5 },
          { name: 'provider zero value', query: { latitude: '90', longitude: '180' }, temperature: 0, status: 201 },
          { name: 'provider unavailable', query: { latitude: '10', longitude: '12' }, status: 503, temperature: 19.8, error: true },
          { name: 'malformed provider body', query: { latitude: '10', longitude: '12' }, malformed: true, error: true },
          { name: 'missing provider value', query: { latitude: '10', longitude: '12' }, missing: true, error: true },
          ...['', ' ', 'bad', '91'].map(latitude => ({
            name: `invalid latitude ${JSON.stringify(latitude)}`, query: { latitude, longitude: '12' }, error: true, noProvider: true,
          })),
          ...['', ' ', 'bad', '181'].map(longitude => ({
            name: `invalid longitude ${JSON.stringify(longitude)}`, query: { latitude: '10', longitude }, error: true, noProvider: true,
          })),
          { name: 'missing latitude', query: { longitude: '12' }, error: true, noProvider: true },
          { name: 'missing longitude', query: { latitude: '10' }, error: true, noProvider: true },
        ];
      for (const scenario of scenarios) {
        let providerCalls = 0;
        let providerCoordinates = false;
        const status = scenario.status ?? 200;
        // This is the explicitly supplied synthetic adapter, not a claim about
        // every preview SDK version: status metadata plus a JSON Content string.
        const Server = {
          Context: { QueryParameters: scenario.query },
          Logger: { Log: () => {}, Error: () => {}, Info: () => {}, Warn: () => {} },
          Sitesetting: { get: () => 'https://weather.example.invalid/current' },
          Connector: { HttpClient: { GetAsync: async url => {
            providerCalls++;
            const parsed = new URL(url);
            providerCoordinates = parsed.hostname === 'weather.example.invalid' &&
              parsed.searchParams.has('latitude') && parsed.searchParams.has('longitude') &&
              Number(parsed.searchParams.get('latitude')) === Number(scenario.query.latitude) &&
              Number(parsed.searchParams.get('longitude')) === Number(scenario.query.longitude);
            return {
              StatusCode: status, IsSuccessStatusCode: status >= 200 && status < 300,
              Content: scenario.malformed ? '{bad' : JSON.stringify(scenario.missing ? {} : {
                current: { temperature_2m: scenario.temperature },
              }),
            };
          } } },
        };
        let envelope;
        let handlerRejected = false;
        try {
          const handler = new Function('Server', `${server}\nreturn get;`)(Server);
          const value = await handler();
          add(`${scenario.name}: handler returns a string`, typeof value === 'string');
          envelope = { success: true, data: value, error: null, requestId: 'synthetic-request' };
        } catch {
          handlerRejected = true;
          envelope = { success: false, data: null, error: 'Endpoint failed', requestId: 'synthetic-request' };
        }
        // Client validation can reject before fetch, so client failure alone
        // cannot prove that the server enforces the same boundary.
        if (scenario.error) add(`${scenario.name}: handler rejects invalid outcome`,
          handlerRejected || domainFailure(envelope.data));
        let csrf = false;
        let endpointCalls = 0;
        const fetch = async (url, options = {}) => {
          if (String(url) === '/_layout/tokenhtml') {
            return new Response('<input name="__RequestVerificationToken" value="synthetic-csrf">');
          }
          const parsed = new URL(String(url), 'https://portal.example.invalid');
          const headers = new Headers(options.headers);
          csrf = headers.get('__RequestVerificationToken') === 'synthetic-csrf';
          endpointCalls++;
          if (parsed.pathname !== `/_api/serverlogics/${exercise === 'sum' ? 'sum' : 'weather'}`) {
            return new Response('{}', { status: 404 });
          }
          const expected = new URLSearchParams(scenario.query);
          const sameQuery = [...expected].every(([key, value]) => parsed.searchParams.get(key) === value);
          if (!sameQuery) return new Response('{}', { status: 400 });
          return new Response(JSON.stringify(envelope), { status: 200 });
        };
        let value;
        let failed = false;
        try {
          const loadResult = new Function('fetch', `${client}\nreturn loadResult;`)(fetch);
          value = await loadResult(scenario.query);
        } catch { failed = true; }
        const field = exercise === 'sum' ? 'sum' : 'temperatureC';
        add(`${scenario.name}: end-to-end outcome`, scenario.error
          ? failed : !failed && value?.[field] === (scenario.expected ?? scenario.temperature));
        if (!scenario.error) {
          let payload;
          try { payload = JSON.parse(envelope.data); }
          catch { payload = null; }
          // A client can recompute the expected result, so its output cannot
          // establish that the independently callable endpoint returns correct data.
          add(`${scenario.name}: handler response preserves requested result`,
            !handlerRejected && !domainFailure(envelope.data) &&
            payload?.[field] === (scenario.expected ?? scenario.temperature));
          add(`${scenario.name}: authenticated frontend call`, endpointCalls === 1 && csrf);
          if (exercise === 'weather') add(`${scenario.name}: requested provider queried`, providerCalls === 1 && providerCoordinates);
        }
        if (scenario.noProvider) add(`${scenario.name}: rejected before provider call`, providerCalls === 0);
      }
      // Transport failures and a malformed platform envelope must also fail at
      // the client boundary, independently of server domain-error handling.
      for (const [name, response] of [
        ['HTTP error', () => Response.json({
          success: true, data: JSON.stringify({ sum: 3, temperatureC: 19.8 }),
        }, { status: 502 })],
        ['platform error', () => Response.json({ success: false, data: null, error: 'denied' })],
        ['malformed envelope', () => Response.json({ success: true })],
      ]) {
        let failed = false;
        try {
          const loadResult = new Function('fetch', `${client}\nreturn loadResult;`)(async url =>
            String(url) === '/_layout/tokenhtml'
              ? new Response('<input name="__RequestVerificationToken" value="synthetic-csrf">') : response());
          await loadResult(exercise === 'sum' ? { a: '1', b: '2' } : { latitude: '10', longitude: '12' });
        } catch { failed = true; }
        add(`${name}: client surfaces failure`, failed);
      }
      return checks;
    }, { server, client, exercise: spec.exercise });
  } catch (error) {
    signal?.throwIfAborted();
    if (timedOut) return [{ name: 'bounded server/frontend execution', passed: false }];
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await context.close();
  }
}

'use strict';
// The class gate for service text in commandStates' messages. The design keeps ETags, digests, handlers and raw responses out of the
// feature's halts and journals, and the service's answers can carry any of them in any string: an error's code or message, a next-page link,
// any field of a row. Each case below plants ONE marker that looks like a row version into ONE string position of ONE answer the feature reads,
// in one phase, and proves the marker reaches none of: the halt, the console lines (warnings and log, the result lines among them), a
// verify detail, the listing's output, build-log.jsonl, build-status.json. Every message about an answer is worded by one formatter
// (lib/command-state-contract.js serviceAnswerText) from checked values only, so the gate holds for any position; a path that copies service
// text again fails the case that reaches it.
//
// The phases:
//   preflight  a build armed after its dry run: every read from its preflight on is planted
//   final      a build armed when its table is published, after the row was written and acknowledged: the final completion proof's reads
//   write      the row PATCH's answer
//   listing    list-command-states.js, its output as the command line emits it
//   verify     verifyCommandStates, each declared row's detail
//   publish    the table publication's answer: the before-app envelope's plain PublishXml and the managed publisher's publish of a table a
//              managed group routes (lib/managed-scope-publisher.js), both answered to the build's own Dataverse client and not the org; the
//              SDK's refusal of the reconciled table's publication that follows a refused envelope, and of its settle after the final halt
//              (`fallback`); the publish phase's SDK publication of a table (`phase8`); and the managed publisher's client failing before the
//              request is dispatched (`managed-predispatch`)
//
// The one carve-out is the button's caption (`buttonlabeltext`), which the design shows to a maker: in the listing's `commands[].caption`
// and in the approval display (console only, never journaled). A planted caption may appear there, as exactly what was read, and nowhere else.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const realHttp = require('../lib/sdk-http-client.js');
const { createCommandStateOrg, commandRow, json, ORIGIN, SELECT_ALL } = require('./helpers/command-state-org.js');
const { T, MD, ROW, specFor, harness, buildWithJournal } = require('./helpers/command-state-build-harness.js');
const { createCommandStateTransport } = require('../lib/command-state-transport.js');
const { verifyCommandStates } = require('../lib/command-state-read.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { openManagedContext } = require('../lib/managed-bindings.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const MARKER = 'review-service-message W/"498763"';
const TAINT = /review-service-message|498763/;
const LISTING = path.resolve(__dirname, '..', 'list-command-states.js');
const apiOf = (req) => /^(.*\/api\/data\/v9\.\d+)/.exec(req.url)[1];
const isGet = (req) => req.method === 'GET';

// Each answer the feature reads, by the request that asks for it.
const RESOURCES = {
  app: { match: (r) => isGet(r) && r.path.startsWith('/appmodules?'), list: true, fields: ['appmoduleid', 'uniquename'] },
  layer: { match: (r) => isGet(r) && r.path.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'), list: true, fields: ['appmoduleid', 'appmoduleidunique', 'componentstate'] },
  components: { match: (r) => isGet(r) && r.path.startsWith('/appmodulecomponents?'), list: true, fields: ['objectid', 'componenttype'] },
  table: { match: (r) => isGet(r) && r.path.startsWith(`/EntityDefinitions(LogicalName='${T}')`), fields: ['MetadataId', 'EntitySetName'] },
  tableById: { match: (r) => isGet(r) && r.path.startsWith(`/EntityDefinitions(${MD})`), fields: ['LogicalName', 'MetadataId'] },
  concurrency: { match: (r) => isGet(r) && r.path.startsWith("/EntityDefinitions(LogicalName='appaction')"), fields: ['IsOptimisticConcurrencyEnabled'] },
  commands: { match: (r) => isGet(r) && r.path.startsWith('/appactions?'), list: true, fields: [...SELECT_ALL, '@odata.etag', 'iscustomizable.Value'] },
  row: { match: (r) => isGet(r) && r.path.startsWith('/appactions('), fields: [...SELECT_ALL, '@odata.etag', 'iscustomizable.Value'] },
  write: { match: (r) => r.method === 'PATCH' },
};
// Which phase reads which answer.
const PHASES = {
  preflight: ['app', 'layer', 'components', 'table', 'concurrency', 'row'],
  final: ['app', 'layer', 'components', 'table', 'concurrency', 'row'],
  verify: ['app', 'layer', 'components', 'table', 'concurrency', 'row'],
  listing: ['app', 'layer', 'components', 'table', 'tableById', 'concurrency', 'commands'],
  write: ['write'],
};

const refusal = (status, at) => () => ({ status, body: { error: at === 'code' ? { code: MARKER, message: 'denied' } : { code: '0x80040220', message: MARKER } } });
const setField = (record, field) => {
  if (field === 'iscustomizable.Value') return { ...record, iscustomizable: { ...record.iscustomizable, Value: MARKER } };
  return { ...record, [field]: MARKER };
};

// Every position of an answer, as (the answer the org would give, the request) -> the answer planted.
function positionsOf(name) {
  const resource = RESOURCES[name];
  if (name === 'write') {
    const out = {};
    for (const status of [403, 404, 412, 500, 503]) {
      out[`HTTP ${status} error.code`] = refusal(status, 'code');
      out[`HTTP ${status} error.message`] = refusal(status, 'message');
    }
    out['HTTP 404 not-found error.message'] = () => ({ status: 404, body: { error: { code: '0x80040217', message: MARKER } } });
    out['HTTP 200 body'] = () => ({ status: 200, body: { '@odata.etag': MARKER, error: { code: MARKER, message: MARKER } } });
    return out;
  }
  const out = { 'error.code': refusal(403, 'code'), 'error.message': refusal(403, 'message') };
  if (resource.list) {
    out['@odata.nextLink (another origin)'] = (answer) => ({ ...answer, body: { ...answer.body, '@odata.nextLink': `https://example.invalid/${MARKER}` } });
    out['@odata.nextLink (the same API)'] = (answer, req) => ({ ...answer, body: { ...answer.body, '@odata.nextLink': `${apiOf(req)}${req.path.split('?')[0]}?$skiptoken=${MARKER}` } });
    out.value = (answer) => ({ ...answer, body: { ...answer.body, value: MARKER } });
  }
  for (const field of resource.fields) {
    out[field] = resource.list
      ? (answer) => ({ ...answer, body: { ...answer.body, value: answer.body.value.map((row, i) => (i === 0 ? setField(row, field) : row)) } })
      : (answer) => ({ ...answer, body: setField(answer.body, field) });
  }
  if (name === 'row') {
    // A row whose caption changed with its version since the dry run: its approval is stale, and the halts that say so (the approval check,
    // and the re-read just before the write) name the row without its caption.
    const relabelled = (answer) => ({ ...answer, body: { ...setField(answer.body, 'buttonlabeltext'), '@odata.etag': 'W/"2001"' } });
    let reads = 0;
    out['buttonlabeltext, at a new row version'] = relabelled;
    // A build reads the row in its preflight, again in the plan it checks the approvals against, and once more just before the write.
    out['buttonlabeltext, at a new row version, just before the write'] = (answer) => ((reads += 1) < 3 ? answer : relabelled(answer));
  }
  return out;
}

// An org whose answers to one resource are planted while `armed()`; `hits` counts the planted answers served.
function planted(name, plant, armed) {
  const rows = [commandRow(ROW, T, MD)];
  const tables = { [T]: { metadataId: MD } };
  // The answer the org would give, from a twin over the same rows (a GET changes nothing, so the twin always agrees).
  const twin = createCommandStateOrg({ tables, rows });
  const state = { hits: 0 };
  const overrides = async (req) => {
    if (!armed() || !RESOURCES[name].match(req)) return undefined;
    let answer = { status: 0, body: undefined };
    if (isGet(req)) {
      const given = await twin.request({ method: req.method, url: req.url, headers: req.headers });
      answer = { status: given.statusCode, body: JSON.parse(given.body) };
      assert.ok(answer.status >= 200 && answer.status < 300, `the unplanted ${name} answer is a success`);
    }
    const out = plant(answer, req);
    state.hits += 1;
    return json(out.status, out.body);
  };
  return { rows, tables, overrides, state };
}

const isLabel = (name, position) => (name === 'row' || name === 'commands') && position.startsWith('buttonlabeltext');

async function inBuild(phase, name, plant, position) {
  let armed = false;
  const { rows, overrides, state } = planted(name, plant, () => armed);
  const h = harness({ rows, overrides, onPublish: () => { if (phase === 'final') armed = true; } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  if (phase !== 'final') armed = true;
  const out = await buildWithJournal(h, spec, approvals);
  if (phase === 'final') assert.strictEqual(h.patches().length, 1, 'the final proof runs after the row write');
  // The approval display is the console's, and the one place a planted caption belongs.
  const display = (out.caught && out.caught.approvalDisplay) || '';
  const unshown = (text) => (isLabel(name, position) && display ? text.split(display).join('') : text);
  return { hits: state.hits, primary: out.caught ? out.caught.message : '', where: whereOf(out, unshown) };
}

// What a build says and leaves, by where.
function whereOf(out, unshown = (text) => text) {
  const states = out.caught && out.caught.commandStates;
  return [
    ['the halt', out.caught ? `${out.caught.code} ${out.caught.message}` : ''],
    ['the warnings', unshown(out.said)],
    ['the console', unshown(out.logged)],
    ['the result', JSON.stringify(states === undefined ? out.result : states) || ''],
    ['build-log.jsonl', out.log],
    ['build-status.json', out.status],
  ];
}

// The publication's answer, planted in each of its positions: the error's code or message at a refusal status, a body that is not JSON, and
// no answer at all (the client throws, as the SDK's does for a failure of the transport).
function publishPositions() {
  const out = {};
  for (const status of [400, 403, 404, 429, 500, 503]) {
    out[`HTTP ${status} error.code`] = () => ({ status, body: { error: { code: MARKER, message: 'denied' } } });
    out[`HTTP ${status} error.message`] = () => ({ status, body: { error: { code: '0x80040220', message: MARKER } } });
  }
  out['HTTP 502 non-JSON body'] = () => ({ status: 502, body: `<html><body>${MARKER}</body></html>` });
  out['no answer'] = () => { throw Object.assign(new Error(MARKER), { code: MARKER }); };
  return out;
}

async function inPublish(route, plant) {
  let hits = 0;
  const barrier = route === 'managed' ? createPublicationBarrier() : undefined;
  const h = harness({ barrier, publishAnswer: async () => { hits += 1; return plant(); } });
  const spec = specFor();
  const { approvals } = await h.approve(spec);
  const engine = {};
  if (barrier) {
    // A committed managed group of the table routes it (managed-scope-publisher.js routeStored); this store holds none, so the route is set here.
    const { store } = openManagedContext({ workspaceDir: makeTempDir('cs-taint-store-'), environment: ORIGIN, appUniqueName: spec.app.uniqueName, solutionUniqueName: spec.solution.uniqueName, barrier });
    barrier.route(T, 'a managed group of the table');
    Object.assign(engine, { publicationBarrier: barrier, bindingGroups: { store } });
  }
  const out = await buildWithJournal(h, spec, approvals, engine);
  return { hits, primary: [out.caught ? out.caught.message : '', out.said].join('\n'), where: whereOf(out) };
}

// The SDK's refusal of a table's publication, planted in each position of the error it answers by value (the vendored SDK's ConnectionError:
// its message quotes the service, its cause carries the service's error), and a transport that got no answer.
function sdkPublishPositions() {
  const refusalWith = (change) => () => {
    const error = Object.assign(new Error('HTTP 503 from https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml: denied'), {
      code: 'CONNECTION_ERROR', statusCode: 503, url: `${ORIGIN}/api/data/v9.2/PublishXml`, cause: { error: { code: '0x80040220', message: 'denied' } },
    });
    change(error);
    return error;
  };
  return {
    'error.message': refusalWith((e) => { e.message = `HTTP 503 from ${e.url}: ${MARKER}`; }),
    'error.code': refusalWith((e) => { e.code = MARKER; }),
    'error.url': refusalWith((e) => { e.url = `${ORIGIN}/${MARKER}`; }),
    'error.cause.error.message': refusalWith((e) => { e.cause.error.message = MARKER; }),
    'error.cause.error.code': refusalWith((e) => { e.cause.error.code = MARKER; }),
    'no answer (transport)': refusalWith((e) => { e.statusCode = 0; e.message = `Transport failure reaching ${ORIGIN}: ${MARKER}`; delete e.cause; }),
  };
}

// The managed publisher's PublishXml failed by the client before it was dispatched, the error's message or its code planted.
function clientFailurePositions() {
  return {
    'client error.message': () => { throw Object.assign(new Error(MARKER), { code: 'ECONNRESET' }); },
    'client error.code': () => { throw Object.assign(new Error('socket closed'), { code: MARKER }); },
  };
}

// `fallback`: the envelope before the app is refused (its answer is clean) and the SDK's publication of the reconciled table, which follows
// it, answers the planted refusal; the final halt then settles the publish it owes, which is refused the same way. `phase8`: the envelope is
// answered ok and the publish phase's SDK publication of the view the build created answers it. `managed-predispatch`: the table is routed
// to the managed publisher, whose client fails before the request is dispatched.
async function inSdkPublish(route, plant) {
  let hits = 0;
  const barrier = route === 'managed-predispatch' ? createPublicationBarrier() : undefined;
  const h = harness({
    barrier,
    publishAnswer: () => (route === 'fallback' ? { status: 503, body: { error: { code: '0x80040220', message: 'denied' } } } : undefined),
    adaptSdk: (sdk) => {
      if (route === 'fallback') sdk.findArtifact = async (kind) => (kind === 'view' ? `view-${T}` : null);
      if (route === 'managed-predispatch') {
        const post = sdk.dataverse.post;
        sdk.dataverse.post = async (url, body) => {
          if (!String(body && body.ParameterXml).includes(`<entity>${T}</entity>`)) return post(url, body);
          hits += 1;
          return plant();
        };
        return;
      }
      sdk.publishArtifact = async (type, id) => {
        if (type !== 'view') return { type, id, shipped: true, publish: { kind: 'verified' } };
        hits += 1;
        return { type, id, shipped: false, publish: { kind: 'failed', error: plant() } };
      };
    },
  });
  const spec = specFor(undefined, { views: [{ entity: T, name: 'Active Tickets', columns: ['new_subject'] }] });
  const { approvals } = await h.approve(spec);
  const engine = {};
  if (barrier) {
    const { store } = openManagedContext({ workspaceDir: makeTempDir('cs-taint-store-'), environment: ORIGIN, appUniqueName: spec.app.uniqueName, solutionUniqueName: spec.solution.uniqueName, barrier });
    barrier.route(T, 'a managed group of the table');
    Object.assign(engine, { publicationBarrier: barrier, bindingGroups: { store } });
  }
  const out = await buildWithJournal(h, spec, approvals, engine);
  return { hits, primary: [out.caught ? out.caught.message : '', out.said].join('\n'), where: whereOf(out) };
}

async function inListing(name, plant, position) {
  const { rows, tables, overrides, state } = planted(name, plant, () => true);
  const org = createCommandStateOrg({ tables, rows, overrides });
  const emitted = [];
  const requires = {
    // emitResult ends the process; here it ends main() instead, as list-command-states.test.js does.
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload) => {
        emitted.push({ ok, payload });
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    './lib/sdk-http-client.js': { ...realHttp, createAzHttpClient: (env) => realHttp.createAzHttpClient(env, { getToken: () => 'test-token', request: org.request, sleep: async () => {} }) },
  };
  // Without --entity the listing resolves the app's tables by metadata id; with it, by logical name.
  const cli = loadCli(LISTING, { requires, argv: ['--env', ORIGIN, '--app', 'contoso_Support', ...(name === 'tableById' ? [] : ['--entity', T])] });
  try {
    await cli.main();
  } catch (error) {
    if (typeof error.exitCode !== 'number') throw error;
  }
  assert.strictEqual(emitted.length, 1, 'one result is emitted');
  const { payload } = emitted[0];
  // A planted caption is listed as exactly what was read, in `caption`, and said nowhere else.
  const commands = Array.isArray(payload.commands) ? payload.commands.map((item) => {
    if (!isLabel(name, position) || item.caption !== MARKER) return item;
    const { caption, ...rest } = item;
    return rest;
  }) : payload.commands;
  return {
    hits: state.hits,
    primary: emitted[0].ok ? '' : JSON.stringify(payload),
    where: [['the listing output', JSON.stringify({ ...payload, ...(commands ? { commands } : {}) })], ['stdout', cli.stdoutText()], ['stderr', cli.stderrText()]],
  };
}

async function inVerify(name, plant) {
  const { rows, tables, overrides, state } = planted(name, plant, () => true);
  const org = createCommandStateOrg({ tables, rows, overrides });
  const reader = createCommandStateTransport({
    client: realHttp.createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} }),
    apiUrl: (p) => `${ORIGIN}/api/data/v9.2${p}`,
  });
  const checks = await verifyCommandStates(reader, specFor());
  assert.strictEqual(checks.length, 1);
  return { hits: state.hits, primary: checks[0].present ? '' : checks[0].detail, where: [['the verify detail', JSON.stringify(checks)]] };
}

const cases = [];
for (const [phase, names] of Object.entries(PHASES)) {
  for (const name of names) {
    for (const [position, plant] of Object.entries(positionsOf(name))) cases.push({ phase, name, position, plant });
  }
}
for (const route of ['plain', 'managed']) {
  for (const [position, plant] of Object.entries(publishPositions())) cases.push({ phase: 'publish', name: route, position, plant });
}
for (const route of ['fallback', 'phase8']) {
  for (const [position, plant] of Object.entries(sdkPublishPositions())) cases.push({ phase: 'publish', name: route, position, plant });
}
for (const [position, plant] of Object.entries(clientFailurePositions())) cases.push({ phase: 'publish', name: 'managed-predispatch', position, plant });
const nameOf = (c) => `${c.phase} | ${c.name} | ${c.position}`;

// The thirteen cases an independent review found leaking, each one of the matrix: an app component's objectid and component type and the
// app read's next-page link, at the preflight and in the final proof; the objectid and the link in the listing and in verify; and a refused
// row read, table-row-version read and table read by metadata id, whose message is the service's but whose Dataverse code must be said. Two
// more came from a later review: the before-app publish refused with the service's message.
const REVIEWED = [
  'preflight | components | objectid', 'final | components | objectid', 'preflight | components | componenttype', 'final | components | componenttype',
  'preflight | app | @odata.nextLink (another origin)', 'final | app | @odata.nextLink (another origin)',
  'listing | components | objectid', 'listing | app | @odata.nextLink (another origin)',
  'verify | components | objectid', 'verify | app | @odata.nextLink (another origin)',
  'verify | row | error.message', 'verify | concurrency | error.message', 'listing | tableById | error.message',
  // The pull request's review: a refused before-app publish whose message the warning quoted.
  'publish | plain | HTTP 403 error.message', 'publish | plain | HTTP 503 error.message',
  // A later pass: the SDK's refusal of the fallback publication, quoted in the warning and copied into the halt and the journal; and the
  // managed publisher's refusal reason when its client failed before the request was dispatched.
  'publish | fallback | error.message', 'publish | managed-predispatch | client error.message',
];
test('the matrix holds every reviewed case', () => {
  const names = new Set(cases.map(nameOf));
  assert.deepStrictEqual(REVIEWED.filter((n) => !names.has(n)), []);
});

for (const c of cases) {
  test(`no service text: ${nameOf(c)}`, async () => {
    const seen = c.phase === 'listing' ? await inListing(c.name, c.plant, c.position)
      : c.phase === 'verify' ? await inVerify(c.name, c.plant)
        : c.phase === 'publish' ? await (['plain', 'managed'].includes(c.name) ? inPublish(c.name, c.plant) : inSdkPublish(c.name, c.plant))
          : await inBuild(c.phase, c.name, c.plant, c.position);
    assert.ok(seen.hits > 0, 'the planted answer was read');
    if (c.phase === 'preflight' && c.position.startsWith('buttonlabeltext, at')) assert.match(seen.primary, /^command-state-approval-stale\b/, 'the stale-approval halt is reached');
    for (const [where, text] of seen.where) {
      assert.ok(!TAINT.test(text), `${where} holds the planted text: ${text.slice(Math.max(0, text.search(TAINT) - 160), text.search(TAINT) + 60)}`);
    }
    // A refusal whose code is the platform's is still said by its status and that code: the message stays useful without the service's text.
    if (c.phase !== 'publish' && (c.position === 'error.message' || (c.name === 'write' && /^HTTP 40[34] error\.message$/.test(c.position)))) {
      assert.match(seen.primary, /HTTP 40[34], Dataverse error 0x80040220/, 'the status and the Dataverse code are said');
    }
    if (c.phase === 'publish' && c.name === 'plain' && /^HTTP \d+ error\.message$/.test(c.position)) {
      assert.match(seen.primary, /PublishXml answered HTTP \d+, Dataverse error 0x80040220/, 'the refused publish is said by its status and code');
    }
    if (c.phase === 'publish' && ['fallback', 'phase8'].includes(c.name) && c.position === 'error.message') {
      assert.match(seen.primary, /publish view Active Tickets FAILED[^\n]*: PublishXml answered HTTP 503, Dataverse error 0x80040220/, 'the SDK\'s refusal is said by its status and code');
    }
    if (c.name === 'managed-predispatch' && c.position === 'client error.message') {
      assert.match(seen.primary, /PublishXml got no usable answer \(ECONNRESET\)/, 'the failure is said by its system code');
    }
  });
}

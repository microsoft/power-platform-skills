'use strict';
// A READ of a table the build has only just created can meet the table's metadata-cache lag (#796) — live, the lookup of a view by name on
// a new table answered
//   HTTP 400 {"error":{"code":"0x80041102","message":"The entity with a name = 'contoso_ticket' with namemapping = 'Logical' was not found in the MetadataCache.LazyDynamicMetadataCache with version 9495075 and timestamp 9495075"}}
// These cases run the build over the REAL vendored SDK, the plugin's own HTTP client and the stateful fake Dataverse the lifecycle tests
// share (helpers/fake-lifecycle-org.js), with that answer injected on the named reads, and pin by what was sent and what the fake holds:
//   * a lagged read is read again where it failed, so every write of the build — its saves, its publishes, their bodies — is exactly what
//     the same build sends with no lag: only the reads differ;
//   * the form looked up by name is never taken as missing because its read failed: on a table this invocation created the read is read
//     again (the platform makes a stock "Information" Main form with every table, so a spec that names it would otherwise get a second);
//     on a table that was there before, the build stops with the service's answer and creates nothing;
//   * a lag that outlasts the build's retries stops it with the service's answer, and creates nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');

const TABLE = 'contoso_ticket';
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoReadLag', displayName: 'Read Lag', publisherPrefix: 'contoso' },
  app: { name: 'Read Lag' },
  entities: [{
    schemaName: TABLE, displayName: 'Ticket', pluralName: 'Tickets',
    primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
    columns: [{ schemaName: 'contoso_priority', displayName: 'Priority', type: 'Choice', options: ['Low', 'High'] }],
  }],
  views: [{ name: 'Open Tickets', entity: TABLE, columns: ['contoso_name', 'contoso_priority'] }],
  charts: [{ name: 'Tickets by Priority', entity: TABLE, chartType: 'Pie', groupBy: 'contoso_priority', measure: 'count' }],
  forms: [{ name: 'Ticket Form', entity: TABLE, layout: 'auto' }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Records', subAreas: [{ entity: TABLE, title: 'Tickets' }] }] }] },
};
const LAG_MESSAGE = `The entity with a name = '${TABLE}' with namemapping = 'Logical' was not found in the MetadataCache.LazyDynamicMetadataCache with version 9495075 and timestamp 9495075`;
const lagAnswer = () => ({ statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80041102', message: LAG_MESSAGE } }) });

// The reads the cases lag, as the SDK and the build send them (the URL decoded), e.g.
//   GET /api/data/v9.0/savedqueryvisualizations?$select=savedqueryvisualizationid&$filter=primaryentitytypecode eq 'contoso_ticket' and name eq 'Tickets by Priority'&$top=2
//   GET /api/data/v9.0/savedqueries?$select=savedqueryid&$filter=returnedtypecode eq 'contoso_ticket' and name eq 'Open Tickets'&$top=2
//   GET /api/data/v9.0/systemforms?$select=formid&$filter=objecttypecode eq 'contoso_ticket' and name eq 'Ticket Form' and type eq 2&$top=2
const chartRead = (r, url) => r.method === 'GET' && /\/savedqueryvisualizations\?/.test(url) && /name eq 'Tickets by Priority'/.test(url);
const viewRead = (r, url) => r.method === 'GET' && /\/savedqueries\?/.test(url) && /name eq 'Open Tickets'/.test(url);
const formRead = (name) => (r, url) => r.method === 'GET' && /\/systemforms\?/.test(url) && url.includes(`objecttypecode eq '${TABLE}' and name eq '${name}'`);

// One environment and the harness over it. `lag(r, url)` says which requests answer the lag instead of the fake (each is counted once
// per request, so a budget of answers is the caller's).
function world(label, lag = () => false) {
  const org = createLifecycleOrg();
  const original = org.request;
  const injected = [];
  org.request = async (r) => {
    const url = decodeURIComponent(r.url);
    if (lag(r, url, org)) {
      injected.push(`${r.method} ${url.replace(org.origin, '')}`);
      return lagAnswer();
    }
    return original(r);
  };
  return { org, injected, h: createLifecycleHarness(org, makeTempDir(`read-lag-${label}-`)) };
}
const once = (n, test) => { let left = n; return (r, url, org) => left > 0 && test(r, url, org) && left-- > 0; };
const build = (w, s = spec) => w.h.measure(() => w.h.build(s, { publish: false, sampleData: false, verify: false }));
const retriesOf = (step) => ((step.value && step.value.log) || []).filter((l) => /retry/i.test(l));
const formsNamed = (org, name) => org.find('systemforms', (r) => r.objecttypecode === TABLE && r.name === name).map((r) => r.formid);

// Every write a step sent, each as `METHOD path sha256(body)`, sorted, with every GUID (a new row's id differs from run to run) and the
// unique suffix a build gives a web resource read as placeholders: what the build asked for, and in what words.
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function writesOf(org, step) {
  return org.requests.slice(step.mark, step.end).filter((r) => r.method !== 'GET').map((r) => {
    const body = r.body === undefined ? '' : JSON.stringify(r.body).replace(GUID, '<id>');
    return `${r.method} ${String(r.path).replace(GUID, '<id>')} ${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
  }).sort();
}

test('reads that meet the lag of a table the build just created are read again in place: every write and publish equals the run with no lag', async () => {
  const control = world('control');
  const clean = await build(control);
  assert.equal(clean.error, undefined, clean.error && clean.error.message);
  assert.equal(clean.value.result.ok, true);
  assert.deepEqual(retriesOf(clean), [], 'no lag, no retry');

  // Three lag answers, the whole allowance of the invocation: two on the chart's lookup and one on the view's.
  const lagged = world('lagged', ((chart, view) => (r, url, org) => chart(r, url, org) || view(r, url, org))(once(2, chartRead), once(1, viewRead)));
  const step = await build(lagged);
  assert.equal(step.error, undefined, step.error && step.error.message);
  assert.deepEqual(step.unexpected, []);
  assert.equal(step.value.result.ok, true);
  assert.equal(lagged.injected.length, 3, lagged.injected.join('\n'));
  assert.equal(retriesOf(step).length, 3, 'one wait for each lag answer');
  assert.deepEqual(writesOf(lagged.org, step), writesOf(control.org, clean), 'the same writes, with the same bodies, as the run with no lag');
  assert.deepEqual(step.writes, clean.writes);
  assert.equal(step.writes['POST PublishXml'], clean.writes['POST PublishXml']);
  assert.equal(step.writes['PATCH savedqueries'], clean.writes['PATCH savedqueries']);
  // The lag answers are given before the fake sees the request, so the reads it served are the run with no lag's, one for one.
  assert.equal(step.reads, clean.reads, 'the reads that met the lag were each made again once, and nothing else was read');
});

test('a form lookup that meets the lag on a table this build created is read again: a spec that names the stock "Information" form reconciles that one form', async () => {
  const stockSpec = { ...spec, forms: [{ ...spec.forms[0], name: 'Information' }] };
  const control = world('stock-control');
  const clean = await build(control, stockSpec);
  assert.equal(clean.error, undefined, clean.error && clean.error.message);
  assert.equal(formsNamed(control.org, 'Information').length, 1);
  assert.equal(clean.writes['POST systemforms'], undefined, 'the stock form is reconciled, never created');

  // The table is created by the build; the one lag answer comes on the lookup of its stock form by name.
  const lagged = world('stock-lag', once(1, (r, url, org) => org.metadata.tables.has(TABLE) && formRead('Information')(r, url)));
  const step = await build(lagged, stockSpec);
  assert.equal(step.error, undefined, step.error && step.error.message);
  assert.equal(step.value.result.ok, true);
  assert.equal(lagged.injected.length, 1);
  assert.equal(retriesOf(step).length, 1);
  assert.equal(formsNamed(lagged.org, 'Information').length, 1, 'one "Information" form: the lag was not read as "no such form"');
  assert.equal(step.writes['POST systemforms'], undefined, 'no form is created');
  assert.deepEqual(writesOf(lagged.org, step), writesOf(control.org, clean));
});

test('a form lookup that meets the lag on a table that was there before the build stops it with the service\'s answer and creates nothing', async () => {
  let on = false;
  const w = world('existing', (r, url) => on && formRead('Ticket Form')(r, url));
  const first = await build(w);
  assert.equal(first.error, undefined, first.error && first.error.message);
  assert.equal(formsNamed(w.org, 'Ticket Form').length, 1);
  on = true;
  const again = await build(w);
  assert.ok(again.error, 'the rebuild stops');
  assert.match(again.error.message, /0x80041102|not found in the MetadataCache/);
  assert.match(again.error.message, new RegExp(`name = '${TABLE}'`));
  assert.deepEqual(retriesOf(again), [], 'a table this invocation did not create is not waited for');
  assert.equal(again.writes['POST systemforms'], undefined, 'no second form is created');
  assert.equal(formsNamed(w.org, 'Ticket Form').length, 1, 'the environment still holds one "Ticket Form"');
  assert.equal(w.injected.length, 1, 'read once');
});

test('a form lookup on a table this build created that stays lagged past the build\'s retries stops it with the service\'s answer and creates nothing', async () => {
  const w = world('exhausted', (r, url, org) => org.metadata.tables.has(TABLE) && formRead('Ticket Form')(r, url));
  const step = await build(w);
  assert.ok(step.error, 'the build stops');
  assert.match(step.error.message, /not found in the MetadataCache/);
  assert.equal(w.injected.length, 4, 'the first read and its three re-reads: the three retries of the invocation, then the stop');
  assert.equal(step.writes['POST systemforms'], undefined, 'no form is created');
  assert.equal(formsNamed(w.org, 'Ticket Form').length, 0);
});

// The form preflight of the destructive-change gate (build-model-app.js discoverOpDiffState) reads the form by name BEFORE the data-model step
// creates the table, so on a new table the lookup answers the MetadataCache 400 and the gate asks whether the table is there. That question
// must be asked the way the data-model step asks it (entity-provision.js findExistingTable): for a table whose labels are localized, an
// inconclusive narrow read is read again, never answered by the broad `EntityDefinitions?$select=…DisplayName…` list — a read that, issued
// before a localized create, makes Dataverse keep only the base-language label. A plain table may still fall back to the list, as before.
const LOCALIZED = {
  ...spec,
  entities: [{ ...spec.entities[0], displayName: { 1033: 'Ticket', 3082: 'Entrada' }, pluralName: { 1033: 'Tickets', 3082: 'Entradas' }, columns: [] }],
  views: [], charts: [],
  forms: [{ entity: TABLE, name: 'Ticket Form', layout: 'explicit', tabs: [{ label: 'General', sections: [{ label: 'General', fields: ['contoso_name'] }] }] }],
};
const PLAIN = { ...LOCALIZED, entities: [{ ...LOCALIZED.entities[0], displayName: 'Ticket', pluralName: 'Tickets' }] };
// `narrow(n)` answers the first n narrow table reads after the preflight's form lookup with `status` (the production client tries a 5xx six
// times before it gives the answer back, so six 503s are one inconclusive read), e.g.
//   GET /api/data/v9.0/EntityDefinitions(LogicalName='contoso_ticket')?$select=LogicalName,EntitySetName
// and records the order of the broad table list read and the table's create, e.g.
//   GET /api/data/v9.0/EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity
async function preflightRun(label, s, status, narrowFaults) {
  const org = createLifecycleOrg();
  org.pageServer.languages.provisioned = [1033, 3082];
  const original = org.request;
  const sequence = [];
  let formMissed = false;
  let left = narrowFaults;
  org.request = async (r) => {
    const url = decodeURIComponent(r.url);
    if (!org.metadata.tables.has(TABLE) && formRead('Ticket Form')(r, url)) { formMissed = true; return lagAnswer(); }
    if (r.method === 'GET' && url.includes(`/EntityDefinitions(LogicalName='${TABLE}')`) && formMissed && left > 0) {
      left -= 1;
      sequence.push(`narrow ${status}`);
      return status === 400 ? lagAnswer() : { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'Service unavailable' } }) };
    }
    if (r.method === 'GET' && /\/EntityDefinitions\?/.test(url)) sequence.push('broad');
    if (r.method === 'POST' && /\/EntityDefinitions$/.test(url)) sequence.push(`create ${Object.keys(labelsOf(r.body)).join('+')}`);
    return original(r);
  };
  const h = createLifecycleHarness(org, makeTempDir(`read-lag-preflight-${label}-`));
  const step = await h.measure(() => h.build(s, { publish: false, sampleData: false, verify: false }));
  const createAt = sequence.findIndex((e) => e.startsWith('create'));
  const broadAt = sequence.indexOf('broad');
  return { org, step, sequence, formMissed, createAt, broadAt, broadBeforeCreate: broadAt >= 0 && (createAt < 0 || broadAt < createAt) };
}
// The LCIDs of a create's DisplayName: `{ LocalizedLabels: [{ Label, LanguageCode }, …] }`.
function labelsOf(body) {
  const b = typeof body === 'string' ? JSON.parse(body) : body;
  return Object.fromEntries(((b.DisplayName && b.DisplayName.LocalizedLabels) || []).map((l) => [l.LanguageCode, l.Label]));
}

for (const [status, faults, what] of [[400, 1, 'answers the MetadataCache 400 once'], [503, 6, 'answers 503 past the client\'s own retries once']]) {
  test(`#796 the form preflight on a new LOCALIZED table whose narrow table read ${what} reads it again, and never sends the broad label-bearing table list before the create`, async () => {
    const run = await preflightRun(`loc-${status}`, LOCALIZED, status, faults);
    assert.equal(run.step.error, undefined, run.step.error && run.step.error.message);
    assert.ok(run.formMissed, 'the preflight looked the form up before the table existed');
    assert.equal(run.broadBeforeCreate, false, `no broad read before the localized create: ${run.sequence.join(' → ')}`);
    assert.equal(run.step.value.result.ok, true, JSON.stringify(run.step.value.result.errors));
    assert.deepEqual(run.step.unexpected, []);
    assert.equal(run.sequence[run.createAt], 'create 1033+3082', `the table is created with both labels: ${run.sequence.join(' → ')}`);
  });
}

test('#796 the form preflight on a new LOCALIZED table whose narrow table reads stay inconclusive stops before any write, with no broad read and no create', async () => {
  const run = await preflightRun('loc-stuck', LOCALIZED, 503, 1000);
  assert.equal(run.step.error, undefined, run.step.error && run.step.error.message);
  assert.equal(run.step.value.result.ok, false);
  assert.match(run.step.value.result.errors.join('\n'), /preflight safety check could not run/);
  assert.match(run.step.value.result.errors.join('\n'), /could not determine whether table 'contoso_ticket' already exists/);
  assert.equal(run.broadAt, -1, run.sequence.join(' → '));
  assert.equal(run.createAt, -1, 'no table is created');
  assert.deepEqual(Object.keys(run.step.writes), [], 'nothing is written');
});

test('#796 controls: a conclusive 404 proves a new localized table absent as before; a PLAIN table may still settle an inconclusive read by the table list', async () => {
  const conclusive = await preflightRun('loc-404', LOCALIZED, 400, 0);
  assert.equal(conclusive.step.error, undefined, conclusive.step.error && conclusive.step.error.message);
  assert.equal(conclusive.step.value.result.ok, true, JSON.stringify(conclusive.step.value.result.errors));
  assert.ok(conclusive.formMissed);
  assert.equal(conclusive.broadAt, -1, conclusive.sequence.join(' → '));
  const plain = await preflightRun('plain-400', PLAIN, 400, 1);
  assert.equal(plain.step.error, undefined, plain.step.error && plain.step.error.message);
  assert.equal(plain.step.value.result.ok, true, JSON.stringify(plain.step.value.result.errors));
  assert.deepEqual(plain.sequence.slice(0, 2), ['narrow 400', 'broad'], 'one narrow read, then the table list, unchanged');
  assert.ok(plain.createAt > plain.broadAt);
});
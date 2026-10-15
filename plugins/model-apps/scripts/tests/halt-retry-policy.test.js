'use strict';
// The build's retry policy, held halt by halt (lib/retry-policy.js, build-model-app.js isTransientHalt).
//
// The build runs itself again — every earlier phase, up to three more times — when a halt reads as a transient service error. It used to decide that by matching
// the halt's TEXT, and a halt's text quotes what the maker named: a view called "SQL Timeout Reader", a workspace folder, a persona. A deterministic refusal then
// "retried", and the log blamed the service. So every halt now DECLARES its policy where it is raised, from the structure of what failed:
//   never        a run again cannot change the answer (a refusal of the spec, an identity or ownership conflict, an approval, a prerequisite, a local file)
//   by-failure   the halt wraps a failure of the service: its HTTP status (429, 502, 503, 504), a timeout or reset of the transport, the SDK's own typed
//                classification, and — as a fallback — the SERVICE's own words decide. Never the halt's message, and never what the maker named.
//
// This file does three things.
//   1. It ENUMERATES the halts from the source (tests/helpers/halt-sites.js describes the pattern) and fails for any code that is not in POLICY below, for a table row
//      the source no longer raises, and for a site that declares no policy or another one. A halt added on another branch without a policy therefore fails here,
//      when the branches meet, instead of silently inheriting a reading of its own text.
//   2. For every halt it can reach with small doubles, it raises the REAL halt from the production code with a label that reads as a transient error
//      ("SQL Timeout 503 try again later") and holds the policy: a `never` halt is not retried by the real retry loop, and a `by-failure` halt is retried exactly
//      when the failure it wraps is a genuine one (a 429, a 503), however the maker's label reads. The page-phase halts need the page doubles of
//      sdk-build-pages-deploy.test.js, which holds them the same way (`via`).
//   3. It holds the retry rule for failures that are not halts: the errors the build's engine raises itself are made by `refusal` and `serviceFailure`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanHaltSites, scanBareErrors, haltSitesOf } = require('./helpers/halt-sites.js');
const {
  runSdkBuild, haltOnUnpublishedAppHeader, acquireAppPagesLease, refuseUnpushedAppCopy, assertAuthorizedSitemapRewrite, reconciledPublishHalt,
} = require('../lib/sdk-build.js');
const { BuildHalt, makeRunner, requireSuccessfulPush, findExistingTable, resolveLanguageCode, checkLocalizedLabelLanguages } = require('../lib/entity-provision.js');
const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
const { SdkError } = require('../lib/maker-sdk.js');

const SCRIPTS = path.join(__dirname, '..');
// What a maker may call anything — a view, a role, a persona, a flow, a folder — and what no halt may be judged by.
const LABEL = 'SQL Timeout 503 try again later';
const ENV = 'https://contoso.crm.dynamics.com';
const ROLE = '33333333-3333-4333-8333-333333333333';
const BU = '44444444-4444-4444-4444-444444444444';
const APP = '55555555-5555-4555-8555-555555555555';

// ── The policy table ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// `kinds`: what the halt's construction(s) may declare. `via`: the test file that holds the halt with the page doubles (or the halt's own fixtures); every other
// halt is held by a row of ROWS below.
const PAGES = 'sdk-build-pages-deploy.test.js';
const POLICY = {
  'language-not-provisioned': { kinds: ['never'] },
  'localized-label-language-not-provisioned': { kinds: ['never'] },
  'already-exists': { kinds: ['never'] },
  'version-conflict': { kinds: ['never'] },
  'table-probe-inconclusive': { kinds: ['by-failure'] },
  'relationship-name-taken': { kinds: ['never'], via: 'entity-provision.test.js' },
  'view-filter-label-unresolved': { kinds: ['by-failure'], via: 'view-filter-labels.test.js' },
  'pages-locked': { kinds: ['never'] },
  'app-header-unpublished': { kinds: ['never'] },
  'app-copy-unpushed-edits': { kinds: ['never'] },
  'sitemap-removal-unapproved': { kinds: ['never'] },
  'reconciled-publish-failed': { kinds: ['by-failure'] },
  'bpf-unique-name-conflict': { kinds: ['never'] },
  'pages-sitemap-read-failed': { kinds: ['by-failure'], via: 'sdk-build.test.js' },
  'pages-removed': { kinds: ['never'], via: 'sdk-build.test.js' },
  'pages-requires-app': { kinds: ['never'], via: PAGES },
  'pages-existence-failed': { kinds: ['by-failure'], via: PAGES },
  'pages-manifest-corrupt': { kinds: ['never'], via: 'sdk-build.test.js' },
  'pages-identity-conflict': { kinds: ['never'], via: PAGES },
  'pages-creation-receipt-failed': { kinds: ['never'], via: PAGES },
  'pages-duplicate-name-create': { kinds: ['never'], via: PAGES },
  'pages-shared-check-failed': { kinds: ['by-failure', 'never'], via: 'sdk-build.test.js' },
  'pages-shared-across-apps': { kinds: ['never'], via: PAGES },
  'pages-blank-provenance': { kinds: ['never'], via: PAGES },
  'pages-source-not-utf8': { kinds: ['never'], via: PAGES },
  'pages-malformed-navref': { kinds: ['never'], via: PAGES },
  'pages-nav-parity': { kinds: ['never'], via: PAGES },
  'pages-stray-pageref': { kinds: ['never'], via: PAGES },
  'pages-griffel-shorthand': { kinds: ['never'], via: PAGES },
  'pages-publish-failed': { kinds: ['by-failure'], via: PAGES },
  'pages-dangling-navref': { kinds: ['never'], via: PAGES },
  'pages-update-identity-mismatch': { kinds: ['never'], via: PAGES },
  'security-role-failed': { kinds: ['by-failure'] },
  'role-grant-unresolved': { kinds: ['by-failure'] },
  'role-grant-persona-overlap': { kinds: ['never'] },
  'role-grant-duplicate-target': { kinds: ['never'] },
  'role-grant-failed': { kinds: ['by-failure'] },
  'bpf-role-unresolved': { kinds: ['never'] },
  'bpf-role-grant-failed': { kinds: ['by-failure'] },
};
// The sites whose code is an expression, on purpose: the code is decided at run time, so the policy cannot be read off a literal.
const DYNAMIC = [
  { file: 'lib/entity-provision.js', expr: "(err && err.code) || 'sdk-error'", kind: 'by-failure', what: 'the runner wraps every failed step with the code of what failed' },
  { file: 'lib/entity-provision.js', expr: 'sdkCode', kind: 'by-failure', what: 'a push the SDK refused by value, with the code the SDK gave' },
  { file: 'lib/sdk-build.js', expr: 'verdict.code', kind: 'never', what: 'the navigation verdict (app-navigation-empty): a re-run reads the same spec' },
];
// Object literals that carry `phase`, `code` and `recoverable` and are not halts.
const NOT_HALTS = [{ file: 'build-model-app.js', what: 'the journal record of a halt, written after the retry decision' }];
// The files whose errors are all made by lib/retry-policy.js (see the scan).
const ENGINE_FILES = ['lib/sdk-build.js', 'lib/entity-provision.js'];

// ── 1. The enumeration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sites = scanHaltSites(SCRIPTS);

test('the scan finds the halts the build raises today — if it found fewer, it would be the scan that is broken, not the table that is complete', () => {
  const found = new Set(sites.filter((s) => s.code).map((s) => s.code));
  for (const code of Object.keys(POLICY)) assert.ok(found.has(code), `the scan did not find the halt "${code}", which this table knows (tests/helpers/halt-sites.js)`);
  assert.ok(sites.length >= 50, `the scan found ${sites.length} halt sites; there are more than fifty`);
  assert.ok(sites.filter((s) => s.how === 'new BuildHalt').length >= 50, 'the constructor calls are what it reads');
});

test('every halt the source raises has a policy in the table — a halt added without one fails here, instead of silently reading its own text', () => {
  const unknown = [...new Set(sites.filter((s) => s.code && !POLICY[s.code]).map((s) => `${s.code} (${s.file}:${s.line})`))];
  assert.deepStrictEqual(unknown, [], `these halts have no entry in POLICY (tests/halt-retry-policy.test.js): give each its policy there, and declare it where it is raised (retry: RETRY.NEVER, or a retry decided from the failure it wraps)`);
  const gone = Object.keys(POLICY).filter((code) => !sites.some((s) => s.code === code));
  assert.deepStrictEqual(gone, [], 'these rows of POLICY name a halt the source no longer raises');
});

test('every halt is raised with a retry policy of its own, and the one the table allows for its code', () => {
  const problems = [];
  for (const s of sites.filter((x) => x.how === 'new BuildHalt')) {
    const where = `${s.file}:${s.line}`;
    const allowed = s.code ? (POLICY[s.code] || {}).kinds : (DYNAMIC.find((d) => d.file === s.file && d.expr === s.codeExpr) || {}).kind && [DYNAMIC.find((d) => d.file === s.file && d.expr === s.codeExpr).kind];
    if (!s.declared) problems.push(`${where} ${s.code || s.codeExpr}: no retry policy is declared (retry: RETRY.NEVER, or one decided from the failure it wraps)`);
    else if (allowed && !allowed.includes(s.declared)) problems.push(`${where} ${s.code || s.codeExpr}: declares "${s.declared}", the table allows ${allowed.join(' or ')}`);
  }
  assert.deepStrictEqual(problems, []);
  // A row that lists a kind no site uses is a row that has rotted.
  for (const [code, row] of Object.entries(POLICY)) {
    for (const kind of row.kinds) assert.ok(sites.some((s) => s.code === code && s.declared === kind), `"${code}": no site declares "${kind}", which the table allows`);
  }
});

test('a halt whose code is an expression is listed on purpose, and every listed one still exists', () => {
  const dynamic = sites.filter((s) => s.how === 'new BuildHalt' && !s.code);
  const unlisted = dynamic.filter((s) => !DYNAMIC.some((d) => d.file === s.file && d.expr === s.codeExpr)).map((s) => `${s.file}:${s.line} code: ${s.codeExpr}`);
  assert.deepStrictEqual(unlisted, [], 'a halt with a computed code needs an entry in DYNAMIC (what it is, and its policy)');
  for (const d of DYNAMIC) assert.ok(dynamic.some((s) => s.file === d.file && s.codeExpr === d.expr), `DYNAMIC lists a site that is gone: ${d.file} ${d.expr}`);
});

test('a halt built without the constructor (an object with phase, code and recoverable) is not hiding from the table', () => {
  const shaped = sites.filter((s) => s.how === 'halt-shaped literal' && !NOT_HALTS.some((n) => n.file === s.file));
  assert.deepStrictEqual(shaped.map((s) => `${s.file}:${s.line} ${s.code || s.codeExpr}`), [], 'raise it with `new BuildHalt(…, { …, retry })`, or list it in NOT_HALTS if it is not a halt');
});

test('the build\'s engine makes no bare `new Error(`: every failure it raises says what a run again may do (refusal, serviceFailure)', () => {
  const bare = scanBareErrors(SCRIPTS, ENGINE_FILES).map((b) => `${b.file}:${b.line}`);
  assert.deepStrictEqual(bare, [], 'use refusal(message) for a deterministic refusal and serviceFailure(message, …) for a failure of the service (lib/retry-policy.js)');
});

// The scan is what keeps a halt added later from inheriting a reading of its own text, so what it can and cannot see is pinned on sources written for the purpose: the shapes a halt is written in, and the prose that is not one.
test('the scan itself: it reads a halt wherever it is written — by the pattern tests/helpers/halt-sites.js documents — and not one that is mentioned in a comment, a string or a template', () => {
  const read = (src) => haltSitesOf('x.js', src, 'x.js').map((s) => [s.code || s.codeExpr, s.declared, s.how]);
  const head = "throw new BuildHalt(`m`, { phase: 'p', code: 'a-code', recoverable: false";
  // A halt with no policy declares none; one that says never, or decides from the failure, declares that.
  assert.deepStrictEqual(read(`${head} });`), [['a-code', null, 'new BuildHalt']]);
  assert.deepStrictEqual(read(`${head}, retry: RETRY.NEVER });`), [['a-code', 'never', 'new BuildHalt']]);
  assert.deepStrictEqual(read(`${head}, retry: retryPolicyFor(err) });`), [['a-code', 'by-failure', 'new BuildHalt']]);
  assert.deepStrictEqual(read(`${head}, ...retryFrom(err, words) });`), [['a-code', 'by-failure', 'new BuildHalt']]);
  assert.deepStrictEqual(read(`${head}, retry: slow ? RETRY.NEVER : RETRY.SERVICE });`), [['a-code', 'by-failure', 'new BuildHalt']]);
  // A conditional spread declares one only when EVERY branch does: a branch that says nothing would leave its halt to the text.
  assert.strictEqual(read(`${head}, ...(x ? { cause: e, retry: retryPolicyFor(e) } : { retry: RETRY.SERVICE, retryText: w, ...(s ? { statusCode: s } : {}) }) });`)[0][1], 'by-failure');
  assert.strictEqual(read(`${head}, ...(x ? { retry: RETRY.NEVER } : { retry: RETRY.NEVER }) });`)[0][1], 'never');
  assert.strictEqual(read(`${head}, ...(x ? { retry: RETRY.NEVER } : { cause: e }) });`)[0][1], null, 'a branch with no policy');
  assert.strictEqual(read(`${head}, ...(x ? { retry: RETRY.NEVER } : {}) });`)[0][1], null, 'an empty branch');
  // Words that only look like a policy are not one: they are in a string or a comment, which are not code.
  assert.strictEqual(read(`${head}, note: 'retry: RETRY.NEVER' });`)[0][1], null);
  assert.strictEqual(read(`${head}, /* retry: RETRY.NEVER */ });`)[0][1], null);
  assert.strictEqual(read(`${head}, note: \`retry: \${RETRY.NEVER}\` });`)[0][1], null);
  assert.strictEqual(read(`${head} }); const retry = RETRY.NEVER;`)[0][1], null, 'a policy declared elsewhere is not the halt\'s');
  // Wherever it is written: over several lines, with a message that holds braces and substitutions, nested in other calls.
  assert.deepStrictEqual(read("run(() => {\n  throw new BuildHalt(\n    `a ${ { x: 1 }.x } {b} (c)`,\n    {\n      phase: 'p', code: \"double-quoted\",\n      recoverable: true,\n      retry: RETRY.NEVER,\n    },\n  );\n});"), [['double-quoted', 'never', 'new BuildHalt']]);
  assert.deepStrictEqual(read(`f(${head}, retry: RETRY.NEVER }), g(${head.replace('a-code', 'b-code')}, retry: RETRY.NEVER }));`).map((r) => r[0]), ['a-code', 'b-code']);
  // A halt mentioned in prose is not a site.
  assert.deepStrictEqual(read("// throw new BuildHalt('x', { code: 'in-a-comment' })\n/* new BuildHalt('x', { code: 'in-a-block' }) */\nconst a = \"new BuildHalt('x', { code: 'in-a-string' })\";\nconst b = `new BuildHalt(\\`x\\`, { code: 'in-a-template' })`;\nconst c = /new BuildHalt\\(/;\n"), []);
  // A code that is not a literal is listed as an expression, and options that are not a literal are said so: neither can be read off the source, and the test makes each a decision.
  assert.deepStrictEqual(read("throw new BuildHalt('m', { phase: 'p', code: (err && err.code) || 'x', recoverable: false, retry: RETRY.NEVER });"), [["(err && err.code) || 'x'", 'never', 'new BuildHalt']]);
  assert.deepStrictEqual(read("throw new BuildHalt('m', options);"), [['<options: options>', null, 'new BuildHalt']]);
  assert.deepStrictEqual(read("throw new BuildHalt('m');"), [[null, null, 'new BuildHalt']]);
  // A halt written another way — an error with the halt's own keys — is a site too.
  assert.deepStrictEqual(read("throw Object.assign(new Error('m'), { phase: 'p', code: 'sneaky', recoverable: false });"), [['sneaky', null, 'halt-shaped literal']]);
  assert.deepStrictEqual(read("return { phase: 'p', code: 'plain-record', recoverable: true };"), [['plain-record', null, 'halt-shaped literal']]);
  assert.deepStrictEqual(read(`${head}, retry: RETRY.NEVER });`).length, 1, 'the options of the constructor are not also a halt-shaped literal');
});

test('the scan\'s bare-error check reads code only, and finds a `new Error(` wherever the engine writes one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-sites-'));
  try {
    fs.writeFileSync(path.join(dir, 'engine.js'), "// new Error('in a comment')\nconst s = \"new Error('in a string')\";\nthrow new Error('here');\nfn(() => new Error(`and ${1} here`));\nthrow refusal('fine');\n");
    assert.deepStrictEqual(scanBareErrors(dir, ['engine.js']), [{ file: 'engine.js', line: 3 }, { file: 'engine.js', line: 4 }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 2. The halts, raised by the production code ─────────────────────────────────────────────────────────────────────────────────────────────────
const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = (what) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${what}-`)); dirs.push(dir); return dir; };

// The SDK's ConnectionError, as the bundle builds it: a code, the status the service answered (0 for a transport failure), the request's url, and a message that opens
// with where the request went (`HTTP <status> from <url>: <the service's words>`).
function connectionError(statusCode, words, url = `${ENV}/api/data/v9.2/roles?$filter=name eq '${LABEL}'`) {
  const lead = statusCode > 0 ? `HTTP ${statusCode} from ${url}: ` : `Transport failure reaching ${url}: `;
  return Object.assign(new Error(`${lead}${words}`), { code: 'CONNECTION_ERROR', statusCode, url });
}
// Failures a run again cannot change, as the SDK, the service and the machine report them — every one with a label that reads as transient where a label can be.
// What `enrichDefaultViews` raises when the publish of the views it saved fails: an SdkError of its own code, the publish error's message inside it, and no cause.
const wrappedPublish = (answer, table = 'contoso_order') => new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `enrichDefaultViews: 2 view(s) on '${table}' were saved but the publish FAILED, so none of them is live (${answer}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
const REFUSALS = [
  ['a refusal in the SDK\'s words', () => new Error('same-name role is managed and cannot be adopted')],
  ['a typed validation error that quotes the label', () => Object.assign(new Error(`View '${LABEL}' is invalid`), { code: 'VALIDATION_ERROR' })],
  ['a 403 from the service whose url carries the label', () => connectionError(403, 'permission denied')],
  ['a local file error that quotes the path', () => Object.assign(new Error(`EACCES: permission denied, open '/work/${LABEL}/page.json'`), { code: 'EACCES', syscall: 'open' })],
  ['an SDK error that wraps a publish the service refused (a 403), on a table called like a timeout', () => wrappedPublish(`HTTP 403 from ${ENV}/api/data/v9.2/PublishXml: permission denied`, 'contoso_sql_timeout')],
];
// Failures that ARE the service's to say, whatever anything is called.
const GENUINE = [
  ['a 503', () => connectionError(503, 'The service is unavailable.')],
  ['a 429', () => connectionError(429, 'Too many requests.')],
  ['a reset of the connection', () => connectionError(0, 'Request failed: read ECONNRESET')],
  ['an SDK error that wraps a publish the service could not take (a 503)', () => wrappedPublish(`HTTP 503 from ${ENV}/api/data/v9.2/PublishXml: Service Unavailable`)],
];

// The spec every row's retry loop runs on: valid, and not the point.
const loopSpec = () => ({
  schemaVersion: 2,
  solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
  app: { name: 'Contoso' },
  entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
});

// How often the REAL retry loop runs the build when every attempt ends with `halt`.
async function attemptsFor(halt) {
  let attempts = 0;
  const lines = [];
  const sdk = {};
  try {
    await buildModelApp(loopSpec(), { apply: true, env: ENV, retryDelayMs: 0, appDir: tempDir('halt-policy-app') }, {
      sdk, provisionSdk: sdk, sleep: async () => {}, log: (m) => lines.push(String(m)), warn: () => {}, verify: async () => ({ ok: true }),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      runBuild: async () => { attempts += 1; throw halt; },
    });
  } catch (e) { if (e !== halt) throw e; }
  return { attempts, retried: lines.filter((l) => /retrying/.test(l)).length };
}

const haltOf = (promiseOrFn) => Promise.resolve().then(promiseOrFn).then(
  () => { throw new Error('expected a halt, and the code finished'); },
  (e) => e,
);
const buildHalt = (spec, sdk, phases) => haltOf(() => runSdkBuild(spec, { sdk, provisionSdk: sdk, apply: true, phases }));

// The security phase's doubles.
const orderSpec = (extra) => ({ ...loopSpec(), ...extra });
const persona = (name) => ({ persona: name, jobs: [{ name: 'Read', privileges: [{ entity: 'contoso_order', access: ['read'] }] }] });
const grant = (extra) => ({ privileges: [{ entity: 'contoso_order', access: ['read'] }], ...extra });
const roleRow = (name = LABEL) => ({ roleid: ROLE, name, ismanaged: false });
function securityDouble(over = {}) {
  return {
    queryRecords: async (entity) => (entity === 'businessunit' ? [{ businessunitid: BU }] : []),
    createPersonaRole: async (s) => ({ roleId: ROLE, name: s.name, reused: false, appliedPrivileges: [] }),
    addEntityPrivilegesToRole: async () => [],
    addSolutionComponent: async () => ({}),
    associateRecords: async () => ({}),
    disassociateRecords: async () => ({}),
    ...over,
  };
}
// The business process flow rows: a persona named in the flow's securityRoles is granted on the flow's backing table.
const bpfSpec = (name) => ({
  ...loopSpec(),
  entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_notes', type: 'Text' }] }],
  personas: [persona('Dispatcher')],
  businessProcessFlows: [{ name, entity: 'contoso_ticket', status: 'Active', stages: [{ name: 'Triage', steps: [{ name: 'Notes', field: 'contoso_notes' }] }], securityRoles: { personas: ['Dispatcher'] } }],
});
const bpfDouble = (over = {}) => securityDouble({
  createArtifact: (type, def) => ({ id: '66666666-6666-6666-6666-666666666666', type, def }),
  pushArtifact: async (type, id) => ({ ok: true, id }),
  activateArtifact: async () => ({ ok: true }),
  updateRecord: async () => ({}),
  ...over,
});

// Each row raises one halt. `make({ failure })` — `failure` is the error a `by-failure` halt wraps, absent for a halt with none or for the refusal the production
// code itself makes — returns the halt. `quotes` says the halt's message holds the label (the control: its words alone read as transient).
const ROWS = {
  'security-role-failed': ({ failure }) => buildHalt(orderSpec({ personas: [persona(LABEL)] }), securityDouble({ createPersonaRole: async () => { throw failure || new Error('same-name role is managed and cannot be adopted'); } }), ['security']),
  'role-grant-unresolved': ({ failure }) => buildHalt(orderSpec({ roleGrants: [grant({ role: LABEL })] }), securityDouble({ queryRecords: async (entity) => { if (entity === 'role' && failure) throw failure; return entity === 'businessunit' ? [{ businessunitid: BU }] : []; } }), ['security']),
  'role-grant-persona-overlap': () => buildHalt(orderSpec({ personas: [persona(LABEL)], roleGrants: [grant({ roleId: ROLE })] }), securityDouble({ queryRecords: async (entity) => (entity === 'role' ? [roleRow()] : entity === 'businessunit' ? [{ businessunitid: BU }] : []) }), ['security']),
  'role-grant-duplicate-target': () => buildHalt(orderSpec({ roleGrants: [grant({ role: LABEL }), grant({ roleId: ROLE })] }), securityDouble({ queryRecords: async (entity) => (entity === 'role' ? [roleRow()] : entity === 'businessunit' ? [{ businessunitid: BU }] : []) }), ['security']),
  'role-grant-failed': ({ failure }) => buildHalt(orderSpec({ roleGrants: [grant({ role: LABEL })] }), securityDouble({ queryRecords: async (entity) => (entity === 'role' ? [roleRow()] : entity === 'businessunit' ? [{ businessunitid: BU }] : []), addEntityPrivilegesToRole: async () => { throw failure || new Error('entity does not support share access'); } }), ['security']),
  'bpf-role-unresolved': () => buildHalt(bpfSpec(LABEL), bpfDouble({ createPersonaRole: async (s) => ({ name: s.name }) }), ['business-process-flows', 'security']),
  'bpf-role-grant-failed': ({ failure }) => buildHalt(bpfSpec(LABEL), bpfDouble({ addEntityPrivilegesToRole: async () => { throw failure || new Error('read access unavailable on backing table'); } }), ['business-process-flows', 'security']),
  'bpf-unique-name-conflict': () => {
    let asked = 0;
    // The reuse query finds nothing; the query by the derived unique name finds a flow of another table, which a create would collide with.
    return buildHalt(bpfSpec(LABEL), bpfDouble({ queryRecords: async (entity) => { if (entity === 'workflow') { asked += 1; return asked === 1 ? [] : [{ workflowid: ROLE, name: 'Another flow', primaryentity: 'contoso_other' }]; } return entity === 'businessunit' ? [{ businessunitid: BU }] : []; } }), ['business-process-flows']);
  },
  'already-exists': () => haltOf(() => requireSuccessfulPush({ saved: false, error: Object.assign(new Error('permanent refusal'), { code: 'ARTIFACT_ALREADY_EXISTS' }) }, `view ${LABEL}`)),
  'version-conflict': () => haltOf(() => requireSuccessfulPush({ saved: false, error: Object.assign(new Error('permanent refusal'), { code: 'VERSION_CONFLICT' }) }, `view ${LABEL}`)),
  'app-header-unpublished': () => haltOf(() => haltOnUnpublishedAppHeader({ fetchArtifact: async () => ({}) }, APP, { saved: false, error: Object.assign(new Error('publish first'), { code: 'APP_DRAFT_HEADER_NOT_WRITABLE' }) }, LABEL)),
  'app-copy-unpushed-edits': () => haltOf(() => refuseUnpushedAppCopy({ listArtifacts: async () => [{ id: APP, isDirty: true }] }, APP, LABEL)),
  'sitemap-removal-unapproved': () => {
    const live = { siteMap: { areas: [{ groups: [{ subAreas: [{ type: 'URL', url: `https://contoso.example/help?q=${LABEL}` }] }] }] } };
    return haltOf(() => assertAuthorizedSitemapRewrite({ fetchArtifact: async () => ({}), getArtifact: async () => live }, APP, { areas: [] }, new Set(), 'app-shell'));
  },
  'reconciled-publish-failed': async ({ failure }) => reconciledPublishHalt([{ target: ['view', ROLE, [`view ${LABEL}`]], error: failure || Object.assign(new Error('permission denied'), { statusCode: 403 }) }]),
  'pages-locked': () => {
    const workspace = path.join(tempDir('halt-policy-lease'), LABEL);
    const held = acquireAppPagesLease(workspace, 'contoso_app');
    dirs.push(path.dirname(workspace));
    return haltOf(() => acquireAppPagesLease(workspace, 'contoso_app')).finally(() => held.release());
  },
  'language-not-provisioned': () => haltOf(() => resolveLanguageCode({ spec: {}, languageCode: 1031, provisionedLanguages: async () => [1033] })),
  'localized-label-language-not-provisioned': () => haltOf(() => checkLocalizedLabelLanguages({ entities: [{ schemaName: LABEL, displayName: { 1033: 'Name', 3082: 'Nombre' }, columns: [] }] }, async () => [1033])),
  'table-probe-inconclusive': ({ failure }) => haltOf(() => findExistingTable({ dataverse: { get: async () => { throw failure || Object.assign(new Error('bad request'), { statusCode: 400 }); } } }, LABEL, { hasLocalizedLabels: true, attempts: 1 })),
};

for (const [code, make] of Object.entries(ROWS)) {
  const row = POLICY[code];
  test(`halt policy: ${code} is raised with a label that reads as a transient error, and ${row.kinds.includes('by-failure') ? 'follows the failure it wraps' : 'is never run again'}`, async () => {
    assert.ok(row, `${code} needs an entry in POLICY`);
    if (!row.kinds.includes('by-failure')) {
      const halt = await make({});
      assert.strictEqual(halt.code, code);
      assert.strictEqual(isTransientHalt(halt, { spec: loopSpec() }), false, 'a refusal a run again cannot change is not taken for a transient error');
      assert.strictEqual(isTransientHalt(new Error(halt.message)), halt.message.includes(LABEL), 'the control: where the halt quotes the label, its words alone would have read as transient');
      const { attempts, retried } = await attemptsFor(halt);
      assert.deepStrictEqual({ attempts, retried }, { attempts: 1, retried: 0 }, 'the real retry loop runs the build once');
      return;
    }
    for (const [what, failureOf] of REFUSALS) {
      const halt = await make({ failure: failureOf() });
      assert.strictEqual(halt.code, code, what);
      assert.strictEqual(isTransientHalt(halt, { spec: loopSpec() }), false, `${what}: a refusal is not a transient error, whatever the halt quotes`);
    }
    // The halt's own refusal — the one the production code makes when the doubles give no failure to wrap — is final too.
    const own = await make({});
    assert.strictEqual(isTransientHalt(own, { spec: loopSpec() }), false, 'the refusal the production code itself makes');
    assert.deepStrictEqual(await attemptsFor(own), { attempts: 1, retried: 0 });
    for (const [what, failureOf] of GENUINE) {
      const halt = await make({ failure: failureOf() });
      assert.strictEqual(halt.code, code, what);
      assert.strictEqual(isTransientHalt(halt, { spec: loopSpec() }), true, `${what}: a failure of the service is run again, for any label`);
      assert.ok(halt.message.includes(LABEL) || code === 'reconciled-publish-failed' || code === 'table-probe-inconclusive', `${what}: the halt quotes the label, and the label did not decide`);
    }
    const retried = await attemptsFor(await make({ failure: GENUINE[0][1]() }));
    assert.deepStrictEqual(retried, { attempts: 4, retried: 3 }, 'a 503 is run again, three times, as it always was');
  });
}

// The halts without a row here are held beside their own doubles: the table must say where, and the file must hold them.
test('every halt without a row in this file names the test file that holds it, and that file raises it', () => {
  for (const [code, row] of Object.entries(POLICY)) {
    if (ROWS[code]) { assert.ok(!row.via || fs.existsSync(path.join(__dirname, row.via)), `${code}: ${row.via}`); continue; }
    assert.ok(row.via, `"${code}" has no row in this file and names no other file that holds it`);
    const file = path.join(__dirname, row.via);
    assert.ok(fs.existsSync(file), `${code}: ${row.via} does not exist`);
    assert.ok(fs.readFileSync(file, 'utf8').includes(`'${code}'`), `${code}: ${row.via} does not raise it`);
  }
});

// The failure the runner wraps, with its code: the one halt every failed step of the engine becomes.
test('halt policy: the runner\'s halt follows the failure it wraps — typed refusals, files and marked errors are final; a 429, a 503, a reset and the service\'s words are run again', async () => {
  const wrap = async (failure) => {
    const runner = makeRunner({ emit: () => {}, total: 1 });
    return haltOf(() => runner.run('data-model', `view ${LABEL}`, async () => { throw failure; }));
  };
  for (const [what, failureOf] of REFUSALS) {
    const halt = await wrap(failureOf());
    assert.strictEqual(isTransientHalt(halt), false, what);
    assert.ok(halt instanceof BuildHalt);
  }
  const refused = await wrap(require('../lib/retry-policy.js').refusal(`could not find "${LABEL}"`));
  assert.strictEqual(isTransientHalt(refused), false, 'an error the engine itself marks as a refusal');
  for (const [what, failureOf] of GENUINE) assert.strictEqual(isTransientHalt(await wrap(failureOf())), true, what);
  assert.strictEqual(isTransientHalt(await wrap(new Error('Microsoft.Crm.ObjectModel.CustomizationLockException: try again later'))), true, 'the service\'s words, in an error with no status');
  assert.strictEqual(isTransientHalt(await wrap(connectionError(500, 'Sql error: Generic SQL error. Sql Number: 1205'))), true, 'a deadlock victim');
  assert.strictEqual(isTransientHalt(await wrap(connectionError(500, 'Internal server error', `${ENV}/api/data/v9.2/x?$filter=name eq '${LABEL}'`))), false, 'a url is not the service\'s words');
});

// A push the SDK refused by value, with the code the SDK gave: the halt it becomes follows the failure.
test('halt policy: a push refused by value follows the SDK\'s failure — a code it gave is final, a 503 is run again — and the label cannot change either', () => {
  const push = (error) => { try { requireSuccessfulPush({ saved: false, error }, `view ${LABEL}`); } catch (e) { return e; } return null; };
  assert.strictEqual(isTransientHalt(push(Object.assign(new Error('permanent refusal'), { code: 'VALIDATION_ERROR' }))), false);
  assert.strictEqual(isTransientHalt(push(connectionError(503, 'The service is unavailable.'))), true);
  assert.strictEqual(isTransientHalt(push(connectionError(400, 'Bad request'))), false);
  assert.strictEqual(push(connectionError(503, 'x')).code, 'CONNECTION_ERROR', 'the halt keeps the code the SDK gave, which a phase\'s skipIf matches on');
});

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
// An apply that names no app folder and no workspace gets an app folder of its own: it holds its build lease in its workspace (helpers/own-app-folder.js).
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const {
  runSdkBuild: runSdkBuildInPlace, haltOnUnpublishedAppHeader, acquireAppPagesLease, refuseUnpushedAppCopy, assertAuthorizedSitemapRewrite, reconciledPublishHalt,
} = require('../lib/sdk-build.js');
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { BuildHalt, makeRunner, requireSuccessfulPush, findExistingTable, resolveLanguageCode, checkLocalizedLabelLanguages } = require('../lib/entity-provision.js');
const { buildModelApp, isTransientHalt } = require('../build-model-app.js');
const { SdkError, ConnectionError, createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { serviceFailure } = require('../lib/retry-policy.js');

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
  // The table list the build falls back to, answered with a success that is no list of tables (lib/collection-answers.js): a run again reads the same answer, and signing in
  // again is the maker's. Its message quotes the table's name in lower case, so it is held by a test of its own below rather than by a row of ROWS.
  'table-list-unreadable': { kinds: ['never'], via: 'unreadable-table-list-callers.test.js' },
  // The alternate key that waited for its table's name column length, when that length could not be set: the stop is as transient as the failure of the length step it wraps
  // (a 429, a lock or a 503 is run again, and the run sets the length and makes the key; a refusal, or a failure that says it must not be retried, is final). Held failure by
  // failure, through the real data-model phase, beside its doubles.
  'alt-key-name-length-not-set': { kinds: ['by-failure'], via: 'table-columns-in-create.test.js' },
  'relationship-name-taken': { kinds: ['never'], via: 'entity-provision.test.js' },
  'view-filter-label-unresolved': { kinds: ['by-failure'], via: 'view-filter-labels.test.js' },
  'pages-locked': { kinds: ['never'] },
  // The build lease (lib/app-operation-lease.js): another build of the app holds the workspace, or a lease handed to an apply is not a live one for it.
  // Running the phases again releases neither, and the refusal quotes the lock's path, which holds the maker's folder.
  'build-locked': { kinds: ['never'] },
  'build-lease-invalid': { kinds: ['never'] },
  'app-header-unpublished': { kinds: ['never'] },
  'app-copy-unpushed-edits': { kinds: ['never'] },
  'sitemap-removal-unapproved': { kinds: ['never'] },
  'reconciled-publish-failed': { kinds: ['by-failure'] },
  'bpf-unique-name-conflict': { kinds: ['never'] },
  'pages-sitemap-read-failed': { kinds: ['by-failure'], via: 'sdk-build.test.js' },
  'pages-removed': { kinds: ['never'], via: 'sdk-build.test.js' },
  'pages-requires-app': { kinds: ['never'], via: PAGES },
  'pages-existence-failed': { kinds: ['by-failure'], via: PAGES },
  // The read of a page a pending create left behind, throttled until the run's budget had no room to wait for it: a run again may find the service ready (the build's loop turns it into the budget's halt).
  'pages-read-throttled': { kinds: ['by-failure'], via: PAGES },
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
  // A connector binding whose connection reference in the environment written to is for another connector (lib/page-binding-targets.js): raised at preflight, before anything is
  // written, and a run again reads the same reference. Held with the doubles of a target environment, under a page name that reads as a transient error.
  'pages-binding-reference-conflict': { kinds: ['never'], via: 'page-bindings.test.js' },
  'security-role-failed': { kinds: ['by-failure'] },
  'role-grant-unresolved': { kinds: ['by-failure'] },
  'role-grant-persona-overlap': { kinds: ['never'] },
  'role-grant-duplicate-target': { kinds: ['never'] },
  'role-grant-failed': { kinds: ['by-failure'] },
  'bpf-role-unresolved': { kinds: ['never'] },
  'bpf-role-grant-failed': { kinds: ['by-failure'] },
  // The build's own loop stops with it when the next wait a throttle costs does not fit the run's budget (build-model-app.js), and the engine's runner when a step would start after the budget refused a wait (entity-provision.js,
  // makeRunner; throttle-engine-stop.test.js): held beside the loop's doubles.
  'throttle-budget-exhausted': { kinds: ['by-failure'], via: 'build-model-app.test.js' },
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
// The failure of the transport as the plugin raises it: the HTTP client throws an Error that carries Node's own code beside the message (when Node gave one), and the SDK keeps it as the cause of its ConnectionError of status 0.
const transportFailure = (words, code) => {
  const thrown = Object.assign(new Error(`Request failed: ${words}`), code ? { code } : {});
  return new ConnectionError(`${ENV}/api/data/v9.2/roles`, 0, thrown.message, thrown);
};
// What Node says when a certificate does not name the host: the names it quotes can be any text, a transport code included.
const ALTNAME_FAILURE = "Hostname/IP does not match certificate's altnames: Host: contoso.crm.dynamics.com. is not in the cert's altnames: DNS:ECONNRESET.example.com";
// The answer to a unique-key violation (SQL 2627) when the value that collided is a name a maker gave, spelled like the deadlock's signature: the platform writes its own diagnostic after the SQL text that quotes the name, and it says 2627.
const ECHOED_UNIQUE_KEY = " Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (Sql Number: 1205). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 2627";
// Failures a run again cannot change, as the SDK, the service and the machine report them — every one with a label that reads as transient where a label can be.
// What `enrichDefaultViews` raises when the publish of the views it saved fails: an SdkError of its own code, the publish error's message inside it, and no cause.
const wrappedPublish = (answer, table = 'contoso_order') => new SdkError('ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `enrichDefaultViews: 2 view(s) on '${table}' were saved but the publish FAILED, so none of them is live (${answer}). Re-publish the entity to make them visible; the saves themselves are unaffected.`);
const unconfirmedResource = (cause) => Object.assign(new Error(`Web resource '${LABEL}' has unconfirmed published content`, cause ? { cause } : undefined), { code: 'WEB_RESOURCE_UNVERIFIED' });
// What the build's engine words around an answer it read with a request of its own (lib/entity-provision.js statusError: a column's length, which table answers to a name, the update of a
// column by its ids): the answer's OData `error` rides on the failure (`answered`), and the rule reads its code as it reads the code the SDK's ConnectionError keeps.
const engineAnswer = (status, message, code) => serviceFailure(`the update of the column was refused (HTTP ${status}: ${message})`, { status, words: `HTTP ${status}: ${message}`, answered: { ...(code ? { code } : {}), message } });
const REFUSALS = [
  ['a refusal in the SDK\'s words', () => new Error('same-name role is managed and cannot be adopted')],
  ['a typed validation error that quotes the label', () => Object.assign(new Error(`View '${LABEL}' is invalid`), { code: 'VALIDATION_ERROR' })],
  ['a 403 from the service whose url carries the label', () => connectionError(403, 'permission denied')],
  ['an unconfirmed web resource whose non-enumerable cause refuses publication (403)', () => unconfirmedResource(connectionError(403, 'permission denied'))],
  ['a local file error that quotes the path', () => Object.assign(new Error(`EACCES: permission denied, open '/work/${LABEL}/page.json'`), { code: 'EACCES', syscall: 'open' })],
  ['an SDK error that wraps a publish the service refused (a 403), on a table called like a timeout', () => wrappedPublish(`HTTP 403 from ${ENV}/api/data/v9.2/PublishXml: permission denied`, 'contoso_sql_timeout')],
  // A logical name has no space, but it can be a word of the rule: `CustomizationLockException` is one word, and `contoso_customizationlockexception` is a valid name.
  ['an SDK error that wraps a publish the service refused (a 403), on a table whose logical name holds a word of the retry rule', () => wrappedPublish(`HTTP 403 from ${ENV}/api/data/v9.2/PublishXml: permission denied`, 'contoso_customizationlockexception')],
  // A status that says no is final: the words of its answer are the maker's as much as the service's (lib/retry-policy.js, rule 5), so a lock or a timeout that only the WORDS name, on a status that is not transient, is not run again.
  ['a lock named only by its words, on a 409', () => connectionError(409, 'CustomizationLockException: another solution install is running')],
  ['SQL timeout named only by its words, under the code every SQL failure shares', () => new ConnectionError(`${ENV}/api/data/v9.2/roles`, 500, 'SQL timeout expired.', { error: { code: '0x80044150', message: 'SQL timeout expired.' } })],
  // A SQL deadlock victim is the generic SQL error code AND the platform's signature in the service's own answer: neither alone is, and a url that quotes the signature is the maker's.
  ['the deadlock signature in a 500 that names no code', () => connectionError(500, 'Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205')],
  ['the generic SQL error code beside another SQL number (a constraint), on a url that quotes the deadlock signature', () => new ConnectionError(`${ENV}/api/data/v9.2/roles?$filter=name eq 'Sql Number: 1205'`, 500, ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 547', { error: { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 547' } })],
  ['the generic SQL error code beside a unique-key violation (2627) whose message quotes a name spelled like the deadlock signature', () => new ConnectionError(`${ENV}/api/data/v9.2/roles`, 500, ECHOED_UNIQUE_KEY, { error: { code: '0x80044150', message: ECHOED_UNIQUE_KEY } })],
  ['a 403 whose answer names a privilege derived from a table called like a lock', () => new ConnectionError(`${ENV}/api/data/v9.2/roles`, 403, 'Principal user is missing prvReadcontoso_customizationlockexception privilege.', { error: { code: '0x80040220', message: 'Principal user is missing prvReadcontoso_customizationlockexception privilege.' } })],
  // A certificate that does not verify is a fact about this machine's trust store: its names quote anything, and no word in them — a reset, a timeout — makes it a blip. Decided by Node's code when the error carries one, and by the certificate's own phrases when it does not.
  ['a certificate that does not name the host, whose alternative name spells a transport code (Node\'s code on the error)', () => transportFailure(ALTNAME_FAILURE, 'ERR_TLS_CERT_ALTNAME_INVALID')],
  ['the same failure from a transport that reports no code', () => transportFailure(ALTNAME_FAILURE)],
  // An answer the engine read itself is judged as the SDK's: a status that says no is final, and a code merely NAMED in its words, or a deadlock's number that a name quotes, is not the code.
  ['an answer the engine read itself: a 400 under a code that names no condition, whose words say to try again', () => engineAnswer(400, `The attribute ${LABEL} cannot be changed right now. Please try again later.`, '0x80040203')],
  ['an answer the engine read itself: a 500 whose message names the SQL timeout\'s code under another code', () => engineAnswer(500, 'An unexpected error occurred (0x80044151). SQL timeout expired.', '0x80040216')],
  ['an answer the engine read itself: the generic SQL error code beside a unique-key violation whose message quotes the deadlock signature', () => engineAnswer(500, ECHOED_UNIQUE_KEY, '0x80044150')],
];
// Failures that ARE the service's to say, whatever anything is called.
const GENUINE = [
  ['a 503', () => connectionError(503, 'The service is unavailable.')],
  ['a 429', () => connectionError(429, 'Too many requests.')],
  ['a reset of the connection', () => connectionError(0, 'Request failed: read ECONNRESET')],
  ['an unconfirmed web resource whose non-enumerable cause is a refused publish (429)', () => unconfirmedResource(connectionError(429, 'another customization is running'))],
  ['an unconfirmed web resource whose published read-back differs, with no cause', () => unconfirmedResource()],
  ['an SDK error that wraps a publish the service could not take (a 503)', () => wrappedPublish(`HTTP 503 from ${ENV}/api/data/v9.2/PublishXml: Service Unavailable`)],
  ['an SDK error that wraps a publish the service throttled (a 429), on a table whose logical name holds a word of the retry rule', () => wrappedPublish(`HTTP 429 from ${ENV}/api/data/v9.2/PublishXml: Too many requests.`, 'contoso_customizationlockexception')],
  ['an SDK error that wraps a publish the service refused for a customization lock, which is a throttle (a 429), in its words', () => wrappedPublish(`HTTP 429 from ${ENV}/api/data/v9.2/PublishXml: CustomizationLockException: another solution install is running`)],
  // A condition the service names by the code of its answer is run again on any status.
  ['a customization lock, named by the code of its answer', () => new ConnectionError(`${ENV}/api/data/v9.2/roles`, 409, 'Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment.', { error: { code: '0x8004F064', message: 'Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment.' } })],
  ['SQL giving up waiting, named by the code of its answer', () => new ConnectionError(`${ENV}/api/data/v9.2/roles`, 500, 'SQL timeout expired.', { error: { code: '0x80044151', message: 'SQL timeout expired.' } })],
  // SQL chose the request as a deadlock victim and rolled it back: the generic SQL error code, and the platform's signature in the service's own answer.
  ['a SQL deadlock victim, named by the generic SQL error code and the platform\'s signature in its answer', () => new ConnectionError(`${ENV}/api/data/v9.2/roles`, 500, ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205', { error: { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205' } })],
  ['a reset of the connection, with Node\'s code on the error the client raised', () => transportFailure('read ECONNRESET', 'ECONNRESET')],
  // The same conditions in an answer the engine read with a request of its own: the code of that answer rides on the engine's failure, and is read as the SDK's is.
  ['an answer the engine read itself: a customization lock, named by the code of its answer', () => engineAnswer(409, 'Cannot start the requested operation [Update] because there is another [EntityCustomization] running at this moment.', '0x8004F064')],
  ['an answer the engine read itself: SQL giving up waiting, named by the code of its answer', () => engineAnswer(500, 'SQL timeout expired.', '0x80044151')],
  ['an answer the engine read itself: a SQL deadlock victim, the generic SQL error code and the platform\'s signature in its own message', () => engineAnswer(500, ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205', '0x80044150')],
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
  // Raised by the real entries: a second apply of the app while a first holds its lease, in a folder whose name reads as a transient error; and an
  // apply handed a lease that is no lease — the label itself.
  'build-locked': async () => {
    const workspace = path.join(tempDir('halt-policy-build'), LABEL);
    let halt;
    await buildModelApp(loopSpec(), { apply: true, workspaceDir: workspace, retryDelayMs: 0 }, {
      runBuild: async (s, o) => { halt = await haltOf(() => runSdkBuild(s, { ...o, buildLease: undefined, phases: [] })); return { ok: true, dryRun: false, created: {} }; },
    });
    return halt;
  },
  'build-lease-invalid': () => haltOf(() => runSdkBuild(loopSpec(), { apply: true, workspaceDir: path.join(tempDir('halt-policy-build'), LABEL), buildLease: LABEL, phases: [] })),
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
  assert.strictEqual(isTransientHalt(await wrap(new Error('Sql error: Generic SQL error. Sql Number: 1205'))), true, 'a deadlock victim, in an error with no status');
  assert.strictEqual(isTransientHalt(await wrap(connectionError(500, 'Sql error: Generic SQL error. Sql Number: 1205'))), false, 'the deadlock signature in a 500 that names no code is words, and a status that says no is final: a deadlock victim is the generic SQL error code AND the signature, in the service\'s own answer');
  assert.strictEqual(isTransientHalt(await wrap(new ConnectionError(`${ENV}/api/data/v9.2/roles`, 500, ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205', { error: { code: '0x80044150', message: ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205' } }))), true, 'a deadlock victim the service answered with a 500 is run again: the generic SQL error code and the signature');
  assert.strictEqual(isTransientHalt(await wrap(connectionError(500, 'Internal server error', `${ENV}/api/data/v9.2/x?$filter=name eq '${LABEL}'`))), false, 'a url is not the service\'s words');
});

// The table list the build falls back to when the narrow read of a table is inconclusive, answered with a success that is no list of tables — a sign-in page, here — through the
// guard every SDK a script makes carries (lib/collection-answers.js guardTableLists): the build cannot tell whether the table exists, and stops before any create.
test('halt policy: table-list-unreadable is raised for a table named like a transient error, and is never run again', async () => {
  const { guardTableLists } = require('../lib/collection-answers.js');
  const tableList = guardTableLists({ get: async () => ({ status: 200, headers: {}, body: '<html><title>Sign in to your account</title></html>' }) });
  const provision = {
    dataverse: { get: async () => ({ status: 500, headers: {}, body: { error: { message: 'An unexpected error occurred.' } } }) },
    findTables: () => tableList.get(`${ENV}/api/data/v9.2/EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity`),
  };
  const halt = await haltOf(() => findExistingTable(provision, LABEL));
  assert.strictEqual(halt.code, 'table-list-unreadable');
  assert.strictEqual(halt.recoverable, true, 'a run after signing in again goes on from here');
  assert.strictEqual(isTransientHalt(halt, { spec: loopSpec() }), false, 'a success that is no list of tables is a verdict, whatever the table is called');
  assert.strictEqual(isTransientHalt(new Error(halt.message)), true, 'the control: the halt quotes the table\'s name, and its words alone would have read as transient');
  assert.deepStrictEqual(await attemptsFor(halt), { attempts: 1, retried: 0 }, 'the real retry loop runs the build once');
});

// A push the SDK refused by value, with the code the SDK gave: the halt it becomes follows the failure.
test('halt policy: a push refused by value follows the SDK\'s failure — a code it gave is final, a 503 is run again — and the label cannot change either', () => {
  const push = (error) => { try { requireSuccessfulPush({ saved: false, error }, `view ${LABEL}`); } catch (e) { return e; } return null; };
  assert.strictEqual(isTransientHalt(push(Object.assign(new Error('permanent refusal'), { code: 'VALIDATION_ERROR' }))), false);
  assert.strictEqual(isTransientHalt(push(connectionError(503, 'The service is unavailable.'))), true);
  assert.strictEqual(isTransientHalt(push(connectionError(400, 'Bad request'))), false);
  assert.strictEqual(push(connectionError(503, 'x')).code, 'CONNECTION_ERROR', 'the halt keeps the code the SDK gave, which a phase\'s skipIf matches on');
});

// The SDK's own sentence, from the bundle. `enrichDefaultViews` of a build without --publish picks the table's default views, saves each and publishes them, and when that publish fails it throws an SdkError of
// its own — a sentence that names the table and holds the publish error's message, with no cause. The service's answer is in it and the maker's table is too, and a logical name is any word, with a prefix
// (`contoso_customizationlockexception`): so what the rule reads out of it is checked on the error the real bundle builds, not on one written to look like it. Only what talks to the service is replaced — the saves of the views and
// the publish; the choice of the views and the sentence are the bundle's.
async function bundleWrapper(table, publishError) {
  const views = [0, 1].map((state) => ({
    savedqueryid: `33333333-3333-4333-8333-33333333333${state}`, name: `${state ? 'Inactive' : 'Active'} Items`, canbedeleted: { Value: false }, createdon: '2026-01-01T00:00:00Z',
    fetchxml: `<fetch><entity name="${table}"><filter><condition attribute="statecode" operator="eq" value="${state}"/></filter></entity></fetch>`,
  }));
  const sdk = createMakerSdk({
    instanceUrl: ENV,
    workspaceStorage: createNodeWorkspaceStorage(tempDir('halt-policy-sdk')),
    httpClient: { get: async (url) => { assert.match(url, /\/savedqueries\?/); return { status: 200, headers: {}, body: { value: views } }; } },
  });
  await sdk.initWorkspace();
  sdk.fetchArtifact = async () => ({});
  sdk.updateElement = async () => ({});
  sdk.pushArtifact = async (type, id) => ({ type, id, saved: true });
  sdk.publishArtifact = async () => ({ publish: { kind: 'failed', error: publishError } });
  return sdk;
}
const defaultViewsSpec = (table) => ({
  ...loopSpec(),
  entities: [{ schemaName: table, primaryAttribute: { schemaName: 'contoso_name' }, columns: [{ schemaName: 'contoso_description', displayName: 'Description', type: 'Text' }] }],
});

test('halt policy: the real SDK\'s sentence around a failed publish of the default views is read through — a table called like a lock does not make a 403 run again, a throttle, a lock and a reset still do', async () => {
  const publishUrl = `${ENV}/api/data/v9.2/PublishXml`;
  const CASES = [
    ['a 403', new ConnectionError(publishUrl, 403, 'permission denied'), 1],
    ['a 400', new ConnectionError(publishUrl, 400, 'The request is not valid'), 1],
    ['a 404', new ConnectionError(publishUrl, 404, 'Not found'), 1],
    ['a certificate nobody trusts', new ConnectionError(publishUrl, 0, 'Request failed: unable to verify the first certificate'), 1],
    ['a 429', new ConnectionError(publishUrl, 429, 'Too many requests.'), 4],
    ['a 503', new ConnectionError(publishUrl, 503, 'Service Unavailable'), 4],
    ['a lock, in the service\'s words alone, on a 500 — the wrapped publish carries no code, and a status that says no is final', new ConnectionError(publishUrl, 500, 'CustomizationLockException: another solution install is running'), 1],
    ['a reset of the connection', new ConnectionError(publishUrl, 0, 'Request failed: read ECONNRESET'), 4],
  ];
  for (const table of ['contoso_item', 'contoso_customizationlockexception']) {
    for (const [what, publishError, attempts] of CASES) {
      const enriching = await bundleWrapper(table, publishError);
      const sdk = { enrichDefaultViews: enriching.enrichDefaultViews.bind(enriching) };
      const halt = await buildHalt(defaultViewsSpec(table), sdk, ['views']);
      assert.strictEqual(halt.code, 'ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED', `${what}, ${table}: the halt the runner raises for the SDK's own error`);
      assert.match(halt.cause.message, new RegExp(`^enrichDefaultViews: 2 view\\(s\\) on '${table}' were saved but the publish FAILED, so none of them is live \\(`), `${what}, ${table}: the sentence is the bundle's`);
      assert.strictEqual(isTransientHalt(halt), attempts > 1, `${what}, ${table}`);
      assert.deepStrictEqual(await attemptsFor(halt), { attempts, retried: attempts - 1 }, `${what}, ${table}: how often the real retry loop runs the build`);
    }
  }
});

// The answer a service gives to a READ the real SDK makes — and echoes the table in. The SDK builds its own ConnectionError for it (the status, the url, and the body as its cause), the real views phase raises the halt, and the
// real retry loop is counted: what runs the build four times is what the service said by status or by code, and never a word of an answer that quotes the maker's table.
async function viewsReadFailing(answer) {
  const sdk = createMakerSdk({
    instanceUrl: ENV,
    workspaceStorage: createNodeWorkspaceStorage(tempDir('halt-policy-sdk')),
    httpClient: { get: async () => answer },
  });
  await sdk.initWorkspace();
  return { enrichDefaultViews: sdk.enrichDefaultViews.bind(sdk) };
}
async function attemptsOfTheLoop(spec, sdk, phases) {
  let attempts = 0;
  const lines = [];
  try {
    await buildModelApp(spec, { apply: true, env: ENV, retryDelayMs: 0, appDir: tempDir('halt-policy-app') }, {
      sdk, provisionSdk: sdk, sleep: async () => {}, log: (m) => lines.push(String(m)), warn: () => {}, verify: async () => ({ ok: true }),
      discoverOpDiffState: async () => ({ collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null }),
      runBuild: async (s, o) => { attempts += 1; return runSdkBuild(s, { ...o, phases }); },
    });
  } catch { /* the halt the loop ends with */ }
  return attempts;
}

test('halt policy: the real SDK\'s read of a table called like a lock is run once for a 403, a 400 or a 404 that echoes it — and again for a throttle, an unavailable service and a condition the service names by its code', async () => {
  for (const table of ['contoso_item', 'contoso_customizationlockexception']) {
    const body = (message, code) => ({ error: { ...(code ? { code } : {}), message } });
    const CASES = [
      ['a 403 that names the privilege derived from the table', 403, body(`Principal user is missing prvRead${table} privilege.`), 1],
      ['a 400 that names the table', 400, body(`The entity '${table}' does not contain the specified attribute 'contoso_missing'.`), 1],
      ['a 404 that names the segment', 404, body(`Resource not found for the segment '${table}s'.`), 1],
      ['a 500 whose words say SQL timeout, under the code every SQL failure shares', 500, body('SQL timeout expired.', '0x80044150'), 1],
      ['a 500 under the code every SQL failure shares, beside another SQL number (a constraint)', 500, body(' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 547', '0x80044150'), 1],
      ['a 500 that carries the deadlock signature and no code', 500, body(' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205'), 1],
      ['a 500 that carries the deadlock signature under the code of a missing privilege', 500, body(' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205', '0x80040220'), 1],
      ['a 403 that holds the words of a lock, under the code of a missing privilege', 403, body(`Principal user is missing prvRead${table} privilege. CustomizationLockException: try again later`, '0x80040220'), 1],
      ['a 429', 429, body('Too many requests.'), 4],
      ['a 502', 502, body('Bad gateway'), 4],
      ['a 503', 503, body('Service Unavailable'), 4],
      ['a 504', 504, body('Gateway timeout'), 4],
      ['a 500 the service names as a SQL timeout by its code', 500, body('SQL timeout expired.', '0x80044151'), 4],
      // SQL rolled the request back as a deadlock victim: the generic SQL error code, and the platform's signature in the service's own answer. The build runs again, three times, as it did before the retry read the structure of a failure.
      ['a 500 the service names as a SQL deadlock victim by its code and the platform\'s signature', 500, body(' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205', '0x80044150'), 4],
      // The number that counts is the last the answer gives: a name quoted in the SQL text is not the platform's diagnostic, before another number or before the deadlock's.
      ['a 500 under the code every SQL failure shares whose message quotes a name spelled like the deadlock signature, before the platform\'s own SQL 2627', 500, body(ECHOED_UNIQUE_KEY, '0x80044150'), 1],
      ['the same before the platform\'s own deadlock diagnostic', 500, body(ECHOED_UNIQUE_KEY.replace('Sql Number: 2627', 'Sql Number: 1205'), '0x80044150'), 4],
      ['a 409 the service names as a customization lock by its code', 409, body('Cannot start the requested operation [Publish] because there is another [EntityCustomization] running at this moment.', '0x8004F064'), 4],
    ];
    for (const [what, status, answerBody, attempts] of CASES) {
      const sdk = await viewsReadFailing({ status, headers: {}, body: answerBody });
      assert.strictEqual(await attemptsOfTheLoop(defaultViewsSpec(table), sdk, ['views']), attempts, `${what}, ${table}`);
    }
  }
});

// A persona's role is created by the REAL SDK (`createPersonaRole` posts the role under the persona's name), in the real security phase and the real retry loop. The name a maker gives a persona is the role's name, and a role whose name is
// taken is refused with a SQL unique-key violation (2627) that QUOTES the name: so a persona called `Sql Number: 1205` is in the answer to a failure that no run again can change. The platform's own diagnostic comes after the name.
async function personaRoleRefused(label, messageFor) {
  const businessUnit = '44444444-4444-4444-8444-444444444444';
  const names = [];
  const sdk = createMakerSdk({
    instanceUrl: ENV,
    workspaceStorage: createNodeWorkspaceStorage(tempDir('halt-policy-sdk')),
    httpClient: {
      get: async (url) => {
        if (/businessunits/i.test(url)) return { status: 200, headers: {}, body: { value: [{ businessunitid: businessUnit }] } };
        const table = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(String(url));
        if (table) return { status: 200, headers: {}, body: { LogicalName: table[1], Privileges: [{ PrivilegeId: table[1] === 'appmodule' ? '33333333-3333-4333-8333-333333333333' : '11111111-1111-4111-8111-111111111111', Name: `prvRead${table[1]}`, PrivilegeType: 'Read', CanBeBasic: true, CanBeLocal: true, CanBeDeep: true, CanBeGlobal: true }] } };
        return { status: 200, headers: {}, body: { value: [] } };
      },
      post: async (url, body) => {
        assert.match(String(url), /\/roles$/, 'the only write the security phase makes here is the role');
        names.push(body.name);
        return { status: 500, headers: {}, body: { error: { code: '0x80044150', message: messageFor(body.name) } } };
      },
    },
  });
  await sdk.initWorkspace();
  const engine = { queryRecords: async (entity) => (entity === 'businessunit' ? [{ businessunitid: businessUnit }] : []), createPersonaRole: sdk.createPersonaRole.bind(sdk) };
  const attempts = await attemptsOfTheLoop(orderSpec({ personas: [persona(label)] }), engine, ['security']);
  return { attempts, sends: names.length, names };
}

test('halt policy: a persona named like the deadlock signature does not make the unique-key violation its role gets a deadlock — through the real SDK\'s role create, the real security phase and the real loop — while a genuine deadlock still runs the phase again', async () => {
  const unique = (name) => ` Sql error: Violation of UNIQUE KEY constraint 'ndx_name'. Cannot insert duplicate key. The duplicate key value is (${name}). CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 2627`;
  const constraint = (name) => unique(name).replace('Sql Number: 2627', 'Sql Number: 547');
  const deadlock = () => ' Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205';
  const CASES = [
    ['an ordinary name, a unique-key violation (SQL 2627)', 'Dispatcher', unique, 1],
    ['a name spelled like the deadlock signature, a unique-key violation (SQL 2627)', 'Sql Number: 1205', unique, 1],
    ['the same name, a constraint (SQL 547)', 'Sql Number: 1205', constraint, 1],
    ['an ordinary name, a genuine deadlock (SQL 1205)', 'Dispatcher', deadlock, 4],
    ['a name spelled like the deadlock signature, a genuine deadlock (SQL 1205)', 'Sql Number: 1205', deadlock, 4],
  ];
  for (const [what, label, messageFor, attempts] of CASES) {
    const out = await personaRoleRefused(label, messageFor);
    assert.ok(out.names.length > 0 && out.names.every((name) => name.includes(label)), `${what}: the real SDK sent the name the maker gave`);
    assert.strictEqual(out.attempts, attempts, `${what}: how often the real loop runs the security phase`);
    assert.strictEqual(out.sends, attempts, `${what}: one role create for each`);
  }
});

// The transport's own failures, through the PRODUCTION HTTP client, the real SDK (which wraps what the client throws in a ConnectionError of status 0 and keeps it as the cause) and the real retry loop. A certificate that does not verify
// quotes the names it carries, and a name can spell a transport code: it is a fact about this machine, never a blip — by Node's code when the transport gave one, and by the certificate's own phrases when it did not.
test('halt policy: a certificate failure whose names spell a transport code is run once through the real HTTP client, the real SDK and the real loop — and a reset, with or without Node\'s code, is run again', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const CASES = [
    ['a certificate that does not name the host, with its code', { error: ALTNAME_FAILURE, code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 1],
    ['the same failure from a transport that reports no code', { error: ALTNAME_FAILURE }, 1],
    ['a certificate nobody trusts', { error: 'unable to verify the first certificate', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 1],
    ['an unknown host', { error: 'getaddrinfo ENOTFOUND contoso.invalid', code: 'ENOTFOUND' }, 1],
    ['a reset, with its code', { error: 'read ECONNRESET', code: 'ECONNRESET' }, 4],
    ['a reset, from a transport that reports no code', { error: 'read ECONNRESET' }, 4],
  ];
  for (const table of ['contoso_item', 'contoso_customizationlockexception']) {
    for (const [what, failure, attempts] of CASES) {
      const httpClient = createAzHttpClient(ENV, { getToken: () => 'TOK', sleep: async () => {}, random: () => 0, request: async () => failure });
      const sdk = createMakerSdk({ instanceUrl: ENV, workspaceStorage: createNodeWorkspaceStorage(tempDir('halt-policy-sdk')), httpClient });
      await sdk.initWorkspace();
      const enriching = { enrichDefaultViews: sdk.enrichDefaultViews.bind(sdk) };
      assert.strictEqual(await attemptsOfTheLoop(defaultViewsSpec(table), enriching, ['views']), attempts, `${what}, ${table}`);
    }
  }
});

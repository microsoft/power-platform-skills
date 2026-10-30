'use strict';
// Removing an app from a persona's role (`appAccess: false`) over the REAL bundle and a stateful fake environment: the
// build's ensureAppNotAvailableToRole (lib/sdk-build.js) sends the SDK's disassociateRecords, a DELETE of the
// `appmoduleroles_association/$ref` link. Pinned: the link really goes; a link already gone (404) is the state asked for
// and the build succeeds; a refusal (403) or an answer that says nothing (a dropped connection) is never read as removed —
// not even a refusal worded like a missing row: only a 404, or a 400 / status-less failure that says the link is missing,
// is "already gone". Otherwise the build fails and says so, so a persona never silently keeps an app it was meant to lose.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness } = require('./helpers/lifecycle-harness.js');

const UNLINK = /\/appmodules\([^)]+\)\/appmoduleroles_association(?:\([^)]+\))?\/\$ref/;

function spec(appAccess) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoAccess', displayName: 'Contoso Access', publisherPrefix: 'contoso' },
    app: { name: 'Access Probe', description: 'An app a persona gains and loses.' },
    entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    appShell: { areas: [{ label: 'Work', groups: [{ label: 'Work', subAreas: [{ entity: 'contoso_ticket', title: 'Tickets' }] }] }] },
    personas: [{ persona: 'Ticket Reader', ...(appAccess ? {} : { appAccess: false }), jobs: [{ name: 'Read tickets', privileges: [{ entity: 'contoso_ticket', access: ['read'], scope: 'user' }] }] }],
  };
}

// The fake environment, with the unlink's answer replaced by `answer` (a response, or a thrown error) when one is given.
function setUp() {
  const org = createLifecycleOrg();
  const sent = [];
  let mode = null;
  const request = async (req) => {
    if (req.method === 'DELETE' && UNLINK.test(decodeURIComponent(req.url))) {
      sent.push(req.method);
      if (mode === 'refuse') return { statusCode: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040220', message: 'Principal user is missing prvWriteAppModule privilege.' } }) };
      if (mode === 'gone') return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040217', message: 'The association does not exist.' } }) };
      if (mode === 'refuse-worded') return { statusCode: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040220', message: 'The role does not exist in the business unit of the caller.' } }) };
      if (mode === 'drop') { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
      if (mode && typeof mode === 'object') {
        // A failure with no HTTP answer: the request itself throws, carrying only its words.
        if (mode.status == null) { const e = new Error(mode.message); if (mode.code) e.code = mode.code; throw e; }
        return { statusCode: mode.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: mode.code || '0x80040216', message: mode.message } }) };
      }
    }
    return org.request(req);
  };
  const wrapped = Object.create(org);
  wrapped.request = request;
  const root = makeTempDir('app-access-unlink-');
  const harness = createLifecycleHarness(wrapped, root);
  return { org, harness, sent, answer: (m) => { mode = m; } };
}

// Whether the app is linked to the persona's role, as the environment holds it.
async function linked(harness, org) {
  const res = await harness.client.get(`${org.origin}/api/data/v9.0/roles?$select=roleid&$filter=name eq 'Ticket Reader' and appmoduleroles_association/any(a:a/uniquename eq 'contoso_AccessProbe')`);
  const rows = (res && res.body && res.body.value) || [];
  return rows.length > 0;
}

async function buildOk(h, appAccess) {
  const { result } = await h.harness.build(spec(appAccess), { sampleData: false, verify: false });
  return result;
}

test('appAccess false removes the link; a link already gone is success', { timeout: 300000 }, async () => {
  const h = setUp();
  const first = await buildOk(h, true);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(await linked(h.harness, h.org), true, 'the persona got the app');

  const removed = await buildOk(h, false);
  assert.equal(removed.ok, true, JSON.stringify(removed.errors));
  assert.equal(h.sent.length, 1, 'one DELETE $ref');
  assert.equal(await linked(h.harness, h.org), false, 'the link is gone');

  h.answer('gone');
  const again = await buildOk(h, false);
  assert.equal(again.ok, true, '404: the link is already gone, which is the state asked for');
  assert.equal(h.sent.length, 2, 'the re-run sent the DELETE and read its 404 as done');
});

for (const [mode, what] of [['refuse', 'a 403'], ['refuse-worded', 'a 403 worded like a missing row'], ['drop', 'a dropped connection']]) {
  test(`${what} on the unlink fails the build and the link stays`, { timeout: 300000 }, async () => {
    const h = setUp();
    const first = await buildOk(h, true);
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    h.answer(mode);
    // The build halts (BuildHalt) on the security phase rather than returning a result that says it removed the link.
    await assert.rejects(buildOk(h, false), (err) => err.name === 'BuildHalt' && /^security failed:/.test(err.message) && /appmoduleroles_association/.test(err.message));
    assert.ok(h.sent.length >= 1);
    assert.equal(await linked(h.harness, h.org), true, 'the environment still links the app: nothing pretends otherwise');
  });
}

// Only a 404, or a 400 / status-less failure whose words or Dataverse code say the link is missing, is "already gone".
// Every other status is an error whatever its words say: a refusal, a conflict, a throttle or a server failure that
// happens to read "not found" must never let a persona keep an app it was meant to lose.
const ROWS = [
  [true, { status: 404, message: 'Not Found' }],
  [true, { status: 400, code: '0x80040217', message: 'Bad request' }],
  [true, { status: 400, message: 'The association does not exist.' }],
  [false, { status: 403, code: '0x80040220', message: 'The role does not exist in the business unit of the caller.' }],
  [false, { status: 401, message: 'Token not found.' }],
  [false, { status: 409, message: 'Record not found in the batch.' }],
  [false, { status: 412, message: 'Row not found at that version.' }],
  [false, { status: 429, code: '0x80040217', message: 'Too many requests.' }],
  [false, { status: 500, message: 'Plugin not found.' }],
  [false, { status: 503, code: '0x80040217', message: 'Service unavailable.' }],
  [false, { status: 403, code: '0x80040220', message: 'Principal user is missing prvWriteAppModule privilege.' }],
  [false, { status: 400, message: 'Bad request' }],
  // A transport failure (the bundle raises it with status 0) says nothing about the link, whatever its words.
  [false, { status: null, message: 'The association does not exist.' }],
  [false, { status: null, message: 'The connection was closed.' }],
];

test('the unlink reads "already gone" only from a 404, or a 400 that says so', { timeout: 900000 }, async () => {
  const h = setUp();
  const first = await buildOk(h, true);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const wrong = [];
  for (const [benign, answer] of ROWS) {
    h.answer(answer);
    let outcome;
    try {
      const r = await buildOk(h, false);
      outcome = r.ok ? 'ok' : 'not ok';
    } catch (err) {
      outcome = err.name === 'BuildHalt' && /^security failed:/.test(err.message) && /appmoduleroles_association/.test(err.message) ? 'halt' : `other: ${err.message}`;
    }
    if (outcome !== (benign ? 'ok' : 'halt')) wrong.push(`${JSON.stringify(answer)} -> ${outcome}`);
    // The fake never removes the link for a canned answer, so it is still there for the next row.
    assert.equal(await linked(h.harness, h.org), true);
  }
  assert.deepEqual(wrong, []);
});
'use strict';
// The command-bar customisations of an app's tables in the download's "not round-tripped" report — over the REAL vendored SDK, the
// plugin's own HTTP client and the stateful fake Dataverse the lifecycle tests share (helpers/fake-lifecycle-org.js).
//
// A download does not reconstruct `commands[]`, and its report of what it leaves out named forms, views, charts, business rules and
// global choices but never a command: nothing read them. A rebuild of the spec in another environment then made the app without its
// command-bar buttons, and nothing had said so. The download now reads the modern commands (`appaction` rows) of the app's tables and
// names the ones that are the app's — table-scoped, or scoped to this app; unmanaged; not a Group container; active — by table and label,
// in its NOTE, in `notRoundTripped` and in the spec's `descriptionInventory`. A read that fails is reported as a class that could not be
// inventoried, never as "no commands". The cases pin what it names and leaves out, the one read it adds, and the failure.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { createLifecycleHarness, seedForeignWork, appUniqueName, FOREIGN } = require('./helpers/lifecycle-harness.js');
const { validateAppSpec } = require('../lib/app-spec.js');

const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'ContosoTickets', displayName: 'Contoso Tickets', publisherPrefix: 'contoso' },
  app: { name: 'Tickets' },
  entities: [{ schemaName: 'contoso_ticket', displayName: 'Ticket', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
  webResources: [{ name: 'contoso_ticket.js', displayName: 'Ticket Scripts', type: 'js', content: 'var Ticket = { escalate: function () {} };' }],
  commands: [{ entity: 'contoso_ticket', label: 'Escalate', location: 'MainTab', library: 'contoso_ticket.js', function: 'Ticket.escalate' }],
  appShell: { areas: [{ label: 'Work', groups: [{ label: 'Tickets', subAreas: [{ entity: 'contoso_ticket', title: 'Tickets' }] }] }] },
};

const ran = (step, label) => {
  assert.ok(step, `${label} ran`);
  if (step.error) throw step.error;
  assert.deepEqual(step.unexpected, [], `every request ${label} sent is one the fake models`);
  return step;
};

// The environment, with the app built and then commands made in Maker beside the build's: one scoped to this app, and the ones that are
// not the app's — another app's, a managed one, one on a table the app does not hold, an inactive one, and a Group container. `refuse`
// answers the next reads of appactions with a 403.
async function environment() {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const seen = { refuseCommands: false };
  const request = async (req) => {
    if (seen.refuseCommands && req.method === 'GET' && /\/appactions\?/.test(req.url)) {
      return { statusCode: 403, headers: { 'content-type': 'application/json; odata.metadata=minimal' }, body: JSON.stringify({ error: { code: '0x80040220', message: 'Principal user is missing prvReadAppAction privilege.' } }) };
    }
    return org.request(req);
  };
  const root = makeTempDir('download-commands-');
  const harness = createLifecycleHarness({ ...org, request }, root);
  const build = ran(await harness.measure(() => harness.build(spec)), 'the build');
  assert.equal(build.value.result.ok, true, JSON.stringify(build.value.result.errors));
  const app = org.find('appmodules', (a) => a.uniquename === appUniqueName(spec))[0];
  const inMaker = async (row) => {
    const res = await org.request({ url: `${org.API}/appactions`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: 1, location: 0, type: 0, uniquename: `contoso_${row.name}`, ...row }) });
    assert.ok(res.statusCode < 300, `${res.statusCode}: ${res.body}`);
  };
  await inMaker({ name: 'approve', buttonlabeltext: 'Approve', contextvalue: 'contoso_ticket', 'appmoduleid@odata.bind': `/appmodules(${app.appmoduleid})` });
  await inMaker({ name: 'otherapp', buttonlabeltext: 'Other app only', contextvalue: 'contoso_ticket', 'appmoduleid@odata.bind': `/appmodules(${FOREIGN.app})` });
  await inMaker({ name: 'managed', buttonlabeltext: 'Shipped with a solution', contextvalue: 'contoso_ticket', ismanaged: true });
  await inMaker({ name: 'widget', buttonlabeltext: 'On another table', contextvalue: 'fabrikam_widget' });
  await inMaker({ name: 'retired', buttonlabeltext: 'Retired', contextvalue: 'contoso_ticket', statecode: 1, statuscode: 2 });
  await inMaker({ name: 'group', grouptitle: 'Actions', contextvalue: 'contoso_ticket', type: 3 });
  return { org, root, harness, seen };
}
let envP;
const env = () => envP || (envP = environment());
const appactionReads = (org, mark, end) => org.requests.slice(mark, end).filter((r) => r.method === 'GET' && /^\/appactions\?/.test(r.path));

test('commands: the download names the command-bar buttons that are the app\u2019s — table-scoped or this app\u2019s — and no other', async () => {
  const e = await env();
  const out = path.join(e.root, 'download');
  const s = ran(await e.harness.measure(() => e.harness.download(appUniqueName(spec), out)), 'the download');
  const { emitted, stderr, spec: downloaded } = s.value;
  assert.equal(emitted.ok, true, JSON.stringify(emitted));
  assert.deepEqual(s.writes, {}, 'a download writes nothing to the environment');
  const summary = emitted.payload.notRoundTripped;
  assert.deepEqual(summary.classes.find((c) => c.kind === 'commands'), { kind: 'commands', count: 2, label: 'command' });
  assert.deepEqual(summary.entities.find((x) => x.entity === 'contoso_ticket').commands, ['Approve', 'Escalate']);
  assert.ok(!summary.incomplete, JSON.stringify(summary.incomplete));
  assert.deepEqual((downloaded.descriptionInventory.commands || []).map((c) => `${c.entity}: ${c.name}`), ['contoso_ticket: Approve', 'contoso_ticket: Escalate'], 'the spec lists them, as the NOTE says');
  assert.match(stderr, /NOTE: this download does not reconstruct forms\[\], views\[\], commands\[\]/);
  assert.match(stderr, /contoso_ticket — .*commands: Approve, Escalate/);
  assert.deepEqual(downloaded.commands, [], 'and the spec still carries none');
  assert.deepEqual(validateAppSpec(downloaded, { profile: 'plan', reconstructed: true }).errors, []);
  // One read of the app's tables' commands, unmanaged only, by table.
  const reads = appactionReads(e.org, s.mark, s.end);
  assert.equal(reads.length, 1);
  const query = new URL(reads[0].path, e.org.origin).searchParams;
  assert.equal(query.get('$filter'), "ismanaged eq false and (contextvalue eq 'contoso_ticket')");
  assert.equal(query.get('$select'), 'appactionid,name,buttonlabeltext,contextvalue,type,statecode,_appmoduleid_value');
});

test('commands: a read of the commands that fails is reported as a class the download could not inventory — never as "no commands" — and the download goes on', async () => {
  const e = await env();
  e.seen.refuseCommands = true;
  try {
    const s = ran(await e.harness.measure(() => e.harness.download(appUniqueName(spec), path.join(e.root, 'refused'))), 'the download');
    const { emitted, stderr, spec: downloaded } = s.value;
    assert.equal(emitted.ok, true, 'the inventory is a report, never a gate');
    const summary = emitted.payload.notRoundTripped;
    assert.ok(!summary.classes.some((c) => c.kind === 'commands'));
    assert.deepEqual(summary.incomplete.map((i) => i.kind), ['commands']);
    assert.match(summary.incomplete[0].reason, /403|prvReadAppAction/);
    assert.match(stderr, /could NOT be inventoried[\s\S]*commands — /);
    assert.equal((downloaded.descriptionInventory || {}).commands, undefined);
  } finally {
    e.seen.refuseCommands = false;
  }
});

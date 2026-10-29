'use strict';
// THE REQUEST TRAIL OF THE WHOLE LIFECYCLE, pinned request by request, over the REAL vendored SDK.
//
// lifecycle-matrix-real-bundle.test.js pins what each phase WRITES (a count per `METHOD resource`) and what it PUBLISHES, and holds its
// reads under a ceiling. That leaves three kinds of change invisible: a read added or removed under the ceiling (a new SDK that reads an
// app's token once more after each update), a body that gains or loses a member (a view update that now sends `returnedtypecode`, a date
// column that now states its behaviour), and requests that reorder. Each is a change a maker can observe — in the requests the
// environment sees, its audit and its throttling budget — and at an SDK uptake each must be explained by a release-note line. This file
// makes every such change fail a named test with a precise diff instead of being found by luck or on a live environment.
//
// The lifecycle is the kitchen-sink App Spec (helpers/lifecycle-harness.js) over the stateful fake Dataverse
// (helpers/fake-lifecycle-org.js), with another maker's work in the environment first, run as a maker runs it:
//   build     first build (--apply --publish --sample-data --verify)
//   rebuild   the same spec, unchanged
//   edit      a rebuild of an EDITED spec: a column added to two tables (one a Date and Time column), a view's columns and another
//             view's description changed, the app's description changed and the page's source changed
//   download  the app downloaded to a spec
//   verify    the edited spec verified
//   teardown  the edited spec torn down
//
// Each phase's golden (scripts/tests/golden/lifecycle-trail.<phase>.txt) lists every HTTP request: method, path with query (GUIDs and
// timestamps masked), the SHAPE of its body — member names and value types, never values: `{name:string,type:number}` — by a short hash
// into the legend at the end, and the status the fake answered; a `$batch` lists its operations, in their order, below it. The requests
// are cut into SEGMENTS by the phase's publishes (each PublishXml, with what it names, is a segment's last line), and the segments are
// in order: a write that moves to the other side of a publish — so that the publish no longer makes it live, or makes it live early —
// is a difference. WITHIN a segment the requests are listed sorted and counted (`3x GET …`), not in the order they were sent: the build
// creates and enriches the views of different tables concurrently, and measured over eight runs under load the interleaving of those
// requests varied (one run in two) while the multiset of every segment never did. So what is pinned is: the exact multiset of requests
// (with query, body shape and status), the order and content of the publishes, and which publish each request precedes. What is NOT
// pinned is the order of two requests between the same two publishes — the fake refuses a request out of dependency order (a column of
// a table not yet created), and the lifecycle tests prove what each phase leaves behind.
//
// WHEN THIS FAILS: the message prints, per phase, the requests added and removed (counted by `METHOD resource`) and the first lines where
// the golden differs. Every difference must be explained — at an SDK uptake, by a release-note line (`Changed` for a behaviour, `Fixed`
// for a bug the new SDK fixes); in a skill change, by the change. Then regenerate the goldens and review their diff:
//   UPDATE_GOLDENS=1 node --test scripts/tests/lifecycle-trail-golden-real-bundle.test.js
// (PowerShell: `$env:UPDATE_GOLDENS='1'; node --test …; Remove-Item Env:UPDATE_GOLDENS`.)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createLifecycleOrg } = require('./helpers/fake-lifecycle-org.js');
const { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, publishesOf, appUniqueName } = require('./helpers/lifecycle-harness.js');
const { GOLDEN_DIR, UPDATE } = require('./helpers/golden.js');

const PHASES = ['build', 'rebuild', 'edit', 'download', 'verify', 'teardown'];
const goldenFile = (phase) => path.join(GOLDEN_DIR, `lifecycle-trail.${phase}.txt`);

// The fake mints GUIDs for every row it creates, and the SDK mints some of its own (a page's conversation messages): masked, so the
// golden pins what is asked for and not which id it was given. A timestamp in a query (a modifiedon filter) likewise.
const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?/g;
const mask = (text) => String(text).replace(GUID, '<id>').replace(TIMESTAMP, '<time>');

// A body's shape: member names and value types, recursively — `{AttributeType:string,MaxLength:number,DateTimeBehavior:{Value:string}}`.
// An array is the sorted set of its elements' shapes, so a list of three columns and of four is the same shape (the count shows as
// requests). A raw body (a page file's content) is `string`/`bytes`.
function shape(value) {
  if (value === null) return 'null';
  if (Buffer.isBuffer(value)) return 'bytes';
  if (Array.isArray(value)) return `[${[...new Set(value.map(shape))].sort().join('|')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${mask(key)}:${shape(value[key])}`).join(',')}}`;
  return typeof value;
}

// One phase's golden text, and the shapes its lines refer to by hash (a hash, not a running number, so one new shape does not renumber
// every later line of the diff).
function trailOf(org, step) {
  const legend = new Map();
  const ref = (body) => {
    if (body === undefined) return '';
    const s = shape(body);
    const hash = crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
    legend.set(hash, s);
    return ` #${hash}`;
  };
  const publishes = publishesOf(org, step);
  const segments = [[]];
  for (const r of org.requests.slice(step.mark, step.end)) {
    const unit = [`${r.method} ${mask(r.path)}${r.operations ? '' : ref(r.body)} -> ${r.status}`];
    for (const op of r.operations || []) unit.push(`      > ${op.method} ${mask(op.path)}${ref(op.body)}`);
    segments[segments.length - 1].push(unit.join('\n'));
    if (r.path === '/PublishXml') segments.push([]);
  }
  const lines = [`# ${step.end - step.mark} requests, ${publishes.length} publishes`];
  segments.forEach((units, i) => {
    if (i === segments.length - 1 && !units.length) return;
    lines.push(i < publishes.length ? `## up to publish ${i + 1}: ${publishes[i]}` : '## after the last publish');
    const counts = new Map();
    for (const unit of units) counts.set(unit, (counts.get(unit) || 0) + 1);
    for (const unit of [...counts.keys()].sort()) lines.push(`${String(counts.get(unit)).padStart(3)}x ${unit}`);
  });
  const legendLines = [...legend].sort(([a], [b]) => a.localeCompare(b)).map(([hash, s]) => `#${hash} ${s}`);
  return [...lines, '# shapes', ...legendLines].join('\n') + '\n';
}

// The edits of the `edit` phase: one of each kind a maker makes most, each an existing artifact the build changes in place.
function editedSpec() {
  const spec = kitchenSinkSpec();
  spec.app.description = 'One app that uses every feature, edited.';
  spec.entities.find((e) => e.schemaName === 'contoso_tag').columns.push({ schemaName: 'contoso_color', displayName: 'Color', type: 'Text', maxLength: 50 });
  spec.entities.find((e) => e.schemaName === 'contoso_task').columns.push({ schemaName: 'contoso_start', displayName: 'Start', type: 'DateTime' });
  spec.views.find((v) => v.name === 'Open Tasks').columns.push('contoso_done');
  spec.views.find((v) => v.name === 'Open Projects').description = 'Projects still running, edited.';
  return spec;
}
const EDITED_PAGE_SOURCE = "import * as React from 'react';\nexport default function KitchenPage() { return <div>Kitchen, edited</div>; }\n";

let lifecycleP;
const lifecycle = () => lifecycleP || (lifecycleP = runLifecycle());
async function runLifecycle() {
  const org = createLifecycleOrg();
  const harness = createLifecycleHarness(org, makeTempDir('lifecycle-trail-'));
  await seedForeignWork(org);
  const spec = kitchenSinkSpec();
  const edited = editedSpec();
  const out = { org, steps: {} };
  const stage = async (phase, fn) => { out.steps[phase] = await harness.measure(fn); };
  await stage('build', () => harness.build(spec));
  await stage('rebuild', () => harness.build(spec));
  fs.writeFileSync(path.join(harness.appDir, 'KitchenPage.tsx'), EDITED_PAGE_SOURCE);
  await stage('edit', () => harness.build(edited));
  await stage('download', () => harness.download(appUniqueName(edited), path.join(harness.appDir, '..', 'download')));
  await stage('verify', () => harness.verify(edited));
  await stage('teardown', () => harness.teardown(edited));
  return out;
}

// `METHOD resource` counts of a golden's requests (a `$batch`'s operations counted too, marked), for the summary of a difference: the
// resource as lifecycle-matrix-real-bundle.test.js names it, keys and query left out ("GET appmodules", "PATCH savedqueries").
//   " 17x POST /AddSolutionComponent #3c0a1b2d -> 200"    a request, sent 17 times in its segment
//   "      > PATCH /uxagentprojectfiles(<id>)/filecontent #…"   an operation of the `$batch` above it, once per time that batch was sent
function countsOf(text) {
  const counts = new Map();
  let times = 0;
  const add = (key, n) => counts.set(key, (counts.get(key) || 0) + n);
  const resourceOf = (where) => where.replace(/\?.*$/, '').replace(/^\//, '').replace(/\((?:[^()']|'[^']*')*\)/g, '');
  for (const line of text.split('\n')) {
    const request = /^\s*(\d+)x (GET|POST|PATCH|PUT|DELETE) (\S+)/.exec(line);
    if (request) { times = Number(request[1]); add(`${request[2]} ${resourceOf(request[3])}`, times); continue; }
    const operation = /^\s+> (GET|POST|PATCH|PUT|DELETE) (\S+)/.exec(line);
    if (operation) add(`(in a $batch) ${operation[1]} ${resourceOf(operation[2])}`, times);
  }
  return counts;
}

// A golden's requests as `segment heading -> request (its body shapes written out, its batch operations under it) -> count`, and its
// publishes, so two goldens can be compared request by request whatever the hashes and line numbers.
function unitsOf(text) {
  const lines = text.split('\n');
  const legend = new Map(lines.filter((l) => /^#[0-9a-f]{8} /.test(l)).map((l) => [l.slice(0, 9), l.slice(10)]));
  const spell = (line) => line.replace(/#[0-9a-f]{8}\b/g, (hash) => legend.get(hash) || hash);
  const units = new Map();
  const publishes = [];
  let heading = '';
  let current = null;
  for (const line of lines) {
    if (line === '# shapes') break;
    if (line.startsWith('## ')) { heading = line.slice(3); const m = /^up to publish \d+: (.*)$/.exec(heading); if (m) publishes.push(m[1]); continue; }
    const request = /^\s*(\d+)x (.*)$/.exec(line);
    if (request) { current = { key: `${heading}\n    ${spell(request[2])}`, count: Number(request[1]) }; units.set(current.key, (units.get(current.key) || 0) + current.count); continue; }
    if (current && /^\s+> /.test(line)) {
      // An operation belongs to the batch above it: re-key that unit with the operation appended.
      const count = units.get(current.key) - current.count;
      if (count) units.set(current.key, count); else units.delete(current.key);
      current.key = `${current.key}\n      ${spell(line.trim())}`;
      units.set(current.key, (units.get(current.key) || 0) + current.count);
    }
  }
  return { units, publishes };
}

// What a reader needs to explain a difference: the requests added and removed by `METHOD resource`, the publishes if they changed, and
// each request that is in one golden and not (as often) in the other, in its segment, with its body shapes written out.
function describeDifference(phase, expected, actual) {
  const before = countsOf(expected);
  const after = countsOf(actual);
  const moved = [...new Set([...before.keys(), ...after.keys()])].sort()
    .map((key) => [key, (after.get(key) || 0) - (before.get(key) || 0)]).filter(([, delta]) => delta !== 0)
    .map(([key, delta]) => `    ${delta > 0 ? '+' : ''}${delta} ${key}`);
  const was = unitsOf(expected);
  const now = unitsOf(actual);
  const clip = (text) => text.split('\n').map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)).join('\n');
  const changed = [...new Set([...was.units.keys(), ...now.units.keys()])].sort()
    .filter((key) => (was.units.get(key) || 0) !== (now.units.get(key) || 0))
    .map((key) => `  [${was.units.get(key) || 0}x before, ${now.units.get(key) || 0}x now] in "${clip(key)}`.replace('\n', '":\n'));
  const LIMIT = 30;
  return [
    `The ${phase} phase's request trail differs from scripts/tests/golden/lifecycle-trail.${phase}.txt.`,
    moved.length ? `  Requests added (+) and removed (-), by METHOD resource:\n${moved.join('\n')}` : '  The same requests by METHOD resource: a query, a body shape, a status, or the publish a request precedes differs.',
    JSON.stringify(was.publishes) === JSON.stringify(now.publishes) ? '' : `  The publishes were:\n    ${was.publishes.join('\n    ')}\n  and are now:\n    ${now.publishes.join('\n    ')}`,
    `  Each request that differs (${changed.length}${changed.length > LIMIT ? `, the first ${LIMIT}` : ''}):`,
    ...changed.slice(0, LIMIT),
    '  Explain EVERY difference — at an SDK uptake by a release-note line (Changed / Fixed), otherwise by the change that made it —',
    '  then regenerate with UPDATE_GOLDENS=1 and review the golden\'s diff.',
  ].filter(Boolean).join('\n');
}
for (const phase of PHASES) {
  test(`lifecycle trail: the ${phase} phase sends exactly the requests, bodies and publishes it sent before`, async (t) => {
    const run = await lifecycle();
    const step = run.steps[phase];
    if (step.error) throw step.error;
    // A phase that failed would pin a failure's trail: the lifecycle tests prove each phase succeeds; here it is a precondition.
    const value = step.value || {};
    if (value.result && value.result.ok === false) assert.fail(`the ${phase} phase failed: ${JSON.stringify(value.result.errors || value.result.error)}`);
    if (phase === 'verify') assert.deepEqual({ ok: value.ok, missing: value.missing, unverified: value.unverified || [] }, { ok: true, missing: [], unverified: [] }, 'verify passes');
    if (phase === 'download') assert.equal(value.emitted && value.emitted.ok, true, `the download succeeds: ${value.stderr}`);
    assert.deepEqual(step.unexpected, [], `every request the ${phase} phase sent is one the fake models`);
    t.diagnostic(`${phase}: ${step.end - step.mark} requests in ${step.ms} ms`);
    const actual = trailOf(run.org, step);
    if (UPDATE) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(goldenFile(phase), actual);
      return;
    }
    // A Windows checkout may turn the committed LF into CRLF (helpers/golden.js): compare content, not line endings.
    const expected = fs.readFileSync(goldenFile(phase), 'utf8').replace(/\r\n/g, '\n');
    if (actual !== expected) assert.fail(describeDifference(phase, expected, actual));
  });
}

// The guard of the guard, over the real trail builder: one more read, one more member in one body, and a write moved to the other side
// of a publish each change the golden and are named in the description — and the one thing that is tolerated, two requests of one
// segment sent in the other order, does not — so the golden can never rot into a check that passes whatever is sent.
test('lifecycle trail (meta): one more read, one more body member and a write moved past a publish each fail; a reorder between publishes does not', () => {
  const publish = (what) => ({ method: 'POST', path: '/PublishXml', body: { ParameterXml: `<importexportxml><appmodules><appmodule>${what}</appmodule></appmodules></importexportxml>` }, status: 204 });
  const read = { method: 'GET', path: "/appmodules?$select=appmoduleid&$filter=uniquename eq 'contoso_x'", status: 200 };
  const view = { method: 'PATCH', path: '/savedqueries(0a1b2c3d-0000-4000-8000-00000000abcd)', body: { fetchxml: '<fetch/>' }, status: 204 };
  const form = { method: 'PATCH', path: '/systemforms(0a1b2c3d-0000-4000-8000-00000000abce)', body: { formxml: '<form/>' }, status: 204 };
  const trail = (requests) => trailOf({ requests }, { mark: 0, end: requests.length });
  const golden = trail([read, view, form, publish('a'), read]);
  assert.equal(trail([read, form, view, publish('a'), read]), golden, 'two requests between the same publishes may be sent in either order');
  const moreReads = describeDifference('build', golden, trail([read, read, view, form, publish('a'), read]));
  assert.match(moreReads, /\+1 GET appmodules/);
  const newMember = describeDifference('edit', golden, trail([read, { ...view, body: { fetchxml: '<fetch/>', returnedtypecode: 'contoso_x' } }, form, publish('a'), read]));
  assert.match(newMember, /The same requests by METHOD resource[\s\S]*\[0x before, 1x now\] in "up to publish 1: app":\n\s+PATCH \/savedqueries\(<id>\) \{fetchxml:string,returnedtypecode:string\}/);
  const late = trail([read, view, publish('a'), form, read]);
  assert.notEqual(late, golden, 'a write moved past the publish that should make it live');
  assert.match(describeDifference('rebuild', golden, late), /The same requests by METHOD resource[\s\S]*\[1x before, 0x now\] in "up to publish 1: app":\n\s+PATCH \/systemforms\(<id>\) \{formxml:string\}/);
  assert.equal(shape({ b: [1, 'x', { c: null }], a: true }), '{a:boolean,b:[number|string|{c:null}]}');
  assert.equal(mask('/x(0a1b2c3d-0000-4000-8000-00000000abcd)?$filter=modifiedon gt 2026-01-02T03:04:05Z'), '/x(<id>)?$filter=modifiedon gt <time>');
});
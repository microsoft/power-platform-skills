'use strict';
// Solution membership is read once, and a component the solution is PROVEN to hold is not added again — by a row of
// its own, or, for a view, chart or form, by its table being held with ALL its subcomponents.
// The wire-level behaviour (what the build sends over a rebuild) is pinned in rebuild-writes-real-bundle.test.js;
// these pin the helper's contract with the SDK reader stubbed, including every way the proof can fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSolutionMembers, createSolutionMembership, ensureSolutionComponent } = require('../lib/solution-membership.js');

const SOL = '11111111-2222-4333-8444-555555555555';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

// An SDK reader answering the two queries the helper makes, recording every call.
function reader({ solutions = [{ solutionid: SOL }], components = [], failOn } = {}) {
  const calls = [];
  return {
    calls,
    async queryRecords(entity, options) {
      calls.push([entity, options]);
      if (failOn === entity) throw new Error(`${entity} unreadable`);
      return entity === 'solution' ? solutions : components;
    },
  };
}

test('solution membership: the members are keyed by component type and bare lower-case id', async () => {
  const read = reader({ components: [
    { objectid: A.toUpperCase(), componenttype: 26 },
    { objectid: `{${B}}`, componenttype: '60' },
  ] });
  const { members } = await readSolutionMembers(read, 'ContosoSD', [26, 60]);
  assert.deepEqual([...members].sort(), [`26:${A}`, `60:${B}`].sort());
});

test('solution membership: the read asks for exactly the types given, restricted to this solution, and pages', async () => {
  const read = reader();
  await readSolutionMembers(read, "Contoso'SD", [26, 59, 26, 60]);
  assert.equal(read.calls.length, 2);
  assert.deepEqual(read.calls[0], ['solution', { select: ['solutionid'], filter: "uniquename eq 'Contoso''SD'", top: 1 }]);
  const [entity, options] = read.calls[1];
  assert.equal(entity, 'solutioncomponent');
  assert.deepEqual(options.select, ['objectid', 'componenttype', 'rootcomponentbehavior']);
  // Tables ride along (type 1) because a view, chart or form can be vouched for by its table.
  assert.equal(options.filter, `_solutionid_value eq ${SOL} and (componenttype eq 26 or componenttype eq 59 or componenttype eq 60 or componenttype eq 1)`);
  assert.equal(options.paginate, true);
  assert.equal('top' in options, false, 'paginate and top cannot be combined: the SDK refuses it, and $top would cap the read at one page');

  // Kinds a table never vouches for need no table rows: nothing is asked beyond them.
  const rootsOnly = reader();
  await readSolutionMembers(rootsOnly, 'ContosoSD', [20, 29, 61, 62, 80]);
  assert.equal(rootsOnly.calls[1][1].filter, `_solutionid_value eq ${SOL} and (componenttype eq 20 or componenttype eq 29 or componenttype eq 61 or componenttype eq 62 or componenttype eq 80)`);
});

test('solution membership: nothing is proven when the solution cannot be identified — and nothing is read for a built-in one', async () => {
  const none = reader({ solutions: [] });
  assert.equal(await readSolutionMembers(none, 'Missing', [26]), null);
  assert.equal(none.calls.length, 1, 'no component read without a solution row');

  // The id is interpolated unquoted into an Edm.Guid comparison, so anything but a GUID must stop here.
  const hostile = reader({ solutions: [{ solutionid: "x or 1 eq 1" }] });
  assert.equal(await readSolutionMembers(hostile, 'ContosoSD', [26]), null);
  assert.equal(hostile.calls.length, 1);

  for (const name of ['Default', 'active', 'BASIC']) {
    const builtIn = reader();
    assert.equal(await readSolutionMembers(builtIn, name, [26]), null);
    assert.equal(builtIn.calls.length, 0, `${name}: a built-in container holds every unmanaged customization, so its membership proves nothing`);
  }
  assert.equal(await readSolutionMembers(reader(), '', [26]), null);
  assert.equal(await readSolutionMembers(reader(), 'ContosoSD', []), null);
  assert.equal(await readSolutionMembers({}, 'ContosoSD', [26]), null, 'a reader without queryRecords proves nothing');
});

test('solution membership: a row that is not an (id, positive type) pair is ignored rather than trusted', async () => {
  const read = reader({ components: [
    { objectid: A, componenttype: 26 },
    { objectid: null, componenttype: 26 },
    { objectid: '', componenttype: 26 },
    { objectid: B, componenttype: 'x' },
    { objectid: B, componenttype: null },
    { objectid: B, componenttype: 0 },
    null,
  ] });
  assert.deepEqual([...(await readSolutionMembers(read, 'ContosoSD', [26])).members], [`26:${A}`]);
  assert.equal(await readSolutionMembers(reader({ components: 'oops' }), 'ContosoSD', [26]), null, 'a non-list answer is unknown, not empty');
});

test('solution membership: has() is true only for what the read returned, and a failed read proves nothing — and is not retried', async () => {
  const read = reader({ components: [{ objectid: A, componenttype: 26 }] });
  const membership = createSolutionMembership({ read, solutionUniqueName: 'ContosoSD', componentTypes: [26, 60] });
  assert.equal(await membership.has(A, 26), true);
  assert.equal(await membership.has(A, 60), false, 'the same id under another component type is a different component');
  assert.equal(await membership.has(B, 26), false);
  assert.equal(await membership.has(A.toUpperCase(), 26), true);
  assert.equal(await membership.has(`{${A}}`, 26), true);

  const broken = reader({ failOn: 'solutioncomponent' });
  const unknown = createSolutionMembership({ read: broken, solutionUniqueName: 'ContosoSD', componentTypes: [26] });
  assert.equal(await unknown.has(A, 26), false);
  assert.equal(await unknown.has(A, 26), false);
  assert.equal(broken.calls.filter(([entity]) => entity === 'solutioncomponent').length, 1, 'a failed read is remembered, not repeated for every component');
  unknown.note(A, 26);
  assert.equal(await unknown.has(A, 26), false, 'noting a component cannot invent membership the read did not establish');
});

test('solution membership: concurrent callers share one read, and it starts only at first use', async () => {
  const read = reader({ components: [{ objectid: A, componenttype: 26 }] });
  const membership = createSolutionMembership({ read, solutionUniqueName: 'ContosoSD', componentTypes: [26] });
  assert.equal(read.calls.length, 0, 'nothing has asked yet, so nothing is read');
  const answers = await Promise.all([A, B, A, B, A].map((id) => membership.has(id, 26)));
  assert.deepEqual(answers, [true, false, true, false, true]);
  assert.equal(read.calls.length, 2, 'one solution lookup and one component read, however many callers');
});

test('solution membership: ensureSolutionComponent adds only what is not proven present, and remembers what it added', async () => {
  const read = reader({ components: [{ objectid: A, componenttype: 26 }] });
  const membership = createSolutionMembership({ read, solutionUniqueName: 'ContosoSD', componentTypes: [26] });
  const adds = [];
  const sdk = { addSolutionComponent: async (o) => { adds.push(o); } };
  const present = { componentId: A, componentType: 26, solutionUniqueName: 'ContosoSD' };
  const absent = { componentId: B, componentType: 26, solutionUniqueName: 'ContosoSD' };

  assert.equal(await ensureSolutionComponent(sdk, membership, present), false);
  assert.deepEqual(adds, []);
  assert.equal(await ensureSolutionComponent(sdk, membership, absent), true);
  assert.deepEqual(adds, [absent], 'the add carries exactly the arguments a direct call would');
  assert.equal(await ensureSolutionComponent(sdk, membership, absent), false, 'a second assert of what this run just added is skipped');
  assert.equal(adds.length, 1);
});

test('solution membership: without a membership, or when the add fails, ensureSolutionComponent behaves as a direct add', async () => {
  const adds = [];
  const sdk = { addSolutionComponent: async (o) => { adds.push(o); } };
  const o = { componentId: A, componentType: 26, solutionUniqueName: 'ContosoSD' };
  assert.equal(await ensureSolutionComponent(sdk, undefined, o), true);
  assert.deepEqual(adds, [o]);

  const membership = createSolutionMembership({ read: reader(), solutionUniqueName: 'ContosoSD', componentTypes: [26] });
  const failing = { addSolutionComponent: async () => { throw new Error('refused'); } };
  await assert.rejects(ensureSolutionComponent(failing, membership, o), /refused/, 'each call site keeps its own policy for a failed add');
  assert.equal(await membership.has(A, 26), false, 'a failed add records nothing');
});

// ------------------------------------------------------------------- views, charts and forms vouched for by their table
//
// The rows below are the shapes the platform returns (see the header of lib/solution-membership.js), and the reader
// answers the query the way it does: only the types asked for, only the columns selected, the primary key always.
//   a table      { solutioncomponentid, objectid: <MetadataId>, componenttype: 1, rootcomponentbehavior: 0 | 1 | 2 }
//   a component  { solutioncomponentid, objectid: <its own id>, componenttype: 26 | 59 | 60 | …, rootcomponentbehavior: null }
// A table held with all its subcomponents (0) has no row for its views, forms or charts; one held at 1 or 2 has a row
// for each of those that was added on its own, and for no other.
const T_WHOLE = 'a1a1a1a1-0000-4000-8000-0000000000a1'; // held with ALL its subcomponents
const T_META = 'a2a2a2a2-0000-4000-8000-0000000000a2'; // "Do not include subcomponents": the table's own metadata
const T_SHELL = 'a3a3a3a3-0000-4000-8000-0000000000a3'; // "Include As Shell Only"
const T_NULL = 'a4a4a4a4-0000-4000-8000-0000000000a4'; // a table row that carries no behavior
const T_ABSENT = 'a5a5a5a5-0000-4000-8000-0000000000a5'; // not in the solution at all
let rowCount = 0;
const solutionRow = (objectid, componenttype, rootcomponentbehavior) => ({ solutioncomponentid: `5c000000-0000-4000-8000-${String(++rowCount).padStart(12, '0')}`, objectid, componenttype, rootcomponentbehavior });
const tableRow = (objectid, behavior) => solutionRow(objectid, 1, behavior);
const componentRow = (objectid, componenttype) => solutionRow(objectid, componenttype, null);

function dataverseReader(rows, { failOn } = {}) {
  const calls = [];
  return {
    calls,
    async queryRecords(entity, options) {
      calls.push([entity, options]);
      if (failOn === entity) throw new Error(`${entity} unreadable`);
      if (entity === 'solution') return [{ solutionid: SOL }];
      const types = [...String(options.filter).matchAll(/componenttype eq (\d+)/g)].map((m) => Number(m[1]));
      return rows.filter((row) => types.includes(row.componenttype))
        .map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name === 'solutioncomponentid' || options.select.includes(name))));
    },
  };
}

// A membership over `rows`, with a table resolver answering from `tableIds` (an Error value throws) and recording
// every table it is asked about in `asked`.
function membershipOver(rows, tableIds = {}, { read = dataverseReader(rows) } = {}) {
  const asked = [];
  const resolveTableId = async (logical) => {
    asked.push(logical);
    const id = tableIds[logical];
    if (id instanceof Error) throw id;
    return id;
  };
  return { asked, read, membership: createSolutionMembership({ read, solutionUniqueName: 'ContosoSD', componentTypes: [20, 26, 29, 59, 60], resolveTableId }) };
}
const TABLES = { new_whole: T_WHOLE, new_meta: T_META, new_shell: T_SHELL, new_null: T_NULL, new_absent: T_ABSENT };
const ALL_TABLE_ROWS = () => [tableRow(T_WHOLE, 0), tableRow(T_META, 1), tableRow(T_SHELL, 2), tableRow(T_NULL, null)];

test('solution membership: only a table held with ALL its subcomponents (behavior 0) is told apart as whole', async () => {
  const rows = [...ALL_TABLE_ROWS(), tableRow(B, '0'), tableRow(C, undefined), tableRow('d4d4d4d4-0000-4000-8000-0000000000d4', ''), componentRow(A, 26)];
  const { members, wholeTables } = await readSolutionMembers(dataverseReader(rows), 'ContosoSD', [26, 59, 60]);
  assert.deepEqual([...wholeTables].sort(), [T_WHOLE, B].sort(), 'behavior 0, as a number or as the string the SDK also accepts — not null, not empty, not absent');
  assert.ok(members.has(`1:${T_SHELL}`), 'a table held in part is still in the solution; it just proves nothing about its views');
  assert.ok(members.has(`26:${A}`));
});

test('solution membership: a view, chart or form of a table held with all its subcomponents is a member without a row of its own', async () => {
  const { membership, asked } = membershipOver(ALL_TABLE_ROWS(), TABLES);
  for (const type of [26, 59, 60]) assert.equal(await membership.has(A, type, { table: 'new_whole' }), true, `type ${type}`);
  assert.deepEqual(asked, ['new_whole'], 'the table is resolved once for all three kinds');
  assert.equal(await membership.has(A, 26, { table: 'New_Whole' }), true, 'the logical name is matched case-insensitively');
});

test('solution membership: a table held in part, held without behavior, or not held proves nothing about its views, charts and forms', async () => {
  const { membership } = membershipOver(ALL_TABLE_ROWS(), TABLES);
  for (const table of ['new_meta', 'new_shell', 'new_null', 'new_absent']) {
    for (const type of [26, 59, 60]) assert.equal(await membership.has(A, type, { table }), false, `${table} / type ${type}: they need rows of their own`);
  }
  assert.equal(await membership.has(A, 26), false, 'with no table given there is nothing to vouch for it');
  assert.equal(await membership.has(A, 26, { table: undefined }), false);
});

test('solution membership: a row of its own still counts, whatever its table is held at, and without asking about the table', async () => {
  const { membership, asked } = membershipOver([...ALL_TABLE_ROWS(), componentRow(B, 26), componentRow(C, 60)], TABLES);
  assert.equal(await membership.has(B, 26, { table: 'new_shell' }), true);
  assert.equal(await membership.has(C, 60, { table: 'new_absent' }), true);
  assert.deepEqual(asked, [], 'a row answers the question; no table is resolved for it');
});

test('solution membership: a table vouches for views, charts and forms only — never for a kind that gets a row of its own', async () => {
  const { membership, asked } = membershipOver(ALL_TABLE_ROWS(), TABLES);
  // Role, workflow (business rule, process flow), web resource, sitemap, app, and the table itself.
  for (const type of [20, 29, 61, 62, 80, 1]) assert.equal(await membership.has(A, type, { table: 'new_whole' }), false, `type ${type}`);
  assert.deepEqual(asked, [], 'and the table is not even resolved for them');
});

test('solution membership: a failed or unusable table lookup proves nothing, is not retried per component, and never throws', async () => {
  const failing = membershipOver(ALL_TABLE_ROWS(), { new_whole: new Error('metadata unavailable') });
  for (const id of [A, B, C]) assert.equal(await failing.membership.has(id, 26, { table: 'new_whole' }), false);
  assert.deepEqual(failing.asked, ['new_whole'], 'a failure is remembered, not repeated for every component');

  for (const answer of [undefined, null, '', 'not-a-guid', 42, T_WHOLE.slice(1)]) {
    const { membership } = membershipOver(ALL_TABLE_ROWS(), { new_whole: answer });
    assert.equal(await membership.has(A, 26, { table: 'new_whole' }), false, `answer ${JSON.stringify(answer)}`);
  }
  const noResolver = createSolutionMembership({ read: dataverseReader(ALL_TABLE_ROWS()), solutionUniqueName: 'ContosoSD', componentTypes: [26] });
  assert.equal(await noResolver.has(A, 26, { table: 'new_whole' }), false, 'without a resolver only rows count');
});

test('solution membership: a MetadataId is matched however it is written, and a table lookup is shared by concurrent callers', async () => {
  for (const written of [T_WHOLE.toUpperCase(), `{${T_WHOLE}}`, ` ${T_WHOLE} `]) {
    const { membership } = membershipOver(ALL_TABLE_ROWS(), { new_whole: written });
    assert.equal(await membership.has(A, 26, { table: 'new_whole' }), true, written);
  }
  const { membership, asked } = membershipOver(ALL_TABLE_ROWS(), TABLES);
  const answers = await Promise.all([[A, 'new_whole'], [B, 'new_whole'], [C, 'new_shell'], [A, 'new_shell'], [B, 'new_whole']].map(([id, table]) => membership.has(id, 60, { table })));
  assert.deepEqual(answers, [true, true, false, false, true]);
  assert.deepEqual(asked.sort(), ['new_shell', 'new_whole'], 'one lookup per table');
});

test('solution membership: a solution that holds no table with all its subcomponents never pays for a table lookup', async () => {
  const { membership, asked } = membershipOver([tableRow(T_META, 1), tableRow(T_SHELL, 2), componentRow(A, 26)], TABLES);
  assert.equal(await membership.has(B, 26, { table: 'new_meta' }), false);
  assert.equal(await membership.has(A, 26, { table: 'new_meta' }), true);
  assert.deepEqual(asked, []);
});

test('solution membership: a component the table carries is not added, one it does not carry is, and the add never carries the table', async () => {
  const { membership } = membershipOver(ALL_TABLE_ROWS(), TABLES);
  const adds = [];
  const sdk = { addSolutionComponent: async (o) => { adds.push(o); } };
  const view = { componentId: A, componentType: 26, solutionUniqueName: 'ContosoSD' };
  assert.equal(await ensureSolutionComponent(sdk, membership, view, { table: 'new_whole' }), false);
  assert.deepEqual(adds, []);
  assert.equal(await ensureSolutionComponent(sdk, membership, view, { table: 'new_shell' }), true);
  assert.deepEqual(adds, [view], 'exactly the arguments a direct add sends: the table is evidence, not a parameter');
  assert.equal(await ensureSolutionComponent(sdk, membership, view, { table: 'new_shell' }), false, 'and what this run added is remembered');
  assert.equal(adds.length, 1);
});

test('solution membership: when the read itself fails, no table is consulted and everything is added', async () => {
  const { membership, asked } = membershipOver(ALL_TABLE_ROWS(), TABLES, { read: dataverseReader(ALL_TABLE_ROWS(), { failOn: 'solutioncomponent' }) });
  assert.equal(await membership.has(A, 26, { table: 'new_whole' }), false);
  assert.deepEqual(asked, []);
});

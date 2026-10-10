'use strict';
// AB#6736948 — the build sets each table's Main Form Set order (lib/form-order.js).
//
// What a table opens with is decided by the ORDER of its Main forms (each form's formxml
// `<DisplayConditions Order="n">`), not by `systemform.isdefault`: measured live, moving `isdefault` did
// not reorder the forms a user is served, and three new forms at EQUAL Order (every new form carries
// Order 0) were served with the `isdefault` form LAST. So a build that only promoted `isdefault` left a
// table with three new Main forms opening with an alternate one. These tests drive the forms phase against a
// small model of the environment's forms and pin, per scenario, which forms get which Order, which are
// never touched, and what the build says when it cannot make its choice stick.
const test = require('node:test');
const assert = require('node:assert');

const { runSdkBuild, planFor } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const FORM_TYPE = { Main: 2, QuickCreate: 7, QuickView: 6 };
const T = 'new_workitem';
// The bug's own forms: a standard form, an alternate persona form and a reduced summary form.
const STD = 'Work Item';
const ALT = 'My Work \u2014 Work Item';
const SUM = 'Work Item \u2014 Summary';

function specFor({ existing = false, forms, mainFormOrder, personas } = {}) {
  return {
    solution: { uniqueName: 'FO', displayName: 'FO', publisherPrefix: 'new' },
    app: { name: 'FO App', description: 'd' },
    entities: [{
      schemaName: T, displayName: 'Work Item', pluralName: 'Work Items',
      primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
      columns: [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }],
      ...(existing ? { existing: true } : {}),
      ...(mainFormOrder ? { mainFormOrder } : {}),
    }],
    forms: forms || [
      { entity: T, name: STD, formType: 'Main' },
      { entity: T, name: ALT, formType: 'Main' },
      { entity: T, name: SUM, formType: 'Main' },
    ],
    ...(personas ? { personas } : {}),
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'W', subAreas: [{ entity: T, title: 'Work Items' }] }] }] },
  };
}

// A model of the environment's forms, answering exactly the reads and writes the forms phase makes.
// `seed` lists forms that already exist: { id, name, entity?, type?, active?, isdefault?, dc? } where `dc`
// is the form's <DisplayConditions> ({ everyone | roleIds, fallbackForm, order }) or undefined for none.
// A form the build creates behaves as the SDK's does: its local copy carries the <DisplayConditions> the
// SDK gives every new form (Order 0, offered to everyone) in its root bag, and it exists on the server —
// with whatever that copy says — only once it is pushed.
function makeEnv(seed = [], failures = {}, options = {}) {
  const { sdk } = makeSimpleMockSdk();
  const provision = Object.create(sdk);
  const forms = new Map();
  const log = [];
  const add = (f) => forms.set(f.id, { entity: T, type: 2, active: true, isdefault: false, ...f, dc: f.dc ? { ...f.dc } : undefined });
  seed.forEach(add);
  const byName = (name) => [...forms.values()].find((f) => f.name === name);
  const unpushed = new Map(); // local id -> what the server will record when it is pushed
  provision.createArtifact = async (t, def) => {
    const art = await sdk.createArtifact(t, def);
    if (t === 'form') {
      const local = await sdk.getArtifact('form', art.id);
      if (!options.noDisplayConditions) {
        local.bag.c.push({ i: 3, node: { n: 'DisplayConditions', a: [['Order', '0'], ['FallbackForm', 'true']], c: [{ n: 'Everyone', a: [], c: [] }] } });
      }
      unpushed.set(art.id, { entity: def.entityLogicalName, name: def.name, type: FORM_TYPE[def.formType || 'Main'] });
    }
    return art;
  };
  provision.pushArtifact = async (t, id) => {
    const out = await sdk.pushArtifact(t, id);
    if (t === 'form' && unpushed.has(id)) {
      const meta = unpushed.get(id);
      unpushed.delete(id);
      const local = await sdk.getArtifact('form', id);
      const node = (local.bag.c.find((e) => e && e.node && e.node.n === 'DisplayConditions') || {}).node;
      const order = node ? Number((node.a.find(([n]) => n === 'Order') || [])[1]) : undefined;
      add({ id, ...meta, dc: node ? { everyone: true, fallbackForm: true, order } : undefined });
      log.push(['created', meta.name, order]);
    }
    return out;
  };
  provision.queryRecords = async (entity, o = {}) => {
    if (entity === 'solution') return [];
    if (entity !== 'systemform') return [{ publisherid: 'pub-1' }];
    const filter = String(o.filter || '');
    const byId = /^formid eq (\S+)$/.exec(filter);
    if (byId) {
      const f = forms.get(byId[1]);
      return f ? [{ formid: f.id, isdefault: f.isdefault, objecttypecode: f.entity, type: f.type, name: f.name, formactivationstate: f.active ? 1 : 0 }] : [];
    }
    const ent = /objecttypecode eq '([^']+)'/.exec(filter);
    if (!ent) return [];
    const name = / name eq '((?:[^']|'')*)'/.exec(filter);
    const type = / type eq (\d+)/.exec(filter);
    const activeOnly = / formactivationstate eq 1/.test(filter);
    return [...forms.values()]
      .filter((f) => f.entity === ent[1]
        && (!name || f.name === name[1].replace(/''/g, "'"))
        && (!type || f.type === Number(type[1]))
        && (!activeOnly || f.active))
      .map((f) => ({ formid: f.id, name: f.name, formactivationstate: f.active ? 1 : 0, isdefault: f.isdefault }));
  };
  provision.updateRecord = async (entity, id, patch) => {
    const f = entity === 'systemform' && forms.get(id);
    if (!f) return;
    if (patch.isdefault !== undefined) { f.isdefault = patch.isdefault; log.push(['isdefault', f.name, patch.isdefault]); }
    if (patch.formactivationstate !== undefined) { f.active = patch.formactivationstate === 1; log.push(['activation', f.name, patch.formactivationstate]); }
  };
  provision.getFormSecurityRoles = async (id) => {
    if (failures.failRead && (!failures.readOnly || failures.readOnly(id))) throw new Error(failures.failRead);
    const f = forms.get(id);
    if (!f) throw new Error(`no form ${id}`);
    return f.dc ? { ...f.dc } : undefined;
  };
  // The SDK's contract (vendored FormApi): roles/everyone REPLACE the element; order/fallbackForm alone
  // re-attach the existing one and change only those attributes — and are refused when there is none.
  provision.setFormSecurityRoles = async (id, opts) => {
    const f = forms.get(id);
    if (!f) throw new Error(`no form ${id}`);
    log.push(['set', f.name, opts]);
    if (failures.failWrite) throw new Error(failures.failWrite);
    const wantsElement = opts.everyone || (opts.roleIds && opts.roleIds.length > 0);
    if (!wantsElement) {
      if (!f.dc) throw new Error('`order`/`fallbackForm` were supplied without `roleIds` or `everyone`, but this form has no <DisplayConditions> to attach them to');
      if (opts.order !== undefined) f.dc.order = opts.order;
      if (opts.fallbackForm !== undefined) f.dc.fallbackForm = opts.fallbackForm;
      return;
    }
    const prior = f.dc || {};
    f.dc = {
      ...(opts.everyone ? { everyone: true } : { roleIds: [...opts.roleIds] }),
      fallbackForm: opts.fallbackForm !== undefined ? opts.fallbackForm : (prior.fallbackForm !== undefined ? prior.fallbackForm : false),
      ...(opts.order !== undefined ? { order: opts.order } : (prior.order !== undefined ? { order: prior.order } : {})),
    };
  };
  provision.addSolutionComponent = async () => undefined;
  const order = (name) => { const f = byName(name); return f && f.dc ? f.dc.order : undefined; };
  const writes = () => log.filter((l) => l[0] === 'set').map(([, name, opts]) => [name, opts]);
  // The order each new form was CREATED with, in creation order: [name, order].
  const created = () => log.filter((l) => l[0] === 'created').map(([, name, order]) => [name, order]);
  return { provision, forms, log, byName, order, writes, created, failures };
}

async function build(spec, env, { phases = ['forms'], extraProvision, workspaceDir } = {}) {
  const { sdk } = makeSimpleMockSdk();
  if (extraProvision) Object.assign(env.provision, extraProvision);
  const events = [];
  const warnings = [];
  const res = await runSdkBuild(spec, {
    sdk, provisionSdk: env.provision, apply: true, phases, ...(workspaceDir ? { workspaceDir } : {}),
    emit: (e) => events.push(e), warn: (m) => warnings.push(String(m)),
  });
  const step = (re) => events.filter((e) => e.phase === 'forms' && e.status !== 'start' && re.test(e.label));
  return { res, events, warnings, step };
}

// --- a table the spec owns (created by this build) ---------------------------------------------------

test('own table, three new Main forms, no choice made: the first in spec order is put first (0), the others follow in spec order', async () => {
  const env = makeEnv();
  const { res, step, warnings } = await build(specFor(), env);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual([env.order(STD), env.order(ALT), env.order(SUM)], [0, 1, 2]);
  // Every new form arrives with Order 0, so the first is already in place: only the others are written.
  assert.deepStrictEqual(env.writes(), [[ALT, { order: 1 }], [SUM, { order: 2 }]]);
  assert.deepStrictEqual(env.created(), [[STD, 0], [ALT, 0], [SUM, 0]], 'a table the spec orders is ordered after the creates, not in them');
  assert.strictEqual(env.byName(STD).isdefault, true, 'the same form is still promoted to isdefault');
  const [s] = step(/^form order for new_workitem/);
  assert.strictEqual(s.status, 'ok');
  assert.strictEqual(s.label, "form order for new_workitem: 'Work Item', then 2 more");
  assert.deepStrictEqual(warnings.filter((w) => /form order/.test(w)), []);
});

test('own table, isDefault on the summary form: it comes first, and the others keep spec order after it', async () => {
  const spec = specFor();
  spec.forms[2].isDefault = true;
  const env = makeEnv();
  await build(spec, env);
  assert.deepStrictEqual([env.order(SUM), env.order(STD), env.order(ALT)], [0, 1, 2]);
  assert.strictEqual(env.byName(SUM).isdefault, true);
  assert.strictEqual(env.byName(STD).isdefault, false);
});

test('own table, entities[].mainFormOrder (partial): the listed forms first in list order, then the rest', async () => {
  const env = makeEnv();
  const { step } = await build(specFor({ mainFormOrder: [SUM, ALT] }), env);
  assert.deepStrictEqual([env.order(SUM), env.order(ALT), env.order(STD)], [0, 1, 2]);
  assert.strictEqual(env.byName(SUM).isdefault, true, 'the first listed form is the default too');
  assert.strictEqual(step(/^form order for/)[0].label, `form order for new_workitem: '${SUM}' > '${ALT}', then 1 more`);
});

test('a rebuild with everything already in place writes nothing (idempotent)', async () => {
  const env = makeEnv([
    { id: 'a', name: STD, dc: { everyone: true, fallbackForm: true, order: 0 } },
    { id: 'b', name: ALT, dc: { everyone: true, fallbackForm: true, order: 1 } },
    { id: 'c', name: SUM, dc: { everyone: true, fallbackForm: true, order: 2 } },
  ]);
  const { step } = await build(specFor(), env);
  assert.deepStrictEqual(env.writes(), []);
  assert.strictEqual(step(/^form order for/)[0].status, 'ok');
});

test('own table rebuilt after a maker reordered the NON-default forms: their order is kept, only the default is put back first', async () => {
  // In Maker: My Work first, then the default Work Item, then Summary moved above My Work... i.e. the
  // stored order is SUM 0, ALT 1, STD 2. The spec says nothing about ALT vs SUM, so their relative order
  // (SUM before ALT) must survive; only STD — the default — is moved back to the front.
  const env = makeEnv([
    { id: 'a', name: STD, dc: { everyone: true, fallbackForm: true, order: 2 } },
    { id: 'b', name: ALT, dc: { everyone: true, fallbackForm: true, order: 1 } },
    { id: 'c', name: SUM, dc: { everyone: true, fallbackForm: true, order: 0 } },
  ]);
  await build(specFor(), env);
  assert.deepStrictEqual([env.order(STD), env.order(SUM), env.order(ALT)], [0, 1, 2]);
});

test('a Main form with NO <DisplayConditions> gets the element a new form has (everyone, fallback) plus its order — an order alone would be refused', async () => {
  const env = makeEnv([
    { id: 'a', name: STD, dc: { everyone: true, fallbackForm: true, order: 0 } },
    { id: 'b', name: ALT, dc: undefined },
    { id: 'c', name: SUM, dc: { everyone: true, fallbackForm: true, order: 1 } },
  ]);
  await build(specFor(), env);
  // Stored order before: STD 0, SUM 1, ALT none (sorts last) → STD, SUM, ALT.
  assert.deepStrictEqual(env.writes(), [[ALT, { everyone: true, fallbackForm: true, order: 2 }]]);
  assert.deepStrictEqual(env.byName(ALT).dc, { everyone: true, fallbackForm: true, order: 2 });
});

test('a role-restricted Main form keeps its roles and fallback setting when only its order is written', async () => {
  const env = makeEnv([
    { id: 'a', name: STD, dc: { everyone: true, fallbackForm: true, order: 0 } },
    { id: 'b', name: ALT, dc: { roleIds: ['r1', 'r2'], fallbackForm: false, order: 0 } },
    { id: 'c', name: SUM, dc: { everyone: true, fallbackForm: true, order: 0 } },
  ]);
  await build(specFor(), env);
  assert.deepStrictEqual(env.byName(ALT).dc, { roleIds: ['r1', 'r2'], fallbackForm: false, order: 1 });
  assert.deepStrictEqual(env.writes().find(([n]) => n === ALT), [ALT, { order: 1 }], 'an order-only write, never a role write');
});

test('a Main form this spec does not declare is never written, and one that is not after the first form is named in a warning', async () => {
  const env = makeEnv([
    { id: 'x', name: 'Legacy', dc: { everyone: true, fallbackForm: true, order: 0 } },
    { id: 'y', name: 'Information', dc: undefined },
    { id: 'z', name: 'Later', dc: { everyone: true, fallbackForm: true, order: 7 } },
  ]);
  const { warnings } = await build(specFor(), env);
  assert.ok(!env.writes().some(([n]) => ['Legacy', 'Information', 'Later'].includes(n)), JSON.stringify(env.writes()));
  const w = warnings.filter((m) => /which this spec does not declare/.test(m));
  assert.strictEqual(w.length, 1, JSON.stringify(warnings));
  assert.match(w[0], /Main form 'Legacy'.*form order 0.*not after 'Work Item' \(0\).*Form settings > Form order/);
  assert.strictEqual(env.byName('Legacy').isdefault, false, 'nor is its default flag touched');
});

test('an unreadable undeclared form does not undo a written order: the step succeeds and says what it could not check', async () => {
  const env = makeEnv([{ id: 'x', name: 'Managed Elsewhere', dc: { everyone: true, fallbackForm: true, order: 0 } }]);
  const base = env.provision.getFormSecurityRoles;
  env.provision.getFormSecurityRoles = async (id) => { if (id === 'x') throw new Error('read refused (403)'); return base(id); };
  const { step, warnings } = await build(specFor(), env);
  assert.strictEqual(step(/^form order for/)[0].status, 'ok');
  assert.deepStrictEqual([env.order(STD), env.order(ALT), env.order(SUM)], [0, 1, 2]);
  const w = warnings.find((m) => /could not read its other Main forms/.test(m));
  assert.ok(w, JSON.stringify(warnings));
  assert.match(w, /read refused \(403\).*--verify/);
});

test('an inactive undeclared Main form is not warned about: it is never served', async () => {
  const env = makeEnv([{ id: 'x', name: 'Retired', active: false, dc: { everyone: true, fallbackForm: true, order: 0 } }]);
  const { warnings } = await build(specFor(), env);
  assert.deepStrictEqual(warnings.filter((m) => /does not declare/.test(m)), []);
});

test('QuickCreate and QuickView forms are never ordered, and do not count as Main forms', async () => {
  const spec = specFor({
    forms: [
      { entity: T, name: STD, formType: 'Main' },
      { entity: T, name: 'Quick', formType: 'QuickCreate' },
      { entity: T, name: 'Card', formType: 'QuickView' },
      { entity: T, name: ALT, formType: 'Main' },
    ],
  });
  const env = makeEnv();
  const { step } = await build(spec, env);
  assert.deepStrictEqual(env.writes(), [[ALT, { order: 1 }]]);
  assert.strictEqual(step(/^form order for/).length, 1);
  assert.strictEqual(step(/^form order for/)[0].label, "form order for new_workitem: 'Work Item', then 1 more");
});

test('two tables are ordered independently', async () => {
  const spec = specFor();
  spec.entities.push({ schemaName: 'new_task', displayName: 'Task', pluralName: 'Tasks', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' } });
  spec.forms.push({ entity: 'new_task', name: 'Task', formType: 'Main' }, { entity: 'new_task', name: 'Task Board', formType: 'Main', isDefault: true });
  const env = makeEnv();
  const { step } = await build(spec, env);
  assert.deepStrictEqual([env.order(STD), env.order(ALT), env.order(SUM)], [0, 1, 2]);
  assert.deepStrictEqual([env.order('Task Board'), env.order('Task')], [0, 1]);
  assert.strictEqual(step(/^form order for/).length, 2);
});

test('the order is written AFTER every form exists and after the default is promoted', async () => {
  const env = makeEnv();
  await build(specFor(), env);
  const promoted = env.log.findIndex((l) => l[0] === 'isdefault' && l[2] === true);
  const firstWrite = env.log.findIndex((l) => l[0] === 'set');
  assert.ok(promoted >= 0 && firstWrite > promoted, JSON.stringify(env.log));
  assert.strictEqual(env.forms.size, 3, 'all three forms existed before any order was written');
});

// --- an EXISTING table (the bug: authoring the order of a table the spec did not create) -------------

function existingTable(orders = { std: 0, alt: 1, sum: 2 }, extra = []) {
  return makeEnv([
    { id: 'e1', name: STD, isdefault: true, dc: { everyone: true, fallbackForm: true, order: orders.std } },
    { id: 'e2', name: ALT, dc: { everyone: true, fallbackForm: true, order: orders.alt } },
    { id: 'e3', name: SUM, dc: { everyone: true, fallbackForm: true, order: orders.sum } },
    ...extra,
  ]);
}

test('existing table, standard + alternate persona + summary forms, NO choice in the spec: nothing is reordered or promoted', async () => {
  const env = existingTable({ std: 1, alt: 0, sum: 2 });
  env.byName(STD).isdefault = false;
  env.byName(ALT).isdefault = true;
  const { step, warnings } = await build(specFor({ existing: true }), env);
  assert.deepStrictEqual(env.writes(), []);
  assert.deepStrictEqual(env.log.filter((l) => l[0] === 'isdefault'), [], 'the default of a table the spec does not own is not re-pointed implicitly');
  assert.deepStrictEqual(step(/^form order for/).map((e) => [e.status, e.label]), [['skip', 'form order for new_workitem (no new Main form — its order is left as it is)']]);
  assert.deepStrictEqual(warnings.filter((w) => /form order/.test(w)), []);
});

test('existing table, explicit isDefault on the standard form: promoted AND put first; the others keep their stored relative order', async () => {
  // Regression for AB#6736948: an isDefault on an existing table used to be dropped without a word.
  const env = existingTable({ std: 2, alt: 0, sum: 1 });
  env.byName(STD).isdefault = false;
  env.byName(ALT).isdefault = true;
  const spec = specFor({ existing: true });
  spec.forms[0].isDefault = true;
  const { res } = await build(spec, env);
  assert.deepStrictEqual([env.order(STD), env.order(ALT), env.order(SUM)], [0, 1, 2]);
  assert.strictEqual(env.byName(STD).isdefault, true);
  assert.strictEqual(env.byName(ALT).isdefault, false, 'the declared sibling that held the default is cleared');
  assert.strictEqual(res.created.defaultForms[T], 'e1');
});

test('existing table, entities[].mainFormOrder: exactly the declared order, on forms the build reconciled (not created)', async () => {
  const env = existingTable({ std: 0, alt: 1, sum: 2 });
  await build(specFor({ existing: true, mainFormOrder: [SUM, STD, ALT] }), env);
  assert.deepStrictEqual([env.order(SUM), env.order(STD), env.order(ALT)], [0, 1, 2]);
  assert.strictEqual(env.byName(SUM).isdefault, true);
  assert.strictEqual(env.byName(STD).isdefault, false);
});

test('existing table, deactivateOtherMainForms on the explicit default is NOT applied: deactivation stays limited to a table the build owns', async () => {
  const env = existingTable({ std: 0, alt: 1, sum: 2 }, [{ id: 'u1', name: 'Information', dc: undefined }]);
  const spec = specFor({ existing: true, forms: [{ entity: T, name: STD, formType: 'Main', isDefault: true, deactivateOtherMainForms: true }] });
  await build(spec, env);
  assert.deepStrictEqual(env.log.filter((l) => l[0] === 'activation'), []);
  assert.strictEqual(env.byName('Information').active, true);
});

test('existing table, a NEW alternate form and no choice: it is put after the table\u2019s other Main forms, which are not touched', async () => {
  // AC 2: adding an alternate form must not change what the table opens with. A new form carries Order 0,
  // which would tie with the form everyone opens today — and the platform, not the build, orders a tie.
  const env = makeEnv([
    { id: 'e1', name: STD, isdefault: true, dc: { everyone: true, fallbackForm: true, order: 0 } },
    { id: 'e3', name: SUM, dc: { everyone: true, fallbackForm: true, order: 3 } },
    { id: 'u1', name: 'Information', dc: undefined },
  ]);
  const { step, warnings } = await build(specFor({ existing: true }), env);
  // Highest other order (3) + 1 + its index among the spec's Main forms (1): created at 5, in ONE write —
  // the create — never at the Order 0 every new form starts with.
  assert.deepStrictEqual(env.created(), [[ALT, 5]]);
  assert.deepStrictEqual(env.writes(), [], 'no separate order write');
  assert.strictEqual(env.order(STD), 0);
  assert.strictEqual(env.order(SUM), 3);
  assert.strictEqual(env.byName('Information').dc, undefined);
  assert.deepStrictEqual(env.log.filter((l) => l[0] === 'isdefault'), []);
  assert.deepStrictEqual(step(/^form order for/).map((e) => [e.status, e.label]), [['ok', `form order for new_workitem ('${ALT}' after its other Main forms)`]]);
  // …but ahead of 'Information', which has no order and so is served after every form that has one.
  assert.deepStrictEqual(warnings.filter((w) => /form order/.test(w)).map((w) => /before 'Information', which has no form order/.test(w)), [true]);
});

test('existing table, two new forms: both are created after the others, in spec order, from ONE read of the others', async () => {
  const env = makeEnv([{ id: 'e1', name: STD, dc: { everyone: true, fallbackForm: true, order: 5 } }]);
  let reads = 0;
  const query = env.provision.queryRecords;
  env.provision.queryRecords = async (set, o) => { if (set === 'systemform' && /formactivationstate eq 1/.test(String(o && o.filter))) reads += 1; return query(set, o); };
  await build(specFor({ existing: true }), env);
  // 5 + 1 + index (1, 2). Created concurrently, yet neither new form is among the "others" the other read.
  assert.deepStrictEqual(env.created().sort(), [[ALT, 7], [SUM, 8]]);
  assert.deepStrictEqual(env.writes(), []);
  assert.strictEqual(reads, 1, 'the table\u2019s other forms are read once');
});

test('existing table whose other Main forms carry no order: the new form cannot be put after them, so the build says it now comes first', async () => {
  const env = makeEnv([{ id: 'u1', name: 'Information', dc: undefined }, { id: 'e1', name: STD, dc: undefined }]);
  const spec = specFor({ existing: true, forms: [{ entity: T, name: STD, formType: 'Main' }, { entity: T, name: ALT, formType: 'Main' }] });
  const { warnings, step } = await build(spec, env);
  assert.deepStrictEqual(env.writes(), []);
  assert.deepStrictEqual(env.created(), [[ALT, 1]], 'no other form has an order to follow: -1 + 1 + its index');
  const w = warnings.find((m) => /none of its other Main forms has a form order/.test(m));
  assert.ok(w, JSON.stringify(warnings));
  assert.match(w, new RegExp(`'${ALT}' now comes first .*forms\\[\\]\\.isDefault or entities\\[\\]\\.mainFormOrder`));
  assert.strictEqual(step(/^form order for/)[0].status, 'ok');
});

// --- tables ordered by hand, and what cannot be done -----------------------------------------------------

test('a table ordered by hand (securityRoles.order) gets no order step at all, and the security phase still writes its order', async () => {
  const spec = specFor({
    personas: [{ persona: 'Dispatcher', jobs: [{ name: 'Assign', privileges: [{ entity: T, access: ['read'] }] }] }],
  });
  spec.forms[1].securityRoles = { everyone: true, order: 5 };
  const env = makeEnv();
  const { step } = await build(spec, env, {
    phases: ['forms', 'security'],
    extraProvision: { createPersonaRole: async () => ({ roleId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', reused: false, appliedPrivileges: [], assignedTeams: [], assignedUsers: [] }) },
  });
  assert.deepStrictEqual(step(/^form order for/), []);
  assert.deepStrictEqual(env.writes(), [[ALT, { everyone: true, order: 5 }]], 'only the author\u2019s own securityRoles write');
  assert.deepStrictEqual(planFor(spec, { phases: ['forms'] }).filter((p) => /form order/.test(p.label)), []);
});

test('securityRoles WITHOUT an order keeps the position the forms phase gave the form', async () => {
  const spec = specFor({
    personas: [{ persona: 'Dispatcher', jobs: [{ name: 'Assign', privileges: [{ entity: T, access: ['read'] }] }] }],
  });
  spec.forms[1].securityRoles = { personas: ['Dispatcher'] };
  const env = makeEnv();
  await build(spec, env, {
    phases: ['forms', 'security'],
    extraProvision: { createPersonaRole: async () => ({ roleId: 'dddddddd-dddd-dddd-dddd-dddddddddddd', reused: false, appliedPrivileges: [], assignedTeams: [], assignedUsers: [] }) },
  });
  assert.deepStrictEqual(env.byName(ALT).dc, { roleIds: ['dddddddd-dddd-dddd-dddd-dddddddddddd'], fallbackForm: true, order: 1 });
});

test('a declared Main form the forms phase produced no id for: the table is not ordered, and the step names the form', async () => {
  // The guard behind this skip: ordering the other forms without that one would leave it at Order 0,
  // tied with the first — so the order the step reports would not be the order users are served.
  const env = makeEnv();
  const basePush = env.provision.pushArtifact;
  env.provision.pushArtifact = async (t, id) => {
    const out = await basePush(t, id);
    const f = env.forms.get(id);
    return t === 'form' && f && f.name === SUM ? { ...out, id: undefined } : out;
  };
  const { step } = await build(specFor(), env);
  assert.deepStrictEqual(step(/^form order for/).map((e) => [e.status, e.label]), [['skip', `form order for new_workitem ('${SUM}' not built in this run)`]]);
  assert.deepStrictEqual(env.writes(), []);
});

test('a failed form create still halts the build, before any order is written', async () => {
  const env = makeEnv();
  const base = env.provision.createArtifact;
  env.provision.createArtifact = (t, def) => {
    if (t === 'form' && def.name === SUM) throw new Error('create refused');
    return base(t, def);
  };
  await assert.rejects(runSdkBuild(specFor(), {
    sdk: makeSimpleMockSdk().sdk, provisionSdk: env.provision, apply: true, phases: ['forms'],
    emit: () => {}, warn: () => {},
  }), /create refused/);
  assert.deepStrictEqual(env.writes(), []);
});

test('an SDK without the form-order calls: the step is skipped with the reason, and nothing breaks', async () => {
  const env = makeEnv();
  env.provision.getFormSecurityRoles = undefined;
  const { res, step } = await build(specFor(), env);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(step(/^form order for/).map((e) => [e.status, e.label]), [['skip', "form order for new_workitem (this SDK cannot read or write a form's order)"]]);
});

test('a failed order READ is reported (✗ + warning) and the build goes on — it never halts', async () => {
  const env = makeEnv([], { failRead: 'read refused (403)' });
  const { res, step, warnings } = await build(specFor(), env);
  assert.strictEqual(step(/^form order for/)[0].status, 'error');
  assert.ok(warnings.some((w) => /could not set the Main Form Set order of 'new_workitem': read refused \(403\)/.test(w)), JSON.stringify(warnings));
  assert.ok(res.created.formIds[`${T}|Main|${SUM}`], 'the forms themselves are built');
});

test('a failed order WRITE is reported and the build goes on', async () => {
  const env = makeEnv([], { failWrite: 'write refused (429)' });
  const { step, warnings } = await build(specFor(), env);
  assert.strictEqual(step(/^form order for/)[0].status, 'error');
  assert.ok(warnings.some((w) => /could not set the Main Form Set order of 'new_workitem': write refused \(429\)/.test(w)), JSON.stringify(warnings));
});

test('when the table\u2019s other forms cannot be read, the new form is created at the end of the order, and the build says so', async () => {
  const env = makeEnv([{ id: 'e1', name: STD, dc: { everyone: true, fallbackForm: true, order: 0 } }], { failRead: 'read refused (403)' });
  const { step, warnings } = await build(specFor({ existing: true }), env);
  assert.deepStrictEqual(env.created().sort(), [[ALT, 100001], [SUM, 100002]], 'past any order Maker assigns, still in spec order');
  assert.strictEqual(step(/^form order for/)[0].status, 'ok');
  const w = warnings.find((m) => /could not read its other Main forms/.test(m));
  assert.ok(w, JSON.stringify(warnings));
  assert.match(w, /read refused \(403\).*created at the end of the form order \(order 100000 and up\)/);
});

// --- the plan ---------------------------------------------------------------------------------------------

test('planFor lists one form-order step per table with Main forms, after that table\u2019s forms', () => {
  const spec = specFor();
  spec.entities.push({ schemaName: 'new_task', displayName: 'Task', pluralName: 'Tasks', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' } });
  spec.forms.push({ entity: 'new_task', name: 'Quick Task', formType: 'QuickCreate' });
  const labels = planFor(spec, { phases: ['forms'] }).map((p) => p.label);
  assert.deepStrictEqual(labels.filter((l) => /form order/.test(l)), ['form order for new_workitem'], 'a table with only a QuickCreate form has no Main Form Set');
  assert.ok(labels.indexOf('form order for new_workitem') > labels.lastIndexOf('form for new_workitem'));
  assert.deepStrictEqual(planFor(spec, { phases: ['views'] }).filter((p) => /form order/.test(p.label)), [], 'no step when the forms phase does not run');
});

test('the step count stays honest: every planned form-order step is emitted exactly once', async () => {
  for (const [spec, env] of [
    [specFor(), makeEnv()],
    [specFor({ existing: true }), existingTable()],
    [specFor({ existing: true }), makeEnv([{ id: 'e1', name: STD, dc: { everyone: true, fallbackForm: true, order: 0 } }])],
  ]) {
    const planned = planFor(spec, { phases: ['forms'] }).filter((p) => /form order/.test(p.label)).length;
    const { step } = await build(spec, env);
    assert.strictEqual(step(/^form order for/).length, planned);
  }
});

// --- a new form is created in its place --------------------------------------------------------------
//
// On a table whose order the build does not set, a new Main form's order is part of its create. A separate
// write after the create left the form at Order 0 — possibly ahead of the form the table opened with — on
// any failure between the two, and a later build cannot tell the form is new, so it could never repair it.

const existingWithOriginal = () => makeEnv([{ id: 'e1', name: STD, isdefault: true, dc: { everyone: true, fallbackForm: true, order: 5 } }]);
const addAlternate = () => specFor({ existing: true, forms: [{ entity: T, name: STD, formType: 'Main' }, { entity: T, name: ALT, formType: 'Main' }] });

test('a new form on an existing table is created in its place: its create carries the order', async () => {
  const env = existingWithOriginal();
  const pushes = [];
  const push = env.provision.pushArtifact;
  env.provision.pushArtifact = async (t, id) => { pushes.push([t, id]); return push(t, id); };
  await build(addAlternate(), env);
  assert.deepStrictEqual(env.created(), [[ALT, 7]], '5 + 1 + index 1');
  assert.deepStrictEqual(env.writes(), []);
  assert.strictEqual(env.order(STD), 5, 'the original is not touched');
  const altId = env.byName(ALT).id;
  assert.strictEqual(pushes.filter(([t, id]) => t === 'form' && id === altId).length, 1, 'one push creates it, already placed');
});

test('a build interrupted after creating one new form leaves nothing out of place, and the next build places the rest after it', async () => {
  const env = existingWithOriginal();
  const spec = specFor({ existing: true, forms: [{ entity: T, name: STD, formType: 'Main' }, { entity: T, name: ALT, formType: 'Main' }, { entity: T, name: SUM, formType: 'Main' }] });
  const base = env.provision.createArtifact;
  let refuse = true;
  env.provision.createArtifact = async (t, def) => {
    if (refuse && t === 'form' && def.name === SUM) { await new Promise((r) => setTimeout(r, 20)); throw new Error('interrupted'); }
    return base(t, def);
  };
  await assert.rejects(build(spec, env), /interrupted/);
  assert.strictEqual(env.order(ALT), 7, 'what was created is already after the original');
  refuse = false;
  await build(spec, env);
  assert.strictEqual(env.order(ALT), 7, 'and is not moved');
  // ALT is one of the table's others now: 7 + 1 + index 2.
  assert.strictEqual(env.order(SUM), 10);
  assert.ok(env.order(STD) < env.order(ALT) && env.order(ALT) < env.order(SUM));
});

test('a later new form goes after a form an earlier build created', async () => {
  const env = makeEnv([
    { id: 'e1', name: STD, dc: { everyone: true, fallbackForm: true, order: 5 } },
    { id: 'e2', name: ALT, dc: { everyone: true, fallbackForm: true, order: 7 } },
  ]);
  // The new form is FIRST in the spec, yet the forms already on the table stay ahead of it.
  await build(specFor({ existing: true, forms: [{ entity: T, name: SUM, formType: 'Main' }, { entity: T, name: STD, formType: 'Main' }, { entity: T, name: ALT, formType: 'Main' }] }), env);
  assert.deepStrictEqual(env.created(), [[SUM, 8]]);
});

test('a failure placing a new form fails its create before anything is pushed', async () => {
  const env = existingWithOriginal();
  const update = env.provision.updateElement;
  env.provision.updateElement = async (t, id, ptr, value) => {
    if (t === 'form' && /^\/bag\/c\/\d+$/.test(ptr)) throw new Error('local copy refused the edit');
    return update(t, id, ptr, value);
  };
  await assert.rejects(build(addAlternate(), env), /local copy refused the edit/);
  assert.strictEqual(env.byName(ALT), undefined, 'the form was never pushed, so nothing is left at Order 0');
});

test('a new form whose SDK copy carries no <DisplayConditions> is created as the SDK makes it, and the build says so', async () => {
  const env = makeEnv([{ id: 'e1', name: STD, dc: { everyone: true, fallbackForm: true, order: 5 } }], {}, { noDisplayConditions: true });
  const { warnings } = await build(addAlternate(), env);
  assert.deepStrictEqual(env.created(), [[ALT, undefined]]);
  assert.ok(warnings.some((w) => new RegExp(`'${ALT}' was created without a form order the build could set`).test(w)), JSON.stringify(warnings));
});

test('forms on a table the spec orders, or orders by hand, are not placed in their create', async () => {
  const own = makeEnv();
  await build(specFor(), own);
  assert.deepStrictEqual(own.created(), [[STD, 0], [ALT, 0], [SUM, 0]], 'the order step orders them after the creates');
  const byHand = makeEnv([{ id: 'e1', name: STD, dc: { everyone: true, fallbackForm: true, order: 5 } }]);
  await build(specFor({ existing: true, forms: [{ entity: T, name: STD, formType: 'Main', securityRoles: { everyone: true, order: 1 } }, { entity: T, name: ALT, formType: 'Main' }] }), byHand);
  assert.deepStrictEqual(byHand.created(), [[ALT, 0]], 'the author orders this table');
});

// A form with no order at all is served after every form that has one. Appending the new form after the
// ORDERED forms therefore still puts it ahead of such a form — and a user whose roles offer them no ordered
// form, who therefore opened that one, now opens the new form. The build cannot fix that without writing a
// form the spec does not declare, so it says so.
test('a new form appended ahead of a form with NO order says so, naming it', async () => {
  const env = makeEnv([
    { id: 'r1', name: 'Dispatcher Only', dc: { roleIds: ['r'], fallbackForm: false, order: 0 } },
    { id: 'u1', name: 'Information', dc: undefined },
  ]);
  const { warnings } = await build(specFor({ existing: true, forms: [{ entity: T, name: ALT, formType: 'Main' }] }), env);
  assert.strictEqual(env.order(ALT), 1);
  const w = warnings.find((m) => /no form order/.test(m));
  assert.ok(w, JSON.stringify(warnings));
  assert.match(w, new RegExp(`'${ALT}' now comes before 'Information', which has no form order .* a user who opened it may now open '${ALT}'`));
});

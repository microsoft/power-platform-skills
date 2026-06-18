const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { buildModelApp } = require(path.join(__dirname, '..', 'build-model-app.js'));

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.project-tracker.json'), 'utf8')
);

// The relational worked sample (Customer -> Tickets -> Comments) exercises sub-grids,
// charts, display labels, and relational ($parent) sample data.
const desk = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8')
);

// A spec with a Choice column + sample data written as LABELS (the builder
// resolves "Active" -> the option's integer value).
function specWithSampleData() {
  const s = JSON.parse(JSON.stringify(sample));
  s.sampleData = {
    new_project: [
      { new_name: 'Apollo', new_budget: 5000, new_status: 'Active' },
      { new_name: 'Gemini', new_budget: 250, new_status: 'New' },
    ],
  };
  return s;
}

// Each recorded dv row is ['dv', method, apiPath, body]. Script rows are
// ['script', name, args]. Log lines are captured separately in `logs`.
function recordingDeps() {
  const calls = [];
  const logs = [];
  // A small id sequence so each POSTed record (view, chart, ...) gets a distinct id;
  // create-record.js returns ids per record so $parent binds can resolve them.
  let seq = 0;
  const nextId = (prefix) => `${prefix}${++seq}`;
  let formSeq = 0;
  return {
    calls,
    logs,
    runScript: (name, args) => {
      calls.push(['script', name, args]);
      if (name === 'create-record.js') {
        const body = JSON.parse(args[3] || '[]');
        const arr = Array.isArray(body) ? body : [body];
        return { ok: true, count: arr.length, ids: arr.map(() => nextId('rec')) };
      }
      return { ok: true, logicalName: (args[1] || 'x').toLowerCase(), metadataId: 'mid_' + (args[1] || 'x') };
    },
    dv: (method, apiPath, body) => {
      calls.push(['dv', method, apiPath, body]);
      if (method === 'GET' && String(apiPath).includes('systemforms')) {
        // Distinct form id per entity so the forms map isn't collapsed to one key.
        return { status: 200, data: { value: [{ formid: 'F' + ++formSeq, type: 2 }] } };
      }
      if (method === 'GET' && String(apiPath).includes('EntityDefinitions')) {
        // Resolve the EntitySetName from the requested logical name (logical + 's').
        const m = String(apiPath).match(/LogicalName='([^']+)'/);
        const logical = m ? m[1] : 'new_project';
        return { status: 200, data: { EntitySetName: logical + 's' } };
      }
      if (method === 'POST' && apiPath === 'savedqueries') {
        return { status: 204, data: {}, headers: { 'odata-entityid': `savedqueries(${nextId('SQ')})` } };
      }
      if (method === 'POST' && apiPath === 'savedqueryvisualizations') {
        return { status: 204, data: {}, headers: { 'odata-entityid': `savedqueryvisualizations(${nextId('SQV')})` } };
      }
      if (method === 'POST' && apiPath === 'appmodules') {
        return { status: 204, data: {}, headers: { 'odata-entityid': 'appmodules(APP1)' } };
      }
      if (method === 'POST' && apiPath === 'sitemaps') {
        return { status: 204, data: {}, headers: { 'odata-entityid': 'sitemaps(SM1)' } };
      }
      return { status: 204, data: {}, headers: {} };
    },
    kernel: (job) => {
      calls.push(['kernel', job.kind, job.spec, job.ctx]);
      if (job.kind === 'buildChart') {
        return { ok: true, datadescription: '<datadefinition/>', presentationdescription: '<presentationdescription/>' };
      }
      return { ok: true, formxml: '<form/>', fetchxml: '<fetch/>', layoutxml: '<grid/>', sitemapxml: '<SiteMap/>' };
    },
    log: (m) => logs.push(m),
  };
}

const dvCalls = (deps) => deps.calls.filter((c) => c[0] === 'dv');
const scriptNames = (deps) => deps.calls.filter((c) => c[0] === 'script').map((c) => c[1]);
const kernelKinds = (deps) => deps.calls.filter((c) => c[0] === 'kernel').map((c) => c[1]);
const stepLines = (deps) => deps.logs.filter((l) => /^\[\d+\/\d+\]/.test(l));
const idxScript = (deps, name) => deps.calls.findIndex((c) => c[0] === 'script' && c[1] === name);
const idxKernel = (deps, kind) => deps.calls.findIndex((c) => c[0] === 'kernel' && c[1] === kind);
const idxDv = (deps, apiPath) => deps.calls.findIndex((c) => c[0] === 'dv' && c[2] === apiPath);

test('dry-run (plan) writes nothing and reports the planned steps', async () => {
  const deps = recordingDeps();
  const r = await buildModelApp(sample, { apply: false, env: 'https://x' }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(deps.calls.length, 0);
  assert.ok(r.plan.some((p) => p.includes('create-table') && p.includes('new_project')));
  assert.ok(r.plan.some((p) => p.includes('main form')));
});

test('apply creates solution, table, and the two columns via dv-* scripts', async () => {
  const deps = recordingDeps();
  const r = await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.strictEqual(r.ok, true);
  const scripts = scriptNames(deps);
  assert.ok(scripts.includes('create-solution.js'));
  assert.ok(scripts.includes('create-table.js'));
  assert.strictEqual(deps.calls.filter((c) => c[0] === 'script' && c[1] === 'add-column.js').length, 2);
});

test('apply builds the main form and PATCHes the system form', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildForm'));
  const patch = dvCalls(deps).find((c) => c[1] === 'PATCH');
  assert.ok(patch, 'a PATCH was issued');
  assert.ok(String(patch[2]).includes('systemforms(F1)'));
  assert.ok(patch[3] && patch[3].formxml, 'PATCH body carries formxml');
});

test('apply builds + creates a savedquery view for the entity', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildView'));
  const sq = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'savedqueries');
  assert.ok(sq, 'savedqueries POST issued');
  assert.strictEqual(sq[3].returnedtypecode, 'new_project');
  assert.ok(String(sq[3].fetchxml).length > 0);
});

test('apply publishes entities BEFORE building the form (so cells are not stripped)', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  const pubIdx = deps.calls.findIndex((c) => c[0] === 'dv' && c[1] === 'POST' && c[2] === 'PublishXml');
  const formIdx = deps.calls.findIndex((c) => c[0] === 'kernel' && c[1] === 'buildForm');
  assert.ok(pubIdx >= 0, 'PublishXml (entity publish) issued');
  assert.ok(pubIdx < formIdx, 'entity publish happens before buildForm');
});

test('apply + publish builds sitemap, creates appmodule, wires components, and publishes', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, publish: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildSitemap'));
  const app = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'appmodules');
  assert.ok(app && app[3].uniquename, 'appmodule POST with uniquename');
  assert.ok(dvCalls(deps).some((c) => c[1] === 'POST' && c[2] === 'sitemaps' && c[3].sitemapnameunique));
  // AddAppComponents is the UNBOUND action with an AppId + sitemap/form/view (no entity).
  const add = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'AddAppComponents');
  assert.ok(add && add[3].AppId, 'AddAppComponents called with AppId');
  assert.ok(!add[3].Components.some((x) => x['@odata.type'] === 'Microsoft.Dynamics.CRM.entity'), 'no explicit entity component');
  assert.ok(dvCalls(deps).some((c) => c[1] === 'POST' && c[2] === 'PublishAllXml'));
});

test('apply WITHOUT publish does not call PublishAllXml', async () => {
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  assert.ok(!dvCalls(deps).some((c) => c[2] === 'PublishAllXml'));
});

// --- Sample data (opt-in) -------------------------------------------------

test('apply --sample-data inserts records, resolving choice labels to option ints', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, sampleData: true, env: 'https://x' }, deps);
  const cr = deps.calls.find((c) => c[0] === 'script' && c[1] === 'create-record.js');
  assert.ok(cr, 'create-record.js called');
  // args = [env, entitySet, '--body', '<json>']
  assert.strictEqual(cr[2][1], 'new_projects', 'uses the resolved entity-set name');
  const body = JSON.parse(cr[2][3]);
  assert.strictEqual(body.length, 2);
  assert.strictEqual(body[0].new_status, 100000001, '"Active" -> 100000001 (option index 1)');
  assert.strictEqual(body[1].new_status, 100000000, '"New" -> 100000000 (option index 0)');
  assert.strictEqual(body[0].new_name, 'Apollo', 'non-choice values pass through unchanged');
  assert.strictEqual(body[0].new_budget, 5000);
});

test('sample data is inserted AFTER entities are published and BEFORE forms', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, sampleData: true, env: 'https://x' }, deps);
  const pubIdx = idxDv(deps, 'PublishXml');
  const crIdx = idxScript(deps, 'create-record.js');
  const formIdx = idxKernel(deps, 'buildForm');
  assert.ok(pubIdx >= 0 && crIdx >= 0 && formIdx >= 0);
  assert.ok(pubIdx < crIdx, 'sample data after entity publish');
  assert.ok(crIdx < formIdx, 'sample data before form build');
});

test('apply WITHOUT --sample-data never inserts records, even if the spec has sampleData', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, env: 'https://x' }, deps);
  assert.ok(!deps.calls.some((c) => c[0] === 'script' && c[1] === 'create-record.js'));
});

test('dry-run plan lists the sample-data step when the spec carries sampleData', async () => {
  const r = await buildModelApp(specWithSampleData(), { apply: false, env: 'https://x' }, recordingDeps());
  assert.ok(r.plan.some((p) => /sample record/i.test(p)), 'plan mentions sample records');
});

// --- Live progress --------------------------------------------------------

test('apply emits monotonic [n/total] progress lines that end exactly at total', async () => {
  const deps = recordingDeps();
  await buildModelApp(specWithSampleData(), { apply: true, publish: true, sampleData: true, env: 'https://x' }, deps);
  const lines = stepLines(deps);
  assert.ok(lines.length >= 6, 'several progress lines emitted');
  const parse = (l) => l.match(/^\[(\d+)\/(\d+)\]/).slice(1, 3).map(Number);
  const totals = new Set(lines.map((l) => parse(l)[1]));
  assert.strictEqual(totals.size, 1, 'a single consistent total across all lines');
  const total = [...totals][0];
  const idxs = lines.map((l) => parse(l)[0]);
  assert.deepStrictEqual(idxs, idxs.slice().sort((a, b) => a - b), 'indices are monotonic');
  assert.strictEqual(Math.max(...idxs), total, 'the last step index equals the total');
  assert.strictEqual(idxs[0], 1, 'numbering starts at 1');
});

// --- Rich forms / charts / sub-grids (relational worked sample) -----------

const kernelSpecOf = (deps, kind) => {
  const c = deps.calls.find((x) => x[0] === 'kernel' && x[1] === kind);
  return c && c[2];
};

test('views and charts build BEFORE forms (so a parent sub-grid can reference a child view id)', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  const viewIdx = idxKernel(deps, 'buildView');
  const chartIdx = idxKernel(deps, 'buildChart');
  const formIdx = idxKernel(deps, 'buildForm');
  assert.ok(viewIdx >= 0 && chartIdx >= 0 && formIdx >= 0);
  assert.ok(viewIdx < formIdx, 'views build before forms');
  assert.ok(chartIdx < formIdx, 'charts build before forms');
});

test('charts step creates a savedqueryvisualization and adds it to the solution as type 59', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  assert.ok(kernelKinds(deps).includes('buildChart'), 'kernel buildChart called');
  const sqv = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'savedqueryvisualizations');
  assert.ok(sqv, 'savedqueryvisualizations POST issued');
  assert.strictEqual(sqv[3].primaryentitytypecode, 'new_ticket');
  assert.strictEqual(sqv[3].isdefault, false);
  assert.ok(sqv[3].datadescription && sqv[3].presentationdescription, 'both chart XML blobs sent');
  // add-to-solution.js called with component type 59 for the chart id.
  const add59 = deps.calls.find((c) => c[0] === 'script' && c[1] === 'add-to-solution.js' && c[2][3] === '59');
  assert.ok(add59, 'chart added to solution as component type 59');
});

test('buildChart job carries the entity, groupBy, measure and chartType', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  const spec = kernelSpecOf(deps, 'buildChart');
  assert.ok(spec, 'a buildChart job was sent');
  assert.strictEqual(spec.entity, 'new_ticket');
  assert.strictEqual(spec.groupBy, 'new_priority');
  assert.strictEqual(spec.measure, 'count');
  assert.strictEqual(spec.chartType, 'Pie');
});

test('app shell adds chart components (savedqueryvisualization) to AddAppComponents', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  const add = dvCalls(deps).find((c) => c[1] === 'POST' && c[2] === 'AddAppComponents');
  assert.ok(add, 'AddAppComponents called');
  const charts = add[3].Components.filter(
    (x) => x['@odata.type'] === 'Microsoft.Dynamics.CRM.savedqueryvisualization'
  );
  assert.strictEqual(charts.length, 2, 'both charts wired as components');
  assert.ok(charts.every((x) => x.savedqueryvisualizationid), 'each chart component carries an id');
});

test('forms send sub-grids with the resolved relationshipName and the child view id', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  // The customer form has a sub-grid of tickets (rel new_customer_new_ticket, view "Active Tickets").
  const customerForm = deps.calls.find(
    (c) => c[0] === 'kernel' && c[1] === 'buildForm' && c[2].subgrids && c[2].subgrids.some((s) => s.targetEntity === 'new_ticket')
  );
  assert.ok(customerForm, 'customer form sent with a tickets sub-grid');
  const sg = customerForm[2].subgrids.find((s) => s.targetEntity === 'new_ticket');
  // The sub-grid RelationshipName is the relationship SCHEMA name (distinct from the
  // lookup attribute name new_CustomerId, which Dataverse would reject as a collision).
  assert.strictEqual(sg.relationshipName, 'new_customer_new_ticket', 'relationshipName is the relationship schema name');
  assert.ok(sg.viewId, 'a child view id was resolved');
  assert.strictEqual(sg.label, 'Related Tickets');
});

test('create-relationship uses a relationship name DISTINCT from the lookup name (Dataverse rejects a collision)', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  // create-relationship.js args: ['1n', env, <relSchemaName>, <referenced>, <referencing>, <lookupSchemaName>, ...]
  const rels = deps.calls.filter((c) => c[0] === 'script' && c[1] === 'create-relationship.js');
  assert.ok(rels.length >= 1, 'at least one relationship created');
  for (const r of rels) {
    const relName = r[2][2];
    const lookupName = r[2][5];
    assert.notStrictEqual(relName, lookupName, 'relationship name must differ from the lookup attribute name');
  }
  const cust = rels.find((r) => r[2][3] === 'new_customer' && r[2][4] === 'new_ticket');
  assert.ok(cust, 'customer->ticket relationship created');
  assert.strictEqual(cust[2][2], 'new_customer_new_ticket', 'relationship schema name');
  assert.strictEqual(cust[2][5], 'new_CustomerId', 'lookup attribute name');
});

test('forms with no explicit tabs send autoFields with DISPLAY labels (fixes F1)', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  const ticketForm = deps.calls.find(
    (c) => c[0] === 'kernel' && c[1] === 'buildForm' && c[2].autoFields && c[3] && c[3].entityName === 'new_ticket'
  );
  assert.ok(ticketForm, 'the ticket form sent autoFields (not explicit tabs)');
  const fields = ticketForm[2].autoFields;
  const priority = fields.find((f) => f.logicalName === 'new_priority');
  assert.ok(priority, 'priority field present in autoFields');
  assert.strictEqual(priority.label, 'Priority', 'label is the display name, not the logical name');
  assert.strictEqual(priority.type, 'picklist', 'Choice maps to kernel picklist');
  const primary = fields.find((f) => f.logicalName === 'new_name');
  assert.strictEqual(primary.label, 'Title', 'primary uses its display name');
  // purpose is threaded for the tracking form.
  assert.strictEqual(ticketForm[2].purpose, 'tracking', 'purpose threaded to the kernel');
});

test('auto-layout form emits DISPLAY-name cell labels via the REAL kernel (F1 regression)', async () => {
  // The mocked-kernel test above only checks the kernel *input*. This one drives the
  // actual vendored cds-maker-kernel so a regression in display-label threading (F1)
  // through planFormLayout/displayLabel is caught: it inspects the emitted FormXML.
  const { runKernel } = require(path.join(__dirname, '..', 'lib', 'maker-kernel.js'));
  const deps = recordingDeps();
  deps.kernel = (job) => runKernel(job); // real bundle instead of the '<form/>' stub
  await buildModelApp(desk, { apply: true, env: 'https://x' }, deps);
  // The ticket form (layout: "auto") is PATCHed to its system form as { formxml }.
  const patch = deps.calls.find(
    (c) =>
      c[0] === 'dv' &&
      c[1] === 'PATCH' &&
      /^systemforms\(/.test(String(c[2])) &&
      c[3] &&
      typeof c[3].formxml === 'string' &&
      c[3].formxml.includes('datafieldname="new_priority"')
  );
  assert.ok(patch, 'ticket auto-layout form xml was PATCHed to its system form');
  const xml = patch[3].formxml;
  // The displayed cell label must be the DISPLAY name, not the logical name.
  assert.ok(xml.includes('description="Priority"'), 'cell label uses the display name "Priority"');
  assert.ok(!xml.includes('description="new_priority"'), 'cell label is NOT the logical name new_priority');
  // The control still binds to the logical name.
  assert.ok(xml.includes('datafieldname="new_priority"'), 'control still binds to the logical name');
  // Primary uses its display name "Title" (not "new_name").
  assert.ok(xml.includes('description="Title"'), 'primary cell label uses the display name "Title"');
  assert.ok(!xml.includes('description="new_name"'), 'primary cell label is NOT the logical name new_name');
});

test('explicit tabs are sent verbatim with per-field display labels', async () => {
  // The project-tracker sample uses explicit tabs.
  const deps = recordingDeps();
  await buildModelApp(sample, { apply: true, env: 'https://x' }, deps);
  const form = kernelSpecOf(deps, 'buildForm');
  assert.ok(form.tabs, 'explicit form sent tabs (not autoFields)');
  assert.ok(!form.autoFields, 'no autoFields for an explicit form');
  const fields = form.tabs[0].sections[0].fields;
  const status = fields.find((f) => f.logicalName === 'new_status');
  assert.strictEqual(status.label, 'Status', 'explicit field carries the display label');
  assert.strictEqual(status.type, 'picklist');
});

test('relational sample data inserts parents before children and binds $parent via @odata.bind', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, sampleData: true, env: 'https://x' }, deps);
  const crCalls = deps.calls.filter((c) => c[0] === 'script' && c[1] === 'create-record.js');
  assert.strictEqual(crCalls.length, 3, 'one create-record call per entity with records');
  // Customer (parent) inserted before ticket (child) before comment (grandchild).
  const setNames = crCalls.map((c) => c[2][1]);
  assert.deepStrictEqual(setNames, ['new_customers', 'new_tickets', 'new_comments'], 'topological order');
  // The ticket batch binds each ticket to its parent customer via @odata.bind.
  const ticketBody = JSON.parse(crCalls[1][2][3]);
  const bind = ticketBody[0]['new_CustomerId@odata.bind'];
  assert.ok(bind && /^\/new_customers\(rec\d+\)$/.test(bind), 'ticket bound to a created customer id');
  assert.ok(!('$parent' in ticketBody[0]), '$parent directive is not sent to the Web API');
  // The comment batch binds to its parent ticket.
  const commentBody = JSON.parse(crCalls[2][2][3]);
  const cbind = commentBody[0]['new_TicketId@odata.bind'];
  assert.ok(cbind && /^\/new_tickets\(rec\d+\)$/.test(cbind), 'comment bound to a created ticket id');
});

test('relational sample data still resolves Choice labels to option ints', async () => {
  const deps = recordingDeps();
  await buildModelApp(desk, { apply: true, sampleData: true, env: 'https://x' }, deps);
  const crCalls = deps.calls.filter((c) => c[0] === 'script' && c[1] === 'create-record.js');
  const ticketBody = JSON.parse(crCalls[1][2][3]);
  // priority options ["Low","Medium","High","Critical"]; "High" -> index 2.
  assert.strictEqual(ticketBody[0].new_priority, 100000002, '"High" -> 100000002');
});

test('dry-run plan lists chart build steps and notes sub-grids on forms', async () => {
  const r = await buildModelApp(desk, { apply: false, env: 'https://x' }, recordingDeps());
  assert.ok(r.plan.some((p) => /chart "Tickets by Priority".*Pie/.test(p)), 'plan lists the chart');
  assert.ok(
    r.plan.some((p) => /main form for new_customer.*sub-grids:.*new_ticket/.test(p)),
    'plan notes the sub-grid on the customer form'
  );
});

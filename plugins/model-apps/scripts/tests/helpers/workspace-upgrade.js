'use strict';
// The upgrade paths of workspace-upgrade-real-bundle.test.js and workspace-upgrade-entry-real-bundle.test.js: an app built by the
// PREVIOUS release's SDK bundle (helpers/previous-bundle.js) into a workspace, and the first thing a maker then does with this
// release on that workspace — each path starting from the state the previous release left, never from one this release has
// already touched — compared with the same steps on a workspace this release's bundle wrote (the control).
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dirs.js');
const { createLifecycleOrg } = require('./fake-lifecycle-org.js');
const { kitchenSinkSpec, createLifecycleHarness, seedForeignWork, appUniqueName } = require('./lifecycle-harness.js');
const { withVendoredCompiler, createMakerSdk } = require('../../lib/maker-sdk.js');
const { requirePrevious } = require('./previous-bundle.js');

// The projection version of every copy in a workspace, per artifact folder: { apps: [8], forms: [8, 8, 8, 8], ... }.
function projections(workspaceDir) {
  const root = path.join(workspaceDir, '.metadata');
  const out = {};
  if (!fs.existsSync(root)) return out;
  for (const kind of fs.readdirSync(root)) {
    const dir = path.join(root, kind);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'))) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (Number.isInteger(meta.projectionVersion)) (out[kind] = out[kind] || []).push(meta.projectionVersion);
    }
  }
  return out;
}
const versions = (byKind) => [...new Set(Object.values(byKind).flat())].sort((a, b) => a - b);

// A view filter a maker can save in the designer and the typed view model does not hold: a Quick Find marker on a filter BELOW the
// top level, and a multi-value condition (`<value>` children) inside it. The bundled SDK keeps such a filter verbatim (it used to be
// rebuilt from the typed filters by an edit, losing the marker and the values) — the change that raised the projection version.
const RESIDUAL_FILTER = '<filter type="or" isquickfindfields="1"><condition attribute="contoso_title" operator="like" value="{0}" />'
  + '<condition attribute="contoso_hours" operator="in"><value>1</value><value>2</value></condition></filter>';
const RESIDUAL_VIEW = 'My Open Tasks';

// A maker's edits, one to each kind of copy the build keeps and edits: the app header, a view (the one holding the residual
// filter), a form, a chart, the dashboard, the navigation — and a command bar on a table that had none (a build never edits an
// existing bar: recreate to change) and a table the app did not hold.
function editedSpec() {
  const spec = kitchenSinkSpec();
  spec.app.description = 'One app that uses every feature, edited.';
  spec.views.find((v) => v.name === RESIDUAL_VIEW).columns.push('contoso_done');
  spec.views.find((v) => v.name === 'Open Tasks').columns.push('contoso_done');
  spec.forms.find((f) => f.name === 'Task').description = 'The task record, edited.';
  spec.charts[0].description = 'Workload by priority, edited.';
  spec.dashboards[0].description = 'Project health, edited.';
  spec.appShell.areas[0].groups[0].subAreas.find((s) => s.title === 'Help').title = 'Help Center';
  spec.commands.push({ entity: 'contoso_task', label: 'Close Task', location: 'MainTab', library: 'contoso_project.js', function: 'Project.escalate' });
  spec.app.tables.push('account');
  return spec;
}

const residualView = (org) => {
  const rows = org.find('savedqueries', (v) => v.name === RESIDUAL_VIEW && v.returnedtypecode === 'contoso_task');
  if (rows.length !== 1) throw new Error(`one '${RESIDUAL_VIEW}' view, not ${rows.length}`);
  return rows[0];
};

// What a maker does in Maker: the residual filter added to the view, as the Web API call the designer makes.
async function makerAddsResidualFilter(org) {
  const view = residualView(org);
  const fetchxml = String(view.fetchxml).replace(/(<entity name="contoso_task">[\s\S]*?<filter type="and">)/, `$1${RESIDUAL_FILTER}`);
  if (fetchxml === view.fetchxml) throw new Error(`the '${RESIDUAL_VIEW}' view has no top-level filter to add to: ${view.fetchxml}`);
  const res = await org.request({ url: `${org.API}/savedqueries(${view.savedqueryid})`, method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fetchxml }) });
  if (res.statusCode >= 300) throw new Error(`the maker's edit answered ${res.statusCode}: ${res.body}`);
}

const SDKS = {
  previous: () => withVendoredCompiler(requirePrevious().createMakerSdk),
  current: () => createMakerSdk,
};

// The state the first SDK leaves: the kitchen sink built by it (and, with `residualFilter`, the maker's residual filter added in
// Maker and the app rebuilt by the same SDK, so ITS copy of the view holds the filter). Then `next` — this release's harness on the
// same environment and app folder — is the first thing done with this release.
async function startFrom(which, { residualFilter = false } = {}) {
  const org = createLifecycleOrg();
  await seedForeignWork(org);
  const root = makeTempDir(`workspace-upgrade-${which}-`);
  const out = { org, root, seed: org.inventory(), seedContents: org.contents() };
  const first = createLifecycleHarness(org, root, { createMakerSdk: SDKS[which]() });
  out.build = await first.measure(() => first.build(kitchenSinkSpec()));
  if (residualFilter && !out.build.error) {
    await makerAddsResidualFilter(org);
    out.reread = await first.measure(() => first.build(kitchenSinkSpec()));
  }
  out.firstProjections = projections(first.workspaceDir);
  out.afterBuild = org.inventory();
  out.next = createLifecycleHarness(org, root);
  return out;
}

// A step's value, after checking that it threw nothing and sent nothing the fake does not model.
function stage(record, name) {
  if (!record) throw new Error(`the ${name} did not run`);
  if (record.error) throw record.error;
  if (record.unexpected.length) throw new Error(`the ${name} sent requests the fake does not model: ${record.unexpected.join('; ')}`);
  return record;
}

// A spec or a report as text, with every GUID (the fake mints them at random, so two environments never share one) made one placeholder.
const withoutIds = (value) => JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

module.exports = { projections, versions, editedSpec, residualView, RESIDUAL_FILTER, RESIDUAL_VIEW, startFrom, stage, withoutIds, appUniqueName, kitchenSinkSpec };

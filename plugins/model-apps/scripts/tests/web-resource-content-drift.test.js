'use strict';
// A rebuild reuses a spec web resource that exists and does not write its content (references/app-spec-schema-advanced.md: "Content edits
// are NOT applied on rebuild" — the phase is discover-then-skip, like charts, command bars and dashboards). Until this was pinned it was
// also SILENT: the skip line said only "(exists — reuse)", where the chart, command and dashboard lines say their edits are not applied,
// and verify did not look at web resources at all — so an edited script was reported built and verified while the old one kept running.
// Now the build reads the deployed (published) content of the row it reuses and compares it, byte for byte, with what the spec would
// write; a difference is said in the skip line and as a warning, and nothing is written. Verify (the build's --verify and
// verify-model-app.js) checks that each declared web resource exists and, unless it is `external` (a shared resource the build reuses as
// it finds it), holds the spec's content.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-content-')); dirs.push(d); return d; };
const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const SCRIPT = 'contoso_/scripts/form.js';
const ICON = 'contoso_/icons/item.svg';
const OLD_CODE = 'var Form = { onLoad: function () {} };';
const NEW_CODE = 'var Form = { onLoad: function () { console.log("v2"); } };';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>';
const spec = (webResources) => ({
  solution: { uniqueName: 'ContosoReview', displayName: 'Contoso Review', publisherPrefix: 'contoso' },
  app: { name: 'Publish Review', uniqueName: 'contoso_publishreview' },
  entities: [{ schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
  webResources,
});

// The real bundle over the stateful fake of helpers/fake-app-build-org.js: a web resource has a saved and a published layer, and a plain read
// of it answers the published one. Only the web-resources phase runs.
function scenario() {
  const org = createFakeBuildOrg({ entities: {} });
  const dir = tempDir();
  async function build(built) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    const warnings = [];
    const events = [];
    const outcome = await runSdkBuild(built, { sdk, apply: true, publish: true, phases: ['web-resources'], workspaceDir: dir, appDir: dir, env: org.origin, warn: (w) => warnings.push(String(w)), emit: (e) => events.push(e) });
    const calls = org.calls.slice(mark);
    return { outcome, warnings, calls, writes: calls.filter((c) => c.method !== 'GET'), skips: events.filter((e) => e.status === 'skip').map((e) => e.label) };
  }
  const row = (name) => [...org.resources.values()].find((r) => r.name === name);
  return { org, dir, build, row };
}

const DIFFERS = (name) => `web resource ${name} (exists — reuse; its deployed content differs from the spec's: content edits aren't applied on rebuild, recreate to change)`;
const WARNING = (name) => `web resource ${name}: its deployed content differs from the spec's and is left as it is — a rebuild does not write the content of a web resource that exists; delete it (or tear the app down) and build again to deploy the spec's content`;

// --- the build ------------------------------------------------------------------------------------------------------------------------------------------

test('a rebuild after a content edit says that the deployed content differs and is not applied, in its skip line and a warning, and writes nothing', async () => {
  const s = scenario();
  await s.build(spec([{ name: SCRIPT, type: 'js', content: OLD_CODE }]));
  const id = s.row(SCRIPT).webresourceid;
  const edited = await s.build(spec([{ name: SCRIPT, type: 'js', content: NEW_CODE }]));
  assert.ok(edited.outcome.ok);
  assert.deepEqual(edited.skips, [DIFFERS(SCRIPT)]);
  assert.deepEqual(edited.warnings, [WARNING(SCRIPT)]);
  assert.deepEqual(edited.writes, [], 'nothing is written: the build stays additive');
  assert.equal(s.row(SCRIPT).publishedContent, base64(OLD_CODE), 'the deployed content is as it was');
  assert.equal(edited.outcome.created.webResources[SCRIPT], id, 'the row is reused');
});

test('an unchanged rebuild says what it always said, warns nothing and writes nothing', async () => {
  const s = scenario();
  await s.build(spec([{ name: SCRIPT, type: 'js', content: OLD_CODE }]));
  const again = await s.build(spec([{ name: SCRIPT, type: 'js', content: OLD_CODE }]));
  assert.deepEqual(again.skips, [`web resource ${SCRIPT} (exists — reuse)`]);
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.writes, []);
});

test('the comparison is of the bytes the spec writes, whichever source gives them: contentPath, and contentBase64 for a binary type', async () => {
  const s = scenario();
  fs.writeFileSync(path.join(s.dir, 'form.js'), OLD_CODE);
  await s.build(spec([{ name: SCRIPT, type: 'js', contentPath: 'form.js' }, { name: ICON, type: 'svg', contentBase64: base64(SVG) }]));
  const same = await s.build(spec([{ name: SCRIPT, type: 'js', contentPath: 'form.js' }, { name: ICON, type: 'svg', content: SVG }]));
  assert.deepEqual(same.skips, [`web resource ${SCRIPT} (exists — reuse)`, `web resource ${ICON} (exists — reuse)`], 'the same bytes, written as text this time');
  assert.deepEqual(same.warnings, []);
  fs.writeFileSync(path.join(s.dir, 'form.js'), NEW_CODE);
  const edited = await s.build(spec([{ name: SCRIPT, type: 'js', contentPath: 'form.js' }, { name: ICON, type: 'svg', contentBase64: base64(SVG.replace('14v14', '12v12')) }]));
  assert.deepEqual(edited.skips, [DIFFERS(SCRIPT), DIFFERS(ICON)]);
  assert.deepEqual(edited.warnings, [WARNING(SCRIPT), WARNING(ICON)]);
  assert.deepEqual(edited.writes, []);
});

test('an external web resource — shared, reused as the build finds it — is not compared', async () => {
  const s = scenario();
  await s.build(spec([{ name: ICON, type: 'svg', content: SVG }]));
  const again = await s.build(spec([{ name: ICON, type: 'svg', content: SVG.replace('14v14', '12v12'), external: true }]));
  assert.deepEqual(again.skips, [`web resource ${ICON} (exists — reuse)`]);
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.writes, []);
});

test('a web resource whose content cannot be compared is reused as before, and the skip line says it was not compared', async () => {
  const s = scenario();
  await s.build(spec([{ name: SCRIPT, type: 'js', content: OLD_CODE }]));
  // The spec's file is not there to read (the build's own source check is a step this phase-only run does not take).
  const unread = await s.build(spec([{ name: SCRIPT, type: 'js', contentPath: 'missing.js' }]));
  assert.equal(unread.skips.length, 1);
  assert.match(unread.skips[0], new RegExp(`^web resource ${SCRIPT.replace(/[/.]/g, '\\$&')} \\(exists — reuse; its content was not compared: the spec's content could not be read \\(.*missing\\.js.*\\)\\)$`));
  assert.deepEqual(unread.warnings, []);
  assert.deepEqual(unread.writes, []);
});

// --- verify ---------------------------------------------------------------------------------------------------------------------------------------------

// A verify reader that answers one thing: the web resources, by name, as the published layer holds them — and an empty navigation, which every
// pass reads.
const reader = (rows) => ({
  webResource: async (name) => (Object.hasOwn(rows, name) ? rows[name] : null),
  sitemapXml: async () => '', findTable: async () => null, findColumns: async () => [], queryRecords: async () => [],
});
const webResourceChecks = (r) => r.checks.filter((c) => c.kind === 'web-resource');

test('verify reports a declared web resource whose deployed content differs from the spec\'s, and one that is missing', async () => {
  const r = await verifySpec({ webResources: [{ name: SCRIPT, type: 'js', content: NEW_CODE }, { name: ICON, type: 'svg', content: SVG }] },
    reader({ [SCRIPT]: { id: 'wr-1', content: base64(OLD_CODE) } }));
  assert.equal(r.ok, false);
  assert.deepEqual(webResourceChecks(r), [
    { kind: 'web-resource', name: SCRIPT, present: false, detail: "its deployed content differs from the spec's — a rebuild does not write the content of a web resource that exists; delete it (or tear the app down) and build again to deploy it" },
    { kind: 'web-resource', name: ICON, present: false, detail: 'not found' },
  ]);
});

test('verify passes a web resource that holds the spec\'s content, and checks only that an external one exists', async () => {
  const r = await verifySpec({ webResources: [{ name: SCRIPT, type: 'js', content: OLD_CODE }, { name: ICON, type: 'svg', content: SVG, external: true }] },
    reader({ [SCRIPT]: { id: 'wr-1', content: base64(OLD_CODE) }, [ICON]: { id: 'wr-2', content: base64('<svg/>') } }));
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  assert.deepEqual(webResourceChecks(r).map((c) => [c.name, c.present]), [[SCRIPT, true], [ICON, true]]);
});

test('verify resolves contentPath from the app folder it is given, and leaves a content it cannot read unverified, not failed', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'form.js'), OLD_CODE);
  const declared = { webResources: [{ name: SCRIPT, type: 'js', contentPath: 'form.js' }] };
  const same = await verifySpec(declared, reader({ [SCRIPT]: { id: 'wr-1', content: base64(OLD_CODE) } }), { appDir: dir });
  assert.equal(same.ok, true, JSON.stringify(same.missing));
  const unread = await verifySpec({ webResources: [{ name: SCRIPT, type: 'js', contentPath: 'missing.js' }] }, reader({ [SCRIPT]: { id: 'wr-1', content: base64(OLD_CODE) } }), { appDir: dir });
  assert.deepEqual(webResourceChecks(unread), []);
  assert.equal(unread.unverified.length, 1);
  assert.match(unread.unverified[0], new RegExp(`^web-resource:${SCRIPT.replace(/[/.]/g, '\\$&')} \\(its content was not compared: the spec's content could not be read`));
});

test('verify says nothing of web resources when its reader cannot read them, or when the build did not run their phase', async () => {
  const declared = { webResources: [{ name: SCRIPT, type: 'js', content: NEW_CODE }] };
  const blind = await verifySpec(declared, { sitemapXml: async () => '', findTable: async () => null, findColumns: async () => [], queryRecords: async () => [] });
  assert.deepEqual(webResourceChecks(blind), []);
  const skipped = await verifySpec(declared, reader({}), { phases: ['data-model'] });
  assert.deepEqual(webResourceChecks(skipped), []);
  assert.deepEqual(skipped.phaseSkipped, [`web-resource:${SCRIPT}`]);
  assert.equal(skipped.ok, true);
});

test('the verify reader reads a web resource by name, with its content, as the published layer holds it', async () => {
  const asked = [];
  const sdk = { queryRecords: async (set, o) => { asked.push([set, o]); return o.filter === `name eq '${SCRIPT}'` ? [{ webresourceid: 'wr-1', content: base64(OLD_CODE) }] : []; } };
  const read = readerFor(sdk, 'contoso_publishreview', {});
  assert.deepEqual(await read.webResource(SCRIPT), { id: 'wr-1', content: base64(OLD_CODE) });
  assert.equal(await read.webResource('contoso_/other.js'), null);
  assert.deepEqual(asked[0], ['webresource', { select: ['webresourceid', 'content'], filter: `name eq '${SCRIPT}'`, top: 1 }]);
});

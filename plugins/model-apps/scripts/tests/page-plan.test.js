'use strict';
// Coverage for the App Spec -> genpage-plan.md adapter (H4: /app-builder Phase 1.5 had no
// executable page-worker contract). The worker's contract is references/plan-schema.md, so these
// tests assert the projection is schema-faithful — every required section, in order, and every
// required per-page field — plus the identity convergence that keeps PAGEREF resolution consistent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  buildPagePlan, REQUIRED_PAGE_FIELDS, pageFile, pageEntities, pageDataMode, needsCaching, navTargets,
} = require('../lib/page-plan.js');

function spec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'Contoso', publisherPrefix: 'con' },
    app: { name: 'Contoso Ops', description: 'Track suppliers and their contracts.' },
    entities: [{ schemaName: 'con_supplier', primaryAttribute: { schemaName: 'con_name' } }],
    pages: [
      {
        key: 'overview', name: 'Overview', purpose: 'Supplier KPIs at a glance',
        dataSources: ['con_supplier'], source: { kind: 'intent' },
        navigatesTo: [{ targetKey: 'supplier-detail' }],
      },
      {
        key: 'supplier-detail', name: 'Supplier Detail', purpose: 'One supplier',
        dataSources: ['con_supplier'], source: { kind: 'intent' }, pageInput: {},
      },
      { key: 'about', name: 'About', purpose: 'Static help', source: { kind: 'intent' } },
    ],
  };
}

test('projects every required plan section, in schema order', () => {
  const md = buildPagePlan(spec(), { envUrl: 'https://x.crm.dynamics.com', workingDir: '/wd' });
  const required = [
    '# Genpage Plan', '## User Requirements', '## Working Directory', '## Plugin Root',
    '## Environment', '## Pages', '## Entity Creation Required', '## Existing Entities',
    '## Connector Bindings', '## Design Preferences', '## Relevant Samples',
    '## Per-Page Specifications',
  ];
  let cursor = -1;
  for (const h of required) {
    const at = md.indexOf(`\n${h}`) >= 0 ? md.indexOf(`\n${h}`) : md.indexOf(h);
    assert.notEqual(at, -1, `missing section ${h}`);
    assert.ok(at > cursor, `${h} is out of schema order`);
    cursor = at;
  }
});

// The adapter and the genpage Layer 1 plan validator encode the SAME contract
// (references/plan-schema.md) from opposite ends: this projects a plan, that one polices it. Running
// the real validator over the real projection is what keeps them from drifting apart — it already
// caught two sections the adapter was silently omitting.
test('the projected plan passes the genpage Layer 1 schema validator', () => {
  const layer1 = require('../../../../evals/model-apps/genpage/lib/assertions-layer-1.js');
  const validate = layer1.validateGenpagePlanSchema;
  assert.equal(typeof validate, 'function', 'Layer 1 must export validateGenpagePlanSchema');
  const errors = validate(buildPagePlan(spec(), { envUrl: 'https://x.crm.dynamics.com', workingDir: '/wd' }));
  assert.deepEqual(errors, [], `projected plan violates the shared schema: ${JSON.stringify(errors)}`);
});

test('Existing Entities lists the union of page data sources, or None for an all-mock spec', () => {
  const md = buildPagePlan(spec(), { workingDir: '/wd' });
  assert.match(md, /## Existing Entities\ncon_supplier/);
  const mockOnly = buildPagePlan(
    { pages: [{ key: 'a', name: 'A' }], app: { name: 'A' } }, { workingDir: '/wd' }
  );
  assert.match(mockOnly, /## Existing Entities\nNone/);
});

test('Connector Bindings uses the exact no-bindings sentinel (app-builder authors no connectors)', () => {
  // The page-builder emits connector code ONLY for a real binding table, so this sentinel is what
  // guarantees an app-builder page never ships connector calls.
  assert.match(buildPagePlan(spec(), { workingDir: '/wd' }), /## Connector Bindings\nNo connector bindings\./);
});

test('every page carries every required per-page field', () => {
  const md = buildPagePlan(spec(), { workingDir: '/wd' });
  const blocks = md.split(/^### /m).slice(1);
  assert.equal(blocks.length, 3, 'one block per page');
  for (const b of blocks) {
    for (const f of REQUIRED_PAGE_FIELDS) {
      assert.ok(b.includes(`- **${f}:**`), `page block "${b.split('\n')[0]}" is missing **${f}:**`);
    }
  }
});

test('Environment always carries Solution + Publisher Prefix (mandatory per schema)', () => {
  const md = buildPagePlan(spec(), { workingDir: '/wd' });
  assert.match(md, /- Solution: Contoso/);
  assert.match(md, /- Publisher Prefix: con/);
  // Defaults when the spec omits them — the schema says these are never absent.
  const bare = buildPagePlan({ pages: [{ key: 'p', name: 'P' }], app: { name: 'A' } }, { workingDir: '/wd' });
  assert.match(bare, /- Solution: Default/);
  assert.match(bare, /- Publisher Prefix: new/);
});

test('file name is derived from the stable key so key and filename-stem identity converge', () => {
  // This is what makes the worker's "use the stable key" rule and /genpage's filename-stem
  // PAGEREF resolver agree instead of conflicting.
  const s = spec();
  assert.equal(pageFile(s.pages[0]), 'overview.tsx');
  assert.equal(pageFile(s.pages[1]), 'supplier-detail.tsx');
  // An already-built page keeps its pinned codeFile (edit / round-trip).
  assert.equal(pageFile({ key: 'k', source: { kind: 'tsx', codeFile: 'legacy.tsx' } }), 'legacy.tsx');
});

test('data mode and caching follow whether the page reads an entity on mount', () => {
  const s = spec();
  assert.equal(pageDataMode(s.pages[0]), 'dataverse');
  assert.equal(needsCaching(s.pages[0]), true, 'a Dataverse page fetches on mount');
  assert.equal(pageDataMode(s.pages[2]), 'mock');
  assert.equal(needsCaching(s.pages[2]), false, 'a pure mock page has no on-mount fetch');
  assert.equal(pageEntities(s.pages[2]), 'mock data');
});

test('one PAGEREF placeholder per declared navigatesTo edge (build enforces exact parity)', () => {
  const s = spec();
  assert.deepEqual(navTargets(s.pages[0]), ['supplier-detail']);
  const md = buildPagePlan(s, { workingDir: '/wd' });
  assert.match(md, /"PAGEREF_supplier-detail"/);
  // A page with no edges must not invent one.
  const aboutBlock = md.split(/^### /m).find((b) => b.startsWith('About'));
  assert.doesNotMatch(aboutBlock, /PAGEREF_/);
});

test('a spec with no pages is a loud error, not an empty plan', () => {
  assert.throws(() => buildPagePlan({ pages: [] }, {}), /declares no pages/);
});

test('CLI writes the plan and echoes per-page dispatch parameters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageplan-'));
  try {
    const specPath = path.join(dir, 'app-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec()), 'utf8');
    const cli = path.join(__dirname, '..', 'write-page-plan.js');
    const res = spawnSync(process.execPath, [cli, '--spec', '@' + specPath, '--working-dir', dir], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    assert.ok(fs.existsSync(out.planPath), 'plan file written');
    assert.match(fs.readFileSync(out.planPath, 'utf8'), /^# Genpage Plan/);
    // The echo is what Phase 1.5 iterates for the per-page worker dispatch.
    assert.deepEqual(out.pages.map((p) => p.file), ['overview.tsx', 'supplier-detail.tsx', 'about.tsx']);
    assert.deepEqual(out.pages.map((p) => p.dataMode), ['dataverse', 'dataverse', 'mock']);
    assert.ok(out.pages.every((p) => p.intent === true));
    // Plugin Root must be the PLUGIN root, not scripts/ — the worker resolves
    // ${PLUGIN_ROOT}/references/... and ${PLUGIN_ROOT}/samples/... from it, so an off-by-one
    // directory silently breaks every reference and sample read. (Caught by a live run.)
    const planText = fs.readFileSync(out.planPath, 'utf8');
    const root = /## Plugin Root\n(.+)/.exec(planText)[1].trim();
    assert.ok(fs.existsSync(path.join(root, 'references')), `plugin root has references/: ${root}`);
    assert.ok(fs.existsSync(path.join(root, 'samples')), `plugin root has samples/: ${root}`);
    assert.doesNotMatch(root, /\/scripts$/, 'must not point at scripts/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI fails with usage when a required flag has no value', () => {
  const cli = path.join(__dirname, '..', 'write-page-plan.js');
  const res = spawnSync(process.execPath, [cli, '--spec'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

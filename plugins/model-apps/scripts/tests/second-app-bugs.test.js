// Second-app bug batch (AB#6689110, AB#6688905, AB#6688906) — the three halves that belong to THIS
// plugin. The root causes of 6688904, and of 6688905/6688906's deployed symptoms, live in the
// vendored SDK and are reported separately; what is covered here is what the plugin itself owns.
//
// Written against the reporters' actual inputs rather than a paraphrase: an `ai.summaries` block with
// `default: "off"` plus one explicitly-enabled table, an SVG placed in the legacy `icon` slot, and a
// workspace `.meta.json` that is not readable at the moment the event-wiring step runs.

const test = require('node:test');
const assert = require('node:assert');

const { validateAppSpec } = require('../lib/app-spec.js');
const { verifySpec } = require('../lib/verify-spec.js');

// --- AB#6689110: a requested row summary must not verify clean when it does not exist ------------

const summarySpec = () => ({
  solution: { uniqueName: 'S' },
  app: { name: 'A' },
  entities: [{ schemaName: 'contoso_workitem', displayName: 'Work Item', primaryAttribute: { schemaName: 'contoso_title' }, columns: [] }],
  views: [], charts: [], forms: [], appShell: { areas: [] },
  // The reporter's exact shape: default OFF, one table explicitly opted back in.
  ai: { summaries: { default: 'off', tables: { contoso_workitem: { enabled: true, instruction: 'Summarize execution status.', columns: ['contoso_title'] } } } },
});

const summaryReader = ({ rows = [], throws = false } = {}) => ({
  findTable: async () => ({ logicalName: 'contoso_workitem', entitySetName: 'contoso_workitems' }),
  findColumns: async () => [{ logicalName: 'contoso_title' }],
  sitemapXml: async () => '<SiteMap/>',
  queryRecords: async (set) => {
    if (set !== 'msdyn_aimodel') return [];
    if (throws) throw new Error('HTTP 403 from msdyn_aimodels');
    return rows;
  },
});

test('AB#6689110: a requested row summary that does not exist FAILS verification', async () => {
  // The reported symptom: `PASS, 45/45` with the requested Work Item summary absent. Verification
  // covered `ai.appFeatures` but had no check for `ai.summaries` at all, so the one artifact the
  // maker asked for was the one thing nothing looked at.
  const r = await verifySpec(summarySpec(), summaryReader({ rows: [] }));
  const c = r.checks.find((x) => x.kind === 'ai-summary');
  assert.ok(c, `an ai-summary check must exist: ${JSON.stringify(r.checks.map((x) => x.kind))}`);
  assert.strictEqual(c.present, false);
  assert.strictEqual(r.ok, false, 'and it must fail the whole verification, not just annotate it');
  assert.match(c.detail, /contoso_workitem row summary/, c.detail);
  assert.match(c.detail, /licens/i, 'the message must name the usual cause so the operator can act');
});

test('AB#6689110: a row summary that DOES exist passes', async () => {
  // The counterfactual. Without it the check could pass the test above by failing unconditionally,
  // which would make every licensed environment fail verification instead.
  const r = await verifySpec(summarySpec(), summaryReader({ rows: [{ msdyn_aimodelid: 'm1', msdyn_name: 'contoso_workitem row summary' }] }));
  const c = r.checks.find((x) => x.kind === 'ai-summary');
  assert.strictEqual(c.present, true, JSON.stringify(c));
  assert.strictEqual(r.ok, true, JSON.stringify(r.checks.filter((x) => !x.present)));
});

test('AB#6689110: an unreadable AI model list fails CLOSED, it does not pass', async () => {
  // "Could not look" is not "it is there". Reporting PASS on a read that failed is the same false
  // confidence this check was added to remove.
  const r = await verifySpec(summarySpec(), summaryReader({ throws: true }));
  const c = r.checks.find((x) => x.kind === 'ai-summary');
  assert.strictEqual(c.present, false);
  assert.match(c.detail, /could not read/i, c.detail);
  assert.match(c.detail, /403/, 'the underlying cause must survive into the message');
});

test('AB#6689110: verification uses the SAME table selector as the build', async () => {
  // `default: "off"` with NO per-table opt-in requests nothing, so nothing must be checked —
  // otherwise every spec that merely mentions `ai` fails. The selector is shared with the build
  // (`selectSummaryTables`) precisely so the set verified is the set built; duplicating the
  // default-vs-override rule here is how a verifier starts proving something else.
  const s = summarySpec();
  s.ai.summaries.tables.contoso_workitem.enabled = false;
  const r = await verifySpec(s, summaryReader({ rows: [] }));
  assert.strictEqual(r.checks.some((x) => x.kind === 'ai-summary'), false,
    'a table nobody asked for must not be verified');
  assert.strictEqual(r.ok, true);
});

// --- AB#6688906: an SVG in the legacy raster `icon` slot -----------------------------------------

const iconSpec = (subArea) => ({
  solution: { uniqueName: 'S', publisherPrefix: 'contoso' },
  app: { name: 'A' },
  entities: [{ schemaName: 'contoso_t', displayName: 'T', primaryAttribute: { schemaName: 'contoso_n' }, columns: [] }],
  webResources: [{ name: 'contoso_myactivework.svg', type: 'svg', content: '<svg/>' }],
  views: [], charts: [], forms: [],
  appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [subArea] }] }] },
});
const iconWarnings = (spec) => (validateAppSpec(spec, { profile: 'plan' }).warnings || []).filter((w) => /legacy RASTER slot/.test(w));

test('AB#6688906: an SVG in the legacy `icon` slot is flagged, naming the vectorIcon fix', () => {
  // Step 2 of the report: the author writes the SVG into `icon`, Dataverse accepts it, and the nav
  // renders a placeholder. Everything after that in the report — the switch to `vectorIcon`, the
  // stale `Icon` left behind — follows from this first wrong turn, which is the only half the
  // plugin can prevent.
  const w = iconWarnings(iconSpec({ url: 'https://contoso.example/x', title: 'My Active Work Items', icon: 'contoso_myactivework.svg' }));
  assert.strictEqual(w.length, 1, JSON.stringify(w));
  assert.match(w[0], /vectorIcon: "\$webresource:contoso_myactivework\.svg"/, 'it must name the exact replacement');
});

test('AB#6688906: the CORRECTED spec is silent', () => {
  // Step 4. A rule that still complains after the author has fixed it teaches them to ignore it.
  assert.deepStrictEqual(
    iconWarnings(iconSpec({ url: 'https://contoso.example/x', title: 'My Active Work Items', vectorIcon: '$webresource:contoso_myactivework.svg' })),
    [],
  );
});

test('AB#6688906: a raster icon beside a vector one stays legal', () => {
  // Deliberately NOT rejected. `Icon` + `VectorIcon` together is a legitimate legacy-fallback pair —
  // the shipped smoke spec uses exactly that shape, and an earlier draft of this rule broke it.
  assert.deepStrictEqual(
    iconWarnings(iconSpec({ url: 'https://contoso.example/x', title: 'T', icon: 'contoso_icon.png', vectorIcon: '/WebResources/contoso_v.svg' })),
    [],
  );
});

test('AB#6688906: a platform icon PATH ending .svg is not flagged', () => {
  // An OOB/WebResources path is resolved by the platform and is valid in the legacy slot; flagging
  // it would fire on every downloaded app that round-trips one.
  assert.deepStrictEqual(
    iconWarnings(iconSpec({ url: 'https://contoso.example/x', title: 'T', icon: '/WebResources/contoso_myactivework.svg' })),
    [],
  );
});

// --- AB#6688905: the workspace-metadata race must retry, not halt UNKNOWN ------------------------

const { runSdkBuild } = require('../lib/sdk-build.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const eventSpec = () => ({
  solution: { uniqueName: 'S', displayName: 'S', publisherPrefix: 'new' },
  app: { name: 'A', description: 'd' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
    primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' }, columns: [] }],
  webResources: [{ name: 'new_lib.js', type: 'js', content: 'function f(){}' }],
  forms: [{ entity: 'new_ticket', name: 'Main', formType: 'Main',
    events: [{ event: 'onload', library: 'new_lib.js', function: 'f' }] }],
  views: [], charts: [],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'R', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
});

// The exact error Node raises for the observed race: a Windows sharing/partial-write violation on
// the workspace metadata sibling, reported as UNKNOWN rather than ENOENT.
const raceError = (id) => new Error(
  String.raw`UNKNOWN: unknown error, open 'C:\\w\\.maker-workspace\\.metadata\\forms\\` + id + String.raw`.meta.json'`);

async function buildWithFlakyFetch(failures) {
  const { sdk } = makeSimpleMockSdk();
  const provision = Object.create(sdk);
  provision.queryRecords = async (entity) => {
    if (entity === 'solution' || entity === 'systemform') return [];
    return [{ publisherid: 'pub-1' }];
  };
  let attempts = 0;
  provision.fetchArtifact = async (type, id) => {
    if (type === 'form') {
      attempts += 1;
      if (attempts <= failures) throw raceError(id);
    }
    return sdk.fetchArtifact(type, id);
  };
  const res = await runSdkBuild(eventSpec(), {
    sdk, provisionSdk: provision, apply: true, phases: ['forms'],
    emit: () => undefined, warn: () => undefined,
  });
  return { res, attempts };
}

test('AB#6688905: a transient workspace-metadata failure is RETRIED, not halted', async () => {
  // The reporter's second identical run succeeded, which is the proof the state is transient: the
  // form ROW was already created and only the local workspace sibling had not landed. Halting a
  // multi-form build on that -- with a bare `UNKNOWN` the operator can do nothing with -- costs the
  // whole app-shell, AI and publish phases for a file flush that finishes microseconds later.
  const { res, attempts } = await buildWithFlakyFetch(2);
  assert.strictEqual(res.ok, true, JSON.stringify(res).slice(0, 400));
  assert.ok(attempts >= 3, `it must actually have retried; attempts=${attempts}`);
});

test('AB#6688905: a PERSISTENT metadata failure still fails, naming the race', async () => {
  // The retry must be bounded. A form whose metadata never lands is a real failure -- but the
  // message has to say it is a LOCAL workspace race and that a re-run fixes it, rather than the
  // bare `UNKNOWN: unknown error, open ...` the report quoted.
  await assert.rejects(
    () => buildWithFlakyFetch(Number.MAX_SAFE_INTEGER),
    (err) => {
      const m = String(err && err.message);
      assert.match(m, /workspace metadata/i, m);
      assert.match(m, /not a Dataverse failure/i, 'it must not send the operator to the server');
      assert.match(m, /idempotent/i, 'and must name the remedy: re-run');
      return true;
    });
});

test('AB#6688905: an UNRELATED fetch failure is NOT retried or reworded', async () => {
  // Narrow on purpose. Retrying a genuine Dataverse error would turn one clear failure into four
  // slow ones, and rewording it would hide the real cause.
  const { sdk } = makeSimpleMockSdk();
  const provision = Object.create(sdk);
  provision.queryRecords = async (entity) => {
    if (entity === 'solution' || entity === 'systemform') return [];
    return [{ publisherid: 'pub-1' }];
  };
  let attempts = 0;
  provision.fetchArtifact = async (type) => {
    if (type === 'form') { attempts += 1; throw new Error('HTTP 403 from systemforms: principal lacks prvReadSystemForm'); }
    return undefined;
  };
  await assert.rejects(
    () => runSdkBuild(eventSpec(), { sdk, provisionSdk: provision, apply: true, phases: ['forms'], emit: () => undefined, warn: () => undefined }),
    (err) => { assert.match(String(err.message), /403/, String(err.message)); return true; });
  assert.strictEqual(attempts, 1, 'a non-race error must be surfaced on the FIRST attempt');
});

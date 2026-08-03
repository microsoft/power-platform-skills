'use strict';
// Coverage for the design-completeness lint warnings in scripts/lib/spec-lint.js AND the App Spec
// `personas[].jobs[].surfaces[]` shape validation in scripts/lib/app-spec.js. Both landed together
// to close three testing-only gaps in the /app-builder authoring flow:
//   1. jobs-to-be-done were never enumerated (personas[] left empty, or jobs[] left empty),
//   2. jobs were never mapped to the surfaces that satisfy them (surfaces[] never populated),
//   3. generative pages were never proposed (pages[] left empty).
// Each is a WARNING, not an error — the app is still buildable — but surfacing them at the plan
// gate makes the omission visible while it is still cheap to fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { validateAppSpec } = require('../lib/app-spec.js');

// The four warning message signatures we assert on. Kept as regexes so a copy-edit that keeps the
// meaning does not break the tests, but a semantic change (e.g. downgraded from warning to nothing)
// still fails.
const W_NO_PERSONAS = /no personas\[\]/;
const W_NO_JOBS = /personas\[\] declares no jobs/;
const W_JOB_UNMAPPED = /is not mapped to a surface/;
const W_NO_PAGES = /no pages\[\]/;

// Minimal, clean base spec: has entities so the pre-existing lint rules do not flood with unrelated
// errors, uses the publisher prefix so no prefix warnings fire either. The tests below layer on/off
// personas/jobs/pages to isolate the new lint behaviours.
function base() {
  return {
    solution: { uniqueName: 'X', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Title' }, columns: [] },
    ],
    forms: [], views: [], charts: [],
  };
}

// A complete spec that exercises every design axis: personas with jobs, every job mapped to a
// surface, and pages authored. NONE of the four new warnings should fire on this — it is the
// upper-bound proof that the warnings are additive and not a blanket "personas => warning".
function complete() {
  const s = base();
  s.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }];
  s.personas = [{
    persona: 'Agent',
    jobs: [{
      name: 'Triage tickets',
      privileges: [{ entity: 'new_ticket', access: ['read', 'write'], scope: 'user' }],
      surfaces: ['Active Tickets'],
    }],
  }];
  return s;
}

// ---- lint warnings --------------------------------------------------------------------------

test('a spec with no personas[] triggers the "no personas[]" warning', () => {
  const r = lintAppSpec(base());
  assert.equal(r.ok, true, 'design gaps are warnings, never errors: ' + JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => W_NO_PERSONAS.test(w)), JSON.stringify(r.warnings));
});

test('a clean, complete spec produces NONE of the four new design-completeness warnings', () => {
  // The upper-bound proof: personas + jobs + surfaces + pages leaves all four gaps closed.
  // If any of these fires, the lint has drifted (e.g. added a stronger check that the fixture
  // no longer satisfies), which is a real finding — the base fixture would need updating.
  const r = lintAppSpec(complete());
  const design = r.warnings.filter((w) => [W_NO_PERSONAS, W_NO_JOBS, W_JOB_UNMAPPED, W_NO_PAGES].some((re) => re.test(w)));
  assert.deepEqual(design, [], `expected no design-completeness warnings, got: ${JSON.stringify(design)}`);
  assert.equal(r.ok, true);
});

test('a persona with empty jobs[] triggers the "personas[] declares no jobs" lint warning', () => {
  // Note: validateAppSpec ALSO rejects `jobs: []` as a hard error ("at least one job is required"),
  // but the lint is a separate pass and the two do not share state — a caller that only invokes
  // lintAppSpec (e.g. a downloaded spec whose personas got dropped by hydration) still sees the
  // teaching warning. Assert the OBSERVED lint behaviour: warning fires, `ok` stays true, `errors`
  // stays empty. The validateAppSpec-side error is covered separately below.
  const s = base();
  s.personas = [{ persona: 'Agent', jobs: [] }];
  const r = lintAppSpec(s);
  assert.equal(r.ok, true, 'lint treats no-jobs as a warning, not an error');
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => W_NO_JOBS.test(w)), JSON.stringify(r.warnings));
  // The "no personas" warning must NOT fire in this shape — personas[] is present, just empty.
  assert.ok(!r.warnings.some((w) => W_NO_PERSONAS.test(w)), 'no-personas warning should not fire when personas[] is non-empty');
});

test('a job without surfaces[] warns, naming both the persona and the job', () => {
  const s = base();
  s.personas = [{
    persona: 'Agent',
    jobs: [{
      name: 'Triage tickets',
      privileges: [{ entity: 'new_ticket', access: ['read'] }],
      // no surfaces[]
    }],
  }];
  s.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }];
  const r = lintAppSpec(s);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  const w = r.warnings.find((m) => W_JOB_UNMAPPED.test(m));
  assert.ok(w, `expected an unmapped-job warning, got: ${JSON.stringify(r.warnings)}`);
  // A generic "some job is unmapped" message would leave the author guessing WHICH job — both the
  // persona and the job name must be in the message so it points at the fix.
  assert.match(w, /Agent/, 'persona name must appear in the warning');
  assert.match(w, /Triage tickets/, 'job name must appear in the warning');
});

test('a job with a non-empty surfaces[] does NOT trigger the unmapped-job warning', () => {
  const s = base();
  s.personas = [{
    persona: 'Agent',
    jobs: [{ name: 'Triage', privileges: [{ entity: 'new_ticket', access: ['read'] }], surfaces: ['Active Tickets'] }],
  }];
  s.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }];
  const r = lintAppSpec(s);
  assert.ok(!r.warnings.some((w) => W_JOB_UNMAPPED.test(w)), JSON.stringify(r.warnings));
});

test('a spec with no pages[] triggers the "no pages[]" warning', () => {
  // The genpage-first policy says non-record surfaces should be generative pages, so a spec that
  // declares zero pages is very likely missing something a reviewer needs to see called out.
  const s = base();
  // Add personas + jobs + surfaces so we isolate ONLY the no-pages warning.
  s.personas = [{ persona: 'Agent', jobs: [{ name: 'J', privileges: [{ entity: 'new_ticket', access: ['read'] }], surfaces: ['Active Tickets'] }] }];
  const r = lintAppSpec(s);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => W_NO_PAGES.test(w)), JSON.stringify(r.warnings));
});

test('a spec WITH pages[] does not trigger the no-pages warning', () => {
  const s = base();
  s.personas = [{ persona: 'Agent', jobs: [{ name: 'J', privileges: [{ entity: 'new_ticket', access: ['read'] }], surfaces: ['x'] }] }];
  s.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }];
  const r = lintAppSpec(s);
  assert.ok(!r.warnings.some((w) => W_NO_PAGES.test(w)), JSON.stringify(r.warnings));
});

test('all four design gaps stay warnings, never errors (never block the plan gate)', () => {
  // Regression: an overzealous refactor could re-classify any of these as an error, which would
  // block the plan gate on a spec the author explicitly wants to be permissive about. Assert the
  // combined worst case: no personas, no pages → BOTH warnings fire, `ok` stays true, `errors`
  // stays empty. This is the contract the /app-builder skill relies on to keep the flow moving.
  const r = lintAppSpec(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => W_NO_PERSONAS.test(w)));
  assert.ok(r.warnings.some((w) => W_NO_PAGES.test(w)));
});

// ---- validateAppSpec: surfaces[] shape validation --------------------------------------------

// Minimal spec that passes validateAppSpec for everything EXCEPT the surfaces[] under test — so any
// error we observe is unambiguously about surfaces (or the unknown-key control test).
function specWithJobSurfaces(surfaces, extraJobKeys = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'X', publisherPrefix: 'new' },
    app: { name: 'A' },
    entities: [
      { schemaName: 'new_ticket', displayName: 'Ticket',
        primaryAttribute: { schemaName: 'new_name', displayName: 'Title' }, columns: [] },
    ],
    personas: [{
      persona: 'Agent',
      jobs: [{
        name: 'Triage',
        privileges: [{ entity: 'new_ticket', access: ['read'], scope: 'user' }],
        ...(surfaces !== undefined ? { surfaces } : {}),
        ...extraJobKeys,
      }],
    }],
  };
}

test('validateAppSpec accepts a valid surfaces: [\'Active Tickets\'] job mapping', () => {
  const r = validateAppSpec(specWithJobSurfaces(['Active Tickets']));
  // Guard: the ONLY surfaces-related error would mention `surfaces` — if the fixture is off in a
  // way that surfaces validation is not being reached, the assertion below will still catch it,
  // but this pinpoints why for a maintainer.
  const surfaceErrors = r.errors.filter((e) => /surfaces/.test(e));
  assert.deepEqual(surfaceErrors, [], `unexpected surfaces errors: ${JSON.stringify(surfaceErrors)}`);
  assert.equal(r.ok, true, `spec should pass; errors: ${JSON.stringify(r.errors)}`);
});

test('validateAppSpec rejects surfaces: \'x\' (a string, not an array)', () => {
  const r = validateAppSpec(specWithJobSurfaces('x'));
  assert.equal(r.ok, false);
  // Message must call out the shape violation on the specific job so the author can find it.
  const err = r.errors.find((e) => /surfaces must be an array of strings/.test(e));
  assert.ok(err, `expected shape error, got: ${JSON.stringify(r.errors)}`);
  assert.match(err, /Agent/);
  assert.match(err, /Triage/);
});

test('validateAppSpec rejects surfaces: [\'\'] (empty-string entry)', () => {
  const r = validateAppSpec(specWithJobSurfaces(['']));
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => /each surfaces\[\] entry must be a non-empty string/.test(e));
  assert.ok(err, `expected empty-entry error, got: ${JSON.stringify(r.errors)}`);
});

test('validateAppSpec rejects surfaces: [123] (numeric entry, not a string)', () => {
  const r = validateAppSpec(specWithJobSurfaces([123]));
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => /each surfaces\[\] entry must be a non-empty string/.test(e));
  assert.ok(err, `expected type error on numeric entry, got: ${JSON.stringify(r.errors)}`);
});

test('validateAppSpec still rejects an unknown key on a job (surfaces did not widen the allowlist)', () => {
  // Regression: it would be easy to accidentally add `surfaces` to the JOB_KEYS allowlist AND drop
  // the rejectUnknown call, which would silently accept typos. This pins that unknown keys ARE
  // still rejected — the surfaces addition is additive to the allowlist, not a removal of the
  // rejectUnknown guard.
  const r = validateAppSpec(specWithJobSurfaces(['Active Tickets'], { totallyNotAKey: true }));
  assert.equal(r.ok, false);
  const err = r.errors.find((e) => /unknown key 'totallyNotAKey'/.test(e));
  assert.ok(err, `expected unknown-key error, got: ${JSON.stringify(r.errors)}`);
});

test('validateAppSpec: omitted surfaces is fine (surfaces is optional and documentary)', () => {
  // The spec-lint pass warns about a missing surface mapping; the validate pass should NOT error
  // on it, because a surface may legitimately name an artifact this spec does not author (a stock
  // Dataverse view) and requiring authorship would break that pattern.
  const r = validateAppSpec(specWithJobSurfaces(undefined));
  const surfaceErrors = r.errors.filter((e) => /surfaces/.test(e));
  assert.deepEqual(surfaceErrors, [], `omitted surfaces must not error: ${JSON.stringify(surfaceErrors)}`);
  assert.equal(r.ok, true, `spec should pass with omitted surfaces; errors: ${JSON.stringify(r.errors)}`);
});

test('lint does not crash on a half-typed personas block', () => {
  // Lint is the gate the author hits mid-authoring, so it sees work-in-progress specs. It fixed two
  // pre-existing crash shapes (personas not an array, a null persona) rather than adding more.
  for (const spec of [
    { personas: {} }, { personas: [null] },
    { personas: [{ persona: 'P', jobs: [null] }] },
    { personas: [{ persona: 'P', jobs: 'x' }] },
    { personas: [{ persona: 'P', jobs: [{ name: 'j', surfaces: 'x' }] }] },
    { pages: 'x' },
  ]) {
    assert.doesNotThrow(() => lintAppSpec(spec), `threw on ${JSON.stringify(spec)}`);
  }
});

// --- iconDescription: a depiction, never a Fluent token (tester ask) ---

const iconSpec = (iconDescription, extra = {}) => ({
  schemaVersion: 2, solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
  entities: [{ schemaName: 'new_t', displayName: 'T', iconDescription,
    primaryAttribute: { schemaName: 'new_name', displayName: 'N', type: 'Text' }, ...extra }],
  appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [{ entity: 'new_t', title: 'T' }] }] }] },
});
const iconErrors = (spec) => (validateAppSpec(spec, { profile: 'plan' }).errors || []).filter((e) => /iconDescription/.test(e));

test('a plain-language depiction is accepted', () => {
  for (const d of [
    'a briefcase',
    'an outlined clipboard with a checkmark',
    'a laptop with a clock overlay',
    'briefcase',                    // terse, but still a depiction
    'A briefcase with a handle',    // a phrase may start with a capital
  ]) {
    assert.deepEqual(iconErrors(iconSpec(d)), [], `wrongly rejected: ${d}`);
  }
});

test('a Fluent icon token is rejected — the user has never seen it, so it describes nothing', () => {
  // The SVG is authored fresh in this phase; there is no library being picked from, so a token name
  // cannot tell the user what the glyph will look like. This is the tester's core ask.
  for (const d of ['Briefcase', 'ClipboardTask', 'DocumentBulletList24Regular', 'clipboardTask', 'PersonRegular']) {
    const errs = iconErrors(iconSpec(d));
    assert.equal(errs.length, 1, `should reject token: ${d}`);
    assert.match(errs[0], /looks like a Fluent icon token/);
  }
});

test('iconDescription must be a non-empty string when present', () => {
  for (const d of ['', '   ', 42, null, {}]) assert.ok(iconErrors(iconSpec(d)).length, `should reject: ${JSON.stringify(d)}`);
  // Absent is fine — it is recommended, not required.
  const spec = iconSpec(undefined);
  delete spec.entities[0].iconDescription;
  assert.deepEqual(iconErrors(spec), []);
});

test('sitemap area, group and non-entity subarea descriptions follow the same rule', () => {
  const mk = (where) => ({
    schemaVersion: 2, solution: { uniqueName: 'S', publisherPrefix: 'new' }, app: { name: 'A' },
    entities: [{ schemaName: 'new_t', displayName: 'T', primaryAttribute: { schemaName: 'new_name', displayName: 'N', type: 'Text' } }],
    appShell: { areas: [{ label: 'A', ...(where === 'area' ? { iconDescription: 'ClipboardTask' } : {}),
      groups: [{ label: 'G', ...(where === 'group' ? { iconDescription: 'ClipboardTask' } : {}),
        subAreas: [{ entity: 'new_t', title: 'T', ...(where === 'subarea' ? { iconDescription: 'ClipboardTask' } : {}) }] }] }] },
  });
  for (const where of ['area', 'group', 'subarea']) {
    const errs = iconErrors(mk(where));
    assert.equal(errs.length, 1, `${where}: token should be rejected`);
    assert.match(errs[0], new RegExp(`sitemap ${where === 'subarea' ? 'subArea' : where}`, 'i'));
  }
});

test('a custom table with an icon but no description is a lint WARNING, not an error', () => {
  const spec = iconSpec(undefined, { vectorIcon: 'new_t_icon' });
  delete spec.entities[0].iconDescription;
  const r = lintAppSpec(spec);
  assert.equal(r.ok, true, 'must never block the plan gate');
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /new_t.*iconDescription/.test(w)), `expected a warning, got: ${JSON.stringify(r.warnings)}`);
  // Describing it clears the warning; a REUSED table never warns (it already ships an icon).
  spec.entities[0].iconDescription = 'a briefcase';
  assert.ok(!lintAppSpec(spec).warnings.some((w) => /iconDescription/.test(w)));
  const reused = iconSpec(undefined, { vectorIcon: 'new_t_icon', existing: true });
  delete reused.entities[0].iconDescription;
  assert.ok(!lintAppSpec(reused).warnings.some((w) => /iconDescription/.test(w)));
});

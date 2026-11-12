'use strict';
// A spec with no `appShell` used to CRASH the build with a bare
// `Cannot read properties of undefined (reading 'areas')`, thrown from `appDef` at the app-shell
// phase — after the solution, tables, columns, views and the generated app icon had already been
// created in the environment. The operator got a half-built app and an error naming nothing they
// could act on.
//
// The fix is deliberately NOT "make validation require appShell". That was tried and reverted:
// 19 existing tests build minimal specs with no `appShell` under the default `deploy` profile and
// assert they validate clean, and the download round-trip depends on that permissiveness. So the
// contract stays "optional to validation", and the BUILD is what reports the problem — with a
// message that says exactly what to add. It now reports it before anything is written, from the
// spec alone (lib/app-navigation.js, pinned in app-navigation-build.test.js); the error `appDef`
// throws is the backstop these tests keep pinned.
//
// Found by live deep-testing the ai-features phase, whose spec legitimately declared no navigation.
const test = require('node:test');
const assert = require('node:assert');

const { validateAppSpec } = require('../lib/app-spec.js');
const { appDef } = require('../lib/sdk-build.js');
const { navigationVerdict } = require('../lib/app-navigation.js');

const base = () => ({
  solution: { uniqueName: 'ZZTest', publisherPrefix: 'zzt' },
  app: { name: 'ZZ Test' },
  entities: [{
    schemaName: 'zzt_thing',
    displayName: 'Thing',
    pluralName: 'Things',
    primaryAttribute: { schemaName: 'zzt_name', displayName: 'Name' },
  }],
});

const emptyResult = () => ({ forms: {}, views: {}, charts: {}, pages: {}, dashboards: {} });

test('validation still ACCEPTS a spec with no appShell (the permissive contract is intentional)', () => {
  const r = validateAppSpec(base());
  const shellErrors = ((r && r.errors) || []).filter((e) => /appShell/.test(e));
  assert.deepStrictEqual(shellErrors, [], 'requiring appShell breaks the download round-trip and 19 existing tests');
});

test('appDef throws an ACTIONABLE error for a missing appShell, not a raw TypeError', () => {
  let err;
  try { appDef(base(), emptyResult(), {}); } catch (e) { err = e; }
  assert.ok(err, 'a spec with no appShell must not build silently');
  // The regression witness: this is the exact string the old code produced.
  assert.ok(
    !/Cannot read properties of undefined/.test(err.message),
    `must not surface a raw TypeError; got: ${err.message}`,
  );
  assert.match(err.message, /appShell/, 'must name the key');
  assert.match(err.message, /areas/, 'must name the shape');
  assert.match(err.message, /subAreas/, 'must show the author what to add');
});

test('appDef throws the same actionable error when appShell.areas is not an array', () => {
  const spec = base();
  spec.appShell = {};
  let err;
  try { appDef(spec, emptyResult(), {}); } catch (e) { err = e; }
  assert.ok(err && /appShell/.test(err.message), 'an appShell with no areas cannot build a sitemap either');
  assert.ok(!/Cannot read properties of undefined/.test(err.message), 'still must not be a raw TypeError');
});

test('a valid appShell builds a sitemap — the guard is not a blanket reject', () => {
  const spec = base();
  spec.appShell = {
    areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'zzt_thing', title: 'Things' }] }] }],
  };
  const json = appDef(spec, emptyResult(), {});
  assert.strictEqual(json.siteMap.areas.length, 1);
  assert.strictEqual(json.siteMap.areas[0].groups[0].subAreas[0].entity, 'zzt_thing');
});

// `areas: []` is VALID for validation, and appDef builds it into an empty sitemap instead of throwing — which is why a refusal, when there is one, comes from
// the navigation check (lib/app-navigation.js) with its own message. Whether a build writes it depends on the app: Dataverse refuses to CREATE a sitemap with no
// entry, so a new app is refused before anything is written, and accepts one on an UPDATE, so an app that exists is built, with a warning that it is left with
// no navigation entries.
test('an EMPTY areas[] is valid and appDef builds it into an empty sitemap — the navigation check, not appDef, refuses it for a new app and lets an existing one through', () => {
  const spec = base();
  spec.appShell = { areas: [] };
  assert.deepStrictEqual(((validateAppSpec(spec) || {}).errors || []).filter((e) => /appShell/.test(e)), [], 'valid for validation');
  const json = appDef(spec, emptyResult(), {});
  assert.deepStrictEqual(json.siteMap.areas, [], 'appDef does not throw on it: an explicit empty areas[] is a different thing from no areas[] at all');
  assert.strictEqual(navigationVerdict(spec, { appExists: false }).outcome, 'refuse', 'a new app is refused before anything is written');
  assert.strictEqual(navigationVerdict(spec, { appExists: true }).outcome, 'warn', 'an app that exists is built, and told what it is left with');
});

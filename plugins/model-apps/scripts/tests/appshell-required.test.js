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
// message that says exactly what to add.
//
// Found by live deep-testing the ai-features phase, whose spec legitimately declared no navigation.
const test = require('node:test');
const assert = require('node:assert');

const { validateAppSpec } = require('../lib/app-spec.js');
const { appDef } = require('../lib/sdk-build.js');

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

test('an EMPTY areas[] is still allowed through — it is a valid, if empty, sitemap', () => {
  const spec = base();
  spec.appShell = { areas: [] };
  const json = appDef(spec, emptyResult(), {});
  assert.deepStrictEqual(json.siteMap.areas, [], 'an explicit empty areas[] is a choice, not a mistake');
});

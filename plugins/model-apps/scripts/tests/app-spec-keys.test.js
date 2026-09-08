const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { validateAppSpec } = require(path.join(__dirname, '..', 'lib', 'app-spec.js'));

function base() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
    app: { name: 'Contoso', },
    entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  };
}

test('schemaVersion 2 page requires a unique key', () => {
  const s = base();
  s.pages = [{ name: 'Overview', source: { kind: 'intent' } }]; // no key
  assert.ok(validateAppSpec(s, { profile: 'plan' }).errors.some((e) => /page 'Overview': needs a stable key/.test(e)));
  const dup = base();
  dup.pages = [{ key: 'ov', name: 'A', source: { kind: 'intent' } }, { key: 'ov', name: 'B', source: { kind: 'intent' } }];
  assert.ok(validateAppSpec(dup, { profile: 'plan' }).errors.some((e) => /duplicate page key 'ov'/.test(e)));
});

test('navigatesTo.targetKey must resolve to a known page key', () => {
  const s = base();
  s.pages = [
    { key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'detail', data: { orderId: 'string' } }] },
    // `detail` is sitemap-placed (every page must be), so it is reachable from the nav with no
    // orderId — `directEntry` is what the author says happens then. Without it this spec is
    // rejected, which is the point: previously it validated and generated a page that read
    // undefined context on a path a user can reach by clicking the nav entry.
    { key: 'detail', name: 'Detail', source: { kind: 'intent' }, pageInput: { data: { orderId: 'string' } }, directEntry: { behavior: 'selector' } },
  ];
  // Place every page in the sitemap so the every-page-placed rule (Task 3) does not fail this spec.
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'ov', title: 'Overview' }, { page: 'detail', title: 'Detail' });
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));

  const bad = base();
  bad.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'ghost' }] }];
  assert.ok(validateAppSpec(bad, { profile: 'plan' }).errors.some((e) => /navigatesTo target 'ghost' is not a known page key/.test(e)));
});

test('appShell page subarea references the key (schemaVersion 2)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  s.appShell.areas[0].groups[0].subAreas.push({ title: 'Overview', page: 'ov' });
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));

  const badRef = base();
  badRef.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  badRef.appShell.areas[0].groups[0].subAreas.push({ title: 'Overview', page: 'Overview' }); // used name, not key
  assert.ok(validateAppSpec(badRef, { profile: 'plan' }).errors.some((e) => /unknown page 'Overview'/.test(e)));
});

test('spec.design accepts known keys and rejects unknown ones', () => {
  const s = base();
  s.design = { accentColor: '#0f6cbd', density: 'comfortable', layout: 'cards' };
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
  const bad = base();
  bad.design = { accent: '#000' };
  assert.ok(validateAppSpec(bad, { profile: 'plan' }).errors.some((e) => /design: unknown key 'accent'/.test(e)));
});

// Minor #7 additions ------------------------------------------------------------------

test('navigatesTo entry with a missing or non-string targetKey errors (isV2)', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{}] }]; // no targetKey
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.ok(r.errors.some((e) => /navigatesTo entry needs a targetKey/.test(e)),
    `expected targetKey error, got: ${JSON.stringify(r.errors)}`);

  const nonStr = base();
  nonStr.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 42 }] }];
  assert.ok(validateAppSpec(nonStr, { profile: 'plan' }).errors.some((e) => /navigatesTo entry needs a targetKey/.test(e)));
});

test('navigatesTo.data as a non-object errors (isV2)', () => {
  const s = base();
  s.pages = [
    { key: 'target', name: 'Target', source: { kind: 'intent' } },
    { key: 'src', name: 'Source', source: { kind: 'intent' },
      navigatesTo: [{ targetKey: 'target', data: 'invalid' }] },
  ];
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.ok(r.errors.some((e) => /navigatesTo.data must be an object/.test(e)),
    `expected data error, got: ${JSON.stringify(r.errors)}`);
});

test('design as a non-object errors (isV2)', () => {
  const s = base();
  s.design = 'not-an-object';
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.ok(r.errors.some((e) => /design must be an object/.test(e)),
    `expected design-non-object error, got: ${JSON.stringify(r.errors)}`);
});

test('navigatesTo/pageInput/design validation is skipped for legacy (non-v2) specs', () => {
  // A legacy spec (no schemaVersion) with navigatesTo / pageInput / design should NOT be
  // rejected — these are v2-only fields and a hand-authored legacy spec might not satisfy
  // the v2 contract.
  const legacy = {
    solution: { uniqueName: 'c', publisherPrefix: 'c' }, app: { name: 'C' },
    entities: [{ schemaName: 'c_e', primaryAttribute: { schemaName: 'c_name' }, columns: [] }],
    pages: [
      { name: 'Overview', codeFile: 'o.tsx', navigatesTo: [{ targetKey: 'nowhere' }],
        pageInput: { data: {} } },
    ],
    design: { accentColor: '#f00' },
  };
  const r = validateAppSpec(legacy, { profile: 'deploy' });
  // navigatesTo / pageInput / design validation is gated on isV2, so no errors from those.
  assert.ok(!r.errors.some((e) => /navigatesTo|pageInput|design/.test(e)),
    `unexpected v2-only errors on legacy spec: ${JSON.stringify(r.errors)}`);
});

// The sitemap-placement invariant and pageInput used to CONFLICT with no way for an author to
// satisfy both: every page must be a sitemap subarea (the sitemap is download's only membership
// oracle, so a nav-only page is invisible and gets duplicated on rebuild), yet a detail page needs
// caller-supplied context. Being in the sitemap means the page is ALSO reachable from the nav with
// no input at all — a state nothing previously made the author account for, so the generated page
// read undefined context on a path a user reaches by clicking. `directEntry` is that answer.
test('a page with pageInput must declare directEntry (it is sitemap-placed, so nav entry supplies nothing)', () => {
  const s = base();
  s.pages = [
    { key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'detail', data: { orderId: 'string' } }] },
    { key: 'detail', name: 'Detail', source: { kind: 'intent' }, pageInput: { data: { orderId: 'string' } } },
  ];
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'ov', title: 'Overview' }, { page: 'detail', title: 'Detail' });
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.strictEqual(r.ok, false, 'pageInput without directEntry must be rejected');
  assert.ok(r.errors.some((e) => /declares pageInput .* but no directEntry/.test(e)), JSON.stringify(r.errors));

  // Supplying it makes the same spec valid.
  s.pages[1].directEntry = { behavior: 'selector' };
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
});

test('directEntry.behavior is constrained to the behaviours the generator can actually implement', () => {
  const s = base();
  s.pages = [
    { key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'detail', data: { orderId: 'string' } }] },
    { key: 'detail', name: 'Detail', source: { kind: 'intent' }, pageInput: { data: { orderId: 'string' } }, directEntry: { behavior: 'shrug' } },
  ];
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'ov', title: 'Overview' }, { page: 'detail', title: 'Detail' });
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.ok(r.errors.some((e) => /directEntry.behavior must be one of/.test(e)), JSON.stringify(r.errors));

  for (const behavior of ['selector', 'emptyState']) {
    s.pages[1].directEntry = { behavior };
    assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, behavior + ': ' + JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
  }
});

// The input-contract trace. An input nothing supplies is either a typo or a page that can only ever
// be entered directly; both produce a page reading a key no caller ever sets.
test('every pageInput key must be produced by an incoming navigatesTo edge', () => {
  const s = base();
  s.pages = [
    { key: 'ov', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'detail', data: { orderId: 'string' } }] },
    // `customerId` is declared but no page navigates with it.
    { key: 'detail', name: 'Detail', source: { kind: 'intent' }, pageInput: { data: { orderId: 'string', customerId: 'string' } }, directEntry: { behavior: 'selector' } },
  ];
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'ov', title: 'Overview' }, { page: 'detail', title: 'Detail' });
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /'customerId'.*no page navigates to it with that data/.test(e)), JSON.stringify(r.errors));

  // Producing it on the edge resolves it.
  s.pages[0].navigatesTo[0].data.customerId = 'string';
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
});

test('a page with no pageInput needs no directEntry', () => {
  const s = base();
  s.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'ov', title: 'Overview' });
  assert.strictEqual(validateAppSpec(s, { profile: 'plan' }).ok, true, JSON.stringify(validateAppSpec(s, { profile: 'plan' }).errors));
});

// The modern ("new look") shell is a per-app SETTING, not an appmodule column — `navigationtype` is
// Single/Multi *session* and unrelated. Boolean-only, because a string "false" is truthy in JS and
// would turn the new look ON for an author who wrote it to stay off.
test('app.newLook must be a boolean', () => {
  const s = base();
  s.app.newLook = 'false';
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.ok(r.errors.some((e) => /app.newLook must be a boolean/.test(e)), JSON.stringify(r.errors));

  for (const v of [true, false]) {
    const ok = base();
    ok.app.newLook = v;
    assert.strictEqual(validateAppSpec(ok, { profile: 'plan' }).ok, true, String(v) + ': ' + JSON.stringify(validateAppSpec(ok, { profile: 'plan' }).errors));
  }
  // Absent is fine — the new look is opt-in.
  assert.strictEqual(validateAppSpec(base(), { profile: 'plan' }).ok, true);
});

// ---------------------------------------------------------------------------------------------
// #537 — entities[] had no allow-list, so a key with no reader validated clean and was dropped.
//
// The two that motivated this are `languageCode` and `localizedLabels`: the natural ways to ask for
// a per-table or multi-language label. Both were accepted and silently ignored, so an author asking
// for one table in Spanish got a SUCCESSFUL build with the request gone. These pin the loud failure
// AND the alternative each error names, because an error that does not say what to write instead
// just moves the dead end.
// ---------------------------------------------------------------------------------------------

test('#537: entities[].languageCode is rejected and names the spec-level languageCode', () => {
  for (const profile of ['plan', 'deploy']) {
    const s = base();
    s.entities[0].languageCode = 3082;
    const r = validateAppSpec(s, { profile });
    const hit = (r.errors || []).find((e) => /unknown key 'languageCode'/.test(e));
    assert.ok(hit, `${profile}: ` + JSON.stringify(r.errors));
    // Naming the supported alternative is the point of the error, not a nicety.
    assert.match(hit, /spec-level `languageCode`/);
    assert.match(hit, /build-wide, not per-table/);
  }
});

test('#537: entities[].localizedLabels is rejected and says multi-language is unsupported', () => {
  for (const profile of ['plan', 'deploy']) {
    const s = base();
    s.entities[0].localizedLabels = { 3082: 'Cliente', 1033: 'Customer' };
    const r = validateAppSpec(s, { profile });
    const hit = (r.errors || []).find((e) => /unknown key 'localizedLabels'/.test(e));
    assert.ok(hit, `${profile}: ` + JSON.stringify(r.errors));
    assert.match(hit, /multi-language labels are not supported/);
  }
});

test('#537: a misspelled entity key fails loudly instead of being dropped', () => {
  const s = base();
  s.entities[0].pluralname = 'Orders'; // real key is `pluralName`
  const r = validateAppSpec(s, { profile: 'plan' });
  const hit = (r.errors || []).find((e) => /unknown key 'pluralname'/.test(e));
  assert.ok(hit, JSON.stringify(r.errors));
  assert.match(hit, /allowed: .*pluralName/); // the allowed list is what makes the typo obvious
});

// The counterpart that matters most: an allow-list that is too NARROW silently breaks valid specs,
// which is a worse failure than the one being fixed. Every key the build reads must still validate.
test('#537: every supported entity key still validates clean', () => {
  const s = base();
  s.webResources = [
    { name: 'contoso_i', displayName: 'I', type: 'svg', content: '<svg/>' },
    { name: 'contoso_p', displayName: 'P', type: 'png', contentBase64: 'AA==' },
  ];
  Object.assign(s.entities[0], {
    displayName: 'Order', pluralName: 'Orders', description: 'An order.',
    hasNotes: true, quickCreate: true, existing: false, enrichDefaultViews: true,
    vectorIcon: 'contoso_i', iconDescription: 'a box', icon: 'contoso_p',
    statusReasons: [], alternateKeys: [],
  });
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

// A malformed entity must not be re-described as a key problem: Object.keys('x') is ['0'], which
// would report a bogus "unknown key '0'" on top of the real shape error.
test('#537: a non-object entity does not produce a bogus index key error', () => {
  const s = base();
  s.entities.push('contoso_ghost');
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.ok(!(r.errors || []).some((e) => /unknown key '\d+'/.test(e)), JSON.stringify(r.errors));
});

// The bare "must be a positive integer LCID" named the mistake but not the fix, and a language TAG
// is the likeliest thing an author writes. A tag is deliberately NOT accepted as an alias: es-ES is
// 3082 (international sort) or 1034 (traditional), and guessing wrong would not fail — it would
// build every label in the wrong language.
test('#537: the languageCode error names an LCID and rejects a language tag', () => {
  const s = base();
  s.languageCode = 'es-ES';
  const r = validateAppSpec(s, { profile: 'plan' });
  const hit = (r.errors || []).find((e) => /languageCode must be a positive integer LCID/.test(e));
  assert.ok(hit, JSON.stringify(r.errors));
  assert.match(hit, /1033 \(en-US\)/);      // a concrete value to copy
  assert.match(hit, /not a language tag/);
  assert.match(hit, /"es-ES"/);              // echoes what was actually written

  // The supported spelling still passes, in both profiles.
  for (const profile of ['plan', 'deploy']) {
    const ok = base();
    ok.languageCode = 3082;
    assert.strictEqual(validateAppSpec(ok, { profile }).ok, true, JSON.stringify(validateAppSpec(ok, { profile }).errors));
  }
});

// The hint lookup is keyed by a name that comes from the SPEC, so an inherited Object.prototype
// member must not become part of the message. Before the map was made prototype-less, a table with
// a `constructor` key reported: unknown key 'constructor'function Object() { [native code] }
test('#537: an entity key that collides with Object.prototype does not leak a native function', () => {
  const s = base();
  s.entities[0].constructor = 1;
  s.entities[0].toString = 2;
  const r = validateAppSpec(s, { profile: 'plan' });
  const hits = (r.errors || []).filter((e) => /unknown key/.test(e));
  assert.strictEqual(hits.length, 2, JSON.stringify(r.errors));
  for (const h of hits) assert.ok(!/native code/.test(h), h);
});

// A validator's contract is to RETURN problems, not throw them. Both of these threw before the
// guards went in: Object.prototype.toString throws on a revoked Proxy, and an entity Proxy whose
// ownKeys trap throws escaped straight through the new key loop.
test('#537: exotic values become validation errors, not raw crashes', () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  const s = base();
  s.languageCode = revoked.proxy;
  const r = validateAppSpec(s, { profile: 'plan' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /languageCode must be a positive integer LCID/.test(e)), JSON.stringify(r.errors));

  const s2 = base();
  s2.entities.push(new Proxy({ schemaName: 'contoso_ghost' }, { ownKeys() { throw new Error('trap'); } }));
  const r2 = validateAppSpec(s2, { profile: 'plan' });
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some((e) => /could not be inspected/.test(e)), JSON.stringify(r2.errors));
});

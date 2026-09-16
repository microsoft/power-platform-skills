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

test('#537: entities[].localizedLabels is rejected, and names the shape that DOES work', () => {
  // The key stays rejected after 2.7.0 added multi-language labels — but for a different reason, and
  // the message had to change with it. A localized label is an LCID map on the label FIELD; a
  // separate per-table block cannot address a Choice OPTION or a lookup's display name without
  // inventing a parallel addressing scheme. So "not supported" became "write it here instead",
  // which is the whole point of rejecting a key rather than dropping it.
  for (const profile of ['plan', 'deploy']) {
    const s = base();
    s.entities[0].localizedLabels = { 3082: 'Cliente', 1033: 'Customer' };
    const r = validateAppSpec(s, { profile });
    const hit = (r.errors || []).find((e) => /unknown key 'localizedLabels'/.test(e));
    assert.ok(hit, `${profile}: ` + JSON.stringify(r.errors));
    assert.match(hit, /LCID map on the label FIELD/, hit);
    assert.doesNotMatch(hit, /not supported/, `2.7.0 supports multi-language labels; the hint must not deny it: ${hit}`);
  }

  // And the shape it points at must actually validate, or the error sends the author into a wall.
  const ok = base();
  ok.entities[0].displayName = { 1033: 'Customer', 3082: 'Cliente' };
  ok.entities[0].pluralName = { 1033: 'Customers', 3082: 'Clientes' };
  assert.strictEqual(validateAppSpec(ok, { profile: 'plan' }).ok, true,
    JSON.stringify(validateAppSpec(ok, { profile: 'plan' }).errors));
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

// --- review follow-ups on the #537 entity-key allow-list ----------------------------------------

test('#537 review: an unknown key on an entity with NO schemaName does not say "entity undefined"', () => {
  // The unknown-key message interpolates the entity's schemaName, which is validated AFTERWARDS. A
  // malformed entity therefore produced `entity undefined: unknown key ...` alongside the real
  // `entity.schemaName is required` — two errors for one problem, one of them naming a table that
  // does not exist. The label must degrade to something stable instead.
  const r = validateAppSpec({
    solution: { uniqueName: 'S', displayName: 'S', publisherPrefix: 'new' },
    app: { name: 'A', description: '' },
    entities: [{ languageCode: 3082, primaryAttribute: { schemaName: 'new_n', displayName: 'N' } }],
    appShell: { areas: [] },
  }, { profile: 'plan' });
  const msg = (r.errors || []).join(' | ');
  assert.match(msg, /unknown key 'languageCode'/, 'the unknown key must still be reported');
  assert.doesNotMatch(msg, /entity undefined/, `no "entity undefined" label: ${msg}`);
});

test('#537 review follow-up: a NON-STRING schemaName is an error, not a crash', () => {
  // Found while reproducing the review comment above. `!e.schemaName` only tested truthiness, so
  // `42`, `{}`, `[]` and `true` passed it and the very next line called `.toLowerCase()` on them —
  // `validateAppSpec` THREW a raw TypeError instead of returning findings. That is the one outcome
  // this function must never produce: the caller loses every problem collected so far, not just
  // this one. Reachable from any hand- or model-authored JSON file, which is how specs arrive.
  //
  // Verified against `origin/main` before the fix: it threw for every non-string below.
  const spec = (schemaName) => ({
    solution: { uniqueName: 'S', displayName: 'S', publisherPrefix: 'new' },
    app: { name: 'A', description: '' },
    entities: [{ ...(schemaName === undefined ? {} : { schemaName }), displayName: 'T', primaryAttribute: { schemaName: 'new_n', displayName: 'N' }, columns: [] }],
    appShell: { areas: [] },
  });

  for (const bad of [42, {}, [], true, '   ']) {
    let r;
    assert.doesNotThrow(() => { r = validateAppSpec(spec(bad), { profile: 'plan' }); },
      `a schemaName of ${JSON.stringify(bad)} must be REPORTED, not thrown`);
    assert.strictEqual(r.ok, false);
    assert.ok((r.errors || []).some((e) => /schemaName must be a non-empty string/.test(e)),
      `${JSON.stringify(bad)} -> ${JSON.stringify(r.errors)}`);
  }

  // An ABSENT value keeps the original wording — it is the common case, and "is required" is the
  // right thing to say about a value nobody supplied. Saying "must be a non-empty string" to
  // someone who wrote nothing would be worse, not better.
  for (const absent of [undefined, null, '']) {
    const r = validateAppSpec(spec(absent), { profile: 'plan' });
    assert.ok((r.errors || []).some((e) => /^entity\.schemaName is required$/.test(e)),
      `${JSON.stringify(absent)} -> ${JSON.stringify(r.errors)}`);
  }

  // Counterfactual: a valid name still validates clean, so the tightening did not simply reject
  // everything.
  assert.strictEqual(validateAppSpec(spec('new_ticket'), { profile: 'plan' }).ok, true);
});

// STILL NOT FIXED, and deliberately so: `validateAppSpec` throws if reading `e.schemaName` ITSELF
// throws — a getter or a Proxy trap. The read at the schemaName check is wrapped, but ~19 later
// sites interpolate `e.schemaName` directly and any one of them re-triggers the trap, so a guard
// only at the first site would buy nothing while implying the case was handled. Fixing it properly
// means resolving the name ONCE into a local and threading it through every site, which is its own
// change with its own tests. Unlike the non-string case above, this shape cannot come from
// `JSON.parse` — only a programmatic caller can build it — so it is not on any real input path.

// --- explicit form layout: unknown/unserializable keys (#575 follow-on) ---
// tabs[]/sections[] had NO allow-list, so an invented key validated clean and vanished. Several
// plausible keys are also accepted by the SDK normalizers and then dropped by its serializer.

function withForm(tabs) {
  const s = base();
  s.entities[0].columns = [{ schemaName: 'contoso_amount', type: 'Text' }];
  s.forms = [{ entity: 'contoso_order', name: 'Order', layout: 'explicit', tabs }];
  return s;
}
const errsFor = (tabs) => validateAppSpec(withForm(tabs), { profile: 'plan' }).errors;

test('form layout: an unknown key on a tab, section or field entry is rejected', () => {
  assert.ok(errsFor([{ label: 'G', bogusTabKey: 1, sections: [{ label: 'S', fields: [] }] }])
    .some((e) => /unknown key \x27bogusTabKey\x27 on tab/.test(e)), 'tab key');
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', bogusSectionKey: 1, fields: [] }] }])
    .some((e) => /unknown key \x27bogusSectionKey\x27 on tab .* section/.test(e)), 'section key');
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', fields: [{ name: 'contoso_amount', bogusFieldKey: 1 }] }] }])
    .some((e) => /unknown key \x27bogusFieldKey\x27 on tab .* field/.test(e)), 'field entry key');
});

test('form layout: keys the SDK serializer DROPS are rejected with the real mechanism named', () => {
  // Measured against the vendored bundle: a tab serializes only name/expanded/visible + label.
  const tabShowLabel = errsFor([{ label: 'G', showLabel: true, sections: [{ label: 'S', fields: [] }] }]);
  assert.ok(tabShowLabel.some((e) => /unknown key \x27showLabel\x27 on tab/.test(e)));
  assert.ok(tabShowLabel.some((e) => /a TAB has no label toggle in FormXml/.test(e)), 'names what to use instead');
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', labelPosition: 'Top', fields: [] }] }])
    .some((e) => /unknown key \x27labelPosition\x27 on tab .* section/.test(e)));
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', locked: true, fields: [] }] }])
    .some((e) => /unknown key \x27locked\x27/.test(e)));
});

test('form layout: a tab cannot declare both sections and columns', () => {
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'A', fields: [] }], columns: [{ sections: [{ label: 'B', fields: [] }] }] }])
    .some((e) => /declares both \x27sections\x27 and \x27columns\x27/.test(e)));
});

// `columns` is an INTEGER grid width on a section but an ARRAY of form-columns on a tab. A non-array
// tab `columns` used to validate clean and then be dropped by the compiler (which reads
// `Array.isArray(t.columns)`), so `"columns": 2` on a tab silently shipped a one-column form — the
// exact silent no-op this allow-list exists to end, on the schema's most confusable key. The
// "declares both" rule above cannot catch it: that too requires Array.isArray.
// A cell that spans DOWN reserves its column in the rows beneath it, and FormXml fills a row's cells
// left to right with no way to skip a reserved slot. Measured on the stock account/contact Main
// forms: every section using rowspan puts it on the LAST cell, precisely because nothing can be
// positioned beside it.
test('form layout: a rowspan is rejected unless it is the last field in its section', () => {
  const bad = errsFor([{ label: 'G', sections: [{ label: 'S', columns: 2, fields: [{ name: 'a', rowspan: 2 }, 'b'] }] }]);
  assert.ok(bad.some((e) => /rowspan 2 but is not the last field in its section/.test(e)), `expected a rowspan placement error; got ${JSON.stringify(bad)}`);

  const ok = errsFor([{ label: 'G', sections: [{ label: 'S', columns: 2, fields: ['b', { name: 'a', rowspan: 2 }] }] }]);
  assert.ok(!ok.some((e) => /rowspan/.test(e)), `a terminal rowspan must stay valid; got ${JSON.stringify(ok)}`);
});

// formSectionsOf treats a non-array `sections` as absent, so a typo silently dropped the whole
// form-column's layout instead of failing.
test('form layout: a non-array sections inside a form-column is rejected', () => {
  const errs = errsFor([{ label: 'G', columns: [{ width: '50%', sections: {} }] }]);
  assert.ok(errs.some((e) => /non-array 'sections'/.test(e)), `expected a non-array sections error; got ${JSON.stringify(errs)}`);
});

// The compiler dereferences every tab/column/section entry. Tabs and sections had partial pre-existing
// guards; a malformed FORM-COLUMN was entirely unguarded and reached compileFormIntent, which reads
// `c.width`/`c.sections`, as a raw TypeError.
test('form layout: a non-object tab, form-column or section is rejected, not dereferenced', () => {
  assert.ok(errsFor([null]).some((e) => /tabs\[0\] must be an object/.test(e)), 'a null tab is rejected');
  assert.ok(errsFor(['nope']).some((e) => /tab #1 must be an object/.test(e)), 'a primitive tab is rejected');
  assert.ok(errsFor([{ label: 'G', sections: [null] }]).some((e) => /sections\[0\] must be an object/.test(e)), 'a null section is rejected');
  // The gap this closes:
  assert.ok(errsFor([{ label: 'G', columns: [null] }]).some((e) => /column #1 must be an object, got null/.test(e)), 'a null form-column is rejected');
  assert.ok(errsFor([{ label: 'G', columns: ['x'] }]).some((e) => /column #1 must be an object/.test(e)), 'a primitive form-column is rejected');
});

// compileFormIntent only truth-tests these (`!== false`), so a STRING "false" compiles as true and
// deploys the opposite of what was authored.
test('form layout: expanded / visible / showLabel must be real booleans', () => {
  assert.ok(errsFor([{ label: 'G', expanded: 'false', sections: [{ label: 'S', fields: [] }] }])
    .some((e) => /has expanded 'false' — it must be true or false/.test(e)));
  assert.ok(errsFor([{ label: 'G', visible: 0, sections: [{ label: 'S', fields: [] }] }])
    .some((e) => /has visible '0'/.test(e)));
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', showLabel: 'false', fields: [] }] }])
    .some((e) => /has showLabel 'false'/.test(e)));
  // A real boolean still passes.
  assert.ok(!errsFor([{ label: 'G', expanded: false, sections: [{ label: 'S', showLabel: true, fields: [] }] }])
    .some((e) => /must be true or false/.test(e)));
});

// A name is the container's IDENTITY on a rebuild — the topology reconcile matches deployed
// containers by name and keys its placement targets by name — so duplicates make two authored
// declarations resolve to the same deployed container.
test('form layout: duplicate tab or section names are rejected (a name is identity on rebuild)', () => {
  assert.ok(errsFor([
    { name: 'tab_a', label: 'A', sections: [{ label: 'S1', fields: [] }] },
    { name: 'TAB_A', label: 'B', sections: [{ label: 'S2', fields: [] }] },
  ]).some((e) => /reuses the tab name 'TAB_A'/.test(e)), 'duplicate tab names are caught case-insensitively');

  assert.ok(errsFor([{ label: 'G', sections: [
    { name: 'sec_x', label: 'S1', fields: [] },
    { name: 'sec_x', label: 'S2', fields: [] },
  ] }]).some((e) => /reuses the section name 'sec_x'/.test(e)));
});

test('form layout: a tab columns that is a NUMBER is rejected and points at the section key', () => {
  const errs = errsFor([{ label: 'G', columns: 2, sections: [{ label: 'S', fields: [] }] }]);
  assert.ok(errs.some((e) => /has columns \x272\x27/.test(e)), `expected a tab-columns error; got ${JSON.stringify(errs)}`);
  assert.ok(errs.some((e) => /put \x27columns\x27: 2 on the section instead/.test(e)), 'the message must name the fix');
});

test('form layout: out-of-range spans, section columns and column widths are rejected', () => {
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', columns: 9, fields: [] }] }])
    .some((e) => /may span 1 to 4 columns/.test(e)), 'section columns');
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', fields: [{ name: 'contoso_amount', colspan: 0 }] }] }])
    .some((e) => /has colspan \x270\x27/.test(e)), 'colspan 0');
  assert.ok(errsFor([{ label: 'G', sections: [{ label: 'S', fields: [{ name: 'contoso_amount', rowspan: 1.5 }] }] }])
    .some((e) => /has rowspan \x271.5\x27/.test(e)), 'fractional rowspan');
  assert.ok(errsFor([{ label: 'G', columns: [{ width: '60px', sections: [{ label: 'S', fields: [] }] }] }])
    .some((e) => /width \x2760px\x27 .* must be a percentage/.test(e)), 'non-percentage width');
});

test('form layout: a valid explicit layout with spans and multi-column tabs passes clean', () => {
  const errs = errsFor([{ name: 'tab_g', label: 'G', expanded: false, visible: true, columns: [
    { width: '60%', sections: [{ name: 's1', label: 'S1', columns: 2, showLabel: true, visible: true, fields: [{ name: 'contoso_amount', colspan: 2 }] }] },
    { width: '40%', sections: [{ name: 's2', label: 'S2', columns: 1, fields: ['contoso_name'] }] },
  ] }]);
  assert.deepStrictEqual(errs.filter((e) => /unknown key|must be a percentage|may span|has colspan|has rowspan/.test(e)), []);
});

// The seeder refuses to use a duplicated primary name as `matchOn` (Dataverse could resolve or
// deduplicate the wrong row). That refusal happens in the sample-data phase — after tables, forms and
// views are already deployed — so ordinary sample data used to validate clean and then stop the build
// halfway. The gate mirrors chooseMatchOn exactly, including both of its escape hatches.
test('sampleData: duplicate primary-name values are rejected at author time, not mid-build', () => {
  const dup = base();
  dup.sampleData = { contoso_order: [{ contoso_name: 'Printer issue' }, { contoso_name: 'Printer issue' }] };
  assert.ok(validateAppSpec(dup, { profile: 'plan' }).errors.some((e) => /duplicate contoso_name value 'Printer issue'/.test(e)));

  const unique = base();
  unique.sampleData = { contoso_order: [{ contoso_name: 'A' }, { contoso_name: 'B' }] };
  assert.ok(!validateAppSpec(unique, { profile: 'plan' }).errors.some((e) => /duplicate contoso_name/.test(e)), 'unique names must stay valid');

  // A single-column alternate key is enforced-unique by Dataverse, so it is what matchOn uses and
  // the primary name never comes into it.
  const keyed = base();
  keyed.entities[0].alternateKeys = [{ name: 'k', columns: ['contoso_code'] }];
  keyed.sampleData = { contoso_order: [{ contoso_name: 'X', contoso_code: '1' }, { contoso_name: 'X', contoso_code: '2' }] };
  assert.ok(!validateAppSpec(keyed, { profile: 'plan' }).errors.some((e) => /duplicate contoso_name/.test(e)), 'a safe alternate key makes the primary irrelevant');

  // A safe alternate key is what matchOn USES, so duplicates in it break the same way — and used to
  // pass this gate and fail during sample-data provisioning instead.
  const dupKey = base();
  dupKey.entities[0].alternateKeys = [{ name: 'k', columns: ['contoso_code'] }];
  dupKey.sampleData = { contoso_order: [{ contoso_name: 'A', contoso_code: 'DUP' }, { contoso_name: 'B', contoso_code: 'DUP' }] };
  assert.ok(validateAppSpec(dupKey, { profile: 'plan' }).errors.some((e) => /duplicate contoso_code value 'DUP'/.test(e)),
    'duplicates in the alternate key that matchOn selects must be caught at author time');

  // A partially/entirely empty primary means matchOn is omitted altogether, so there is no wrong-row
  // resolve to guard against.
  const empty = base();
  empty.sampleData = { contoso_order: [{ contoso_name: '' }, { contoso_name: '' }] };
  assert.ok(!validateAppSpec(empty, { profile: 'plan' }).errors.some((e) => /duplicate contoso_name/.test(e)));
});

test('sampleData: _seedKey is rejected because it reaches Dataverse as an unknown attribute', () => {
  const s = base();
  s.sampleData = { contoso_order: [{ contoso_name: 'A', _seedKey: 'order-1' }] };
  const errs = validateAppSpec(s, { profile: 'plan' }).errors;
  assert.ok(errs.some((e) => /_seedKey. is not a supported sample-record key/.test(e)));
  assert.ok(errs.some((e) => /single-column alternate key/.test(e)), 'points at the real mechanism');
});

// A multi-column tab nests its sections inside columns[]. Every raw-spec reader must see them, or
// section-level validation silently stops running for exactly the richer layouts it should police.
test('form layout: sections nested in columns[] are still validated', () => {
  const badKey = errsFor([{ label: 'G', columns: [{ width: '50%', sections: [{ label: 'S', locked: true, fields: [] }] }] }]);
  assert.ok(badKey.some((e) => /unknown key .locked./.test(e)), `nested section keys must be checked; got ${JSON.stringify(badKey)}`);
  const badCols = errsFor([{ label: 'G', columns: [{ width: '50%', sections: [{ label: 'S', columns: 9, fields: [] }] }] }]);
  assert.ok(badCols.some((e) => /may span 1 to 4 columns/.test(e)), 'nested section column counts must be checked');
  const badSpan = errsFor([{ label: 'G', columns: [{ width: '50%', sections: [{ label: 'S', fields: [{ name: 'contoso_amount', colspan: 0 }] }] }] }]);
  assert.ok(badSpan.some((e) => /has colspan .0./.test(e)), 'nested field spans must be checked');
});

test('form layout: a non-array fields inside columns[] is caught, not thrown on', () => {
  const s = base();
  s.entities[0].columns = [{ schemaName: 'contoso_amount', type: 'Text' }];
  s.forms = [{ entity: 'contoso_order', name: 'O', layout: 'explicit',
    tabs: [{ label: 'G', columns: [{ width: '100%', sections: [{ label: 'S', fields: 'contoso_amount' }] }] }] }];
  // A string is ITERABLE, so a naive per-entry loop would walk its characters instead of failing.
  const errs = validateAppSpec(s, { profile: 'plan' }).errors;
  assert.ok(errs.some((e) => /fields must be an array/.test(e)), `got ${JSON.stringify(errs)}`);
});

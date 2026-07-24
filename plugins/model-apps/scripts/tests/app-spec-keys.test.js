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
    { key: 'detail', name: 'Detail', source: { kind: 'intent' }, pageInput: { data: { orderId: 'string' } } },
  ];
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

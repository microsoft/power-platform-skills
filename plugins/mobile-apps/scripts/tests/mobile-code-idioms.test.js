'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  findDynamicRouteIdViolations,
  findCreateThenNavigateViolations,
  findEditQueryViolations,
  findODataBindCasingViolations,
  findUncheckedServiceResults,
  findViolations,
  stripComments,
} = require('../../hooks/validate-mobile-code-idioms');

test('rejects unchecked generated-service results', () => {
  assert.deepEqual(
    findUncheckedServiceResults('const result = await ItemService.get(id); setItem(result.data);'),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('const result = await ItemService.get(id); if (!result.success) throw result.error; setItem(result.data);'),
    [],
  );
  assert.deepEqual(
    findUncheckedServiceResults('const result = await ItemService.get(id); setItem(result.data); console.log(result.success);'),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("const result = await ItemService.get(id); if (!result.success) Alert.alert('Failed'); return result.data;"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("const result = await ItemService.get(id); if (!result.success) { Alert.alert('Failed'); } if (cancelled) { return; } setItem(result.data);"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("const result = await ItemService.get(id); if (!result.success) { if (retry) return; Alert.alert('Failed'); } setItem(result.data);"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("const result = await ItemService.get(id); if (retry) { if (!result.success) return; } setItem(result.data);"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("const result = await ItemService.delete(id); if (!result.success) { Alert.alert('Failed'); } onDeleted();"),
    ['Check `result.success` before reading data from delete().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('useQuery({ queryFn: () => ItemService.get(id) });'),
    ['React Query must receive checked data, not the raw result from ItemService.get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('useQuery({ queryFn: async () => { return ItemService.get(id); } });'),
    ['React Query must receive checked data, not the raw result from ItemService.get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('useQuery({ queryFn: async () => { return (ItemService.get(id)); } });'),
    ['React Query must receive checked data, not the raw result from ItemService.get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('useQuery({ queryFn: context => ItemService.get(context.id) });'),
    ['React Query must receive checked data, not the raw result from ItemService.get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('useQuery({ queryFn: ItemService.getAll });'),
    ['React Query must receive checked data, not the raw result from ItemService.getAll().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("ItemService.get(id).then(result => { setItem(result.data); });"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("ItemService.get(id).then(result => setItem(result.data));"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("ItemService.get(id).then(async result => { setItem(result.data); });"),
    ['Check `result.success` before reading data from get().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults("const result = await ItemService.deleteFileOrImage(id, column); use(result.data);"),
    ['Check `result.success` before reading data from deleteFileOrImage().'],
  );
  assert.deepEqual(
    findUncheckedServiceResults('// await ItemService.create(payload);\n/* await ItemService.update(id, payload); */'),
    [],
  );
});

test('comment stripping preserves executable strings and line structure', () => {
  const source = [
    "const route = '/items//new'; // ItemService.get(id)",
    "const apostrophe = value.replace(/'/g, \"''\");",
    '/* await ItemService.create(payload); */',
    "const bind = 'x@odata.bind';",
  ].join('\n');
  const stripped = stripComments(source);
  assert.match(stripped, /'\/items\/\/new'/);
  assert.match(stripped, /replace\(\/'\/g/);
  assert.match(stripped, /'x@odata\.bind'/);
  assert.doesNotMatch(stripped, /ItemService/);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});

test('rejects create-or-edit routes that use id instead of editId', () => {
  assert.equal(
    findEditQueryViolations("router.push('/(app)/items/form?id=123')").length,
    1,
  );
  assert.deepEqual(
    findEditQueryViolations("router.push('/(app)/items/form?editId=123')"),
    [],
  );
});

test('create-then-navigate uses a pre-generated record ID', () => {
  const flow = (body) => `async function save() { ${body} }`;
  assert.deepEqual(findCreateThenNavigateViolations(`
    async function save() {
      const result = await ItemService.create(payload);
      if (!result.success) return;
      router.push(\`/items/\${result.data.id}\`);
    }
  `), ['Create-then-navigate flows must pre-generate the record ID with `newId()` and navigate with that same ID.']);
  assert.deepEqual(findCreateThenNavigateViolations(flow(`
    const recordId = newId();
    const result = await ItemService.create({ ...payload, itemid: recordId });
    if (!result.success) return;
    router.push(\`/items/\${recordId}\`);
  `)), []);
  assert.equal(findCreateThenNavigateViolations(flow(`
    const recordId = newId();
    const result = await ItemService.create({ title: 'A' });
    if (!result.success) return;
    router.push(\`/items/\${recordId}\`);
  `)).length, 1);
  assert.equal(findCreateThenNavigateViolations(flow(`
    const recordId = newId();
    const analytics = { eventid: recordId };
    const result = await ItemService.create({ title: 'A' });
    if (!result.success) return;
    router.push(\`/items/\${recordId}\`);
  `)).length, 1);
  assert.equal(findCreateThenNavigateViolations(flow(`
    const result = await ItemService.create({ title: 'A' });
    if (!result.success) return;
    router.replace(\`/items/\${result.data.id}\`);
  `)).length, 1);
  assert.deepEqual(findCreateThenNavigateViolations(`
    async function createOnly() {
      const result = await ItemService.create({ title: 'A' });
      if (!result.success) return;
    }
    function open(id) {
      router.push(\`/items/\${id}\`);
    }
  `), []);
  assert.deepEqual(findCreateThenNavigateViolations(`
    class ItemActions {
      async save() {
        const result = await ItemService.create({ title: 'A' });
        if (!result.success) return;
      }
      open(id: string) {
        router.push(\`/items/\${id}\`);
      }
    }
  `), []);
  assert.equal(findCreateThenNavigateViolations(`
    class ItemActions {
      async save(): Promise<void> {
        const result = await ItemService.create({ title: 'A' });
        if (!result.success) return;
        router.replace(\`/items/\${result.data.id}\`);
      }
    }
  `).length, 1);
  assert.equal(findCreateThenNavigateViolations(`
    class ItemActions {
      async save(): Promise<{ ok: boolean }> {
        const result = await ItemService.create({ title: 'A' });
        if (!result.success) return { ok: false };
        router.replace(\`/items/\${result.data.id}\`);
        return { ok: true };
      }
    }
  `).length, 1);
  assert.equal(findCreateThenNavigateViolations(`
    class ItemActions { async save<T>(): Promise<{ ok: boolean }> {
      const result = await ItemService.create({ title: 'A' });
      if (!result.success) return { ok: false };
      router.replace(\`/items/\${result.data.id}\`);
      return { ok: true };
    } }
  `).length, 1);
  assert.equal(findCreateThenNavigateViolations(flow(`
    const recordId = newId();
    const result = await ItemService.create({ parentid: recordId, title: 'A' });
    if (!result.success) return;
    router.push(\`/items/\${recordId}\`);
  `)).length, 1);
  assert.equal(findCreateThenNavigateViolations(flow(`
    const recordId = newId();
    const result = await ItemService.create({ parentitemid: recordId, title: 'A' });
    if (!result.success) return;
    router.push(\`/items/\${recordId}\`);
  `)).length, 1);
  for (const payload of [
    "{ note: 'itemid: recordId' }",
    '{ metadata: { itemid: recordId } }',
  ]) {
    assert.equal(findCreateThenNavigateViolations(`
      async function save() {
        const recordId = newId();
        const result = await ItemService.create(${payload});
        if (!result.success) return;
        router.push(\`/items/\${recordId}\`);
      }
    `).length, 1);
  }
});

test('rejects non-canonical odata bind casing', () => {
  assert.deepEqual(findODataBindCasingViolations("'parent@OData.Bind': '/parents(1)'"), [
    'Use the exact Dataverse annotation suffix `@odata.bind`, not `@OData.Bind`.',
  ]);
  assert.deepEqual(findODataBindCasingViolations("'parent@odata.bind': '/parents(1)'"), []);
});

test('dynamic record routes normalize Dataverse IDs before service calls', () => {
  const file = '/tmp/app/(app)/items/[id].tsx';
  assert.equal(findDynamicRouteIdViolations(
    file,
    'const { id } = useLocalSearchParams(); const result = await ItemService.get(id); if (!result.success) throw result.error;',
  ).length, 1);
  assert.equal(findDynamicRouteIdViolations(
    file,
    "import { normalizeDataverseGuid } from '@/utils'; const safe = normalizeDataverseGuid(other); const result = await ItemService.get(id); if (!result.success) throw result.error;",
  ).length, 1);
  assert.deepEqual(findDynamicRouteIdViolations(
    file,
    "import { normalizeDataverseGuid } from '@/utils'; const params = useLocalSearchParams<{ id?: string | string[] }>(); const rawId = Array.isArray(params.id) ? params.id[0] : params.id; const id = normalizeDataverseGuid(rawId); const result = await ItemService.get(id); if (!result.success) throw result.error;",
  ), []);
  for (const argument of ['(id)', '`${id}`', '[id][0]']) {
    assert.equal(findDynamicRouteIdViolations(
      file,
      `const { id } = useLocalSearchParams(); const result = await ItemService.get(${argument}); if (!result.success) throw result.error;`,
    ).length, 1);
  }
  assert.equal(findDynamicRouteIdViolations(
    file,
    "ItemService.deleteFileOrImage(`${id}`, 'file');",
  ).length, 1);
});

test('detail sample demonstrates checked service and route ID handling', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../shared/samples/screen-detail.tsx'),
    'utf8',
  );
  assert.deepEqual(
    findViolations('/tmp/app/(app)/recipes/[id].tsx', source),
    [],
  );
});

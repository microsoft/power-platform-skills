'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const validator = path.resolve(__dirname, '../validate-mobile-files.js');

function project(testContext, plan = '# Plan\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-validator-matrix-'));
  testContext.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), plan);
  return root;
}

function dispatch(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return spawnSync(process.execPath, [
    validator,
    '--project-root',
    root,
    '--file',
    relativePath,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1',
    },
  });
}

function expectCaught(result, signal) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, signal);
}

function expectAccepted(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('dispatcher catches Dataverse payload and create-navigation violations', (testContext) => {
  const root = project(testContext);
  const cases = [
    {
      id: 'server-managed-column',
      signal: /ownerid/,
      bad: `
        export async function save() {
          const result = await ItemService.create({ title: 'A', ownerid: '' });
          if (!result.success) return;
        }
      `,
      good: `
        export async function save() {
          const result = await ItemService.create({ title: 'A' });
          if (!result.success) return;
        }
      `,
    },
    {
      id: 'raw-lookup-value',
      signal: /_parent_value/,
      bad: `
        export async function save(parentId: string) {
          const result = await ItemService.create({ title: 'A', _parent_value: parentId });
          if (!result.success) return;
        }
      `,
      good: `
        export async function save(parentId: string) {
          const result = await ItemService.create({
            title: 'A',
            'parent@odata.bind': \`/parents(\${parentId})\`,
          });
          if (!result.success) return;
        }
      `,
    },
    {
      id: 'quoted-lookup-value',
      signal: /_parent_value/,
      bad: `
        export async function save(parentId: string) {
          const result = await ItemService.create({ '_parent_value': parentId });
          if (!result.success) return;
        }
      `,
      good: `
        export async function save(parentId: string) {
          // ItemService.create({ '_parent_value': parentId });
          const result = await ItemService.create({
            'parent@odata.bind': \`/parents(\${parentId})\`,
          });
          if (!result.success) return;
        }
      `,
    },
    {
      id: 'variable-lookup-value',
      signal: /_parent_value/,
      bad: `
        export async function save(parentId: string) {
          const payload = { _parent_value: parentId };
          const result = await ItemService.create(payload);
          if (!result.success) return;
        }
      `,
      good: `
        export async function save(parentId: string) {
          const payload = { 'parent@odata.bind': \`/parents(\${parentId})\` };
          const result = await ItemService.create(payload);
          if (!result.success) return;
        }
      `,
    },
    {
      id: 'typed-variable-payload',
      signal: /ownerid|_parent_value/,
      bad: `
        export async function save(parentId: string) {
          const payload: ItemCreate = { ownerid: '', '_parent_value': parentId };
          const result = await ItemService.create(payload);
          if (!result.success) return;
        }
      `,
      good: `
        export async function save(parentId: string) {
          const payload: ItemCreate = {
            'parent@odata.bind': \`/parents(\${parentId})\`,
          };
          const result = await ItemService.create(payload);
          if (!result.success) return;
        }
      `,
    },
    {
      id: 'inline-typed-variable-payload',
      signal: /ownerid|_parent_value/,
      bad: `
        export async function save(parentId: string) {
          const payload: {
            ownerid: string;
            '_parent_value': string;
          } = {
            ownerid: '',
            '_parent_value': parentId,
          };
          const result = await ItemService.create(payload);
          if (!result.success) return;
        }
      `,
      good: `
        export async function save(parentId: string) {
          const payload: {
            title: string;
            'parent@odata.bind': string;
          } = {
            title: 'A',
            'parent@odata.bind': \`/parents(\${parentId})\`,
          };
          const result = await ItemService.create(payload);
          if (!result.success) return;
        }
      `,
    },
    {
      id: 'create-then-navigate',
      signal: /pre-generate the record ID/,
      bad: `
        export async function save(router: any) {
          const result = await ItemService.create({ title: 'A' });
          if (!result.success) return;
          router.push(\`/items/\${result.data.id}\`);
        }
      `,
      good: `
        export async function save(router: any) {
          const recordId = newId();
          const result = await ItemService.create({ itemid: recordId, title: 'A' });
          if (!result.success) return;
          router.push(\`/items/\${recordId}\`);
        }
      `,
    },
    {
      id: 'typed-method-create-navigation',
      signal: /pre-generate the record ID/,
      bad: `
        export class ItemActions {
          async save(): Promise<void> {
            const result = await ItemService.create({ title: 'A' });
            if (!result.success) return;
            router.replace(\`/items/\${result.data.id}\`);
          }
        }
      `,
      good: `
        export class ItemActions {
          async save(): Promise<void> {
            const result = await ItemService.create({ title: 'A' });
            if (!result.success) return;
          }
          open(id: string): void {
            router.replace(\`/items/\${id}\`);
          }
        }
      `,
    },
  ];

  for (const fixture of cases) {
    expectCaught(dispatch(root, `app/(app)/${fixture.id}.ts`, fixture.bad), fixture.signal);
    expectAccepted(dispatch(root, `app/(app)/${fixture.id}.ts`, fixture.good));
  }
});

test('dispatcher validates every FlatList interaction contract independently', (testContext) => {
  const root = project(testContext);
  const listBad = `
    export default function ItemsScreen() {
      const { items } = useListData(loadItems);
      return (
        <SafeAreaView>
          <FlatList data={items} renderItem={({ item }) => <Text>{item.title}</Text>} />
        </SafeAreaView>
      );
    }
  `;
  const listGood = `
    export default function ItemsScreen() {
      const { items, refreshing, onRefresh } = useListData(loadItems);
      return (
        <SafeAreaView>
          <FlatList
            data={items}
            keyExtractor={(item) => item.itemid}
            renderItem={({ item }) => <Text>{item.title}</Text>}
            ListEmptyComponent={<EmptyState title="No items" />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />
        </SafeAreaView>
      );
    }
  `;
  expectCaught(dispatch(root, 'app/(app)/list-bad.tsx', listBad), /keyExtractor/);
  expectAccepted(dispatch(root, 'app/(app)/list-good.tsx', listGood));

  const mixedLists = listGood.replace(
    '</SafeAreaView>',
    '<FlatList data={items} renderItem={({ item }) => <Text>{item.title}</Text>} /></SafeAreaView>',
  );
  expectCaught(dispatch(root, 'app/(app)/mixed-lists.tsx', mixedLists), /keyExtractor/);

  const indexKey = listGood.replace(
    'keyExtractor={(item) => item.itemid}',
    'keyExtractor={(_, index) => String(index)}',
  );
  expectCaught(dispatch(root, 'app/(app)/index-key.tsx', indexKey), /array-index keys/);

  const typedIndexKey = listGood.replace(
    'keyExtractor={(item) => item.itemid}',
    'keyExtractor={(_, index: number) => String(index)}',
  );
  expectCaught(dispatch(root, 'app/(app)/typed-index-key.tsx', typedIndexKey), /array-index keys/);

  const mutableKey = listGood.replace(
    'keyExtractor={(item) => item.itemid}',
    'keyExtractor={(item) => item.title}',
  );
  expectCaught(dispatch(root, 'app/(app)/mutable-key.tsx', mutableKey), /record ID/);
  const destructuredMutableKey = listGood.replace(
    'keyExtractor={(item) => item.itemid}',
    'keyExtractor={({ title }) => title}',
  );
  expectCaught(
    dispatch(root, 'app/(app)/destructured-mutable-key.tsx', destructuredMutableKey),
    /record ID/,
  );
  const destructuredIdKey = listGood.replace(
    'keyExtractor={(item) => item.itemid}',
    'keyExtractor={({ itemid }) => itemid}',
  );
  expectAccepted(dispatch(root, 'app/(app)/destructured-id-key.tsx', destructuredIdKey));

  const genericList = listGood.replace('<FlatList', '<FlatList<Item>');
  expectAccepted(dispatch(root, 'app/(app)/generic-list.tsx', genericList));
  const genericListMissingContract = listBad.replace('<FlatList', '<FlatList<Item>');
  expectCaught(
    dispatch(root, 'app/(app)/generic-list-missing-contract.tsx', genericListMissingContract),
    /keyExtractor/,
  );

  const serviceAndLocal = listGood.replace(
    '</SafeAreaView>',
    '<FlatList data={localItems} keyExtractor={(item) => item.id} renderItem={() => null} ListEmptyComponent={<EmptyState title="No local items" />} /></SafeAreaView>',
  );
  expectAccepted(dispatch(root, 'app/(app)/service-and-local.tsx', serviceAndLocal));

  const separateComponents = `
    export function RemoteItems() {
      const { items, refreshing, onRefresh } = useListData(loadItems);
      return <SafeAreaView><FlatList data={items} keyExtractor={(item) => item.itemid} renderItem={() => null} ListEmptyComponent={<EmptyState title="No remote items" />} refreshing={refreshing} onRefresh={onRefresh} /></SafeAreaView>;
    }
    export function LocalItems() {
      const items = LOCAL_ITEMS;
      return <SafeAreaView><FlatList data={items} keyExtractor={(item) => item.itemid} renderItem={() => null} ListEmptyComponent={<EmptyState title="No local items" />} /></SafeAreaView>;
    }
  `;
  expectAccepted(dispatch(root, 'app/(app)/separate-components.tsx', separateComponents));
  const conciseLocalComponent = `
    export function RemoteItems() {
      const { items, refreshing, onRefresh } = useListData(loadItems);
      return <SafeAreaView><FlatList data={items} keyExtractor={(item) => item.itemid} renderItem={() => null} ListEmptyComponent={<EmptyState title="No remote items" />} refreshing={refreshing} onRefresh={onRefresh} /></SafeAreaView>;
    }
    const items = LOCAL_ITEMS;
    export const LocalItems = () => (
      <SafeAreaView><FlatList data={items} keyExtractor={(item) => item.itemid} renderItem={() => null} ListEmptyComponent={<EmptyState title="No local items" />} /></SafeAreaView>
    );
  `;
  expectAccepted(dispatch(root, 'app/(app)/concise-local-component.tsx', conciseLocalComponent));

  const localFiltered = `
    export default function LocalItemsScreen() {
      const { filtered } = useSearchFilter(LOCAL_ITEMS, ['title']);
      return <SafeAreaView><FlatList data={filtered} keyExtractor={(item) => item.id} renderItem={() => null} ListEmptyComponent={<EmptyState title="No local items" />} /></SafeAreaView>;
    }
  `;
  expectAccepted(dispatch(root, 'app/(app)/local-filtered.tsx', localFiltered));
});

test('plan-aware heavy-list dispatch rejects bounded loading and accepts cursor loading', (testContext) => {
  const plan = `
    ## Screens
    ### Per-Screen Specs
    #### Items
    File: app/(app)/items.tsx
    Pagination: cursor
  `;
  const root = project(testContext, plan);
  const bounded = `
    export default function ItemsScreen() {
      const { items, refreshing, onRefresh } = useListData(() => ItemService.getAll({ top: 50 }));
      return <SafeAreaView><FlatList data={items} keyExtractor={(item) => item.itemid} renderItem={() => null} ListEmptyComponent={<EmptyState title="No items" />} refreshing={refreshing} onRefresh={onRefresh} /></SafeAreaView>;
    }
  `;
  expectCaught(dispatch(root, 'app/(app)/items.tsx', bounded), /Cursor-paginated screens/);

  const cursor = `
    export default function ItemsScreen() {
      const { items, refreshing, onRefresh, loadMore, hasNextPage } = useCursorListData({
        fetchPage: ({ pageSize, skipToken }) => ItemService.getAll({
          maxPageSize: pageSize,
          skipToken,
          select: ['itemid', 'title'],
          orderBy: ['title asc', 'itemid asc'],
        }),
      });
      return <SafeAreaView><FlatList data={items} keyExtractor={(item) => item.itemid} renderItem={() => null} ListEmptyComponent={<EmptyState title="No items" />} refreshing={refreshing} onRefresh={onRefresh} onEndReached={hasNextPage ? loadMore : undefined} /></SafeAreaView>;
    }
  `;
  expectAccepted(dispatch(root, 'app/(app)/items.tsx', cursor));
});

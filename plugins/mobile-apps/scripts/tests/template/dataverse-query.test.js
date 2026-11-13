'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../../..');
const templateRoot = path.join(pluginRoot, 'template');
const templateRequire = createRequire(path.join(templateRoot, 'package.json'));
const ts = templateRequire('typescript');
const hookFile = path.join(pluginRoot, 'shared/samples/src/hooks/useCursorListData.ts');
const utilsFile = path.join(pluginRoot, 'shared/samples/src/utils/dataverse.ts');

function loadSample(file, imports) {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  const exports = {};
  Function('exports', 'require', outputText)(exports, (name) => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected sample dependency: ${name}`);
    return imports[name];
  });
  return exports;
}

function hookHarness(options, state = {}) {
  let queryOptions;
  const resets = [];
  const utils = loadSample(utilsFile, { 'expo-crypto': {} });
  const { useCursorListData } = loadSample(hookFile, {
    react: {
      useState: initial => [initial, () => {}],
      useEffect() {},
      useMemo: fn => fn(),
      useCallback: fn => fn,
    },
    '@tanstack/react-query': {
      useInfiniteQuery: config => {
        queryOptions = config;
        return { hasNextPage: false, ...state };
      },
      useQueryClient: () => ({ resetQueries: async args => { resets.push(args); } }),
    },
    '@/utils': utils,
  });
  const result = useCursorListData(options);
  return { result, queryOptions, resets };
}

test('saved-view pagination passes opaque complete links without decoding or token extraction', async () => {
  const nextLink = 'https://contoso.crm.dynamics.com/api/data/v9.0/contacts?savedQuery=00000000-0000-0000-00aa-000010001002&$skiptoken=%3Ccookie%20p%3D%222%22%2F%3E&opaque=a%2Bb%2520';
  const calls = [];
  const harness = hookHarness({
    queryKey: ['contacts', 'environment', 'view-id'],
    cursorMode: 'nextLink',
    fetchPage: async args => {
      calls.push(args);
      return args.nextLink
        ? { success: true, data: [{ id: 'second' }] }
        : { success: true, data: [{ id: 'first' }], nextLink, skipToken: 'do-not-use' };
    },
  });
  const first = await harness.queryOptions.queryFn({ pageParam: undefined });
  const cursor = harness.queryOptions.getNextPageParam(first);
  assert.equal(cursor, nextLink);
  const second = await harness.queryOptions.queryFn({ pageParam: cursor });
  assert.equal(calls[1].nextLink, nextLink);
  assert.equal(Object.hasOwn(calls[1], 'skipToken'), false);
  assert.deepEqual([...first.items, ...second.items], [{ id: 'first' }, { id: 'second' }]);
  assert.equal(harness.queryOptions.getNextPageParam(second), undefined);
  harness.result.onRefresh();
  assert.deepEqual(harness.resets, [{ queryKey: harness.queryOptions.queryKey, exact: true }]);
});

test('ordinary OData retains skip-token paging and keeps mode in cache identity', async () => {
  const calls = [];
  const harness = hookHarness({
    queryKey: ['contacts'],
    fetchPage: async args => {
      calls.push(args);
      return { success: true, data: [], nextLink: 'https://contoso.crm.dynamics.com/contacts?$skiptoken=a%2Bb' };
    },
  });
  const page = await harness.queryOptions.queryFn({ pageParam: undefined });
  assert.equal(harness.queryOptions.getNextPageParam(page), 'a+b');
  await harness.queryOptions.queryFn({ pageParam: 'a+b' });
  assert.equal(calls[1].skipToken, 'a+b');
  assert.equal(Object.hasOwn(calls[1], 'nextLink'), false);
  assert.equal(harness.queryOptions.queryKey.at(-1).cursorMode, 'skipToken');
});

test('query failures and incomplete saved cursors cannot become successful empty/mock pages', async () => {
  for (const response of [
    { success: false, data: [] },
    { success: false, error: { message: 'Forbidden' } },
    { success: true },
    { success: true, data: [], skipToken: 'missing-complete-link' },
    { success: true, data: [], nextLink: '' },
  ]) {
    const harness = hookHarness({
      queryKey: ['contacts'], cursorMode: 'nextLink',
      fetchPage: async () => response, mockData: [{ id: 'fake' }],
    });
    await assert.rejects(harness.queryOptions.queryFn({ pageParam: undefined }));
    assert.deepEqual(harness.result.items, []);
  }
});

test('empty real data stays empty; only an explicitly disabled query uses prototype rows', () => {
  const options = { queryKey: ['contacts'], fetchPage: async () => [], mockData: [{ id: 'prototype' }] };
  assert.deepEqual(hookHarness(options, { data: { pages: [{ items: [] }] } }).result.items, []);
  assert.deepEqual(hookHarness({ ...options, enabled: false }).result.items, [{ id: 'prototype' }]);
});

test('related Choice normalization uses the published SDK without losing formatted or null fields', async () => {
  const { deserializeMultiSelectPicklistFields } = await import(
    pathToFileURL(templateRequire.resolve('@microsoft/power-apps/data')).href
  );
  const related = {
    new_choices: '100,200',
    'new_choices@OData.Community.Display.V1.FormattedValue': 'First; Second',
    telephone1: null,
  };
  deserializeMultiSelectPicklistFields(related, ['new_choices']);
  assert.deepEqual(related.new_choices, [100, 200]);
  assert.equal(related['new_choices@OData.Community.Display.V1.FormattedValue'], 'First; Second');
  assert.equal(related.telephone1, null);
});

test('the actual cursor sample compiles with installed React Query and SDK query types', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-query-types-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const probe = path.join(root, 'query-probe.ts');
  fs.writeFileSync(probe, `
import { getClient, type DataClient } from '@microsoft/power-apps/data';
import { useCursorListData } from '${hookFile.replace(/\\/g, '/').replace(/\.ts$/, '')}';
type Row = { contactid: string; related?: { choices?: number[]; name?: string | null } | null };
const client = getClient({});
const legacy: DataClient = client;
legacy.retrieveMultipleRecordsAsync<Row>('contacts', { expand: ['parentcustomerid_account($select=name)'] });
client.retrieveMultipleRecordsAsync<{ total: number }>('contacts', { apply: 'aggregate($count as total)' });
useCursorListData<Row>({
  queryKey: ['contacts', 'view'], cursorMode: 'nextLink',
  fetchPage: ({ pageSize, nextLink }) => client.retrieveSavedQueryAsync<Row>('contacts',
    '00000000-0000-0000-00aa-000010001002', { maxPageSize: pageSize, nextLink }),
});
// @ts-expect-error Existing structural clients need not implement saved queries.
legacy.retrieveSavedQueryAsync('contacts', 'view');
// @ts-expect-error Generic OData accepts skipToken, not the saved-query continuation input.
client.retrieveMultipleRecordsAsync('contacts', { nextLink: 'link' });
`);
  const program = ts.createProgram([probe, hookFile], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: templateRoot,
    paths: {
      '@/utils': [utilsFile],
      '@microsoft/power-apps/data': ['node_modules/@microsoft/power-apps/dist/data/index.d.ts'],
      react: ['node_modules/@types/react/index.d.ts'],
      '*': ['node_modules/*'],
    },
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: value => value,
    getCurrentDirectory: () => templateRoot,
    getNewLine: () => '\n',
  }));
});

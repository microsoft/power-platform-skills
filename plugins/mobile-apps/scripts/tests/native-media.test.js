'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { root, available, loadSample, loadSource, checkSampleTypes } = require('./helpers/sample-runtime');

if (!available && process.env.MOBILE_SAMPLE_RUNTIME_REQUIRED === '1') {
  throw new Error('Install the existing template dependencies before running native media tests');
}
const runtimeTest = (name, fn) => test(name, {
  skip: available ? false : 'Existing template TypeScript dependency is not installed',
}, fn);

function imageReader() {
  const dataverse = loadSample('src/utils/dataverse.ts', {
    'expo-crypto': { randomUUID: () => '00000000-0000-0000-0000-000000000001' },
  });
  return loadSample('src/utils/dataverse-image.ts', { './dataverse': dataverse }).readDataverseImage;
}

runtimeTest('image reads pass explicit resolution for catalog, inspection and document media', async () => {
  const readImage = imageReader();
  for (const [column, resolution] of [
    ['sample_catalogimage', 'thumbnail'],
    ['sample_evidenceimage', 'full'],
    ['sample_coverimage', 'full'],
  ]) {
    let called;
    const bytes = new Uint8Array([1, 2, 3]);
    const image = await readImage(async (...args) => {
      called = args;
      return { success: true, data: bytes };
    }, { id: '{00000000-0000-F111-0000-000000000001}', column, resolution });
    assert.deepEqual(called, ['00000000-0000-f111-0000-000000000001', column, resolution === 'full']);
    assert.equal(image, bytes);
  }
});

runtimeTest('invalid image requests cannot invoke the generated service', async () => {
  const readImage = imageReader();
  let calls = 0;
  const download = async () => { calls++; return { success: true, data: new Uint8Array([1]) }; };
  const valid = { id: '00000000-0000-0000-0000-000000000001', column: 'sample_image', resolution: 'full' };
  for (const delta of [{ id: 'bad-id' }, { column: '' }, { resolution: undefined }, { resolution: 'automatic' }]) {
    await assert.rejects(readImage(download, { ...valid, ...delta }));
  }
  assert.equal(calls, 0);
});

runtimeTest('failed or empty full image responses are explicit failures, not silent thumbnails', async () => {
  const readImage = imageReader();
  const options = { id: '00000000-0000-0000-0000-000000000001', column: 'sample_image', resolution: 'full' };
  const failure = { message: 'Full image unavailable' };
  let calls = 0;
  await assert.rejects(readImage(async () => {
    calls++;
    return { success: false, error: failure };
  }, options), error => error.message === 'Image download failed' && error.cause === failure);
  assert.equal(calls, 1);
  for (const data of [undefined, new Uint8Array()]) {
    await assert.rejects(readImage(async () => ({ success: true, data }), options), /No image bytes/);
  }
  const transport = new Error('Connection unavailable');
  await assert.rejects(readImage(async () => { throw transport; }, options), error => error === transport);
});

function sharedQuerySource() {
  const reference = fs.readFileSync(path.join(root, 'agents/references/screen-builder/data-reads.md'), 'utf8');
  return reference.match(/```ts\n\/\/ Shared image query example\n([\s\S]*?)\n```/)[1];
}

function sharedQueryExample() {
  const source = sharedQuerySource();
  const dataverse = loadSample('src/utils/dataverse.ts', {
    'expo-crypto': { randomUUID: () => '00000000-0000-0000-0000-000000000001' },
  });
  return loadSource(source, 'shared-image-query.ts', {
    '@/utils': dataverse, '@/utils/dataverse-image': { readDataverseImage: imageReader() },
  }).imageQueryOptions;
}

runtimeTest('shared image query example type-checks against installed native and query APIs', () => {
  const file = path.join(root, 'shared/samples/__shared-image-query.ts');
  const example = sharedQuerySource() + `
    import { useQuery } from '@tanstack/react-query';
    const options = imageQueryOptions({
      recordId: '00000000-0000-0000-0000-000000000001', column: 'sample_photo',
      scopeKey: 'example-scope', imageVersion: 'one', canRead: true,
      download: async () => ({ success: true, data: new Uint8Array([1]) }),
    });
    export function useExampleImage(isVisible: boolean) {
      return useQuery({ ...options, enabled: isVisible });
    }
  `;
  assert.deepEqual(checkSampleTypes(new Map([[file, example]])), []);
});

runtimeTest('disabled thumbnail observer cannot poison a shared full-image query', async () => {
  const { QueryClient, QueryObserver } = require(require.resolve('@tanstack/react-query', { paths: [path.join(root, 'template')] }));
  const makeOptions = sharedQueryExample();
  const bytes = new Uint8Array([1, 2, 3]);
  let calls = 0;
  const options = makeOptions({
    recordId: '00000000-0000-f111-0000-000000000001', column: 'sample_photo',
    scopeKey: 'sample-account:sample-environment', imageVersion: 'one', canRead: true,
    download: async () => { calls++; return { success: true, data: bytes }; },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const detail = new QueryObserver(client, { ...options, enabled: true });
  const thumbnail = new QueryObserver(client, { ...options, enabled: false });
  const removeDetail = detail.subscribe(() => {});
  const removeThumbnail = thumbnail.subscribe(() => {});
  try {
    const result = await detail.refetch();
    assert.equal(result.isSuccess, true);
    assert.equal(result.data, bytes);
    assert.equal(thumbnail.getCurrentResult().data, bytes);
    assert.ok(calls > 0);
    const before = calls;
    await client.fetchQuery({ ...options, enabled: false, staleTime: 0 });
    assert.ok(calls > before);
  } finally {
    removeDetail(); removeThumbnail(); client.clear();
  }
});

runtimeTest('shared image query guards access/cancellation and keys account, record and version', async () => {
  const makeOptions = sharedQueryExample();
  let calls = 0;
  const input = {
    recordId: '00000000-0000-0000-0000-000000000001', column: 'sample_photo',
    scopeKey: 'sample-account:sample-environment', imageVersion: 'one', canRead: true,
    download: async () => { calls++; return { success: true, data: new Uint8Array([1]) }; },
  };
  const normal = makeOptions(input);
  for (const delta of [{ canRead: false }, { scopeKey: '' }, { recordId: 'bad' }]) {
    await assert.rejects(makeOptions({ ...input, ...delta }).queryFn({ signal: new AbortController().signal }), /access/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normal.queryFn({ signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
  for (const delta of [{ scopeKey: 'another-account:sample-environment' }, { imageVersion: 'two' }, { column: 'sample_cover' }]) {
    assert.notDeepEqual(normal.queryKey, makeOptions({ ...input, ...delta }).queryKey);
  }
});

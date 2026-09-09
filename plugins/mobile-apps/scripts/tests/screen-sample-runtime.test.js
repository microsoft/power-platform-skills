'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  root, available, loadSource, loadSample, hooks, component, components,
  tamagui, find, text, deferred, checkSampleTypes,
} = require('./helpers/sample-runtime');

if (!available && process.env.MOBILE_SAMPLE_RUNTIME_REQUIRED === '1') {
  throw new Error('Install the existing template dependencies before running sample runtime tests.');
}
const runtimeTest = (name, callback) => test(name, {
  skip: available ? false : 'Existing template TypeScript dependency is not installed',
}, callback);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const id = '00000000-0000-0000-0000-000000000001';

runtimeTest('changed samples and scanner snippet type-check against installed template APIs', () => {
  assert.deepEqual(checkSampleTypes(), []);
});

function screenEnvironment() {
  const h = hooks();
  const navigation = [];
  const invalidations = [];
  const router = Object.fromEntries(['back', 'navigate', 'push', 'replace'].map((method) => [
    method, (...args) => navigation.push([method, ...args]),
  ]));
  router.canGoBack = () => true;
  const queryClient = {
    invalidateQueries: async (options) => { invalidations.push(options.queryKey); },
  };
  const query = { data: null, isLoading: false, isError: false, refetch() {} };
  const mutations = [];
  const dependencies = {
    react: h.react,
    'expo-router': {
      useRouter: () => router,
      useLocalSearchParams: () => ({ id }),
      useFocusEffect: h.focusEffect,
    },
    '@tanstack/react-query': {
      useQueryClient: () => queryClient,
      useQuery: (options) => { query.options = options; return query; },
      useMutation: (options) => {
        const mutation = {
          isPending: false,
          async mutateAsync() {
            mutation.isPending = true;
            try { return await options.mutationFn(); }
            finally { mutation.isPending = false; }
          },
        };
        mutations.push(mutation);
        return mutation;
      },
    },
    'react-native': {
      ...components(['BackHandler', 'KeyboardAvoidingView', 'ScrollView']),
      Platform: { OS: 'ios' },
    },
    'react-native-safe-area-context': {
      ...components(['SafeAreaView']),
      useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
    },
    '@expo/vector-icons': components(['Ionicons']),
    tamagui,
    '@/components': components(['LoadingState', 'ErrorState', 'EmptyState', 'BottomActionBar', 'InfoRow']),
  };
  const utils = loadSample('src/utils/dataverse.ts', {
    'expo-crypto': { randomUUID: () => id },
  });
  dependencies['@/utils'] = { ...utils, formatDate: (value) => value };
  return { h, router, navigation, invalidations, dependencies, query, mutations };
}

function formEnvironment(saveRecipe) {
  const environment = screenEnvironment();
  const form = {
    control: {},
    formState: { isValid: true, isDirty: true, isSubmitting: false },
    handleSubmit: (onSubmit) => onSubmit,
    reset(values) { form.values = values; form.formState.isDirty = false; },
  };
  environment.dependencies['react-hook-form'] = { useForm: () => form, Controller: component('Controller') };
  const { default: Screen } = loadSample('screen-form.tsx', environment.dependencies);
  return {
    ...environment, form,
    render: () => environment.h.render(() => Screen({ saveRecipe })),
  };
}

runtimeTest('unwired form disables saving and never reports success or navigates', async () => {
  const env = formEnvironment();
  const tree = env.render();
  assert.equal(find(tree, 'Button', (node) => text(node).trim() === 'Save').props.disabled, true);
  await find(tree, 'Form').props.onSubmit({ title: 'Dinner' });
  assert.match(text(env.render()), /Saving is unavailable/);
  assert.doesNotMatch(text(env.render()), /Recipe saved/);
  assert.equal(env.navigation.length, 0);
});

runtimeTest('non-throwing failed save preserves values and never reports saved or navigates', async () => {
  const env = formEnvironment(async () => ({ success: false }));
  await find(env.render(), 'Form').props.onSubmit({ title: 'Dinner' });
  const tree = env.render();
  assert.match(text(tree), /Couldn't save/);
  assert.doesNotMatch(text(tree), /Recipe saved/);
  assert.equal(env.form.formState.isDirty, true);
  assert.equal(env.navigation.length, 0);
  assert.equal(env.invalidations.length, 0);
});

runtimeTest('form inputs accept typed web and native text events without losing values', () => {
  const env = formEnvironment();
  const tree = env.render();
  for (const [name, type, value, expected] of [
    ['title', 'Input', 'Dinner', 'Dinner'],
    ['description', 'TextArea', 'A quick meal', 'A quick meal'],
    ['servings', 'Input', '4', 4],
  ]) {
    let changed;
    const controller = find(tree, 'Controller', (node) => node.props.name === name);
    const fieldTree = controller.props.render({
      field: { value: '', onChange: (next) => { changed = next; }, onBlur() {} },
      fieldState: { invalid: false },
    });
    const input = find(fieldTree, type);
    input.props.onChange({ target: { value }, nativeEvent: {} });
    assert.equal(changed, expected);
    input.props.onChange({ target: 42, nativeEvent: { text: value } });
    assert.equal(changed, expected);
    assert.ok(input.props['aria-label']);
  }
});

runtimeTest('save locks same-tick repeats and sparse success exits exactly once', async () => {
  const response = deferred();
  let calls = 0;
  const env = formEnvironment(() => { calls++; return response.promise; });
  const submit = find(env.render(), 'Form').props.onSubmit;
  const first = submit({ title: 'Dinner' });
  await submit({ title: 'Duplicate' });
  assert.equal(calls, 1);
  assert.equal(env.navigation.length, 0);
  response.resolve({ success: true });
  await first;
  await submit({ title: 'Duplicate after save' });
  assert.equal(calls, 1);
  assert.equal(env.navigation.length, 1);
  assert.equal(env.invalidations.length, 1);
  assert.equal(env.form.values.title, 'Dinner');
  assert.match(text(env.render()), /Recipe saved/);
});

runtimeTest('failed save unlocks retry and refresh failure cannot replay a committed save', async () => {
  let calls = 0;
  const env = formEnvironment(async () => ({ success: ++calls > 1 }));
  env.dependencies['@tanstack/react-query'].useQueryClient = () => ({
    invalidateQueries: async () => { throw new Error('Refresh unavailable'); },
  });
  const submit = find(env.render(), 'Form').props.onSubmit;
  await submit({ title: 'Dinner' });
  await submit({ title: 'Dinner' });
  await flush();
  await submit({ title: 'Duplicate' });
  assert.equal(calls, 2);
  assert.equal(env.navigation.length, 1);
  assert.match(text(env.render()), /Recipe saved/);
});

function detailEnvironment(service) {
  const env = screenEnvironment();
  env.dependencies['@/generated/services/RecipesService'] = { RecipesService: service };
  env.query.data = { title: 'Dinner', servings: 2, createdon: '2026-01-01' };
  const { default: Screen } = loadSample('screen-detail.tsx', env.dependencies);
  return { ...env, render: () => env.h.render(Screen) };
}

runtimeTest('detail query rejects success:false and unwraps only successful results', async () => {
  const service = { get: async () => ({ success: false }) };
  const env = detailEnvironment(service);
  env.render();
  await assert.rejects(env.query.options.queryFn(), /Load failed/);
  service.get = async () => ({ success: true, data: { title: 'Dinner' } });
  assert.equal((await env.query.options.queryFn()).title, 'Dinner');
  service.get = async () => ({ success: true });
  assert.equal(await env.query.options.queryFn(), null);
});

runtimeTest('invalid detail ID disables the query and refuses service calls', async () => {
  let calls = 0;
  const env = detailEnvironment({ get: async () => { calls++; } });
  env.dependencies['expo-router'].useLocalSearchParams = () => ({ id: 'undefined' });
  const tree = env.render();
  assert.equal(env.query.options.enabled, false);
  assert.equal(find(tree, 'EmptyState').props.title, 'Invalid recipe link');
  await assert.rejects(env.query.options.queryFn(), /Missing recipe ID/);
  assert.equal(calls, 0);
});

runtimeTest('delete checks success, keeps failures recoverable, and suppresses repeat actions', async () => {
  const response = deferred();
  let calls = 0;
  const service = { delete: () => { calls++; return response.promise; } };
  const env = detailEnvironment(service);
  let remove = find(env.render(), 'Button', (node) => text(node) === 'Delete recipe').props.onPress;
  const first = remove();
  await remove();
  assert.equal(calls, 1);
  response.resolve({ success: false });
  await first;
  assert.equal(env.navigation.length, 0);
  assert.equal(env.invalidations.length, 0);
  assert.match(text(env.render()), /Couldn't delete/);
  service.delete = async () => { calls++; return { success: true }; };
  remove = find(env.render(), 'Button', (node) => text(node) === 'Delete recipe').props.onPress;
  await remove();
  await remove();
  assert.equal(calls, 2);
  assert.equal(env.navigation.length, 1);
  assert.equal(env.invalidations.length, 2);
  assert.equal(find(env.render(), 'EmptyState').props.title, 'Recipe deleted');
});

runtimeTest('detail edit uses the form contract and suppresses repeated navigation', () => {
  const env = detailEnvironment({});
  const edit = find(env.render(), 'Button', (node) => text(node).trim() === 'Edit').props.onPress;
  edit();
  edit();
  assert.equal(env.navigation.length, 1);
  assert.equal(env.navigation[0][0], 'navigate');
  assert.equal(env.navigation[0][1].params.editId, id);
});

runtimeTest('bounded lists keep live empty results empty even with mockData', async () => {
  const h = hooks();
  const { useListData } = loadSample('src/hooks/useListData.ts', {
    react: h.react, 'expo-router': { useFocusEffect: h.focusEffect },
  });
  const render = () => h.render(() => useListData(async () => ({ success: true, data: [] }), {
    mockData: [{ id: 'fixture' }],
  }));
  render();
  await flush();
  const state = render();
  assert.equal(state.items.length, 0);
  assert.equal(state.error, null);
  assert.equal(state.loading, false);
});

runtimeTest('bounded lists require explicit fixtures and expose non-throwing service failures', async () => {
  const h = hooks();
  let source = 'live';
  let calls = 0;
  const { useListData } = loadSample('src/hooks/useListData.ts', {
    react: h.react, 'expo-router': { useFocusEffect: h.focusEffect },
  });
  const render = () => h.render(() => useListData(async () => {
    calls++;
    return { success: false };
  }, { source, mockData: [{ id: 'fixture' }] }));
  render();
  await flush();
  assert.match(render().error, /Couldn't load/);
  assert.equal(render().items.length, 0);
  source = 'fixture';
  render();
  await flush();
  assert.equal(render().items[0].id, 'fixture');
  assert.equal(render().error, null);
  assert.equal(calls, 1);
  source = 'live';
  assert.equal(render().items.length, 0);
  await flush();
  assert.equal(render().items.length, 0);
  assert.match(render().error, /Couldn't load/);
  assert.equal(calls, 2);
});

runtimeTest('cursor lists preserve live empties and reject failed result envelopes', async () => {
  const h = hooks();
  let options;
  let response = { success: true, data: [] };
  let calls = 0;
  let source = 'live';
  const query = { data: undefined, error: null };
  const { useCursorListData } = loadSample('src/hooks/useCursorListData.ts', {
    react: h.react,
    '@tanstack/react-query': { useInfiniteQuery: (next) => { options = next; return query; } },
    '@/utils': { extractSkipToken: () => undefined },
  });
  const render = () => h.render(() => useCursorListData({
    queryKey: ['recipes'], source, mockData: [{ id: 'fixture' }], searchDebounceMs: 0,
    fetchPage: async () => { calls++; return response; },
  }));
  render();
  query.data = { pages: [await options.queryFn({ pageParam: undefined })] };
  assert.equal(render().items.length, 0);
  response = { success: true, data: [{ id: 'live' }], skipToken: 'opaque-next-page' };
  const livePage = await options.queryFn({ pageParam: undefined });
  assert.equal(livePage.items[0].id, 'live');
  assert.equal(options.getNextPageParam(livePage), 'opaque-next-page');
  response = { success: false };
  await assert.rejects(options.queryFn({ pageParam: undefined }), /Failed to load data/);
  source = 'fixture';
  render();
  query.data = { pages: [await options.queryFn({ pageParam: undefined })] };
  assert.equal(render().items[0].id, 'fixture');
  assert.equal(calls, 3);
  assert.equal(options.queryKey.at(-1).source, 'fixture');
  assert.equal(options.getNextPageParam(query.data.pages[0]), undefined);
});

runtimeTest('shared loading/error/progress controls expose accessible state', () => {
  const env = screenEnvironment();
  const shared = loadSample('src/components/index.tsx', {
    ...env.dependencies,
    'expo-linear-gradient': components(['LinearGradient']),
    '@/tokens': { gradients: {}, shadows: {} },
  });
  assert.equal(shared.LoadingState({ label: 'Loading recipes' }).props['aria-label'], 'Loading recipes');
  assert.equal(shared.LoadingState({}).props['aria-busy'], true);
  assert.equal(find(shared.ErrorState({ message: 'Try later', onRetry() {} }), 'Text', (node) => text(node) === 'Try later').props.role, 'alert');
  const header = shared.ModalHeader({ title: 'Recipe', onCancel() {}, onSave() {}, saving: true });
  assert.equal(find(header, 'Button', (node) => text(node) === 'Saving…').props.disabled, true);
});

runtimeTest('scanner permission denial retains dismiss, manual entry, and settings recovery', async () => {
  const h = hooks();
  const skill = fs.readFileSync(path.join(root, 'skills/add-native/add-camera/SKILL.md'), 'utf8');
  const source = skill.split('```tsx\n// src/native/barcodeScanner.tsx\n')[1]?.split('\n```')[0];
  assert.ok(source, 'Scanner implementation snippet exists');
  let settings = 0;
  let dismissed = 0;
  let manual = 0;
  let checkPermission = 0;
  let onAppState;
  const permission = { granted: false, canAskAgain: false };
  const { BarcodeScannerView } = loadSource(source, 'barcodeScanner.tsx', {
    react: h.react,
    'react-native': {
      ...components(['Button', 'Text', 'View']),
      Platform: { OS: 'ios' },
      Linking: { openSettings: async () => { settings++; } },
      AppState: { addEventListener: (_event, callback) => { onAppState = callback; return { remove() {} }; } },
      StyleSheet: { create: (styles) => styles, absoluteFillObject: {}, absoluteFill: {} },
    },
    'expo-camera': {
      CameraView: component('CameraView'),
      useCameraPermissions: () => [permission, async () => {}, async () => { checkPermission++; }],
    },
  });
  const tree = h.render(() => BarcodeScannerView({
    onScanned() {}, onDismiss: () => { dismissed++; }, onManualEntry: () => { manual++; },
    overlay: h.react.createElement('CallerClose', {}),
  }));
  find(tree, 'CallerClose');
  find(tree, 'Button', (node) => node.props.title === 'Close scanner').props.onPress();
  find(tree, 'Button', (node) => node.props.title === 'Enter code manually').props.onPress();
  await find(tree, 'Button', (node) => node.props.title === 'Open settings').props.onPress();
  assert.equal(dismissed, 1);
  assert.equal(manual, 1);
  assert.equal(settings, 1);
  assert.equal(permission.granted, false);
  onAppState('active');
  await flush();
  assert.equal(checkPermission, 1);
});

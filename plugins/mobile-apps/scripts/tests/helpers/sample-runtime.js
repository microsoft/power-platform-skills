'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
let ts;
try {
  ts = require(require.resolve('typescript', { paths: [path.join(root, 'template')] }));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

// Execute the real transpiled samples. Only framework/service boundaries are
// replaced; these tests cover handlers/state transitions, not native rendering.
function loadSource(source, filename, dependencies) {
  assert.ok(ts, 'Template TypeScript dependency is required for sample runtime tests');
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    exports: module.exports,
    module,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked sample dependency: ${name}`);
      return dependencies[name];
    },
    console: { error() {} },
    setTimeout,
    clearTimeout,
    URL,
  }, { filename });
  return module.exports;
}

function loadSample(relative, dependencies) {
  const filename = path.join(root, 'shared/samples', relative);
  return loadSource(fs.readFileSync(filename, 'utf8'), filename, dependencies);
}

function hooks() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  function memo(factory, dependencies) {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      slots[index] = { value: factory(), dependencies };
    }
    return slots[index].value;
  }
  const react = {
    createElement(type, props, ...children) {
      return { type: type.displayName ?? type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
      }];
    },
    useRef(initial) { return memo(() => ({ current: initial }), []); },
    useMemo: memo,
    useCallback(callback, dependencies) { return memo(() => callback, dependencies); },
    useEffect(callback, dependencies) {
      memo(() => { effects.push(callback); }, dependencies);
    },
  };
  return {
    react,
    focusEffect: (callback) => react.useEffect(callback, [callback]),
    render(callback) {
      cursor = 0;
      const value = callback();
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return value;
    },
  };
}

function component(name) {
  const value = () => {};
  value.displayName = name;
  return value;
}

function components(names) {
  return Object.fromEntries(names.map((name) => [name, component(name)]));
}

const tamagui = components([
  'YStack', 'XStack', 'ZStack', 'Text', 'Button', 'Form', 'H2', 'H3', 'Input',
  'Label', 'Switch', 'TextArea', 'AlertDialog', 'Paragraph', 'Separator',
]);
tamagui.Button.Text = component('Button.Text');
tamagui.Form.Trigger = component('Form.Trigger');
tamagui.Switch.Thumb = component('Switch.Thumb');
for (const name of ['Trigger', 'Portal', 'Overlay', 'Content', 'Title', 'Description', 'Cancel', 'Action']) {
  tamagui.AlertDialog[name] = component(`AlertDialog.${name}`);
}
tamagui.useTheme = () => new Proxy({}, { get: () => ({ val: '#000000' }) });

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}

function find(tree, type, predicate = () => true) {
  const found = nodes(tree).find((node) => node.type === type && predicate(node));
  assert.ok(found, `Missing rendered ${type}`);
  return found;
}

function text(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return (tree.children ?? []).map(text).join(' ');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function checkSampleTypes() {
  const template = path.join(root, 'template');
  const samples = path.join(root, 'shared/samples');
  const service = path.join(root, 'sample-service-probe.d.ts');
  const scanner = path.join(root, 'sample-scanner-probe.tsx');
  const cameraSkill = fs.readFileSync(path.join(root, 'skills/add-native/add-camera/SKILL.md'), 'utf8');
  // The illustrative Recipes service is not shipped in the template. Its stub
  // models the documented SDK envelope; UI/native/hook types use real packages.
  const virtual = new Map([
    [service, `export declare class RecipesService {
      static get(id: string): Promise<{ success: boolean;
        data?: {title: string; description?: string; servings?: number; createdon: string;
          ingredients?: string[]; steps?: string[]}; error?: {message?: string} }>;
      static delete(id: string): Promise<{ success: boolean; error?: {message?: string} }>;
    }`],
    [scanner, cameraSkill.split('```tsx\n// src/native/barcodeScanner.tsx\n')[1].split('\n```')[0]],
  ]);
  const options = {
    noEmit: true, strict: true, skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2020,
    esModuleInterop: true, allowSyntheticDefaultImports: true,
    baseUrl: samples, paths: { '@/*': ['src/*'] },
    types: ['react'], typeRoots: [path.join(template, 'node_modules/@types')],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  const exists = host.fileExists;
  host.readFile = (file) => virtual.get(file) ?? read(file);
  host.fileExists = (file) => virtual.has(file) || exists(file);
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    if (name === '@/generated/services/RecipesService') {
      return { resolvedFileName: service, extension: ts.Extension.Dts };
    }
    return ts.resolveModuleName(name, containing, options, host).resolvedModule
      ?? ts.resolveModuleName(name, path.join(template, '__sample_probe.ts'), options, host).resolvedModule;
  });
  const files = [
    'screen-form.tsx', 'screen-detail.tsx', 'src/hooks/useListData.ts',
    'src/hooks/useCursorListData.ts', 'src/components/index.tsx',
  ].map((file) => path.join(samples, file));
  const program = ts.createProgram([...files, scanner, path.join(template, 'tamagui.config.ts')], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const location = diagnostic.file
      ? `${path.relative(root, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : 'config';
    return `${location} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
}

module.exports = {
  root, available: Boolean(ts), loadSource, loadSample, hooks, component, components,
  tamagui, nodes, find, text, deferred, checkSampleTypes,
};

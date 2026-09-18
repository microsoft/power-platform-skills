'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { instrumentPrototypeScreen } = require('../lib/prototype-screen-authoring');

const modules = process.env.MOBILE_PROTOTYPE_TEMPLATE_MODULES;
const ts = modules ? require(path.join(modules, 'typescript')) : null;
const installed = { skip: !ts && 'Set MOBILE_PROTOTYPE_TEMPLATE_MODULES to the installed selected template' };
const screen = { screenId: 'home', sourceFile: 'app/(app)/home.tsx', ready: true, targets: [{ id: 'items', label: 'Items', role: 'collection' }] };

const source = `import { ScrollView, Text, View } from 'react-native';
import { useAuthoringScreen, useAuthoringTarget } from '@/authoring';
export const authoringTargets = [{ id: 'items', label: 'Items', role: 'collection' }] as const;
export default function Home({ ready, dirty }: { ready: boolean; dirty: boolean }) {
  const screen = useAuthoringScreen('home', { ready, hasUnsavedChanges: dirty });
  const target = useAuthoringTarget('items', { screen });
  return <View><ScrollView><View ref={target.ref}><Text>Items</Text></View></ScrollView></View>;
}
`;

test('foreground integration writes actual skeleton hooks but never invents usable-screen readiness', installed, () => {
  const skeleton = `import { Text, View } from 'react-native';
export const authoringTargets = [] as const;
export default function Home() { return <View><Text>Building this screen</Text></View>; }
`;
  const output = instrumentPrototypeScreen(ts, skeleton, { ...screen, ready: false, targets: [] });
  assert.match(output, /useAuthoringScreen as useMobileScreenAuthoring/);
  assert.match(output, /ready: false, hasUnsavedChanges: false/);
  assert.match(output, /onLayout=\{mobileAuthoringScreen.onLayout\}/);
  assert.equal(instrumentPrototypeScreen(ts, output, { ...screen, ready: false, targets: [] }), output);
  assert.throws(() => instrumentPrototypeScreen(ts, output, { ...screen, targets: [] }), /still an unready skeleton/);
  assert.throws(() => instrumentPrototypeScreen(ts, skeleton, { ...screen, targets: [] }), /actual readiness and dirty state/);
  assert.throws(() => instrumentPrototypeScreen(ts, 'export default function Home() { return null; }', { ...screen, ready: false, targets: [] }), /real native layout container/);
});

test('the real generator binds layout, all scroll lifecycle callbacks and explicit target refs idempotently', installed, () => {
  const output = instrumentPrototypeScreen(ts, source, screen);
  assert.match(output, /<View onLayout=\{screen.onLayout\}>/);
  assert.match(output, /<View ref=\{target.ref\} collapsable=\{false\} onLayout=\{target.onLayout\}>/);
  for (const callback of ['onScroll', 'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd']) {
    assert.match(output, new RegExp(`${callback}=\\{screen.onScroll\\}`));
  }
  assert.match(output, /scrollEventThrottle=\{16\}/);
  assert.equal(instrumentPrototypeScreen(ts, output, screen), output);
  assert.match(output, /ready, hasUnsavedChanges: dirty/);
});

test('emitted real-screen event callbacks reach the supplied runtime handles and retain actual ready/dirty values', installed, () => {
  const output = instrumentPrototypeScreen(ts, source, screen);
  const javascript = ts.transpileModule(output, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const registrations = [];
  const events = [];
  const handle = { onLayout: (event) => events.push(['screen-layout', event]), onScroll: () => events.push(['scroll']) };
  const target = { ref: { current: null }, onLayout: () => events.push(['target-layout']) };
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(javascript, { module, exports: module.exports, require: (name) => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react-native') return { View: 'View', ScrollView: 'ScrollView', Text: 'Text' };
    if (name === '@/authoring') return {
      useAuthoringScreen: (id, state) => { registrations.push({ id, ...state }); return handle; },
      useAuthoringTarget: (id, options) => { assert.equal(id, 'items'); assert.equal(options.screen, handle); return target; },
    };
    throw new Error(`Unexpected generated import ${name}`);
  } });
  const tree = module.exports.default({ ready: true, dirty: true });
  assert.equal(registrations[0].id, 'home');
  assert.equal(registrations[0].ready, true);
  assert.equal(registrations[0].hasUnsavedChanges, true);
  const layout = { nativeEvent: { layout: { width: 320, height: 640 } } };
  tree.props.onLayout(layout);
  const scroll = tree.props.children;
  for (const callback of ['onScroll', 'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd']) scroll.props[callback]();
  assert.equal(scroll.props.scrollEventThrottle, 16);
  assert.equal(scroll.props.children.props.ref, target.ref);
  assert.equal(scroll.props.children.props.collapsable, false);
  scroll.props.children.props.onLayout();
  assert.deepEqual(events, [['screen-layout', layout], ['scroll'], ['scroll'], ['scroll'], ['scroll'], ['target-layout']]);
  module.exports.default({ ready: false, dirty: false });
  assert.equal(registrations[1].ready, false);
  assert.equal(registrations[1].hasUnsavedChanges, false);
});

test('root and target layout bindings compose without duplicate JSX attributes', installed, () => {
  const input = source.replace('<View><ScrollView><View ref={target.ref}><Text>Items</Text></View></ScrollView></View>',
    '<View ref={target.ref}><Text>Items</Text></View>');
  const output = instrumentPrototypeScreen(ts, input, screen);
  assert.match(output, /onLayout=\{\(event\) => \{ screen.onLayout\(event\); target.onLayout\(\); \}\}/);
  assert.equal(instrumentPrototypeScreen(ts, output, screen), output);
});

test('custom callbacks are never overwritten and a mere reference is not an invoked event handler', installed, () => {
  for (const callback of ['() => {}', '() => { screen.onScroll; }', '() => { const unused = () => screen.onScroll(); }']) {
    assert.throws(() => instrumentPrototypeScreen(ts, source.replace('<ScrollView>', `<ScrollView onScroll={${callback}}>`), screen), /Compose the existing onScroll/);
  }
  const custom = source.replace('<ScrollView>', '<ScrollView onScroll={() => { trackScroll(); screen.onScroll(); }}>');
  assert.match(instrumentPrototypeScreen(ts, custom, screen), /trackScroll\(\); screen.onScroll\(\)/);
  const shadowed = source.replace('<ScrollView>', '<ScrollView onScroll={screen.onScroll} {...scrollProps}>');
  assert.throws(() => instrumentPrototypeScreen(ts, shadowed, screen), /JSX spread can override/);
});

test('metadata, unused component declarations, conditional hooks and shadowed imports cannot fake actual registration', installed, () => {
  const unused = source.replace('export default function Home(', 'function Unused(')
    + '\nexport default function Home() { return <View />; }\n';
  assert.throws(() => instrumentPrototypeScreen(ts, unused, screen), /actual readiness and dirty state/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace("'home'", "'other'"), screen), /exact registered ID/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace('hasUnsavedChanges: dirty', ''), screen), /explicitly bind ready and hasUnsavedChanges/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace('hasUnsavedChanges: dirty', 'hasUnsavedChanges: false'), { ...screen, form: true }), /actual dirty state/);
  const conditional = source.replace("const target = useAuthoringTarget('items', { screen });", "if (ready) { const target = useAuthoringTarget('items', { screen }); }");
  assert.throws(() => instrumentPrototypeScreen(ts, conditional, screen), /unconditionally/);
  const shadowed = source.replace("  const screen = ", "  const useAuthoringScreen = anotherFunction;\n  const screen = ");
  assert.throws(() => instrumentPrototypeScreen(ts, shadowed, screen), /real imported binding/);
  const shadowedView = source.replace("  const screen = ", "  const View = anotherComponent;\n  const screen = ");
  assert.throws(() => instrumentPrototypeScreen(ts, shadowedView, screen), /real imported binding/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace('export default function', 'export default async function'), screen), /actual screen function/);
});

test('target bindings must select an explicit actual View once, with no JSX or pixel location inference', installed, () => {
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace('ref={target.ref}', ''), screen), /no target location is inferred/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace("useAuthoringTarget('items'", "useAuthoringTarget('unknown'"), screen), /unknown or repeated target/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace("  const target = useAuthoringTarget('items', { screen });", '')
    .replace('ref={target.ref}', ''), screen), /every declared semantic target/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace('ref={target.ref}', 'ref={target.ref} collapsable={true}'), screen), /collapsable=\{false\}/);
  assert.throws(() => instrumentPrototypeScreen(ts, source.replace('ref={target.ref}', 'ref={target.ref} ref={otherRef}'), screen), /Repeated JSX attribute/);
});

test('the actual AuthoringScreen component path instruments child scrolling through its inherited context', installed, () => {
  const component = `import { ScrollView, Text } from 'react-native';
import { AuthoringScreen, AuthoringTarget, useAuthoringRemeasure } from '@/authoring';
function Content() {
  const remeasure = useAuthoringRemeasure();
  return <ScrollView><AuthoringTarget targetId="items"><Text>Items</Text></AuthoringTarget></ScrollView>;
}
export default function Home({ ready, dirty }: { ready: boolean; dirty: boolean }) {
  return <AuthoringScreen screenId="home" ready={ready} hasUnsavedChanges={dirty}><Content /></AuthoringScreen>;
}
`;
  const output = instrumentPrototypeScreen(ts, component, screen);
  for (const callback of ['onScroll', 'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd']) {
    assert.match(output, new RegExp(`${callback}=\\{remeasure\\}`));
  }
  assert.equal(instrumentPrototypeScreen(ts, output, screen), output);
  assert.throws(() => instrumentPrototypeScreen(ts, component.replace('<Content />', '<Content /><Content />'), screen), /Repeated component instances/);
  assert.throws(() => instrumentPrototypeScreen(ts, component.replace('hasUnsavedChanges={dirty}', 'hasUnsavedChanges={dirty} {...otherProps}'), screen), /JSX spread can override/);
});

'use strict';
// A page opened as a dialog returns a value with `dataApi.setPageOutput(value)` and `Xrm.Navigation.navigateBack()` (AB#6757591). The runtime has the method, but
// the RuntimeTypes.ts the SDK generates for a page does not declare it, so `dataApi.setPageOutput(…)` fails type checking. references/rules.md ("Dialog output") gives the
// narrow typed intersection that type-checks; these tests hold that text to the types the vendored SDK really generates, and hold the plugin's own page checks to accepting it:
//   - the generated `UxAgentDataApi` has no `setPageOutput`, and a direct call is TS2339 — the SDK gap the rule works around (when the SDK declares the method, this test
//     fails, and the rule can say to call it directly);
//   - the rule's dialog snippet and caller snippet, read from rules.md itself, type-check against those types with no error;
//   - a page written with the pattern passes the checks every page upload makes (Griffel, the navigation scan) and the transpile the SDK compiles a page with.
// The type check is the vendored TypeScript (scripts/vendor/typescript) with no default library: a few global declarations stand in for lib.d.ts, which the plugin does not ship.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generatedRuntimeTypes } = require('./helpers/generated-runtime-types.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { griffelStyleProblems } = require('../lib/griffel-styles.js');
const { extractNavTargets, navMalformedRefs, strayPageRefs } = require('../lib/pageref-resolver.js');
const { pageStructureProblems } = require('../lib/page-structure.js');

// rules.md is read with its line ends normalized: a Windows checkout gives it CRLF (git's core.autocrlf), and the snippets are found by LF patterns — the section's
// end, the code fences — and joined into a page line by line.
const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'rules.md'), 'utf8').replace(/\r\n/g, '\n');
const SECTION = '### Dialog output (`setPageOutput`)';

// The globals a page's types touch, in place of lib.d.ts (`noLib`): the ones the compiler itself needs, and those the generated types and the snippets name.
const GLOBALS = [
  'interface Array<T> { length: number; [n: number]: T; } interface ReadonlyArray<T> { readonly length: number; readonly [n: number]: T; }',
  'interface Boolean {} interface CallableFunction {} interface Function {} interface IArguments {} interface NewableFunction {} interface Number {} interface Object {} interface RegExp {} interface String {} interface Symbol {} interface Date {}',
  'interface Promise<T> { then<R>(f: (value: T) => R): Promise<R>; }',
  'type Record<K extends keyof any, T> = { [P in K]: T }; type Partial<T> = { [P in keyof T]?: T[P] }; type Required<T> = { [P in keyof T]-?: T[P] }; type Readonly<T> = { readonly [P in keyof T]: T[P] };',
  'type Pick<T, K extends keyof T> = { [P in K]: T[P] }; type Exclude<T, U> = T extends U ? never : T; type Extract<T, U> = T extends U ? T : never; type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>; type NonNullable<T> = T & {};',
  'declare const window: unknown;',
].join('\n');

// The diagnostics of `page` (a TypeScript module that imports './RuntimeTypes') against `runtimeTypes`, as { code, text } — the page's own only.
function typeCheck(page, runtimeTypes) {
  const ts = loadVendoredTypeScript();
  const files = { '/lib.d.ts': GLOBALS, '/RuntimeTypes.ts': runtimeTypes, '/page.ts': page };
  const host = {
    getSourceFile: (name, version) => (files[name] === undefined ? undefined : ts.createSourceFile(name, files[name], version)),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const options = { noLib: true, strict: true, noEmit: true, target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10, types: [] };
  const program = ts.createProgram(Object.keys(files), options, host);
  const all = ts.getPreEmitDiagnostics(program);
  // The generated types are checked too: a declaration they need and the stand-in globals lack would show here, and make the page's own result meaningless.
  assert.deepEqual(all.filter((d) => d.file && d.file.fileName !== '/page.ts').map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')), [], 'the generated types check clean against the stand-in globals');
  return all.filter((d) => d.file && d.file.fileName === '/page.ts').map((d) => ({ code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}

// The `typescript` code blocks of the rule's section, in order: the dialog page's, then the caller's.
function sectionSnippets() {
  const at = RULES.indexOf(SECTION);
  assert.ok(at >= 0, `rules.md has the section ${SECTION}`);
  const rest = RULES.slice(at + SECTION.length);
  const section = rest.slice(0, rest.search(/\n#{2,3} /));
  return [...section.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1]);
}

let typesP;
const runtimeTypes = () => typesP || (typesP = generatedRuntimeTypes());

test('the RuntimeTypes the SDK generates declare no setPageOutput, so a direct call fails type checking — the gap the rule works around', async () => {
  const types = await runtimeTypes();
  assert.match(types, /export interface UxAgentDataApi\s+extends BaseUxAgentDataApi<TableRegistrations, EnumRegistrations> \{\}/);
  assert.doesNotMatch(types, /setPageOutput/, 'when the SDK declares it, the intersection in rules.md is no longer needed: say to call it directly');
  const direct = typeCheck([
    "import type { GeneratedComponentProps } from './RuntimeTypes';",
    'export function close(props: GeneratedComponentProps, value: unknown): void {',
    '  props.dataApi.setPageOutput(value);',
    '}',
  ].join('\n'), types);
  assert.deepEqual(direct.map((d) => d.code), [2339]);
  assert.match(direct[0].text, /Property 'setPageOutput' does not exist on type 'UxAgentDataApi'/);
});

test('the dialog page snippet in rules.md type-checks against the generated types with no error', async () => {
  const [dialog] = sectionSnippets();
  assert.ok(dialog && /setPageOutput/.test(dialog) && /navigateBack\(\)/.test(dialog), 'the first snippet returns the value and closes the dialog');
  assert.match(dialog, /dataApi as typeof dataApi & \{ setPageOutput\(value: unknown\): void \}/, 'the narrow intersection, not `any`');
  const page = [
    "import type { GeneratedComponentProps } from './RuntimeTypes';",
    'export function finish(props: GeneratedComponentProps, selectedId: string): void {',
    '  const { dataApi } = props;',
    dialog,
    '}',
  ].join('\n');
  assert.deepEqual(typeCheck(page, await runtimeTypes()), []);
});

test('the caller snippet in rules.md type-checks: navigateTo with target 2, and returnValue read as unknown', async () => {
  const caller = sectionSnippets()[1];
  assert.ok(caller && /target: 2/.test(caller) && /returnValue/.test(caller), 'the second snippet opens the dialog and reads what it returned');
  const page = [
    'export async function pick(targetPageId: string): Promise<unknown> {',
    caller,
    '  return output;',
    '}',
  ].join('\n');
  assert.deepEqual(typeCheck(page, await runtimeTypes()), []);
});

test('a page written with the pattern passes the checks every page upload makes and compiles as the SDK compiles it', () => {
  const [dialog] = sectionSnippets();
  const page = [
    "import * as React from 'react';",
    "import { Button, makeStyles, tokens } from '@fluentui/react-components';",
    "import type { GeneratedComponentProps } from './RuntimeTypes';",
    'const useStyles = makeStyles({ root: { padding: tokens.spacingHorizontalL, borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: tokens.colorNeutralStroke1 } });',
    'const GeneratedComponent = (props: GeneratedComponentProps) => {',
    '  const { dataApi, pageInput } = props;',
    '  const styles = useStyles();',
    '  const selectedId = String(pageInput?.data?.accountId ?? "");',
    '  const choose = () => {',
    dialog.split('\n').map((line) => `    ${line}`).join('\n'),
    '  };',
    '  return <div className={styles.root}><Button appearance="primary" onClick={choose}>Select</Button></div>;',
    '};',
    'export default GeneratedComponent;',
  ].join('\n');
  const ts = loadVendoredTypeScript();
  // A page saved on Windows can hold CRLF line ends, and an upload checks the file as it is (genpage-upload.js decodes it and changes no line end), so the same page
  // written so passes the same checks.
  for (const [ends, text] of [['LF', page], ['CRLF', page.replace(/\n/g, '\r\n')]]) {
    assert.deepEqual(pageStructureProblems(text), [], `${ends}: the structural gate the page of a worker and a promoted page pass`);
    assert.deepEqual(griffelStyleProblems(text).problems, [], `${ends}: the Griffel check`);
    assert.deepEqual(navMalformedRefs(text), [], `${ends}: no malformed navigation reference`);
    assert.deepEqual(strayPageRefs(text), [], `${ends}: no PAGEREF_ token`);
    assert.deepEqual(extractNavTargets(text), [], `${ends}: navigateBack is no navigation to another page`);
    const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((out.diagnostics || []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')), [], ends);
    assert.match(out.outputText, /setPageOutput/, ends);
  }
});

test('rules.md says what the method does and does not do: synchronous and void, it does not close the dialog, and a dialog closed without it returns undefined', () => {
  const at = RULES.indexOf(SECTION);
  const text = RULES.slice(at, at + 2500).replace(/\s+/g, ' ');
  assert.match(text, /`setPageOutput\(value: unknown\): void`\. It stores the value and does \*\*not\*\* close the dialog\./);
  assert.match(text, /`Xrm\.Navigation\.navigateBack\(\)` closes the dialog, and the caller's `navigateTo` promise resolves with `\{ returnValue: <the value> \}`\./);
  assert.match(text, /A dialog closed without `setPageOutput` gives `returnValue: undefined`\. The method is synchronous: do not `await` it\./);
  assert.match(text, /Do not use `any`, and do not change `RuntimeTypes\.ts`/);
});

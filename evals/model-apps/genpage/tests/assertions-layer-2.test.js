'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ASSERTIONS,
  PHASE5_EXPECTATIONS,
  setVerifiedIcons,
  extractIconImports,
  isDataverseFile,
  isMockFile,
} = require('../lib/assertions-layer-2.js');

// Helper to build a fake "file" object the assertion API expects.
function f(name, content) {
  return { path: `/fake/${name}`, name, content };
}

function evalStub(id = 1) {
  return { id, tier: 'smoke', prompt: '', data: {}, expectations: [] };
}

// Seed verified-icons so tests don't depend on the on-disk list.
setVerifiedIcons(new Set(['AddRegular', 'EditRegular', 'DeleteRegular', 'PeopleRegular']));

// ---------- helpers ----------

test('extractIconImports parses single-line imports', () => {
  const src = `import { AddRegular, EditRegular } from "@fluentui/react-icons";`;
  assert.deepEqual(extractIconImports(src), ['AddRegular', 'EditRegular']);
});

test('extractIconImports handles multi-line imports and aliases', () => {
  const src = `import {
    AddRegular,
    EditRegular as Edit,
    DeleteRegular
  } from "@fluentui/react-icons";`;
  assert.deepEqual(extractIconImports(src), ['AddRegular', 'EditRegular', 'DeleteRegular']);
});

test('isDataverseFile / isMockFile based on RuntimeTypes import', () => {
  assert.equal(isDataverseFile(`import { X } from "./RuntimeTypes";`), true);
  assert.equal(isDataverseFile(`import { X } from "other";`), false);
  assert.equal(isMockFile(`import { X } from "other";`), true);
});

// ---------- assertion: export default GeneratedComponent ----------

test('export default GeneratedComponent: pass when present', () => {
  const check = ASSERTIONS.get('Generated .tsx is a single file with `export default GeneratedComponent`');
  const result = check({ files: [f('a.tsx', `export default GeneratedComponent;`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('export default GeneratedComponent: fail when missing', () => {
  const check = ASSERTIONS.get('Generated .tsx is a single file with `export default GeneratedComponent`');
  const result = check({ files: [f('a.tsx', `export default OtherName;`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- assertion: destructures pageInput ----------

test('destructures pageInput: pass on valid destructure', () => {
  const check = ASSERTIONS.get('Generated .tsx destructures props including `pageInput` (e.g., `const { dataApi, pageInput } = props;`)');
  const result = check({ files: [f('a.tsx', `const { dataApi, pageInput } = props;`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('destructures pageInput: fail when only dataApi is destructured', () => {
  const check = ASSERTIONS.get('Generated .tsx destructures props including `pageInput` (e.g., `const { dataApi, pageInput } = props;`)');
  const result = check({ files: [f('a.tsx', `const { dataApi } = props;`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- assertion: 100vh/100vw ----------

test('no 100vh/100vw: pass on clean code', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT use `100vh` or `100vw`');
  const result = check({ files: [f('a.tsx', `height: '50%'`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('no 100vh/100vw: fail when used in code', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT use `100vh` or `100vw`');
  const result = check({ files: [f('a.tsx', `height: '100vh'`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('no 100vh/100vw: pass when only in comments (stripComments ignores)', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT use `100vh` or `100vw`');
  const result = check({ files: [f('a.tsx', `// rule: never use 100vh\nheight: '50%';`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('no 100vh/100vw: pass when only in block comment', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT use `100vh` or `100vw`');
  const result = check({ files: [f('a.tsx', `/* avoid 100vh */ height: '50%';`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- assertion: forbidden theme functions ----------

test('forbidden theme funcs: fail on real usage', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT import `createTheme`, `mergeThemes`, or `useTheme` (these do not exist in Fluent UI V9)');
  const result = check({ files: [f('a.tsx', `const t = useTheme();`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('forbidden theme funcs: pass when only in comment', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT import `createTheme`, `mergeThemes`, or `useTheme` (these do not exist in Fluent UI V9)');
  const result = check({ files: [f('a.tsx', `// don't use useTheme\nconst t = tokens;`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- assertion: FluentProvider ----------

test('no <FluentProvider>: fail on top-level wrap', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT wrap content in a top-level `<FluentProvider>` (already provided at root)');
  const result = check({ files: [f('a.tsx', `return <FluentProvider><div/></FluentProvider>;`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- assertion: window.location / react-router ----------

test('no window.location: fail on use', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT use React Router or construct raw URLs / manipulate `window.location` for navigation');
  const result = check({ files: [f('a.tsx', `window.location.href = '/foo'`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('no react-router: fail on import', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT use React Router or construct raw URLs / manipulate `window.location` for navigation');
  const result = check({ files: [f('a.tsx', `import { Link } from "react-router-dom";`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- assertion: Xrm.Navigation.navigateTo ----------

test('Xrm.Navigation: skip when no nav intent', () => {
  const check = ASSERTIONS.get('Generated .tsx uses `Xrm.Navigation.navigateTo` for any in-app navigation');
  const result = check({ files: [f('a.tsx', `const x = 1;`)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('Xrm.Navigation: pass when used correctly', () => {
  const check = ASSERTIONS.get('Generated .tsx uses `Xrm.Navigation.navigateTo` for any in-app navigation');
  const result = check({ files: [f('a.tsx', `Xrm.Navigation.navigateTo(pageInput);`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Xrm.Navigation: fail when nav intent but wrong API', () => {
  const check = ASSERTIONS.get('Generated .tsx uses `Xrm.Navigation.navigateTo` for any in-app navigation');
  const result = check({ files: [f('a.tsx', `openRecord('account', id);`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- assertion: unsized icons ----------

test('unsized icons: pass on AddRegular', () => {
  const check = ASSERTIONS.get('Generated .tsx uses Fluent UI icons in unsized form (e.g., `AddRegular`, not `Add24Regular`)');
  const result = check({ files: [f('a.tsx', `import { AddRegular } from "@fluentui/react-icons";`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('unsized icons: fail on Add24Regular', () => {
  const check = ASSERTIONS.get('Generated .tsx uses Fluent UI icons in unsized form (e.g., `AddRegular`, not `Add24Regular`)');
  const result = check({ files: [f('a.tsx', `import { Add24Regular } from "@fluentui/react-icons";`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /Add24Regular/);
});

test('unsized icons: pass when sized name appears only in comment', () => {
  const check = ASSERTIONS.get('Generated .tsx uses Fluent UI icons in unsized form (e.g., `AddRegular`, not `Add24Regular`)');
  const result = check({ files: [f('a.tsx', `// use AddRegular not Add24Regular\nimport { AddRegular } from "@fluentui/react-icons";`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- assertion: verified-icons ----------

test('verified-icons: fail on hallucinated import', () => {
  const check = ASSERTIONS.get('Every named import from `@fluentui/react-icons` in the generated .tsx appears in references/verified-icons.txt — no hallucinated icon names');
  const result = check({ files: [f('a.tsx', `import { MadeUpIconRegular } from "@fluentui/react-icons";`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /MadeUpIconRegular/);
});

test('verified-icons: pass on real icons', () => {
  const check = ASSERTIONS.get('Every named import from `@fluentui/react-icons` in the generated .tsx appears in references/verified-icons.txt — no hallucinated icon names');
  const result = check({ files: [f('a.tsx', `import { AddRegular, PeopleRegular } from "@fluentui/react-icons";`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- assertion: try/catch around dataApi ----------

test('dataApi try/catch: skip when no Dataverse files', () => {
  const check = ASSERTIONS.get('Generated .tsx wraps async `dataApi` calls in try-catch (Dataverse pages only)');
  const result = check({ files: [f('a.tsx', `const x = 1;`)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('dataApi try/catch: pass when wrapped', () => {
  const check = ASSERTIONS.get('Generated .tsx wraps async `dataApi` calls in try-catch (Dataverse pages only)');
  const src = `import type { X } from "./RuntimeTypes";
async function fn() { try { await dataApi.queryTable('account'); } catch (e) {} }`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('dataApi try/catch: fail when missing', () => {
  const check = ASSERTIONS.get('Generated .tsx wraps async `dataApi` calls in try-catch (Dataverse pages only)');
  const src = `import type { X } from "./RuntimeTypes";
async function fn() { await dataApi.queryTable('account'); }`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- assertion: no TODO/FIXME ----------

test('no TODO: fail when present', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT include any `TODO`, `FIXME`, ellipsis placeholders, or incomplete function bodies');
  const result = check({ files: [f('a.tsx', `// TODO: implement this`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('no TODO: fail when bare ellipsis on a line', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT include any `TODO`, `FIXME`, ellipsis placeholders, or incomplete function bodies');
  const result = check({ files: [f('a.tsx', `function fn() {\n    ...\n}`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('no TODO: pass when spreads exist (...props is fine)', () => {
  const check = ASSERTIONS.get('Generated .tsx does NOT include any `TODO`, `FIXME`, ellipsis placeholders, or incomplete function bodies');
  const result = check({ files: [f('a.tsx', `function fn(props) { return <Comp {...props} />; }`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- assertion: DataGrid needs createTableColumn + sizing ----------

test('DataGrid: skip when no DataGrid usage', () => {
  const check = ASSERTIONS.get('For DataGrids, generated .tsx imports `createTableColumn` from `@fluentui/react-components` and configures column sizing (columnSizingOptions or resizableColumns)');
  const result = check({ files: [f('a.tsx', `<div/>`)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('DataGrid: fail when missing createTableColumn', () => {
  const check = ASSERTIONS.get('For DataGrids, generated .tsx imports `createTableColumn` from `@fluentui/react-components` and configures column sizing (columnSizingOptions or resizableColumns)');
  const src = `import { DataGrid } from "@fluentui/react-components";
return <DataGrid columnSizingOptions={{}} />;`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('DataGrid: pass with both createTableColumn and sizing', () => {
  const check = ASSERTIONS.get('For DataGrids, generated .tsx imports `createTableColumn` from `@fluentui/react-components` and configures column sizing (columnSizingOptions or resizableColumns)');
  const src = `import { DataGrid, createTableColumn } from "@fluentui/react-components";
return <DataGrid resizableColumns />;`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

// ---------- assertion: PAGEREF for multi-page ----------

test('PAGEREF: skip on single-page fixture', () => {
  const check = ASSERTIONS.get('For multi-page builds, cross-page navigation uses quoted `"PAGEREF_<filename>"` placeholders that the orchestrator\'s Phase 6.5 resolves to real GUIDs');
  const result = check({ files: [f('a.tsx', `Xrm.Navigation.navigateTo({});`)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('PAGEREF: pass on multi-page with placeholder', () => {
  const check = ASSERTIONS.get('For multi-page builds, cross-page navigation uses quoted `"PAGEREF_<filename>"` placeholders that the orchestrator\'s Phase 6.5 resolves to real GUIDs');
  const files = [
    f('list.tsx', `Xrm.Navigation.navigateTo({ pageId: "PAGEREF_detail" });`),
    f('detail.tsx', `// no nav`),
  ];
  const result = check({ files, eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('PAGEREF: fail on multi-page with hard-coded GUIDs', () => {
  const check = ASSERTIONS.get('For multi-page builds, cross-page navigation uses quoted `"PAGEREF_<filename>"` placeholders that the orchestrator\'s Phase 6.5 resolves to real GUIDs');
  const files = [
    f('list.tsx', `Xrm.Navigation.navigateTo({ pageId: "abc-123-def" });`),
    f('detail.tsx', `const x = 1;`),
  ];
  const result = check({ files, eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- queryTable result.rows ----------

test('queryTable .rows: pass when result.rows accessed', () => {
  const check = ASSERTIONS.get('For Dataverse pages that call dataApi.queryTable, the result is accessed via .rows (DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() }) — never used directly as an array (Rule 11)');
  const src = `import { X } from "./RuntimeTypes";
async function fn() {
  const result = await dataApi.queryTable('account', { top: 100 });
  setRecords(result.rows);
}`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('queryTable .rows: fail when result iterated directly', () => {
  const check = ASSERTIONS.get('For Dataverse pages that call dataApi.queryTable, the result is accessed via .rows (DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() }) — never used directly as an array (Rule 11)');
  const src = `import { X } from "./RuntimeTypes";
async function fn() {
  const result = await dataApi.queryTable('account', { top: 100 });
  return result.map((r) => r.name);  // BUG — result is DataTable, not Array
}`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('queryTable .rows: skip on mock pages (no RuntimeTypes import)', () => {
  const check = ASSERTIONS.get('For Dataverse pages that call dataApi.queryTable, the result is accessed via .rows (DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() }) — never used directly as an array (Rule 11)');
  const result = check({ files: [f('a.tsx', `const data = [{ a: 1 }, { a: 2 }];`)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('queryTable .rows: skip when Dataverse file does not use queryTable', () => {
  const check = ASSERTIONS.get('For Dataverse pages that call dataApi.queryTable, the result is accessed via .rows (DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() }) — never used directly as an array (Rule 11)');
  const src = `import { X } from "./RuntimeTypes";
async function fn() {
  await dataApi.createRow('account', {});
}`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('queryTable .rows: comment-only "result.map" does not pass', () => {
  // Comments are stripped before the regex looks for .rows, so a file with
  // queryTable but only a commented-out result.rows reference fails.
  const check = ASSERTIONS.get('For Dataverse pages that call dataApi.queryTable, the result is accessed via .rows (DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() }) — never used directly as an array (Rule 11)');
  const src = `import { X } from "./RuntimeTypes";
async function fn() {
  const result = await dataApi.queryTable('account', {});
  // hint: use result.rows
  return result.length;  // wrong: this is the DataTable, not an array
}`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

// ---------- Phase 5 expectations ----------

test('Phase 5 - charts: fail on Chart.js import', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Chart uses D3.js exclusively — no Chart.js, Recharts, or other libraries. D3 code uses group() not nest()');
  const result = check({ files: [f('a.tsx', `import Chart from "chart.js";`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - charts: fail on d3.nest()', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Chart uses D3.js exclusively — no Chart.js, Recharts, or other libraries. D3 code uses group() not nest()');
  const result = check({ files: [f('a.tsx', `const grouped = d3.nest().key(d => d.cat);`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - charts: pass on d3.group()', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Chart uses D3.js exclusively — no Chart.js, Recharts, or other libraries. D3 code uses group() not nest()');
  const result = check({ files: [f('a.tsx', `const grouped = d3.group(arr, d => d.cat);`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 5 - DatePicker: fail on wrong import package', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): DatePicker (if used) is imported from @fluentui/react-datepicker-compat, not @fluentui/react-components');
  const result = check({ files: [f('a.tsx', `import { DatePicker } from "@fluentui/react-components";`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - DatePicker: pass on correct compat import', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): DatePicker (if used) is imported from @fluentui/react-datepicker-compat, not @fluentui/react-components');
  const result = check({ files: [f('a.tsx', `import { DatePicker } from "@fluentui/react-datepicker-compat";`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

test('Phase 5 - DnD: fail on react-dnd import', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Drag-and-drop uses native HTML5 events (onDragStart, onDragOver, onDrop) — no external DnD library');
  const result = check({ files: [f('a.tsx', `import { useDrag } from "react-dnd";`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - task entity: fail on plural', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Code uses entity logical name \'task\' (singular lowercase) not \'tasks\'');
  const result = check({ files: [f('a.tsx', `dataApi.queryTable("tasks", {});`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - submit handler: fail when no createRow', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Submit uses dataApi.createRow with verified column names from RuntimeTypes.ts');
  const src = `import { X } from "./RuntimeTypes";
function onSubmit() { console.log('submit'); }`;
  const result = check({ files: [f('a.tsx', src)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - submit handler: skip without RuntimeTypes import', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Submit uses dataApi.createRow with verified column names from RuntimeTypes.ts');
  const result = check({ files: [f('a.tsx', `function onSubmit() {}`)], eval: evalStub() });
  assert.equal(result.status, 'skip');
});

test('Phase 5 - raw HTML form elements: fail on <input>', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Form uses Fluent UI V9 components (Input, Dropdown, etc.) — not HTML form elements');
  const result = check({ files: [f('a.tsx', `<input type="text" />`)], eval: evalStub() });
  assert.equal(result.status, 'fail');
});

test('Phase 5 - raw HTML form elements: pass on Fluent <Input>', () => {
  const check = PHASE5_EXPECTATIONS.get('Phase 5 (Page Builder): Form uses Fluent UI V9 components (Input, Dropdown, etc.) — not HTML form elements');
  const result = check({ files: [f('a.tsx', `<Input value="" />`)], eval: evalStub() });
  assert.equal(result.status, 'pass');
});

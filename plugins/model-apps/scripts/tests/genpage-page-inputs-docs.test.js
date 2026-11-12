'use strict';
// Where an agent finds the inputs another generative page accepts (AB#6247727). The platform shows no list of a page's inputs, so passing `data` to a page
// was trial and error: a guessed key is dropped without a word. references/rules.md ("Page Input > What another page accepts") says where they are — the
// App Spec's `pages[].pageInput.data` for a page /app-builder built, and the page's own `pageInput` reads for any other page, read from a download — and how
// each kind is passed: a `pageInput.data` key in the call's `data`, record context (`pageInput.recordId`, `pageInput.entityName`) at the top level of the call.
// The planner and the page-builder point to it. These tests hold the text to what the plugin's own scripts do — the download command is a real one, it writes the
// page's source where the text says, and the App Spec declaration it names is the one the page manifest carries and a download restores — and to the page input
// the SDK generates: the subsection's example, run, gives its target every input it reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { generatedRuntimeTypes } = require('./helpers/generated-runtime-types.js');
const { VERBS } = require('../genpage.js');
const { pageFolderFiles } = require('../lib/genpage-sdk.js');
const { buildManifest } = require('../lib/page-manifest.js');

const PLUGIN = path.join(__dirname, '..', '..');
// Every document is read with its line ends normalized: a Windows checkout gives it CRLF (git's core.autocrlf), and the command and the example are found by LF
// patterns — the code fences, the subsection's end — and the example is split into lines.
const read = (...parts) => fs.readFileSync(path.join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n');
const RULES = read('references', 'rules.md');
const flat = (text) => text.replace(/\s+/g, ' ');

// The subsection, from its heading to the next heading of its level or above.
function subsection(text, heading) {
  const at = text.indexOf(heading);
  assert.ok(at >= 0, `rules.md has ${heading}`);
  const rest = text.slice(at + heading.length);
  return rest.slice(0, rest.search(/\n#{2,3} /));
}
const ACCEPTS = '### What another page accepts (read it before you pass it data)';

test('rules.md says where a page\u2019s inputs are, and that each kind travels in its own place: data keys in data, record context at the top level of the call', () => {
  const pageInput = RULES.slice(RULES.indexOf('## Page Input'), RULES.indexOf('## Special Patterns'));
  assert.ok(pageInput.includes(ACCEPTS), 'the subsection is in the Page Input section');
  const text = flat(subsection(RULES, ACCEPTS));
  assert.match(text, /The platform shows no list of the inputs a page takes\. A page's inputs are the values its own source reads from its `pageInput` prop, and they are of two kinds, which travel in different places of the `navigateTo` call/);
  assert.match(text, /\| `pageInput\.data\.<key>` \| a data key \| `data: \{ <key>: <value> \}` \|/);
  assert.match(text, /\| `pageInput\.recordId` \| record context \| `recordId: <the record's id>`, at the top level beside `pageId` — not in `data` \|/);
  assert.match(text, /\| `pageInput\.entityName` \| record context \| `entityName: "<the table's logical name>"`, at the top level — not in `data` \|/);
  assert.match(text, /its App Spec declares its data keys as `pages\[\]\.pageInput\.data` \(each key with its type\)\. The producing page declares the same keys in `navigatesTo\[\]\.data`\. `download-model-app\.js` writes both into the spec from the app's page manifest\. The spec declares no record context/);
  assert.match(text, /Then search `<working-dir>\/targets\/<target-page-id>\/page\.tsx` for `pageInput`, and write down each read with its path/);
  assert.match(text, /A read of `pageInput\.recordId` or `pageInput\.entityName` \(also `const \{ recordId, entityName \} = pageInput`\) is record context\. Pass both at the top level of the call/);
  assert.match(text, /Pass each input in the place the target reads it, with the same name: data keys in `data`, record context at the top level\. Do not move one into the other/);
  assert.match(text, /A page that reads neither kind takes no input: navigate to it with its `pageId` alone\./);
  // A target that reads only record context is not one that "takes no input", and its record context is not sent in `data`.
  assert.doesNotMatch(text, /Pass only the keys the target reads, with the same names, in `data`/);
  assert.doesNotMatch(text, /A page that reads no `pageInput` takes no input/);
});

test('the download the text gives is the page verb as it is: its flags are the verb\u2019s, and it writes the page\u2019s source as page.tsx in a folder named for the page', () => {
  const block = /```powershell\n([\s\S]*?)```/.exec(subsection(RULES, ACCEPTS));
  assert.ok(block, 'the subsection gives the command');
  const command = block[1].trim();
  assert.match(command, /^node "\$\{PLUGIN_ROOT\}\/scripts\/genpage\.js" download /);
  const flags = [...command.matchAll(/--([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(flags, ['env', 'page-id', 'output-directory']);
  for (const flag of flags) assert.ok(VERBS.download.known.includes(flag), `--${flag} is a flag of genpage.js download`);
  for (const flag of VERBS.download.required) assert.ok(flags.includes(flag), `--${flag} is required by genpage.js download, and given`);
  assert.match(command, /--output-directory '<working-dir>\/targets'/, 'a folder of its own, not the working directory');
  assert.ok(!/--app-id/.test(command), 'any page of the environment: no app to prove it is in');
  // What a download writes for a page (`<output-directory>/<page id>/…`): the page's source is page.tsx.
  const files = pageFolderFiles({ source: 'export default function P(){ return null; }', dataSources: [], conversation: [] });
  assert.equal(files['page.tsx'], 'export default function P(){ return null; }');
  assert.match(flat(subsection(RULES, ACCEPTS)), /Do not use the working directory, and record no base marker, because this is a read/);
});

test('the App Spec declaration the text names is the one the page manifest carries, so a download restores it', () => {
  const spec = {
    app: { name: 'Orders' }, solution: { publisherPrefix: 'contoso' },
    pages: [
      { key: 'list', name: 'Orders', navigatesTo: [{ targetKey: 'detail', data: { orderId: 'string' } }] },
      { key: 'detail', name: 'Order', pageInput: { data: { orderId: 'string' } }, directEntry: { behavior: 'selector' } },
    ],
  };
  const manifest = buildManifest(spec, new Map([['list', '00000000-0000-4000-8000-000000000001'], ['detail', '00000000-0000-4000-8000-000000000002']]));
  const detail = manifest.pages.find((p) => p.key === 'detail');
  assert.deepEqual(detail.pageInput, { data: { orderId: 'string' } });
  const list = manifest.pages.find((p) => p.key === 'list');
  assert.deepEqual(list.navigatesTo, [{ targetKey: 'detail', data: { orderId: 'string' } }]);
  assert.match(read('scripts', 'download-model-app.js'), /if \(m\.pageInput !== undefined\) p\.pageInput = m\.pageInput;/, 'a download writes the manifest\u2019s declaration into the spec');
});

test('the navigation rule, the planner and the page-builder send an agent to that subsection before it passes data to a page the plan does not build', () => {
  assert.match(flat(RULES), /\*\*Passing data to a page this plan does not build:\*\* first read the keys that page accepts — see \*\*Page Input > What another page accepts\*\*\. Never guess the names\./);
  assert.match(flat(RULES), /Never rely on `recordId` as the delivery channel for a custom ID\. This is how to write the pages of this plan; a page this plan does not build may already read `pageInput\.recordId` and `pageInput\.entityName`, and is called the way it reads them \(see \*\*Page Input > What another page accepts\*\*\)\./);
  const planner = flat(read('agents', 'genpage-planner.md'));
  assert.match(planner, /For a page that navigates to an existing page that this plan does not build \(a page of the chosen app, by its page id\), read what that page accepts before you plan the call\./);
  assert.match(planner, /write in the page's \*\*Interactions\*\* the target's page id, the exact `data` keys it reads \(each with the type it converts the value to\), and whether it reads record context \(`pageInput\.recordId`, `pageInput\.entityName`\), which the call passes at the top level, not in `data`\. If it reads neither, write that it takes no input\./);
  const builder = flat(read('agents', 'genpage-page-builder.md'));
  assert.match(builder, /When the target is a page that this plan does not build, pass what that page reads, in the place it reads it \(rules\.md \*\*Page Input > What another page accepts\*\*\): its `pageInput\.data` keys in `data`, and — only when it reads `pageInput\.recordId` or `pageInput\.entityName` — `recordId` and `entityName` at the top level of the call\. Never guessed names\./);
});

// What a target receives from a call, by the page input the SDK generates for a page: `PageInput` declares `recordId` and `entityName` beside `data`, and the rules'
// own navigation examples send record context at the top level of the options and custom values in `data` ("entityName and recordId arrive as props.pageInput";
// "arrives as props.pageInput.data on the target"). So each member of PageInput takes the option of its own name — this is that envelope, and nothing more.
function declaredPageInputMembers(runtimeTypes) {
  const body = /export interface PageInput \{([^}]*)\}/.exec(runtimeTypes);
  assert.ok(body, 'the generated types declare PageInput');
  return [...body[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}
const received = (members, options) => Object.fromEntries(members.filter((m) => options[m] !== undefined).map((m) => [m, options[m]]));

// The example of the subsection, run: its call, with `Xrm` and the caller's values stood in for, gives the options; the target's reads, run on the page input those
// options make, give what the target sees. The example is the rule in the small, so it must hold: what the target reads, the call supplies.
function runExample(members, rewriteCall = (call) => call) {
  const block = /```typescript\n([\s\S]*?)```/.exec(subsection(RULES, ACCEPTS));
  assert.ok(block, 'the subsection gives an example');
  const lines = block[1].split('\n');
  const split = lines.findIndex((line) => /^\/\/ So the caller/.test(line));
  assert.ok(split > 0, 'the example gives the target\u2019s reads, then the call');
  const reads = lines.slice(0, split).filter((line) => /^const \w+ = /.test(line));
  const call = rewriteCall(lines.slice(split + 1).join('\n'));
  let options = null;
  vm.runInNewContext(call, { Xrm: { Navigation: { navigateTo: (o) => { options = o; } } }, targetPageId: '11111111-0000-4000-8000-000000000001', selectedAccountId: '22222222-0000-4000-8000-000000000002' });
  assert.ok(options && options.pageType === 'generative', 'the example calls navigateTo for a generative page');
  const names = reads.map((line) => /^const (\w+) = /.exec(line)[1]);
  const pageInput = received(members, options);
  // Spread into an object of this realm: one made in the context has the context's own Object prototype, which a strict comparison tells apart.
  return { options, seen: { ...vm.runInNewContext(`(function () {\n${reads.join('\n')}\nreturn { ${names.join(', ')} };\n})()`, { pageInput }) } };
}

test('the example\u2019s call gives its target every input it reads — record context at the top level reaches pageInput.recordId and pageInput.entityName, as the generated PageInput declares; moved into data, it reaches nothing', async () => {
  const members = declaredPageInputMembers(await generatedRuntimeTypes(['contoso_item'], { prefix: 'page-inputs-docs-' }));
  assert.deepEqual([...members].sort(), ['data', 'entityName', 'recordId'], 'record context is a member of the page input itself, beside data');
  const { options, seen } = runExample(members);
  assert.deepEqual(seen, { accountId: '22222222-0000-4000-8000-000000000002', table: 'account', view: 'summary' }, 'every read of the target is supplied');
  assert.deepEqual(Object.keys(options.data), ['view'], 'record context is not in data');
  // The mistake the rule prevents: the same record context sent in `data`. The target reads it at the top level, so it gets nothing.
  const misplaced = runExample(members, (call) => call.replace('entityName: "account", recordId: selectedAccountId, data: { view: "summary" }', 'data: { view: "summary", entityName: "account", recordId: selectedAccountId }'));
  assert.deepEqual(misplaced.seen, { accountId: undefined, table: undefined, view: 'summary' });
});

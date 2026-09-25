const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'validate-icon-imports.js');

// Run the hook as a child process with a JSON stdin payload (its real entry
// shape). Returns { status, stderr }.
function runHook(payload, env) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  return { status: res.status, stderr: res.stderr || '' };
}

// Write a temp .tsx file on disk (the hook reads the final on-disk content in
// PostToolUse) and return its path plus a Write tool payload.
function writeTemp(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function payloadFor(filePath, content, tool = 'Write') {
  const toolInput = tool === 'Write'
    ? { file_path: filePath, content }
    : { file_path: filePath, new_string: content };
  return { tool_name: tool, tool_input: toolInput, cwd: path.dirname(filePath) };
}

const GENPAGE_HEADER =
  "import * as React from 'react';\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;\n";

let tmp;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genpage-icons-'));
});
test.afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('valid verified icons in a genpage file pass (exit 0)', () => {
  const content = `import { AddRegular, DeleteRegular } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('hallucinated icon name in a genpage file is blocked (exit 2)', () => {
  const bad = 'TotallyMadeUpIconRegular';
  const content = `import { AddRegular, ${bad} } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, new RegExp(bad));
});

test('sized icon variant is rejected (unsized-only rule) (exit 2)', () => {
  const content = `import { Add24Regular } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /Add24Regular/);
});

test('`as` alias uses the source export name for validation', () => {
  const content = `import { DeleteRegular as Trash } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

// Regression guard: the generator (and samples 8/11) format long icon imports
// across multiple lines. The extractor's `{([^}]+)}` capture must span newlines,
// or a multi-line block would silently bypass validation.
test('multi-line verified icon import passes (exit 0)', () => {
  const content =
    "import {\n    AddRegular,\n    DeleteRegular,\n    EditRegular,\n} from '@fluentui/react-icons';\n" +
    GENPAGE_HEADER;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('hallucinated icon inside a multi-line import is blocked (exit 2)', () => {
  const bad = 'TotallyMadeUpIconRegular';
  const content =
    `import {\n    AddRegular,\n    ${bad},\n    DeleteRegular,\n} from '@fluentui/react-icons';\n` +
    GENPAGE_HEADER;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, new RegExp(bad));
});

test('a `//` comment inside a multi-line import does not hide the next bad icon (exit 2)', () => {
  // Regression: a `//` line leaves the following specifier starting with `//…`,
  // which used to fail the identifier test and be silently skipped (fail-open).
  const bad = 'FakeCommentHiddenRegular';
  const content =
    `import {\n    AddRegular, // a trailing comment\n    ${bad},\n} from '@fluentui/react-icons';\n` +
    GENPAGE_HEADER;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, new RegExp(bad));
});

test('a `//` comment inside a valid multi-line import still passes (exit 0)', () => {
  const content =
    `import {\n    AddRegular, // create\n    DeleteRegular, // remove\n} from '@fluentui/react-icons';\n` +
    GENPAGE_HEADER;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('a `}` inside a `//` comment does not truncate the import capture (exit 2)', () => {
  // Regression: a `}` in a comment used to end the `[^}]+` capture early, so the
  // whole import failed to match and every icon (incl. bad ones) slipped through.
  const bad = 'BraceCommentBypassRegular';
  const content =
    `import {\n    AddRegular, // note: shaped like {}\n    ${bad},\n} from '@fluentui/react-icons';\n` +
    GENPAGE_HEADER;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, new RegExp(bad));
});

test('non-genpage file is ignored even with a bad icon (exit 0)', () => {
  // No `export default GeneratedComponent` and no sibling genpage-plan.md.
  const content = "import { NotARealIconRegular } from '@fluentui/react-icons';\nexport const x = 1;\n";
  const fp = writeTemp(tmp, 'random.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('sibling genpage-plan.md opts a file into validation (exit 2 on bad icon)', () => {
  fs.writeFileSync(path.join(tmp, 'genpage-plan.md'), '# plan\n', 'utf8');
  const content = "import { NotARealIconRegular } from '@fluentui/react-icons';\nexport const x = 1;\n";
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /NotARealIconRegular/);
});

// /app-builder's generate-pages phase emits the same generated pages. Its plan marker opts a
// page in; `app-spec.json` deliberately does NOT, because this hook BLOCKS (exit 2) and the
// plugin installs globally — a generic filename would block legitimate writes in unrelated
// repos. Real app-builder pages are still covered by the GeneratedComponent content marker.
test('sibling model-app-plan.md (app-builder) opts a file into validation (exit 2 on bad icon)', () => {
  fs.writeFileSync(path.join(tmp, 'model-app-plan.md'), '# plan\n', 'utf8');
  const content = "import { NotARealIconRegular } from '@fluentui/react-icons';\nexport const x = 1;\n";
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /NotARealIconRegular/);
});

test('sibling app-spec.json alone does NOT opt a file in (generic name, blocking hook) (exit 0)', () => {
  fs.writeFileSync(path.join(tmp, 'app-spec.json'), '{}\n', 'utf8');
  const content = "import { NotARealIconRegular } from '@fluentui/react-icons';\nexport const x = 1;\n";
  const fp = writeTemp(tmp, 'page.tsx', content);
  assert.equal(runHook(payloadFor(fp, content)).status, 0);
});

test('an app-builder generated page IS validated via the GeneratedComponent content marker (exit 2)', () => {
  // No sibling marker at all — the content marker alone must still opt the page in, which is
  // why dropping app-spec.json from the sibling list loses no real app-builder coverage.
  const content = "import { NotARealIconRegular } from '@fluentui/react-icons';\n"
    + 'const GeneratedComponent = () => null;\nexport default GeneratedComponent;\n';
  const fp = writeTemp(tmp, 'overview.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /NotARealIconRegular/);
});

test('non-tsx file is ignored (exit 0)', () => {
  const content = "import { NotARealIconRegular } from '@fluentui/react-icons';\n";
  const fp = writeTemp(tmp, 'notes.md', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('non-write tool is ignored (exit 0)', () => {
  const { status } = runHook({ tool_name: 'Read', tool_input: { file_path: 'x.tsx' } });
  assert.equal(status, 0);
});

test('file with no @fluentui/react-icons imports passes (exit 0)', () => {
  const content = `import * as React from 'react';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('namespace icon imports are blocked because member access cannot be verified safely (exit 2)', () => {
  const content = `import * as Icons from '@fluentui/react-icons';\n${GENPAGE_HEADER}\nconst x = <Icons.TotallyMadeUpIconRegular />;\n`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /namespace/);
  assert.match(stderr, /@fluentui\/react-icons/);
});

test('unsupported static icon imports are blocked at code-token boundaries and in combined clauses (exit 2)', () => {
  for (const [kind, line, expected] of [
    ['namespace', 'import React from "react"; import * as Icons from "@fluentui/react-icons";', /namespace/],
    ['default plus namespace', 'import DefaultIcon, * as Icons from "@fluentui/react-icons";', /default|namespace/],
    ['default plus named', 'import DefaultIcon, { AddRegular } from "@fluentui/react-icons";', /default/],
  ]) {
    const content = `${line}\n${GENPAGE_HEADER}\nconst x = Icons && DefaultIcon;\n`;
    const fp = writeTemp(tmp, 'page.tsx', content);
    const { status, stderr } = runHook(payloadFor(fp, content));
    assert.equal(status, 2, kind);
    assert.match(stderr, expected, kind);
  }
});

test('default icon imports are blocked because the verified list contains named exports only (exit 2)', () => {
  const content = `import Icons from '@fluentui/react-icons';\n${GENPAGE_HEADER}\nconst x = <Icons.AddRegular />;\n`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /default/);
  assert.match(stderr, /@fluentui\/react-icons/);
});

test('CommonJS icon imports are blocked because they bypass named import validation (exit 2)', () => {
  const content = `const Icons = require('@fluentui/react-icons');\n${GENPAGE_HEADER}\nconst x = <Icons.AddRegular />;\n`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status, stderr } = runHook(payloadFor(fp, content));
  assert.equal(status, 2);
  assert.match(stderr, /CommonJS/);
  assert.match(stderr, /@fluentui\/react-icons/);
});

// Member access through an inline require or a dynamic import reaches an icon without any import
// declaration at all, so these are matched wherever they appear.
test('require and dynamic import block on the icon module argument before trailing commas or options (exit 2)', () => {
  for (const [kind, line] of [
    ['CommonJS', 'const Icons = require("@fluentui/react-icons",);'],
    ['dynamic import', 'const Icons = await import("@fluentui/react-icons",);'],
    ['dynamic import', 'const Icons = await import("@fluentui/react-icons", {});'],
  ]) {
    const content = `${GENPAGE_HEADER}\n${line}\n`;
    const fp = writeTemp(tmp, 'page.tsx', content);
    const { status, stderr } = runHook(payloadFor(fp, content));
    assert.equal(status, 2, `${kind}: ${line}`);
    assert.match(stderr, new RegExp(kind), kind);
  }
});

test('inline require and dynamic import() of the icon module are blocked too (exit 2)', () => {
  for (const [kind, line] of [
    ['CommonJS', "const x = React.createElement(require('@fluentui/react-icons').TotallyMadeUpIconRegular);"],
    ['dynamic import', "const Icons = await import(\"@fluentui/react-icons\");\nconst y = <Icons.TotallyMadeUpIconRegular />;"],
    ['dynamic import', 'const Icons = await import(`@fluentui/react-icons`);'],
    ['CommonJS', 'const Icons = require(`@fluentui/react-icons`);'],
  ]) {
    const content = `${GENPAGE_HEADER}\n${line}\n`;
    const fp = writeTemp(tmp, 'page.tsx', content);
    const { status, stderr } = runHook(payloadFor(fp, content));
    assert.equal(status, 2, kind);
    assert.match(stderr, new RegExp(kind), kind);
  }
  // CONTROL: other modules may still be required or imported dynamically.
  const content = `${GENPAGE_HEADER}\nconst lib = await import('./helpers');\nconst other = require('some-lib');\n`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  assert.equal(runHook(payloadFor(fp, content)).status, 0);
});

// Only a keyword in code is an import: one quoted in help text, a template or a comment is data.
test('an icon import merely quoted in a string, template or comment does not block the write (exit 0)', () => {
  for (const line of [
    'const help = "Never write require(\'@fluentui/react-icons\') in a page";',
    'const tip = `Use named imports, not import("@fluentui/react-icons")`;',
    '/* import * as Icons from "@fluentui/react-icons"; */',
    'const snippet = `\nimport * as Icons from "@fluentui/react-icons";\n`;',
    // …a NAMED import line quoted in a help template too: its icon name is data, not an import to verify.
    'const help = `\nimport { TotallyMadeUpIconRegular } from "@fluentui/react-icons";\n`;',
  ]) {
    const content = `${GENPAGE_HEADER}\n${line}\n`;
    const fp = writeTemp(tmp, 'page.tsx', content);
    const { status, stderr } = runHook(payloadFor(fp, content));
    assert.equal(status, 0, `${line}\n${stderr}`);
  }
  // CONTROL: the same call as code inside a template's ${…} is executable, and still blocked.
  const content = `${GENPAGE_HEADER}\nconst x = \`\${require('@fluentui/react-icons').FakeRegular}\`;\n`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  assert.equal(runHook(payloadFor(fp, content)).status, 2);
});

// A comment BETWEEN an import's tokens is still an import. The patterns run on a copy with comments
// blanked to spaces, so they match across one, and a `//` inside a string is not taken for one.
test('a comment inside an unsupported icon import does not get it past the hook (exit 2)', () => {
  for (const [kind, line] of [
    ['namespace', 'import * as /* every icon */ Icons from "@fluentui/react-icons";'],
    ['default', 'import Icons // all of them\n  from "@fluentui/react-icons";'],
    ['CommonJS', 'const Icons = require(/* icons */ "@fluentui/react-icons");'],
    // A comment inside `${…}` is a comment too: the lexer reports it like any other.
    ['dynamic import', 'const s = `${(await import(/* lazy */ "@fluentui/react-icons")).X}`;'],
  ]) {
    const content = `${line}\n${GENPAGE_HEADER}`;
    const fp = writeTemp(tmp, 'page.tsx', content);
    const { status, stderr } = runHook(payloadFor(fp, content));
    assert.equal(status, 2, `${kind}: ${line}`);
    assert.match(stderr, new RegExp(kind), kind);
  }
  // CONTROL: a URL in a string is not a comment, and an ordinary page still passes.
  const content = `${GENPAGE_HEADER}\nconst docs = "https://contoso.example/icons";\n`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  assert.equal(runHook(payloadFor(fp, content)).status, 0);
});

// Defence in depth: should the lexer ever throw, the hook falls back to comment-stripped matching and
// still blocks — it must not fail open. A `-r` preload swaps in a lexer that throws.
test('if the lexer throws, the hook falls back and still blocks an unsupported import (exit 2)', () => {
  const lexer = require.resolve('../lib/source-literals.js');
  const stub = path.join(tmp, 'throwing-lexer.js');
  fs.writeFileSync(stub, [
    `const lexer = ${JSON.stringify(lexer)};`,
    'require(lexer);',
    "require.cache[lexer].exports = { ...require.cache[lexer].exports, blankNonCodePreservingTemplateExpressions() { throw new Error('lexer failure'); } };",
  ].join('\n'));
  const runWithBrokenLexer = (content) => {
    const fp = writeTemp(tmp, 'page.tsx', content);
    return spawnSync(process.execPath, ['-r', stub, HOOK], { input: JSON.stringify(payloadFor(fp, content)), encoding: 'utf8' });
  };
  const blocked = runWithBrokenLexer(`import * as Icons from '@fluentui/react-icons';\n${GENPAGE_HEADER}`);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /namespace/);
  // CONTROL: the fallback still ignores a commented-out import rather than blocking everything.
  const commented = runWithBrokenLexer(`/* import * as Icons from '@fluentui/react-icons'; */\n${GENPAGE_HEADER}`);
  assert.equal(commented.status, 0, commented.stderr);
  // …and still verifies a real NAMED import: an unverified icon is blocked without the lexer too.
  const named = runWithBrokenLexer(`import { TotallyMadeUpIconRegular } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`);
  assert.equal(named.status, 2, named.stderr);
});

test('commented-out import (line comment) is not treated as a real import (exit 0)', () => {
  const content = `// import { TotallyMadeUpIconRegular } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('block-commented import is not treated as a real import (exit 0)', () => {
  const content = `/* import { TotallyMadeUpIconRegular } from '@fluentui/react-icons'; */\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content));
  assert.equal(status, 0);
});

test('MODEL_APPS_DISABLE_HOOKS=1 disables the validator (exit 0 despite bad icon)', () => {
  const content = `import { TotallyMadeUpIconRegular } from '@fluentui/react-icons';\n${GENPAGE_HEADER}`;
  const fp = writeTemp(tmp, 'page.tsx', content);
  const { status } = runHook(payloadFor(fp, content), { MODEL_APPS_DISABLE_HOOKS: '1' });
  assert.equal(status, 0);
});

test('unparseable stdin does not block (exit 0)', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(res.status, 0);
});

// Corpus: every committed sample the page builder is pointed at must pass this hook. A sample is a
// pattern agents copy, so one importing an icon the hook rejects (a sized variant such as
// `CheckmarkCircle20Filled` once shipped) teaches the exact write the hook then blocks. A plain
// directory listing, not `git ls-files`: nothing transient is ever written to samples/, and the test
// must not skip itself outside a git checkout.
test('every committed sample page passes the icon hook', () => {
  const samples = path.join(__dirname, '..', '..', 'samples');
  const files = fs.readdirSync(samples).filter((f) => f.endsWith('.tsx'));
  assert.ok(files.length > 0, 'the corpus is not empty');
  for (const name of files) {
    const fp = path.join(samples, name);
    const content = fs.readFileSync(fp, 'utf8');
    const { status, stderr } = runHook(payloadFor(fp, content));
    assert.equal(status, 0, `samples/${name} is blocked by the hook:\n${stderr}`);
  }
});

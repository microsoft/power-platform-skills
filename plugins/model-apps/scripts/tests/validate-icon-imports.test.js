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

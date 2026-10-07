'use strict';

// Regression guard for npm tool acquisition. `npx <tool>` without `--no-install` downloads and
// runs a registry package whenever the tool is not installed locally, and a workspace `.npmrc`
// decides which registry serves it. Every runnable `npx` in this plugin must therefore be
// `npx --no-install …`, apart from the developer-run commands in USER_RUN.
//
// "Runnable" means any line of a script or config (.js/.cjs/.mjs/.sh/.json), a command line in a
// fenced code block, or an inline code span — unless an explicit prohibition comes first in the
// same clause: "Never run `npx expo install`" names a command to avoid, while
// "If the tool is not installed, run `npx foo`" is an instruction and fails this test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const testsDir = path.join(pluginRoot, 'scripts', 'tests');

// Developer-run examples retained in the legacy template documentation; no
// operational skill executes these acquisition or floating-upgrade commands.
const USER_RUN = [
  ['template/README.md', 'npx degit microsoft/power-platform-skills/plugins/mobile-apps/template#main'],
  ['template/README.md', 'npx --package @microsoft/power-apps-native-host@latest'],
  ['template/CUSTOMIZATION.md', 'npx --package @microsoft/power-apps-native-host@latest'],
];

const BARE_NPX = /\bnpx\s+(?!--no-install\b)/g;
// Explicit prohibitions only: a bare "not" would also waive conditions such as
// "If the tool is not installed, run `npx foo`".
const NEGATION = /\b(?:never|(?:do|must|should)\s+not|don['’]t)\b/i;

// Only the clause before a match decides whether it is a prohibition, so
// "Do not edit it; run `npx foo`" still counts as an instruction.
function isProhibited(line, index) {
  return NEGATION.test(line.slice(0, index).split(/[.;:!?](?=[\s*]|$)/).pop());
}

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests quote bare `npx` inside assertion regexes; installed packages are not plugin content.
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || full === testsDir) continue;
      files.push(...listFiles(full));
    } else if (/\.(?:md|js|cjs|mjs|sh|json)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function findBareNpx(text, isMarkdown) {
  const hits = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, index) => {
    // Scripts and configs have no fences or code spans, and any line can build a command string
    // such as execSync('npx some-tool'), so scan every line in full.
    if (!isMarkdown) {
      if ([...line.matchAll(BARE_NPX)].some((match) => !isProhibited(line, match.index))) {
        hits.push({ line: index + 1, text: line.trim() });
      }
      return;
    }
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      // Comment lines explain commands rather than run them.
      if (/^\s*(?:#|\/\/)/.test(line)) return;
      const code = line.replace(/\s#.*$/, '');
      if ([...code.matchAll(BARE_NPX)].some((match) => !isProhibited(code, match.index))) {
        hits.push({ line: index + 1, text: line.trim() });
      }
      return;
    }
    for (const span of line.matchAll(/`([^`]*)`/g)) {
      if (span[1].match(BARE_NPX) && !isProhibited(line, span.index)) {
        hits.push({ line: index + 1, text: line.trim() });
      }
    }
  });
  return hits;
}

test('bare-npx detector flags instructions and fenced commands, not prohibitions', () => {
  const sample = [
    'Run `npx foo lint` after edits.',
    'Never run `npx expo install`. Do not use `npx --yes`.',
    'Do not edit it; run `npx baz`.',
    'If the tool is not installed, run `npx qux`.',
    'Run `npx --no-install tsc --noEmit` first.',
    '```bash',
    '# npx in a comment is fine',
    'npx bar --flag',
    'npx --no-install expo export',
    '1. Read-only parse (NEVER run npm/npx against target)',
    '```',
  ].join('\n');
  assert.deepEqual(findBareNpx(sample, true).map((hit) => hit.line), [1, 3, 4, 8]);
});

test('bare-npx detector scans whole lines of scripts', () => {
  const script = [
    "execSync('npx untrusted-tool');",
    "execSync('npx --no-install tsc --noEmit');",
    '// Never shell out to npx tools here.',
    '"lint": "npx eslint ."',
  ].join('\n');
  assert.deepEqual(findBareNpx(script, false).map((hit) => hit.line), [1, 4]);
});

test('plugin content never runs npx without --no-install', () => {
  const offenders = [];
  for (const file of listFiles(pluginRoot)) {
    const relPath = path.relative(pluginRoot, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    for (const hit of findBareNpx(text, relPath.endsWith('.md'))) {
      const bareNpxCount = [...hit.text.matchAll(BARE_NPX)].length;
      const allowed = bareNpxCount === 1 && USER_RUN.some(
        ([allowedFile, command]) => allowedFile === relPath && hit.text.startsWith(command),
      );
      if (!allowed) offenders.push(`${relPath}:${hit.line}: ${hit.text}`);
    }
  }
  assert.deepEqual(offenders, [], `Use \`npx --no-install\` (or $PA) for:\n${offenders.join('\n')}`);

  // Keep the exception list honest: drop an entry once its command is gone.
  for (const [file, command] of USER_RUN) {
    assert.ok(fs.readFileSync(path.join(pluginRoot, file), 'utf8').includes(command), `${file} no longer has ${command}`);
  }
});

'use strict';
// /genpage's commands are run by an AI that substitutes each `<…>` placeholder as TEXT, then hands the line to
// PowerShell or bash. A double-quoted value was expanded before the script ran (`"Revenue $100"` arrived as
// `Revenue `, and a `$` in a parent folder's name changed the path), and a bare one split on a space
// (`--code-file D:\Work Projects\…` became two arguments). So every `<…>` value in a command template is
// single-quoted — the rule stated once under "Instructions" in skills/genpage/SKILL.md. Nothing executes these
// templates in a test, so without this a template could drift back unseen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'skills', 'genpage');
const FILES = ['SKILL.md', 'edit-flow.md', 'verify-flow.md'];

// The command text of a skill document, line by line:
//   - every line of a ```powershell / ```bash block, except comments and the body of a single-quoted here-string
//     (`$prompt = @'` … `'@`), which is data, not command text;
//   - every inline code span, anywhere else (a ```markdown log format included), that starts like a command:
//     `--flag …`, `node …`, `pac …`, or a lowercase command word followed by a flag, a placeholder, a quote, a `$` or
//     a path (`mkdir -p <folder-name>`, `upload --page-id <id>`). JSON examples (`{ "intent": "<need>" }`), a
//     `key: value` snippet and prose (`Replaced PAGEREF_<name> tokens`) are not commands.
function commandText(text) {
  const out = [];
  let fence = null;
  let hereString = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const open = /^\s*```(\w*)/.exec(line);
    if (open) { fence = fence === null ? (open[1] || 'plain') : null; hereString = false; return; }
    if (fence !== null && /^(powershell|pwsh|bash|sh)$/.test(fence)) {
      if (hereString) { if (/^\s*'@/.test(line)) hereString = false; return; }
      if (/@'\s*$/.test(line)) hereString = true;
      if (!/^\s*#/.test(line)) out.push({ n: i + 1, code: line });
      return;
    }
    for (const m of line.matchAll(/`((?:--|node |pac |[a-z][\w.-]*\s+[-<'"$./\\])[^`]*)`/g)) out.push({ n: i + 1, code: m[1] });
  });
  return out;
}

test('every <…> value in a /genpage command template is single-quoted, never double-quoted or bare', () => {
  const bad = [];
  for (const f of FILES) {
    for (const { n, code } of commandText(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
      if (/"@?<[^"]*>[^"]*"/.test(code)) bad.push(`${f}:${n}: double-quoted: ${code.trim()}`);
      else if (/(?:^|[\s(])<[A-Za-z][^<>'"\s]*>/.test(code)) bad.push(`${f}:${n}: bare: ${code.trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});

// Free text reaches a script only through a file the skill writes with its file tool. A here-string in a command block
// would carry it as code: a single-quoted one ends at a line that begins with `'@` (or `‘@`, `’@`), and the rest of that
// line runs — so no command block may open one.
test('no /genpage command block carries text in a here-string', () => {
  const bad = [];
  for (const f of FILES) {
    let fence = null;
    fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const open = /^\s*```(\w*)/.exec(line);
      if (open) { fence = fence === null ? (open[1] || 'plain') : null; return; }
      if (fence !== null && /^(powershell|pwsh|bash|sh)$/.test(fence) && /@['"\u2018\u2019\u201c\u201d]\s*$|<<-?\s*['"]?\w+['"]?\s*$/.test(line)) {
        bad.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('the command-text reader sees what it guards', () => {
  const doc = [
    '```powershell',
    '# a comment with "<x>" is not a command',
    "$prompt = @'",
    'Build a page for "<customer>" and <orders>',
    "'@",
    'node x.js --plan "<working-dir>/plan.md"',
    'node x.js --code-file <working-dir>/a.tsx',
    "node x.js --file '<working-dir>/a.tsx'",
    '```',
    'Prose `--connectors "<working-dir>/c.json"` and a JSON example `{ "intent": "<need>" }`.',
    'Make it: `mkdir -p <folder-name>`, then `upload --page-id \'<id>\'`; not commands: `pageId: "PAGEREF_<x>"`, `Replaced PAGEREF_<name> tokens`.',
    '```markdown',
    "- Command: `node x.js --env '<org-url>'`",
    '```',
  ].join('\n');
  assert.deepEqual(commandText(doc).map((c) => c.code.trim()), [
    "$prompt = @'",
    'node x.js --plan "<working-dir>/plan.md"',
    'node x.js --code-file <working-dir>/a.tsx',
    "node x.js --file '<working-dir>/a.tsx'",
    '--connectors "<working-dir>/c.json"',
    'mkdir -p <folder-name>',
    "upload --page-id '<id>'",
    "node x.js --env '<org-url>'",
  ]);
});

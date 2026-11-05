'use strict';
// Keeps CHANGELOG.md short, and the links at its end whole.
//
// WHY: the file promises, in its own header, entries that are "deliberately short: what changed and why it
// matters to you", and AGENTS.md (Documentation Map) puts the reasoning, the evidence and the trade-offs in
// the PR and in docs/. Nothing held the file to that promise, and it grew to some 180 KB, one release alone
// near 9,000 words: more than a reader looking for "what changed for me" will read. This test makes the
// promise a rule:
//   * a release entry holds at most 300 words, from its `## ` heading (counted) to the next one;
//   * a bullet holds at most 45 words, its marker and its continuation lines included.
// A word is a whitespace-separated token, the unit the limits were set in: `--allow-lossy-download` is one
// word, and so is a bullet's `-`. Link reference definitions (`[#680]: https://...`) are not counted. The
// older entries have unbracketed headings (`## 2.4.1`, `## 2.0.0 - 2026-05-12`), so every level-2 heading
// starts an entry, not only `## [x.y.z]`; the header above the first one is not an entry.
//
// It also keeps the link reference definitions honest. The file keeps them in one block at its end, far
// from the text that uses them, so a slip there is easy to miss: a `[#nnn]` with no definition renders as
// literal brackets, a definition nothing uses is dead weight, and a label defined twice silently uses the
// first definition. See https://spec.commonmark.org/0.31.2/#link-reference-definitions
// A bracketed version heading (`## [2.20.0]`) is a reference only if a definition exists: Keep a Changelog
// brackets version headings whether or not it links them (https://keepachangelog.com/en/1.1.0/).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');
const MAX_ENTRY_WORDS = 300;
const MAX_BULLET_WORDS = 45;

// CommonMark line shapes, read one line at a time (https://spec.commonmark.org/0.31.2/):
//   ATX heading           `## [2.20.0]`, `### Fixed` (up to three spaces of indent, then 1-6 `#`)
//   definition            `[#680]: https://github.com/...` (a label, a colon, then a destination)
//   fence                 three or more backticks or tildes; nothing inside is read as Markdown. A fence
//                         may be indented: inside a list item it sits at the item's content column.
//   thematic break        `---`, `***`, `- - -`
//   list item             `- text`, `* text`, `+ text`, `1. text`, `1) text`
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*\S/;
const FENCE = /^([ \t]*)(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
// A line indented at least two columns belongs to the list item above it (its content starts after `- `).
const INDENTED = /^(?: {2,}|\t)/;

const countWords = (text) => text.split(/\s+/).filter(Boolean).length;
// Labels match case-insensitively, with inner white space collapsed (CommonMark "matching" of labels).
const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
const preview = (text) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}...` : flat;
};

// Code spans hold literal text: `[#nnn]` or `personas[]` inside backticks is no link. Blank each span out
// with spaces, keeping newlines, so the offsets of what is left still map to their lines. A span opens and
// closes with backtick runs of the same length and may cross a line break.
const blankCodeSpans = (text) => text.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => span.replace(/[^\n]/g, ' '));

// Bracketed labels in prose, as CommonMark reads them:
//   [text](url)    inline link: no reference
//   [text][label]  full reference: `label`
//   [label][]      collapsed reference: `label`
//   [label]        shortcut reference: `label`
//   \[text]        escaped: no reference
function labelsIn(text) {
  const found = [];
  for (const match of text.matchAll(/(\\?)!?\[([^\[\]]+)\](?:(\()|\[([^\[\]]*)\])?/g)) {
    if (match[1] || match[3]) continue;
    found.push({ label: match[4] ? match[4] : match[2], index: match.index });
  }
  return found;
}

function parseChangelog(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries = [];
  const definitions = [];
  const prose = [];
  const headingLabels = [];
  let entry = null;
  let bullet = null;
  let afterBlank = false;
  let fence = null;

  // Adds a line to the bullet that owns it: its words count toward the bullet's limit.
  const extend = (item, line) => {
    item.text += ` ${line.trim()}`;
    item.words += countWords(line);
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (fence) {
      // A line indented less than the list item ends the item, and with it a fence the item held but did not
      // close (CommonMark closes a container's open blocks with it); that line is then read as usual.
      if (fence.owner && line.trim() && !INDENTED.test(line)) {
        fence = null;
        bullet = null;
      }
    }
    if (fence) {
      // Inside a fence nothing is Markdown, but every word still counts: toward the entry, and toward the
      // list item when the fence is part of one (an indented example under a bullet). Without that, a code
      // block inside a bullet would carry any number of words past the bullet limit.
      if (entry) entry.words += countWords(line);
      if (fence.owner) extend(fence.owner, line);
      if (new RegExp(`^[ \\t]*${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}[ \\t]*$`).test(line)) {
        bullet = fence.owner;
        fence = null;
        afterBlank = false;
      }
      return;
    }
    const opening = line.match(FENCE);
    if (opening) {
      // An indented fence under an open bullet is a block of that list item; an unindented one ends the list.
      const owner = bullet && INDENTED.test(line) ? bullet : null;
      fence = { marker: opening[2], owner };
      bullet = null;
      if (entry) entry.words += countWords(line);
      if (owner) extend(owner, line);
      return;
    }
    const definition = line.match(DEFINITION);
    if (definition) {
      definitions.push({ label: definition[1], line: lineNumber });
      bullet = null;
      return;
    }
    const heading = line.match(HEADING);
    if (heading && heading[1].length === 2) {
      entry = { heading: line.trim(), line: lineNumber, words: 0, bullets: [] };
      entries.push(entry);
    }
    if (entry) entry.words += countWords(line);
    if (heading) {
      for (const { label } of labelsIn(blankCodeSpans(line))) headingLabels.push({ label, line: lineNumber });
      bullet = null;
      afterBlank = false;
      return;
    }
    prose.push({ text: line, line: lineNumber });
    if (!line.trim()) {
      afterBlank = true;
      return;
    }
    if (THEMATIC_BREAK.test(line)) {
      bullet = null;
    } else if (LIST_ITEM.test(line)) {
      bullet = entry ? { line: lineNumber, text: line.trim(), words: countWords(line) } : null;
      if (bullet) entry.bullets.push(bullet);
    } else if (bullet && (!afterBlank || INDENTED.test(line))) {
      // A continuation line, or after a blank line an indented one: a list item's later paragraph.
      extend(bullet, line);
    } else {
      bullet = null;
    }
    afterBlank = false;
  });

  // Prose is scanned as one text so that a code span crossing a line break is still blanked out whole.
  const joined = blankCodeSpans(prose.map((p) => p.text).join('\n'));
  const starts = [];
  let offset = 0;
  for (const p of prose) {
    starts.push(offset);
    offset += p.text.length + 1;
  }
  const lineAt = (index) => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > index) i--;
    return prose[i].line;
  };
  const references = labelsIn(joined).map(({ label, index }) => ({ label, line: lineAt(index) }));
  return { entries, definitions, references, headingLabels };
}

const nameOf = (entry) => entry.heading.replace(/^#+\s*/, '');

function limitProblems(parsed) {
  const entries = parsed.entries
    .filter((e) => e.words > MAX_ENTRY_WORDS)
    .map((e) => `${nameOf(e)} (line ${e.line}): ${e.words} words, over the ${MAX_ENTRY_WORDS} a release entry may hold`);
  const bullets = parsed.entries.flatMap((e) => e.bullets
    .filter((b) => b.words > MAX_BULLET_WORDS)
    .map((b) => `${nameOf(e)} (line ${b.line}): a bullet of ${b.words} words, over ${MAX_BULLET_WORDS}: "${preview(b.text)}"`));
  return { entries, bullets };
}

function referenceProblems(parsed) {
  const problems = [];
  const defined = new Map();
  for (const d of parsed.definitions) {
    const key = normalizeLabel(d.label);
    if (defined.has(key)) problems.push(`[${d.label}] (line ${d.line}): defined again; line ${defined.get(key).line} already defines it`);
    else defined.set(key, d);
  }
  const used = new Set();
  for (const r of parsed.references) {
    const key = normalizeLabel(r.label);
    if (defined.has(key)) used.add(key);
    else problems.push(`[${r.label}] (line ${r.line}): no link reference definition; add one to the block at the end of the file, or escape the brackets`);
  }
  for (const h of parsed.headingLabels) if (defined.has(normalizeLabel(h.label))) used.add(normalizeLabel(h.label));
  for (const [key, d] of defined) if (!used.has(key)) problems.push(`[${d.label}] (line ${d.line}): defined but never used; remove it`);
  return problems;
}

const parsed = parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'));

test('CHANGELOG.md: every release entry is at most 300 words (the detail belongs in the PR and in docs/)', () => {
  assert.ok(parsed.entries.length > 0, 'CHANGELOG.md has no `## ` release heading');
  const { entries } = limitProblems(parsed);
  assert.deepEqual(entries, [], `Release entries over ${MAX_ENTRY_WORDS} words:\n${entries.join('\n')}`);
});

test('CHANGELOG.md: every bullet is at most 45 words', () => {
  assert.ok(parsed.entries.some((e) => e.bullets.length > 0), 'CHANGELOG.md has no bullet');
  const { bullets } = limitProblems(parsed);
  assert.deepEqual(bullets, [], `Bullets over ${MAX_BULLET_WORDS} words:\n${bullets.join('\n')}`);
});

test('CHANGELOG.md: every [label] has a link reference definition, and every definition is used and defined once', () => {
  assert.ok(parsed.definitions.length > 0, 'CHANGELOG.md has no link reference definition');
  const problems = referenceProblems(parsed);
  assert.deepEqual(problems, [], `Link reference problems:\n${problems.join('\n')}`);
});

// The reader itself, on small texts, so a change to it cannot quietly make the checks above pass by reading
// less (no entries, no bullets, no references) than the file holds.
test('the reader: every level-2 heading starts an entry, bracketed or not; the header above the first is none', () => {
  const p = parseChangelog('# Changelog\n\nIntro words that belong to no entry.\n\n## [1.1.0]\n\n- one two\n\n## 1.0.0 \u2014 2026-01-01\n\n### Fixed\n\nText.\n');
  assert.deepEqual(p.entries.map((e) => [e.heading, e.line, e.words]), [['## [1.1.0]', 5, 5], ['## 1.0.0 \u2014 2026-01-01', 9, 7]]);
});

test('the reader: a bullet counts its marker and continuation lines, an indented later paragraph, and a nested item is a bullet of its own', () => {
  const text = [
    '## [1.0.0]',
    '',
    '- alpha beta',
    '  gamma',
    '  - nested one',
    '',
    '- second item',
    'lazily continued',
    '',
    '  another paragraph of it',
    '1. third',
    '',
    'A paragraph after the list.',
    '',
    '[#1]: https://example.com/1',
    '',
    '---',
    '',
  ].join('\r\n');
  const p = parseChangelog(text);
  assert.deepEqual(p.entries[0].bullets.map((b) => [b.line, b.words]), [[3, 4], [5, 3], [7, 9], [11, 2]]);
  // 2 (heading) + 4 + 3 + 9 + 2 + 5 (the paragraph) + 1 (`---`); the definition is not counted.
  assert.equal(p.entries[0].words, 26);
  assert.deepEqual(p.definitions, [{ label: '#1', line: 15 }]);
});

test('the reader: an entry over 300 words and a bullet over 45 are each reported with their entry and the start of the text', () => {
  const longBullet = `- ${Array.from({ length: 45 }, (_, i) => `w${i}`).join(' ')}`;
  const okBullet = `- ${Array.from({ length: 44 }, (_, i) => `w${i}`).join(' ')}`;
  const p = parseChangelog(['## [2.0.0]', '', longBullet, '', '## 1.0.0', '', okBullet, '', Array.from({ length: 254 }, () => 'x').join(' '), ''].join('\n'));
  assert.deepEqual(p.entries.map((e) => e.words), [48, 301]);
  const { entries, bullets } = limitProblems(p);
  assert.deepEqual(entries, ['1.0.0 (line 5): 301 words, over the 300 a release entry may hold']);
  assert.deepEqual(bullets, ['[2.0.0] (line 3): a bullet of 46 words, over 45: "- w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16..."']);
});

test('the reader: a reference is a [label] in prose, not in a code span, an inline link or an escape, and a version heading uses a definition only if one exists', () => {
  const text = [
    '## [2.0.0]',
    '',
    '- Uses [#1], `[#2]` and `personas[]` in code, [a link](https://example.com), [text][#3], [#4][] and \\[#5].',
    '- A span that crosses a line ``[#6]',
    '  still [code]`` here, and [#7] has no definition.',
    '',
    '## [1.0.0]',
    '',
    '[#1]: https://example.com/1',
    '[#3]: https://example.com/3',
    '[#4]: https://example.com/4',
    '[#8]: https://example.com/8',
    '[#1]: https://example.com/1-again',
    '[1.0.0]: https://example.com/compare',
  ].join('\n');
  const p = parseChangelog(text);
  assert.deepEqual(p.references.map((r) => [r.label, r.line]), [['#1', 3], ['#3', 3], ['#4', 3], ['#7', 5]]);
  assert.deepEqual(referenceProblems(p), [
    '[#1] (line 13): defined again; line 9 already defines it',
    '[#7] (line 5): no link reference definition; add one to the block at the end of the file, or escape the brackets',
    '[#8] (line 12): defined but never used; remove it',
  ]);
});

test('the reader: a fenced block inside a list item counts toward that bullet, and nothing in a fence is read as Markdown', () => {
  const text = [
    '## [99.0.0]',
    '',
    '- Migration example.',
    '  ```text',
    `  ${Array.from({ length: 45 }, (_, i) => `w${i}`).join(' ')}`,
    '  ```',
    '- Short item.',
    '',
    '  ~~~',
    '  - not a bullet',
    '  ## not a heading',
    '  [#9]: not a definition',
    '  see [#9]',
    '  ~~~',
    '',
  ].join('\n');
  const p = parseChangelog(text);
  // 3 (`- Migration example.`) + 2 fence lines + 45; and 3 + 2 fence lines + 14 for the block after the blank line.
  assert.deepEqual(p.entries[0].bullets.map((b) => [b.line, b.words]), [[3, 50], [7, 19]]);
  assert.equal(p.entries[0].words, 71);
  assert.equal(p.entries.length, 1);
  assert.deepEqual([p.definitions, p.references], [[], []]);
  const { bullets } = limitProblems(p);
  assert.equal(bullets.length, 1);
  assert.match(bullets[0], /^\[99\.0\.0\] \(line 3\): a bullet of 50 words, over 45: "- Migration example\. ```text w0 w1/);
});

test('the reader: an unindented fence is no part of the list above it, and a line indented less than an item closes a fence it left open', () => {
  const after = parseChangelog(['## [1.0.0]', '', '- item one', '```', 'code words here', '```', 'after the fence', ''].join('\n'));
  assert.deepEqual(after.entries[0].bullets.map((b) => [b.line, b.words]), [[3, 3]]);
  assert.equal(after.entries[0].words, 13);
  const open = parseChangelog(['## [1.0.0]', '', '- item', '  ```', '  code', '## 0.9.0', '', '- other', ''].join('\n'));
  assert.deepEqual(open.entries.map((e) => [e.heading, e.words, e.bullets.map((b) => [b.line, b.words])]), [
    ['## [1.0.0]', 6, [[3, 4]]],
    ['## 0.9.0', 4, [[8, 2]]],
  ]);
});

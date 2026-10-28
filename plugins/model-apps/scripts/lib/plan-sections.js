'use strict';
// The three Markdown primitives every reader of a genpage plan shares: one `## <heading>` section, the first table that has
// the named columns, and that table's rows. They lived in the eval harness (evals/model-apps/genpage/lib/plan-evidence.js,
// which re-exports them from here unchanged); the plugin's own plan readers need them too (lib/genpage-plan-semantics.js),
// and shipped code must not import an eval module.
//
// The shapes they read, from references/plan-schema.md:
//   ## Pages
//   | Page | File | Purpose | Entities |
//   |------|------|---------|----------|
//   | Account Overview | account-overview.tsx | Show account highlights | account |
//
// planSection(plan, 'Pages') is the text between that heading and the next `## ` heading, trimmed; the heading matches whatever
// its letter case, and only at level two — a `### Pages (2 total)` preview heading is not one (genpage-plan-semantics.js reads the
// preview's own levels). findMarkdownTable(text, ['Page', 'File']) is the first `| … |` line whose cells include every named
// column (letter case ignored) with the lines from it on; parseMarkdownRows(text, columns) is that table's rows below its
// delimiter row, keyed by the lower-cased header, up to the first line that is not a `| … |` row. An all-empty row is skipped.

function planSection(plan, heading) {
  if (!plan) return null;
  const lines = plan.split('\n');
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^##\\s+${escaped}\\s*$`, 'i');
  let i = 0;
  while (i < lines.length && !startRe.test(lines[i])) i++;
  if (i >= lines.length) return null;
  i++;
  const out = [];
  while (i < lines.length && !/^##\s/.test(lines[i])) out.push(lines[i++]);
  return out.join('\n').trim();
}

function findMarkdownTable(sectionText, requiredColumns) {
  const lines = sectionText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    const headers = lines[i].split('|').slice(1, -1).map((header) => header.trim().toLowerCase());
    if (requiredColumns.every((column) => headers.includes(column.toLowerCase()))) {
      return { lineIndex: i, headers, lines: lines.slice(i) };
    }
  }
  return null;
}

function parseMarkdownRows(sectionText, requiredColumns) {
  const table = findMarkdownTable(sectionText, requiredColumns);
  if (!table) return [];
  const rows = [];
  for (const line of table.lines.slice(2)) {
    if (!/^\s*\|.*\|\s*$/.test(line)) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 0 || cells.every((cell) => cell === '')) continue;
    const row = {};
    for (let i = 0; i < table.headers.length; i++) row[table.headers[i]] = cells[i] || '';
    rows.push(row);
  }
  return rows;
}

module.exports = { planSection, findMarkdownTable, parseMarkdownRows };

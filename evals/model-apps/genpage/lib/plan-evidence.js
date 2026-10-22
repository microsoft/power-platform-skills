'use strict';

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

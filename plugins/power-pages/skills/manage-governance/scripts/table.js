#!/usr/bin/env node

// table.js — Shared fixed-width and Markdown table primitives used by the render-*
// scripts (render-env-table.js, render-portal-table.js). These two helpers were
// previously copy-pasted verbatim into each renderer; keeping one definition
// avoids the two drifting apart (a padding/border off-by-one in one but not the
// other would silently misalign only some tables).
//
// The fixed-width helpers assume ASCII / single-width cells. ANSI color escapes
// are zero-width, so callers must compute widths on the *visible* (uncolored)
// text and apply color AFTER padding — see render-portal-table.js.

// Right-pad an ASCII string to a fixed visible width. Null/undefined render as
// empty; never truncates (a cell wider than `width` is returned unchanged, so
// the border math in `border()` still lines up because widths are derived from
// the same cell values).
function pad(str, width) {
  const s = String(str == null ? '' : str);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

// Build one horizontal border line from the per-column visible widths. `fill`
// is the run character (default '-' for the ASCII '+---+' frame; pass '─' for
// the Unicode box). Each column is padded by +2 to match the single space of
// left/right cell padding the row renderers add around every value.
function border(widths, left, mid, right, fill) {
  const f = fill || '-';
  return left + widths.map((w) => f.repeat(w + 2)).join(mid) + right;
}

// GFM rows cannot span physical lines, and a literal pipe starts another
// column. For example, "A|B\r\nPreview" must become "A\\|B Preview".
function markdownCell(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n|[\r\n\u2028\u2029]/g, ' ')
    .replace(/\|/g, '\\|');
}

function renderMarkdownTable(headers, rows) {
  const row = (cells) => '| ' + cells.map(markdownCell).join(' | ') + ' |';
  return [
    row(headers),
    row(headers.map(() => '---')),
    ...rows.map(row),
  ].join('\n');
}

module.exports = { pad, border, renderMarkdownTable };

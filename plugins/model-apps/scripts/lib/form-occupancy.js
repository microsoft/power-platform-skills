'use strict';
// One FormXML row-occupancy model shared by build and verify. Row-spanning cells reserve
// capacity in later rows, and the build must make the same calculation verify enforces so it
// never writes a layout that verify rejects. Raw shape in a two-column section:
//   rows: [a rowspan=2] / [b, c]
//   row 2: own 2 + reserved 1 (a) = 3 columns

function cellWidth(cell) {
  return Number(cell && cell.colspan) || 1;
}

function rowOccupancy(rows) {
  const occupancy = [];
  let carried = [];
  for (const row of rows || []) {
    const own = ((row && row.cells) || []).reduce((n, cell) => n + cellWidth(cell), 0);
    const reserved = carried.reduce((n, reservation) => n + reservation.width, 0);
    occupancy.push({ own, reserved, used: own + reserved });

    carried = carried
      .map((reservation) => ({ width: reservation.width, left: reservation.left - 1 }))
      .filter((reservation) => reservation.left > 0);
    for (const cell of ((row && row.cells) || [])) {
      const rowspan = Number(cell && cell.rowspan) || 1;
      if (rowspan > 1) carried.push({ width: cellWidth(cell), left: rowspan - 1 });
    }
  }
  return occupancy;
}

function fitsGrid(rows, width) {
  const gridWidth = Number(width);
  if (!Number.isFinite(gridWidth) || gridWidth < 1) return false;
  return rowOccupancy(rows).every((row) => row.used <= gridWidth);
}

// The rows a departing cell left holding nothing, as indexes into `rows` (the section's rows AFTER the
// cell was pruned or moved away), bottom-up so removing them in that order keeps every earlier index valid.
//
// A cell occupies its own row and, with rowspan r, a slot in each of the r - 1 rows beneath it. Any of
// those rows that now has no cell AND no slot reserved by a row-spanning cell still above it renders as
// a blank line. A row that is empty but still reserved is NOT blank: the span above occupies it, and
// deleting it would pull every row beneath it up under that span. In a 2-column section:
//   before:             [x, b rs2] / [c] / [d]
//   after c moves away: [x, b rs2] / []  / [d]    row 2 keeps b's reserved slot, so it stays
//   deleting row 2 instead gives [x, b rs2] / [d], which puts d beside b's span: a different layout.
// Only the rows this cell touched are considered, so an empty row that was already there stays.
function strandedRows(rows, rowIndex, span = 1) {
  const list = rows || [];
  const occupancy = rowOccupancy(list);
  const last = Math.min(list.length - 1, rowIndex + Math.max(1, Number(span) || 1) - 1);
  const stranded = [];
  for (let i = last; i >= rowIndex; i -= 1) {
    const cells = (list[i] && list[i].cells) || [];
    if (!cells.length && occupancy[i] && occupancy[i].reserved === 0) stranded.push(i);
  }
  return stranded;
}

module.exports = { rowOccupancy, fitsGrid, strandedRows };

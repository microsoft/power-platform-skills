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

// Column-slot occupancy: WHERE each cell of a section sits, not just how much of each row is used.
// A section lays its cells out as a table does: a cell takes the first free column of its row at or
// after the cell before it, a cell spanning rows reserves its columns in the rows beneath, and a later
// row's cells flow AROUND those reservations. In a 2-column section:
//   rows: [a rowspan=2, b] / [c]
//   grid: row 0 = a b, row 1 = a c     (c lands in column 1: column 0 is a's reservation)
// rowOccupancy only counts widths, so it cannot say that c sits beside a rather than under it; a
// declared layout that keeps a maker's cells fixed while it repacks its own needs exactly that.
//
// grid[r][c] is the index into `placed` of the cell covering that slot, or -1 when the slot is free.
// A cell that does not fit where the flow puts it (it would run past the grid, or onto a slot a span
// already covers) is listed in `overflow` instead of being placed; such a section renders
// unpredictably, so callers treat it as a layout they cannot reason about.
function slotGrid(rows, width) {
  const w = Math.max(1, Math.floor(Number(width)) || 1);
  const grid = [];
  const placed = [];
  const overflow = [];
  const rowAt = (r) => {
    while (grid.length <= r) grid.push(new Array(w).fill(-1));
    return grid[r];
  };
  const free = (r, c, span, rowspan) => {
    if (c + span > w) return false;
    for (let y = r; y < r + rowspan; y += 1) {
      for (let x = c; x < c + span; x += 1) if (rowAt(y)[x] !== -1) return false;
    }
    return true;
  };
  (rows || []).forEach((row, r) => {
    rowAt(r);
    let c = 0;
    ((row && row.cells) || []).forEach((cell, i) => {
      const span = cellWidth(cell);
      const rowspan = Math.max(1, Number(cell && cell.rowspan) || 1);
      while (c < w && grid[r][c] !== -1) c += 1;
      if (!free(r, c, span, rowspan)) {
        overflow.push({ row: r, cell: i });
        return;
      }
      for (let y = r; y < r + rowspan; y += 1) {
        for (let x = c; x < c + span; x += 1) grid[y][x] = placed.length;
      }
      placed.push({ row: r, cell: i, r, c, colspan: span, rowspan });
      c += span;
    });
  });
  return { width: w, grid, placed, overflow };
}

module.exports = { rowOccupancy, fitsGrid, strandedRows, slotGrid };

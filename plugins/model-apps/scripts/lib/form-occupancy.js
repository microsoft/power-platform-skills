'use strict';

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

module.exports = { rowOccupancy, fitsGrid };

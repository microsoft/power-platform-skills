'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rowOccupancy, fitsGrid, strandedRows } = require('../lib/form-occupancy.js');

test('rowOccupancy carries row-spanning reservations into later rows', () => {
  const rows = [
    { cells: [{ control: { fieldName: 'new_a' }, rowspan: 3, colspan: 2 }, { control: { fieldName: 'new_b' } }] },
    { cells: [{ control: { fieldName: 'new_c' } }] },
    { cells: [{ id: 'maker-spacer' }, { control: { fieldName: 'new_d' }, colspan: 2 }] },
    { cells: [{ control: { fieldName: 'new_e' } }] },
  ];

  assert.deepStrictEqual(rowOccupancy(rows), [
    { own: 3, reserved: 0, used: 3 },
    { own: 1, reserved: 2, used: 3 },
    { own: 3, reserved: 2, used: 5 },
    { own: 1, reserved: 0, used: 1 },
  ]);
});

test('fitsGrid counts spacers and carried reservations', () => {
  const rows = [
    { cells: [{ control: { fieldName: 'new_a' }, rowspan: 2 }] },
    { cells: [{ id: 'maker-spacer' }, { control: { fieldName: 'new_b' } }] },
  ];

  assert.strictEqual(fitsGrid(rows, 2), false);
  assert.strictEqual(fitsGrid(rows, 3), true);
});

// The rows a departing cell leaves holding nothing. `rows` is the section AFTER the cell left.
const f = (n, extra = {}) => ({ control: { fieldName: `new_${n}` }, ...extra });

test('strandedRows: the row a cell left empty, when nothing above reserves it', () => {
  // before: [a, b] / [c] / [d]   after d left: [a, b] / [c] / []
  assert.deepStrictEqual(strandedRows([{ cells: [f('a'), f('b')] }, { cells: [f('c')] }, { cells: [] }], 2, 1), [2]);
});

test('strandedRows: an emptied row that a span above still reserves is kept', () => {
  // [a rs2] / [] / [b, c]: row 2 holds a's reserved slot. Deleting it would pull [b, c] up beside a.
  assert.deepStrictEqual(strandedRows([{ cells: [f('a', { rowspan: 2 })] }, { cells: [] }, { cells: [f('b'), f('c')] }], 1, 1), []);
});

test('strandedRows: a departing span also frees the rows it covered, listed bottom-up', () => {
  // before: [a, b] / [d rs2] / []   after d left: [a, b] / [] / []
  assert.deepStrictEqual(strandedRows([{ cells: [f('a'), f('b')] }, { cells: [] }, { cells: [] }], 1, 2), [2, 1]);
});

test('strandedRows: a covered row that still holds a cell is kept', () => {
  assert.deepStrictEqual(strandedRows([{ cells: [f('a')] }, { cells: [] }, { cells: [f('c')] }], 1, 2), [1]);
});

test('strandedRows: an empty row outside the departing cell\'s rows is never touched', () => {
  // [a, b] / [] / [] where row 1 was ALREADY empty and the cell left row 2.
  assert.deepStrictEqual(strandedRows([{ cells: [f('a'), f('b')] }, { cells: [] }, { cells: [] }], 2, 1), [2]);
  // ...and below it: the cell left row 1 of [a] / [] / [] / [c], where row 2 was already empty.
  assert.deepStrictEqual(strandedRows([{ cells: [f('a')] }, { cells: [] }, { cells: [] }, { cells: [f('c')] }], 1, 1), [1]);
});

test('strandedRows: indexes past the end and a missing span are safe', () => {
  assert.deepStrictEqual(strandedRows([{ cells: [f('a')] }], 5, 1), []);
  assert.deepStrictEqual(strandedRows([{ cells: [] }], 0, undefined), [0]);
  assert.deepStrictEqual(strandedRows([{ cells: [] }], 0, 4), [0], 'a span running past the last row is clamped');
});

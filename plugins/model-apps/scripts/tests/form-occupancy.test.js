'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rowOccupancy, fitsGrid } = require('../lib/form-occupancy.js');

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

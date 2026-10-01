'use strict';
// planOrderMoves — the plan the build follows to put a form's tabs, and the sections of each
// form-column, into the layout's order (verify then requires that order).
//
// Proven exhaustively rather than by example: every arrangement of up to five ordered containers
// among up to two a layout does not mention, with each move applied exactly as the SDK's moveElement
// applies it (remove the source, THEN splice at the index), because a plan that is right against the
// pre-removal array is off by one against the real one.
const test = require('node:test');
const assert = require('node:assert');
const { planOrderMoves } = require('../lib/form-container-match.js');

// The SDK's moveElement on one array: remove first, then insert at `to` in the shortened array.
const applyMove = (list, { from, to }) => {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
};

const permutations = (items) => {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  items.forEach((item, i) => {
    for (const rest of permutations(items.slice(0, i).concat(items.slice(i + 1)))) out.push([item].concat(rest));
  });
  return out;
};

const longestIncreasing = (seq) => {
  const len = seq.map(() => 1);
  for (let i = 0; i < seq.length; i += 1) for (let j = 0; j < i; j += 1) if (seq[j] < seq[i]) len[i] = Math.max(len[i], len[j] + 1);
  return seq.length ? Math.max(...len) : 0;
};

test('planOrderMoves puts every arrangement in the layout\'s order, with the fewest moves', () => {
  let arrangements = 0;
  for (let wanted = 0; wanted <= 5; wanted += 1) {
    for (let extras = 0; extras <= 2; extras += 1) {
      const items = [];
      for (let w = 0; w < wanted; w += 1) items.push(`W${w}`);
      for (let x = 0; x < extras; x += 1) items.push(`X${x}`);
      for (const arrangement of permutations(items)) {
        arrangements += 1;
        const layout = items.filter((i) => i.startsWith('W'));
        const positions = layout.map((w) => arrangement.indexOf(w));
        const plan = planOrderMoves(positions);
        const list = arrangement.slice();
        for (const move of plan.moves) {
          assert.notStrictEqual(move.from, move.to, `a move that changes nothing is never planned: ${arrangement}`);
          applyMove(list, move);
        }
        const where = `${arrangement.join(',')} -> ${list.join(',')}`;
        assert.deepStrictEqual(list.filter((i) => i.startsWith('W')), layout, `the layout's order: ${where}`);
        assert.deepStrictEqual(plan.positions, layout.map((w) => list.indexOf(w)), `the reported final indices: ${where}`);
        assert.strictEqual(plan.moves.length, layout.length - longestIncreasing(positions), `only the containers out of the longest ordered run move: ${where}`);
        // A container the layout does not mention is never moved for its own sake, so the others'
        // relative order is untouched.
        assert.deepStrictEqual(list.filter((i) => i.startsWith('X')), arrangement.filter((i) => i.startsWith('X')), `extras keep their order: ${where}`);
        assert.deepStrictEqual(planOrderMoves(plan.positions).moves, [], `an ordered layout plans nothing: ${where}`);
      }
    }
  }
  assert.ok(arrangements > 5000, `the exhaustive sweep ran (${arrangements} arrangements)`);
});

test('planOrderMoves: examples, in the SDK\'s post-removal index space', () => {
  assert.deepStrictEqual(planOrderMoves([]), { moves: [], positions: [] });
  assert.deepStrictEqual(planOrderMoves([3]), { moves: [], positions: [3] });
  assert.deepStrictEqual(planOrderMoves([0, 2, 5]), { moves: [], positions: [0, 2, 5] }, 'gaps are a maker\'s own containers, not disorder');
  // [c, a, b] laid out as a, b, c: c moves once, after b.
  assert.deepStrictEqual(planOrderMoves([1, 2, 0]), { moves: [{ from: 0, to: 2 }], positions: [0, 1, 2] });
  // [b, c, a] laid out as a, b, c: a moves once, before b — the first container goes before the run.
  assert.deepStrictEqual(planOrderMoves([2, 0, 1]), { moves: [{ from: 2, to: 0 }], positions: [0, 1, 2] });
  // A swap across a maker's container: [b, x, a] laid out as a, b. The run keeps the first container,
  // so b moves after a and the maker's x keeps its place before them.
  assert.deepStrictEqual(planOrderMoves([2, 0]), { moves: [{ from: 0, to: 2 }], positions: [1, 2] });
});

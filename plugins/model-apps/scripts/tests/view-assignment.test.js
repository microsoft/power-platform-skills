'use strict';
// lib/view-assignment.js: which declared views share a name and need a row each, who owns which row, which rows of the name a read
// identified, and whether distinct rows can satisfy the declarations nobody can attribute (#845). The matcher is held to a
// brute-force oracle over every 3x3 graph, with and without rows already held.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { declaredViewGroups, createOwnerLedger, viewCandidates, matchDistinctRows, INCOMPLETE } = require(path.join(__dirname, '..', 'lib', 'view-assignment.js'));

const ID1 = '6f9619ff-8b86-d011-b42d-00c04fc964f1';
const ID2 = '6f9619ff-8b86-d011-b42d-00c04fc964f2';
const ID3 = '6f9619ff-8b86-d011-b42d-00c04fc964f3';
const spell = (id) => [id, id.toUpperCase(), `{${id}}`, ` {${id.toUpperCase()}} `];

test('groups: two or more declared views of one table and name, compared case-insensitively; legacy views, singletons and duplicate keys stay out', () => {
  const e = (ordinal, table, name, key, declared = true) => ({ ordinal, declared, table, name, key });
  const groups = declaredViewGroups([
    e(0, 'contoso_item', 'Twin', 'a'),
    e(1, 'Contoso_Item', 'TWIN', 'b'),
    e(2, 'contoso_item', 'Twin', 'legacy', false),
    e(3, 'contoso_item', 'Solo', 'c'),
    null,
    e(5, 'contoso_other', 'Twin', 'd'),
    e(6, 'contoso_dup', 'Pair', 'x'),
    e(7, 'contoso_dup', 'Pair', 'y'),
    e(8, 'contoso_elsewhere', 'Other', 'x'),
  ]);
  assert.deepEqual([...groups.keys()], [0, 1]);
  assert.equal(groups.get(0), groups.get(1));
  assert.equal(groups.get(0).table, 'contoso_item');
  assert.deepEqual(groups.get(0).members.map((m) => m.key), ['a', 'b']);
  assert.ok(Object.isFrozen(groups.get(0)) && Object.isFrozen(groups.get(0).members));
});

test('ledger: two declarations holding one row conflict whatever the sources and spellings; one declaration claiming twice does not', () => {
  const sources = ['managed binding', 'viewId', 'stable id'];
  for (const a of sources) {
    for (const b of sources) {
      for (const [sa, sb] of [[0, 3], [2, 1], [3, 0]]) {
        const ledger = createOwnerLedger();
        // Claimed in reverse spec order, so the answer's order is the ledger's, not the claims'.
        assert.equal(ledger.claim(spell(ID1)[sb], { ordinal: 4, key: 'b', source: b }), ID1);
        assert.equal(ledger.claim(spell(ID1)[sa], { ordinal: 1, key: 'a', source: a }), ID1);
        assert.deepEqual(ledger.conflicts(), [{ id: ID1, owners: [{ ordinal: 1, key: 'a', source: a }, { ordinal: 4, key: 'b', source: b }] }]);
      }
    }
  }
  const self = createOwnerLedger();
  self.claim(ID1, { ordinal: 0, key: 'a', source: 'managed binding' });
  self.claim(ID1.toUpperCase(), { ordinal: 0, key: 'a', source: 'viewId' });
  assert.deepEqual(self.conflicts(), []);
  assert.equal(self.has(`{${ID1}}`), true);
});

test('ledger: a row owned outside the declarations ranks after them, by key; `concerns` filters; malformed ids are not recorded', () => {
  const ledger = createOwnerLedger();
  ledger.claim(ID2, { key: 'zz', source: 'managed binding' });
  ledger.claim(ID2, { key: 'mm', source: 'pending root' });
  ledger.claim(ID2, { ordinal: 2, key: 'b', source: 'stable id' });
  ledger.claim(ID3, { key: 'q', source: 'managed binding' });
  ledger.claim(ID3, { key: 'r', source: 'managed binding' });
  assert.deepEqual(ledger.ownersOf(ID2).map((o) => o.key), ['b', 'mm', 'zz']);
  assert.deepEqual(ledger.conflicts((o) => o.ordinal !== undefined).map((c) => c.id), [ID2]);
  assert.deepEqual(ledger.conflicts().map((c) => c.id), [ID2, ID3]);
  assert.equal(ledger.claim('not-a-guid', { ordinal: 0, key: 'a', source: 'viewId' }), '');
  assert.equal(ledger.has('not-a-guid'), false);
});

test('ledger: a reserved row is no row for a witness, yet nobody owns it and it makes no conflict', () => {
  const ledger = createOwnerLedger();
  assert.equal(ledger.reserve(`{${ID1.toUpperCase()}}`), ID1);
  ledger.claim(ID1, { ordinal: 1, key: 'b', source: 'managed binding' });
  assert.equal(ledger.has(ID1), true);
  assert.deepEqual(ledger.ownersOf(ID1).map((o) => o.key), ['b']);
  assert.deepEqual(ledger.conflicts(), []);
});

test('candidates: one row per physical id in ascending order; every unidentified row makes the read incomplete, reasons in a fixed order', () => {
  const row = (id, extra = {}) => ({ savedqueryid: id, returnedtypecode: 'contoso_item', name: 'Twin', layoutxml: '<grid/>', fetchxml: '<fetch/>', ...extra });
  const clean = viewCandidates([row(spell(ID2)[1]), row(spell(ID1)[2]), row(spell(ID2)[3])], { table: 'Contoso_Item', name: 'twin', hasMore: false });
  assert.deepEqual(clean.candidates.map((c) => c.id), [ID1, ID2]);
  assert.equal(clean.complete, true);
  assert.equal(clean.reported, true);
  assert.deepEqual(clean.reasons, []);

  const messy = viewCandidates([
    row(ID1, { layoutxml: '<grid a="1"/>' }),
    row(ID1, { layoutxml: '<grid a="2"/>' }),
    row(ID2),
    row(ID2, { name: 'Other' }),
    row(ID3, { returnedtypecode: 'contoso_other' }),
    row('nope'),
    { name: 'Twin' },
    null,
  ], { table: 'contoso_item', name: 'Twin', hasMore: true });
  assert.equal(messy.complete, false);
  assert.deepEqual(messy.reasons, [INCOMPLETE.more, INCOMPLETE.noId, INCOMPLETE.notMember, INCOMPLETE.disagree]);
  assert.deepEqual(messy.candidates.map((c) => c.id), [ID1]);
  assert.equal('layoutxml' in messy.candidates[0].row, false, 'disputed content is unknown, not whichever copy came first');
  assert.equal(messy.candidates[0].row.fetchxml, '<fetch/>');

  const silent = viewCandidates([row(ID1)], { table: 'contoso_item', name: 'Twin', hasMore: undefined });
  assert.equal(silent.complete, true);
  assert.equal(silent.reported, false);
  assert.deepEqual(viewCandidates({ value: [] }, { table: 't', name: 'n' }).candidates, []);
  const unsaid = viewCandidates([{ savedqueryid: ID1 }], { table: 'contoso_item', name: 'Twin', hasMore: false });
  assert.deepEqual(unsaid.reasons, [INCOMPLETE.notMember], 'a row that does not say its table and name is no member');
});

// Every way to give each declaration one of its rows, or none, with no row twice and every held row kept: the largest such size.
function oracle(edges, fixed) {
  let best = 0;
  const walk = (l, used, size) => {
    if (l === edges.length) { best = Math.max(best, size); return; }
    if (Number.isInteger(fixed[l])) {
      const r = fixed[l];
      if (edges[l].includes(r) && !used.has(r)) { used.add(r); walk(l + 1, used, size + 1); used.delete(r); }
      return;
    }
    walk(l + 1, used, size);
    for (const r of edges[l]) if (!used.has(r)) { used.add(r); walk(l + 1, used, size + 1); used.delete(r); }
  };
  walk(0, new Set(), 0);
  return best;
}

test('matching: every 3x3 graph under every combination of held rows for all three declarations agrees with the brute-force oracle, with a valid witness or a Hall-deficient set', () => {
  const holds = [undefined, 0, 1, 2];
  let cases = 0;
  for (let mask = 0; mask < 512; mask++) {
    const edges = [0, 1, 2].map((l) => [0, 1, 2].filter((r) => mask & (1 << (l * 3 + r))));
    for (const h0 of holds) {
      for (const h1 of holds) for (const h2 of holds) {
        const fixed = [h0, h1, h2];
        const got = matchDistinctRows(3, edges, { fixed });
        const best = oracle(edges, fixed);
        const label = JSON.stringify({ edges, fixed });
        assert.equal(got.covered, best === 3, label);
        const heldRows = fixed.filter((r) => r !== undefined);
        const valid = fixed.every((r, l) => r === undefined || edges[l].includes(r)) && new Set(heldRows).size === heldRows.length;
        const used = got.witness.filter((r) => r !== -1);
        assert.equal(new Set(used).size, used.length, label);
        got.witness.forEach((r, l) => { if (r !== -1) assert.ok(edges[l].includes(r), label); });
        fixed.forEach((r, l) => { if (valid && r !== undefined) assert.equal(got.witness[l], r, label); });
        if (valid) assert.equal(got.size, best, label);
        if (got.covered) {
          assert.equal(got.deficient, null, label);
        } else if (valid) {
          const held = new Set(fixed.filter((r) => r !== undefined));
          const { left, right } = got.deficient;
          assert.ok(left.length > right.length, label);
          for (const l of left) for (const r of edges[l]) if (!held.has(r)) assert.ok(right.includes(r), label);
        } else {
          assert.ok(got.deficient.left.length > 0, label);
        }
        cases++;
      }
    }
  }
  assert.equal(cases, 512 * 64);
});

test('matching: a held row that is not its declaration\'s, or that two declarations hold, is reported at once with the holders', () => {
  assert.deepEqual(matchDistinctRows(2, [[0], [1]], { fixed: [1] }), { covered: false, size: 0, witness: [-1, -1], deficient: { left: [0], right: [] } });
  assert.deepEqual(matchDistinctRows(3, [[0], [0], [1]], { fixed: [0, 0] }), { covered: false, size: 1, witness: [-1, -1, -1], deficient: { left: [0, 1], right: [0] } });
});

test('matching: 80 declarations over 200 dense rows are covered, and over 79 rows the whole group is the deficient set', () => {
  const dense = Array.from({ length: 80 }, () => Array.from({ length: 200 }, (_, r) => r).reverse());
  const all = matchDistinctRows(80, dense);
  assert.equal(all.covered, true);
  assert.equal(new Set(all.witness).size, 80);
  const short = matchDistinctRows(80, Array.from({ length: 80 }, () => Array.from({ length: 79 }, (_, r) => r)));
  assert.equal(short.covered, false);
  assert.equal(short.size, 79);
  assert.equal(short.deficient.left.length, 80);
  assert.equal(short.deficient.right.length, 79);
});

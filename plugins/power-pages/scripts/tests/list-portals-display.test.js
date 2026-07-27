const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalize,
  orderPortalsForDisplay,
  compareForDisplay,
  DISPLAY_LIMIT,
} = require('../../skills/manage-governance/scripts/list-portals');

function portal(over = {}) {
  return {
    portalId: over.portalId || 'id',
    name: over.name || 'n',
    websiteUrl: over.websiteUrl || 'u',
    type: over.type ?? null,
    status: over.status ?? null,
    createdOn: over.createdOn ?? null,
  };
}

test('normalize surfaces status and createdOn (camelCase)', () => {
  const n = normalize({
    id: 'a',
    name: 'Portal_1',
    websiteUrl: 'https://x',
    type: 'Trial',
    status: 'StateConfigured',
    createdOn: '2026-07-19T07:30:42',
  });
  assert.equal(n.portalId, 'a');
  assert.equal(n.status, 'StateConfigured');
  assert.equal(n.createdOn, '2026-07-19T07:30:42');
  assert.equal(n.type, 'Trial');
});

test('normalize tolerates PascalCase Status/CreatedOn', () => {
  const n = normalize({ Id: 'a', Name: 'P', Status: 'StateConfigured', CreatedOn: '2026-01-01T00:00:00' });
  assert.equal(n.status, 'StateConfigured');
  assert.equal(n.createdOn, '2026-01-01T00:00:00');
});

test('DISPLAY_LIMIT defaults to 10', () => {
  assert.equal(DISPLAY_LIMIT, 10);
});

test('orderPortalsForDisplay preserves order and does not truncate when <= limit', () => {
  const input = [portal({ name: 'A' }), portal({ name: 'B' }), portal({ name: 'C' })];
  const res = orderPortalsForDisplay(input, 10);
  assert.equal(res.truncated, false);
  assert.equal(res.total, 3);
  assert.deepEqual(res.shown.map((p) => p.name), ['A', 'B', 'C']);
});

test('orderPortalsForDisplay caps to limit and prioritizes Production first when > limit', () => {
  // 12 portals: mix of Production/Trial, Configured/other, varied createdOn.
  const input = [];
  for (let i = 0; i < 6; i += 1) {
    input.push(portal({ name: `trial-${i}`, type: 'Trial', status: 'StateConfigured', createdOn: `2026-01-${10 + i}T00:00:00` }));
  }
  for (let i = 0; i < 6; i += 1) {
    input.push(portal({ name: `prod-${i}`, type: 'Production', status: 'StateConfigured', createdOn: `2026-02-${10 + i}T00:00:00` }));
  }
  const res = orderPortalsForDisplay(input, 10);
  assert.equal(res.truncated, true);
  assert.equal(res.total, 12);
  assert.equal(res.shown.length, 10);
  // First six must be the Production ones (rank 1 beats Trial).
  const firstSix = res.shown.slice(0, 6);
  assert.ok(firstSix.every((p) => p.type === 'Production'), 'Production sites lead the list');
});

test('orderPortalsForDisplay ranks StateConfigured above others within same type', () => {
  const input = [];
  // 11 Production portals; some not StateConfigured.
  input.push(portal({ name: 'prod-unconfigured', type: 'Production', status: 'StateCreating', createdOn: '2020-01-01T00:00:00' }));
  for (let i = 0; i < 10; i += 1) {
    input.push(portal({ name: `prod-cfg-${i}`, type: 'Production', status: 'StateConfigured', createdOn: `2026-03-${10 + i}T00:00:00` }));
  }
  const res = orderPortalsForDisplay(input, 10);
  assert.equal(res.truncated, true);
  // The unconfigured one has the oldest createdOn but must be de-prioritized
  // below StateConfigured, so it should be dropped from the top 10.
  assert.ok(!res.shown.some((p) => p.name === 'prod-unconfigured'), 'unconfigured site is de-prioritized out of the top 10');
});

test('compareForDisplay orders by createdOn ASC when type and status tie', () => {
  const older = portal({ name: 'older', type: 'Production', status: 'StateConfigured', createdOn: '2026-01-01T00:00:00' });
  const newer = portal({ name: 'newer', type: 'Production', status: 'StateConfigured', createdOn: '2026-06-01T00:00:00' });
  assert.ok(compareForDisplay(older, newer) < 0);
  assert.ok(compareForDisplay(newer, older) > 0);
});

test('compareForDisplay pushes unparseable/missing createdOn to the end', () => {
  const good = portal({ type: 'Production', status: 'StateConfigured', createdOn: '2026-01-01T00:00:00' });
  const noDate = portal({ type: 'Production', status: 'StateConfigured', createdOn: null });
  assert.ok(compareForDisplay(good, noDate) < 0);
});

test('orderPortalsForDisplay is case-insensitive on type/status', () => {
  const input = [];
  for (let i = 0; i < 6; i += 1) input.push(portal({ name: `t-${i}`, type: 'trial', status: 'stateconfigured', createdOn: `2026-01-${10 + i}T00:00:00` }));
  for (let i = 0; i < 6; i += 1) input.push(portal({ name: `p-${i}`, type: 'production', status: 'stateconfigured', createdOn: `2026-02-${10 + i}T00:00:00` }));
  const res = orderPortalsForDisplay(input, 10);
  assert.ok(res.shown.slice(0, 6).every((p) => String(p.type).toLowerCase() === 'production'));
});

test('orderPortalsForDisplay handles empty / non-array input', () => {
  assert.deepEqual(orderPortalsForDisplay([]), { shown: [], total: 0, truncated: false, limit: 10 });
  assert.deepEqual(orderPortalsForDisplay(undefined), { shown: [], total: 0, truncated: false, limit: 10 });
});

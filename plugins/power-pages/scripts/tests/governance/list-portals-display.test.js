const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const {
  normalize,
  orderPortalsForDisplay,
  compareForDisplay,
  DISPLAY_LIMIT,
} = require('../../../skills/manage-governance/scripts/list-portals');

function loadInventory(request) {
  const filename = require.resolve('../../../skills/manage-governance/scripts/list-portals');
  const realRequire = createRequire(filename);
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (name === '../../../scripts/lib/power-platform-api') {
        return { request, runCli() {} };
      }
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox.module.exports.fetchPortalsPaged;
}

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

test('inventory follows both continuation link casings and normalizes every page', async () => {
  const context = {};
  const calls = [];
  const pages = [
    { value: [{ id: 'a' }], '@odata.nextLink': 'https://api.example.com/websites?skip=10&select=Id' },
    { value: [{ Id: 'b' }], nextLink: 'https://api.example.com/websites?skip=20' },
    { value: [{ id: 'c' }], '@odata.nextLink': null },
  ];
  const fetch = loadInventory(async (args) => {
    assert.equal(args.context, context);
    assert.equal(args.method, 'GET');
    assert.equal(args.path, '/websites');
    calls.push(args.query.skip);
    return { ok: true, body: pages[calls.length - 1] };
  });
  const result = await fetch(context);
  assert.equal(result.error, undefined);
  assert.deepEqual(Array.from(result.portals, (site) => site.portalId), ['a', 'b', 'c']);
  assert.deepEqual(calls, [undefined, '10', '20']);
});

test('a valid empty inventory is complete', async () => {
  const fetch = loadInventory(async () => ({ ok: true, body: { value: [] } }));
  const result = await fetch({});
  assert.equal(result.error, undefined);
  assert.equal(result.portals.length, 0);
});

test('malformed successful inventory envelopes are errors, not empty inventories', async () => {
  for (const body of [undefined, null, '', true, [], {}, { value: null }, { value: {} }, { value: 'bad' }]) {
    const fetch = loadInventory(async () => ({ ok: true, body }));
    const result = await fetch({});
    assert.match(result.error, /malformed response.*incomplete/);
    assert.equal(result.portals.length, 0);
  }
});

test('malformed portal records cannot silently disappear from inventory', async () => {
  for (const site of [null, [], 'bad', {}, { id: '' }, { id: ' ' }, { id: 12 }]) {
    const fetch = loadInventory(async () => ({ ok: true, body: { value: [site] } }));
    const result = await fetch({});
    assert.match(result.error, /malformed portal record.*incomplete/);
    assert.equal(result.portals.length, 0);
  }
});

test('a malformed later page retains earlier records only with an inventory error', async () => {
  const fetch = loadInventory(async ({ query }) => ({
    ok: true,
    body: query.skip ? {} : { value: [{ id: 'a' }], nextLink: '?skip=10' },
  }));
  const result = await fetch({});
  assert.match(result.error, /malformed response.*incomplete/);
  assert.equal(result.portals.length, 1);
  assert.equal(result.portals[0].portalId, 'a');
});

test('a failed later inventory request preserves the failure and earlier records', async () => {
  const fetch = loadInventory(async ({ query }) => query.skip
    ? { ok: false, statusCode: 403, error: { message: 'Access denied' } }
    : { ok: true, body: { value: [{ id: 'a' }], nextLink: '?skip=10' } });
  const result = await fetch({});
  assert.match(result.error, /403.*Access denied/);
  assert.equal(result.portals.length, 1);
});

test('present but unusable pagination links return an incomplete-inventory error', async () => {
  for (const nextLink of [
    '', {}, 10, '?skip=0', '?skip=-1', '?skip=bad', '?skip=10bad',
    '?skip=1.5', '?skip=9007199254740992', '?top=10',
  ]) {
    let calls = 0;
    const fetch = loadInventory(async () => {
      calls += 1;
      return { ok: true, body: { value: [{ id: 'a' }], '@odata.nextLink': nextLink } };
    });
    const result = await fetch({});
    assert.match(result.error, /invalid or non-advancing pagination.*incomplete/);
    assert.equal(calls, 1);
  }
});

test('repeated or backwards pagination cursors report incomplete inventory', async () => {
  for (const nextLink of ['?skip=10', '?skip=5']) {
    let calls = 0;
    const fetch = loadInventory(async ({ query }) => {
      calls += 1;
      return { ok: true, body: { value: [{ id: `site-${calls}` }], nextLink: query.skip ? nextLink : '?skip=10' } };
    });
    const result = await fetch({});
    assert.match(result.error, /non-advancing pagination.*incomplete/);
    assert.equal(calls, 2);
  }
});

test('the inventory page limit is an error only when more pages remain', async () => {
  for (const morePages of [true, false]) {
    let calls = 0;
    const fetch = loadInventory(async () => {
      calls += 1;
      const body = { value: [{ id: `site-${calls}` }] };
      if (morePages || calls < 500) body.nextLink = `?skip=${calls}`;
      return { ok: true, body };
    });
    const result = await fetch({});
    assert.equal(calls, 500);
    assert.equal(result.portals.length, 500);
    if (morePages) assert.match(result.error, /500-page limit.*more pages.*incomplete/);
    else assert.equal(result.error, undefined);
  }
});

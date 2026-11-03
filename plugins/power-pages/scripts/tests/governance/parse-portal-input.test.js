const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parsePortalInput,
} = require('../../../skills/manage-governance/scripts/parse-portal-input');

const siteId = 'abcdefab-1234-5678-90ab-abcdefabcdef';
const otherId = '11111111-2222-3333-4444-555555555555';

test('parsePortalInput accepts exact IDs and preserves selection syntax', () => {
  assert.deepEqual(parsePortalInput('all'), { policyValue: 'All', portalIds: [], errors: [] });
  assert.deepEqual(parsePortalInput('none'), { policyValue: 'None', portalIds: [], errors: [] });
  for (const [prefix, policyValue] of [['', 'Include'], ['not ', 'Exclude'], ['except ', 'Exclude']]) {
    const result = parsePortalInput(` ${prefix}${siteId.toUpperCase()},\r\n ${otherId}, ${siteId} `, {
      validIds: [siteId, otherId],
    });
    assert.deepEqual(result, { policyValue, portalIds: [siteId, otherId], errors: [] });
  }
  assert.deepEqual(parsePortalInput(` ${siteId} `), {
    policyValue: 'Include', portalIds: [siteId], errors: [],
  });
});

test('parsePortalInput rejects embedded IDs without returning a partial selection', () => {
  const invalidTokens = [
    `please use ${siteId} now`,
    `prefix${siteId}`,
    `${siteId}suffix`,
    `{${siteId}}`,
    `${siteId}.`,
    `${siteId} ${otherId}`,
  ];
  for (const validIds of [undefined, [siteId, otherId]]) {
    for (const token of invalidTokens) {
      for (const prefix of ['', 'not ', 'except ', `${otherId}, `]) {
        const result = parsePortalInput(prefix + token, { validIds });
        assert.equal(result.policyValue, null, prefix + token);
        assert.deepEqual(result.portalIds, [], prefix + token);
        assert.ok(result.errors.length > 0, prefix + token);
      }
    }
  }
});

test('an explicitly empty site inventory accepts only all, not unverified IDs or other scope input', () => {
  assert.deepEqual(parsePortalInput('  ALL  ', { validIds: [] }), {
    policyValue: 'All', portalIds: [], errors: [],
  });
  for (const input of [siteId, `not ${siteId}`, `except ${siteId}`, 'Site 1', 'none', '', null]) {
    const result = parsePortalInput(input, { validIds: [] });
    assert.equal(result.policyValue, null);
    assert.deepEqual(result.portalIds, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /no sites.*Enter "all".*or cancel/);
  }
  assert.deepEqual(parsePortalInput(siteId), {
    policyValue: 'Include', portalIds: [siteId], errors: [],
  });
});

test('parse portal CLI restricts an empty environment to all', () => {
  const script = path.resolve(__dirname, '../../../skills/manage-governance/scripts/parse-portal-input.js');
  for (const input of ['all', siteId, 'none']) {
    const result = spawnSync(process.execPath, [script, '--portalsStdin', '--input', input], {
      input: JSON.stringify({ portals: [] }), encoding: 'utf8',
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, input === 'all' ? 0 : 1, result.stderr);
    assert.equal(parsed.policyValue, input === 'all' ? 'All' : null);
    assert.deepEqual(parsed.portalIds, []);
    if (input !== 'all') assert.match(parsed.errors[0], /no sites.*Enter "all"/);
  }
});

test('parsePortalInput resolves exact names containing IDs without extracting the ID', () => {
  const name = `Preview ${siteId}`;
  const result = parsePortalInput(name.toUpperCase(), {
    validIds: [{ portalId: otherId, name }],
  });
  assert.deepEqual(result, {
    policyValue: 'Include', portalIds: [otherId], errors: [], resolvedNames: [name],
  });
});

test('parsePortalInput resolves a portal name from an in-memory list', () => {
  const result = parsePortalInput('Portal_1', {
    validIds: [{ portalId: 'portal-id-1', name: 'Portal_1' }],
  });
  assert.deepEqual(result, {
    policyValue: 'Include',
    portalIds: ['portal-id-1'],
    errors: [],
    resolvedNames: ['Portal_1'],
  });
});

test('duplicate site names require an exact ID regardless of case or inventory order', () => {
  for (const name of ['Shared Site', 'SHARED SITE']) {
    const sites = [{ portalId: siteId, name: 'Shared Site' }, { portalId: otherId, name }];
    for (const validIds of [sites, [...sites].reverse()]) {
      for (const prefix of ['', 'not ', 'except ', `${siteId}, `]) {
        const result = parsePortalInput(`${prefix}shared site`, { validIds });
        assert.equal(result.policyValue, null);
        assert.deepEqual(result.portalIds, []);
        assert.equal(result.resolvedNames, undefined);
        assert.equal(result.errors.length, 1);
        assert.match(result.errors[0], /ambiguous.*Provide the exact site ID or cancel/);
        assert.ok(result.errors[0].includes(siteId));
        assert.ok(result.errors[0].includes(otherId));
      }
      for (const [prefix, policyValue] of [['', 'Include'], ['not ', 'Exclude'], ['except ', 'Exclude']]) {
        const result = parsePortalInput(`${prefix}${siteId.toUpperCase()}`, { validIds });
        assert.equal(result.policyValue, policyValue);
        assert.deepEqual(result.portalIds, [siteId]);
        assert.deepEqual(result.errors, []);
      }
    }
  }
});

test('repeated records for one site ID do not make its name ambiguous', () => {
  const result = parsePortalInput(`shared site, ${siteId}`, {
    validIds: [
      { portalId: siteId, name: 'Shared Site' },
      { portalId: siteId.toUpperCase(), name: 'SHARED SITE' },
    ],
  });
  assert.equal(result.policyValue, 'Include');
  assert.deepEqual(result.portalIds, [siteId.toUpperCase()]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.resolvedNames, ['SHARED SITE']);
});

test('parse portal CLI rejects duplicate names but accepts the selected exact ID', () => {
  const script = path.resolve(__dirname, '../../../skills/manage-governance/scripts/parse-portal-input.js');
  const input = JSON.stringify({
    portals: [{ portalId: siteId, name: 'Same Name' }, { portalId: otherId, name: 'same name' }],
  });
  for (const selection of ['Same Name', otherId]) {
    const result = spawnSync(process.execPath, [script, '--portalsStdin', '--input', selection], {
      input, encoding: 'utf8',
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, selection === otherId ? 0 : 1, result.stderr);
    assert.deepEqual(parsed.portalIds, selection === otherId ? [otherId] : []);
    if (selection !== otherId) assert.match(parsed.errors[0], /ambiguous/);
  }
});

test('parse portal CLI accepts list-portals JSON on stdin', () => {
  const script = path.resolve(
    __dirname,
    '../../../skills/manage-governance/scripts/parse-portal-input.js'
  );
  const result = spawnSync(
    process.execPath,
    [script, '--portalsStdin', '--input', 'Portal_1'],
    {
      input: JSON.stringify({
        portals: [{ portalId: 'portal-id-1', name: 'Portal_1' }],
      }),
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).portalIds, ['portal-id-1']);
});

test('parse portal CLI exits with an error for an ID embedded in extra text', () => {
  const script = path.resolve(
    __dirname,
    '../../../skills/manage-governance/scripts/parse-portal-input.js'
  );
  const result = spawnSync(
    process.execPath,
    [script, '--portalsStdin', '--input', `please use ${siteId} now`],
    {
      input: JSON.stringify({ portals: [{ portalId: siteId, name: 'Site 1' }] }),
      encoding: 'utf8',
    }
  );
  assert.equal(result.status, 1, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.policyValue, null);
  assert.deepEqual(parsed.portalIds, []);
  assert.ok(parsed.errors.length > 0);
});

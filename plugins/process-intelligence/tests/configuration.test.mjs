// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveConnection, profile, validateName, validateEnvironmentId } from '../src/configuration.mjs';
import { bound, assertProfileBytes, removedClouds } from './helpers.mjs';

export const base = profile({ Name: 'sample', Cloud: 'Public', TenantId: '11111111-1111-1111-1111-111111111111',
  EnvironmentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeff' });
test('normalized profiles contain only configuration, revision and OID account binding', () => {
  assertProfileBytes(JSON.stringify(base), null);
  assertProfileBytes(JSON.stringify(profile(bound)), bound.HomeAccountId);
});
test('profile account binding preserves GUIDs and nullable unbound state', () => {
  for (const HomeAccountId of [undefined, null]) {
    assert.equal(profile({ ...bound, HomeAccountId }).HomeAccountId, null);
  }
  for (const HomeAccountId of [base.EnvironmentId, base.EnvironmentId.toUpperCase()]) {
    const input = { ...bound, HomeAccountId };
    assert.equal(profile(input).HomeAccountId, HomeAccountId);
    assert.equal(input.HomeAccountId, HomeAccountId);
  }
});
for (const HomeAccountId of [
  '', 'not-an-oid', 'fixture@example.invalid', 1, false, {}, [],
  bound.HomeAccountId.replaceAll('-', ''), `{${bound.HomeAccountId}}`,
  ` ${bound.HomeAccountId}`, `${bound.HomeAccountId}\n`,
  `${bound.HomeAccountId}.tenant`, `Default-${bound.HomeAccountId}`
]) test(`profile rejects malformed OID binding ${JSON.stringify(HomeAccountId)}`, () => {
  assert.throws(() => profile({ ...bound, HomeAccountId }), error => {
    assert.equal(error.exitCode, 2);
    assert.equal(error.errorCode, 'INVALID_CONFIGURATION');
    assert.match(error.message, /account selection/i);
    if (typeof HomeAccountId === 'string' && HomeAccountId) {
      assert.equal(error.message.includes(HomeAccountId), false);
    }
    return true;
  });
});
const clouds = [
  ['Public', 'api.powerplatform.com', 'login.microsoftonline.com', 2, 'AzureCloud'],
  ['Gcc', 'api.gov.powerplatform.microsoft.us', 'login.microsoftonline.com', 1, 'AzureCloud'],
  ['GccHigh', 'api.high.powerplatform.microsoft.us', 'login.microsoftonline.us', 1, 'AzureUSGovernment'],
  ['DoD', 'api.appsplatform.us', 'login.microsoftonline.us', 1, 'AzureUSGovernment'],
  ['Mooncake', 'api.powerplatform.partner.microsoftonline.cn', 'login.partner.microsoftonline.cn', 1, 'AzureChinaCloud']
];
for (const Cloud of removedClouds) test(`reject removed cloud in config and profile: ${Cloud}`, () => {
  for (const validate of [resolveConnection, profile]) assert.throws(() => validate({ ...base, Cloud }), error => {
    assert.equal(error.exitCode, 2);
    assert.equal(error.errorCode, 'INVALID_CONFIGURATION');
    assert.match(error.message, /Choose Public, Gcc, GccHigh, DoD or Mooncake\./);
    return true;
  });
});
test('Mooncake configuration preserves the official Azure CLI cloud and endpoints', () => {
  for (const Cloud of ['Mooncake', 'mooncake', 'MOONCAKE']) {
    const connection = resolveConnection(profile({ ...base, Cloud }));
    assert.equal(connection.cliCloud, 'AzureChinaCloud');
    assert.equal(connection.authorityHost, 'login.partner.microsoftonline.cn');
    assert.equal(connection.resource, 'https://api.powerplatform.partner.microsoftonline.cn');
  }
});
test('connection documentation separates five accepted mappings from sovereign support policy', async () => {
  for (const file of ['../README.md', '../skills/setup/SKILL.md', '../references/connection-patterns.md']) {
    const content = (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/[`*]/g, '').replace(/\s+/g, ' ');
    assert.match(content, /GCC, GCC High, DoD and Mooncake are not supported yet/, file);
    assert.match(content, /Public is the commercial cloud configuration/, file);
    assert.doesNotMatch(content, /\btip[12]\b|internal configurations/i, file);
    assert.match(content, /CLI accepts five cloud values/, file);
    assert.match(content, /configuration support does not make an unsupported cloud available/, file);
  }
  const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /GCC, GCC High, DoD and Mooncake are not supported yet/);
  const text = await readFile(new URL('../references/connection-patterns.md', import.meta.url), 'utf8');
  const section = text.split('## Clouds and resources')[1].split('## Protected state')[0];
  const rows = section.split(/\r?\n/).filter(line => /^\| [^|]+ \|/.test(line))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim())).filter(row => row[0] !== 'Cloud');
  assert.deepEqual(rows.map(row => row.slice(0, 4)), clouds.map(([cloud, suffix, host, shard]) =>
    [cloud, host, suffix, `Last ${shard} character${shard === 1 ? '' : 's'}`]));
  assert.deepEqual(rows.map(row => row[4]), ['Commercial target', 'Not supported yet', 'Not supported yet',
    'Not supported yet', 'Not supported yet']);
  assert.match(section, /AzureCloud` for Public\/Gcc,/);
  assert.doesNotMatch(section, /germany/i);
});
test('authentication guidance states user prerequisites without provider-design history', async () => {
  const text = (await readFile(new URL('../references/connection-patterns.md', import.meta.url), 'utf8'))
    .replace(/\s+/g, ' ');
  assert.match(text, /Azure CLI manages authentication for the selected tenant and Power Platform API resource/);
  assert.match(text, /organizational account must have access to the selected Process Mining environment/);
  assert.doesNotMatch(text, /provider pattern|PPAPI Connectivity|first-party public client|ProcessMining\.Query\.Invoke/);
});
for (const [cloud, suffix, host, shard, cliCloud] of clouds) test(`routing parity ${cloud}`, () => {
  const r = resolveConnection({ ...base, Cloud: cloud });
  const id = base.EnvironmentId.replaceAll('-', '');
  assert.equal(r.endpoint, `https://${id.slice(0, -shard)}.${id.slice(-shard)}.environment.${suffix}/processmining/mcp?api-version=2024-10-01`);
  assert.equal(r.authority, `https://${host}/${base.TenantId}`);
  assert.equal(r.resource, `https://${suffix}`);
  assert.equal(r.scope, `https://${suffix}/.default`);
  assert.equal(r.cliCloud, cliCloud);
});
test('default prefix and explicit default audience preserve route', () => {
  assert.match(resolveConnection({ ...base, EnvironmentId: `Default-${base.EnvironmentId.toUpperCase()}` }).endpoint, /^https:\/\/default/);
  for (const [Cloud, suffix] of clouds) {
    const p = { ...base, Cloud, Audience: `https://${suffix}` };
    assert.deepEqual(resolveConnection(p), resolveConnection({ ...p, Audience: null }));
    for (const Audience of ['https://gateway.example.invalid', 'https://management.azure.com',
      ...clouds.filter(([other]) => other !== Cloud).map(([, host]) => `https://${host}`)]) {
      assert.throws(() => resolveConnection({ ...p, Audience }), /Audience is not allowlisted/);
    }
  }
});
test('environment IDs canonicalize recognized prefixes and D/N GUID formats', () => {
  for (const prefix of ['', 'Default', 'Legacy', 'Primary']) {
    const expected = `${prefix ? `${prefix}-` : ''}${base.EnvironmentId}`;
    for (const casing of [prefix, prefix.toLowerCase(), prefix.toUpperCase()]) {
      for (const separator of prefix ? ['', '-'] : ['']) {
        for (const guid of [base.EnvironmentId, base.EnvironmentId.replaceAll('-', '')]) {
          const input = casing + separator + guid.toUpperCase();
          assert.equal(validateEnvironmentId(input), expected, input);
          assert.equal(validateEnvironmentId(expected), expected);
        }
      }
    }
  }
});
test('environment GUID whitespace follows .NET trimming without trimming before prefixes', () => {
  const whitespace = '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004' +
    '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  for (const space of whitespace) {
    assert.equal(validateEnvironmentId(space + base.EnvironmentId + space), base.EnvironmentId);
    for (const separator of ['', '-']) {
      assert.equal(validateEnvironmentId(`Legacy${separator}${space}${base.EnvironmentId}${space}`),
        `Legacy-${base.EnvironmentId}`);
    }
    assert.throws(() => validateEnvironmentId(`${space}Default-${base.EnvironmentId}`));
  }
  for (const space of ['\u0000', '\u200b', '\ufeff']) {
    assert.throws(() => validateEnvironmentId(space + base.EnvironmentId + space));
  }
});
test('environment parsing stays bounded for whitespace-heavy metadata', () => {
  const spaces = ' '.repeat(128 * 1024);
  const start = performance.now();
  assert.throws(() => validateEnvironmentId(base.EnvironmentId + spaces + 'x'));
  assert.ok(performance.now() - start < 1000, 'Malformed metadata must not cause quadratic scanning');
  assert.equal(validateEnvironmentId(spaces + base.EnvironmentId + spaces), base.EnvironmentId);
});
test('environment D format preserves .NET fixed-width hexadecimal compatibility', () => {
  for (let component = 0; component < 5; component++) {
    for (const marker of ['+', '0x', '0X', '+0x']) {
      const input = base.EnvironmentId.split('-');
      const expected = [...input];
      input[component] = marker + input[component].slice(marker.length);
      expected[component] = '0'.repeat(marker.length) + expected[component].slice(marker.length);
      assert.equal(validateEnvironmentId(`primary-${input.join('-')}`),
        `Primary-${expected.join('-')}`);
    }
  }
  for (const invalid of [
    'aaaaaaaa-bbbb-cccc-dddd-eeee+eeeeeff',
    'aaaaaaaa-bbbb-cccc-dddd-eeee0xeeeeff',
    '+aaaaaaabbbbccccddddeeeeeeeeeeff',
    'aaaaaaaa-0x+1-cccc-dddd-eeeeeeeeeeff',
    'aaaaaaaa-++11-cccc-dddd-eeeeeeeeeeff'
  ]) {
    assert.throws(() => validateEnvironmentId(invalid), invalid);
  }
});
test('environment IDs reject zero, unknown prefixes, malformed GUIDs and trailing data', () => {
  for (const prefix of ['', 'Default-', 'Legacy', 'Primary-']) {
    for (const zero of ['0'.repeat(32), '00000000-0000-0000-0000-000000000000']) {
      assert.throws(() => validateEnvironmentId(prefix + zero));
    }
  }
  for (const input of [
    undefined, null, 42, {}, [], '', ' ', 'Default', 'Legacy-', 'Primary',
    `Other-${base.EnvironmentId}`, `Primary-Default-${base.EnvironmentId}`,
    `Default--${base.EnvironmentId}`, `Legacy -${base.EnvironmentId}`,
    `{${base.EnvironmentId}}`, `(${base.EnvironmentId})`,
    '{0xaaaaaaaa,0xbbbb,0xcccc,{0xdd,0xdd,0xee,0xee,0xee,0xee,0xee,0xff}}',
    base.EnvironmentId + 'x', base.EnvironmentId + '/path', base.EnvironmentId + '?query',
    base.EnvironmentId + '#fragment', base.EnvironmentId + '\ntrailing',
    'aaaaaaa-abbbb-cccc-dddd-eeeeeeeeeeff', 'aaaaaaaa-bbbbcccc-dddd-eeeeeeeeeeff',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee eef', 'gaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeff'
  ]) {
    assert.throws(() => validateEnvironmentId(input),
      error => error.exitCode === 2 && error.errorCode === 'INVALID_CONFIGURATION');
  }
});
test('profiles normalize environment IDs without changing tenant validation or input objects', () => {
  const input = { ...base, EnvironmentId: 'pRiMaRy' + base.EnvironmentId.replaceAll('-', '').toUpperCase() };
  const original = { ...input };
  assert.equal(profile(input).EnvironmentId, `Primary-${base.EnvironmentId}`);
  assert.deepEqual(input, original);
  for (const TenantId of [base.TenantId.replaceAll('-', ''), ` ${base.TenantId}`, `Default-${base.TenantId}`]) {
    assert.throws(() => profile({ ...base, TenantId }));
  }
});
test('all cloud routes use canonical environment IDs and retain every recognized prefix', () => {
  for (const [cloud, suffix, , shard] of clouds) {
    for (const prefix of ['', 'Default', 'Legacy', 'Primary']) {
      const compact = base.EnvironmentId.replaceAll('-', '');
      const hostId = prefix.toLowerCase() + compact;
      const expected = `https://${hostId.slice(0, -shard)}.${hostId.slice(-shard)}.environment.${suffix}/processmining/mcp?api-version=2024-10-01`;
      for (const EnvironmentId of [
        prefix + compact.toUpperCase(),
        (prefix ? prefix + '-' : '') + '\t' + base.EnvironmentId + '\n',
        (prefix ? prefix + '-' : '') + base.EnvironmentId
      ]) {
        const input = { ...base, Cloud: cloud, EnvironmentId };
        assert.equal(resolveConnection(input).endpoint, expected);
        assert.equal(resolveConnection(profile(input)).endpoint, expected);
        assert.equal(input.EnvironmentId, EnvironmentId);
      }
    }
  }
});
for (const [key, values] of Object.entries({
  Cloud: ['Dev', '', 'unknown'], TenantId: ['select', 'common', 'organizations', 'evil.example', null],
  EnvironmentId: ['x', '../../evil', 'https://example.com', 'Default-not-guid', base.EnvironmentId + '\ntrailing', null],
  Audience: ['https://management.azure.com', 'https://evil.example']
})) for (const value of values) test(`reject invalid ${key} ${value}`, () =>
  assert.throws(() => resolveConnection({ ...base, [key]: value })));
for (const name of ['../escape', 'A', '', 'a'.repeat(41), 'a\n']) test(`reject profile name ${JSON.stringify(name)}`, () =>
  assert.throws(() => validateName(name)));

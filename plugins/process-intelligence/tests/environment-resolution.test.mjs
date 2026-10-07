// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { run } from '../src/cli.mjs';
import { FakeAz, sample, token } from './helpers.mjs';

const resource = 'https://api.bap.microsoft.com';
const command = (environment = sample.EnvironmentId, cloud = 'Public') =>
  ['resolve-environment', '--cloud', cloud, '--environment', environment];
const metadata = (name = sample.EnvironmentId, properties = { tenantId: sample.TenantId }) => ({ name, properties });
function fixture() {
  const cli = new FakeAz(), stdout = new PassThrough(), stderr = new PassThrough(), requests = [];
  cli.tokenOutput = token({ aud: resource });
  let out = '', err = '';
  stdout.on('data', bytes => { out += bytes; }); stderr.on('data', bytes => { err += bytes; });
  const f = { cli, stdout, stderr, requests, response: () => Response.json(metadata()),
    store: { load() { assert.fail('Discovery must not load a profile'); }, save() { assert.fail('Discovery must not save a profile'); } },
    get out() { return out; }, get err() { return err; } };
  f.fetchImpl = async request => { requests.push(request); return f.response(request); };
  return f;
}

test('environment-first lookup returns only confirmed target metadata without profile, token or username output', async () => {
  const f = fixture();
  assert.equal(await run(command(), f), 0, f.err);
  assert.deepEqual(JSON.parse(f.err), { cloud: 'Public', environmentId: sample.EnvironmentId,
    tenantId: sample.TenantId, source: 'environment-metadata' });
  assert.equal(f.out, '');
  assert.equal(f.requests.length, 1);
  const [request] = f.requests;
  assert.equal(request.url, `${resource}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${sample.EnvironmentId}?api-version=2020-10-01`);
  assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'manual');
  assert.ok(request.headers.has('authorization'));
  const acquisitions = f.cli.calls.filter(args => args[1] === 'get-access-token');
  assert.equal(acquisitions.length, 1);
  assert.equal(acquisitions[0][acquisitions[0].indexOf('--tenant') + 1], sample.TenantId);
  assert.equal(acquisitions[0][acquisitions[0].indexOf('--resource') + 1], resource);
  assert.equal(f.cli.calls.some(args => ['login', 'logout'].includes(args[0]) || args[1] === 'set'), false);
  assert.doesNotMatch(f.err, /accessToken|fixture@example|eyJ|displayName/);
});

test('Default-prefixed identifiers are looked up intact rather than treated as a tenant', async () => {
  const environment = `Default-${sample.EnvironmentId.toUpperCase()}`, f = fixture();
  f.response = () => Response.json(metadata(environment.toLowerCase()));
  assert.equal(await run(command(environment, 'public'), f), 0, f.err);
  assert.equal(JSON.parse(f.err).environmentId.toLowerCase(), environment.toLowerCase());
  assert.equal(JSON.parse(f.err).tenantId, sample.TenantId);
  assert.ok(f.requests[0].url.includes(`/environments/Default-${sample.EnvironmentId}?`));
});

test('discovery normalizes input and equivalent metadata IDs without dropping prefixes', async () => {
  for (const prefix of ['', 'Default', 'Legacy', 'Primary']) {
    const f = fixture();
    const compact = sample.EnvironmentId.replaceAll('-', '').toUpperCase();
    const canonical = (prefix ? prefix + '-' : '') + sample.EnvironmentId;
    const alias = prefix.toLowerCase() + compact;
    f.response = () => Response.json({
      ...metadata(alias),
      environmentId: canonical,
      id: '/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/' + canonical
    });
    assert.equal(await run(command(alias + '\n'), f), 0, f.err);
    assert.equal(JSON.parse(f.err).environmentId, canonical);
    assert.equal(JSON.parse(f.err).tenantId, sample.TenantId);
    assert.ok(f.requests[0].url.includes(`/environments/${canonical}?`));
  }
});
test('normalized metadata still rejects different prefixes, conflicting IDs and duplicate matches', async () => {
  const canonical = `Primary-${sample.EnvironmentId}`;
  const alias = 'primary' + sample.EnvironmentId.replaceAll('-', '');
  for (const payload of [
    metadata(sample.EnvironmentId),
    metadata(`Default-${sample.EnvironmentId}`),
    metadata(`Legacy-${sample.EnvironmentId}`),
    { ...metadata(canonical), environmentId: sample.EnvironmentId },
    { ...metadata(canonical), environmentId: null },
    { value: [metadata(canonical), metadata(alias)] }
  ]) {
    const f = fixture();
    f.response = () => Response.json(payload);
    assert.equal(await run(command(alias), f), 3, f.err);
    assert.match(f.err, /exactly the requested environment/);
    assert.equal(f.requests.length, 1);
  }
});

test('exact selected environment can be resolved from a list without using unrelated records', async () => {
  const f = fixture();
  f.response = () => Response.json({ value: [metadata('99999999-9999-9999-9999-999999999999'), metadata()] });
  assert.equal(await run(command(), f), 0, f.err);
});

test('missing tenant uses only a token-free Dataverse challenge from the returned instance', async () => {
  const f = fixture();
  f.response = request => request.url.startsWith(resource)
    ? Response.json(metadata(sample.EnvironmentId, { createdBy: { tenantId: '99999999-9999-9999-9999-999999999999' },
      linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm.dynamics.com/' } }))
    : new Response(null, { status: 401, headers: {
      'www-authenticate': `Bearer authorization_uri="https://login.microsoftonline.com/${sample.TenantId}/oauth2/authorize", resource_id="https://contoso.crm.dynamics.com"`
    } });
  assert.equal(await run(command(), f), 0, f.err);
  assert.deepEqual(JSON.parse(f.err), { cloud: 'Public', environmentId: sample.EnvironmentId,
    tenantId: sample.TenantId, source: 'dataverse-challenge' });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, 'https://contoso.crm.dynamics.com/api/data/v9.2/');
  assert.equal(f.requests[1].headers.has('authorization'), false);
  assert.equal(f.cli.calls.filter(args => args[1] === 'get-access-token').length, 1);
});

test('challenge authority parameters accept whitespace around equals', async () => {
  const f = fixture();
  f.response = request => request.url.startsWith(resource)
    ? Response.json(metadata(sample.EnvironmentId, { linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm.dynamics.com' } }))
    : new Response(null, { status: 401, headers: {
      'www-authenticate': `Bearer resource_id="https://contoso.crm.dynamics.com", authorization_uri = "https://login.microsoftonline.com/${sample.TenantId}/oauth2/authorize"`
    } });
  assert.equal(await run(command(), f), 0, f.err);
  assert.equal(JSON.parse(f.err).tenantId, sample.TenantId);
});

for (const cloud of ['Tip1', 'Tip2', 'Gcc', 'GccHigh', 'DoD', 'Mooncake', 'Germany'])
  test(`no guessed directory route or credential request for ${cloud}`, async () => {
    const f = fixture();
    assert.equal(await run(command(sample.EnvironmentId, cloud), f), 2);
    assert.match(f.err, /Public|cloud/i);
    assert.equal(f.cli.calls.length, 0); assert.equal(f.requests.length, 0);
  });

test('invalid options and environment IDs fail before CLI or HTTP', async () => {
  for (const args of [command('../bad'), command(''), [...command(), '--tenant', sample.TenantId],
    [...command(), '--audience', resource], ['resolve-environment', '--environment', sample.EnvironmentId]]) {
    const f = fixture();
    assert.equal(await run(args, f), 2); assert.equal(f.cli.calls.length, 0); assert.equal(f.requests.length, 0);
  }
});
test('discovery argument errors do not incorrectly require a profile', async () => {
  const f = fixture();
  assert.equal(await run([...command(), '--profile', 'unused'], f), 2);
  assert.doesNotMatch(f.err, /explicit --profile is required/);
  assert.equal(f.cli.calls.length, 0);
});

for (const payload of [
  metadata(`prefix-${sample.EnvironmentId}`),
  metadata('99999999-9999-9999-9999-999999999999'),
  { value: [metadata(), metadata()] },
  { ...metadata(), id: '/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/99999999-9999-9999-9999-999999999999' },
  metadata(sample.EnvironmentId, { tenantId: 'invalid' }),
  metadata(sample.EnvironmentId, { tenantId: sample.TenantId, linkedEnvironmentMetadata: { tenantId: '99999999-9999-9999-9999-999999999999' } }),
  metadata(sample.EnvironmentId, { createdBy: { tenantId: sample.TenantId } }),
  null
]) test('unmatched, ambiguous or incomplete metadata never substitutes the current tenant', async () => {
  const f = fixture(); f.response = () => Response.json(payload);
  assert.notEqual(await run(command(), f), 0);
  assert.match(f.err, /environment|tenant|metadata/i); assert.equal(f.requests.length, 1);
  assert.doesNotMatch(f.err, /99999999|createdBy/);
});

for (const url of ['http://contoso.crm.dynamics.com', 'https://localhost/', 'https://crm.dynamics.com.evil.invalid/',
  'https://contoso.crm.dynamics.com:444/', 'https://user@contoso.crm.dynamics.com/', 'https://contoso.crm.dynamics.com/path',
  'https://contoso.crm.dynamics.com/?redirect=elsewhere'])
  test(`untrusted Dataverse address is rejected without a second request: ${url}`, async () => {
    const f = fixture();
    f.response = () => Response.json(metadata(sample.EnvironmentId, { linkedEnvironmentMetadata: { instanceUrl: url } }));
    assert.notEqual(await run(command(), f), 0); assert.equal(f.requests.length, 1);
  });

for (const header of [
  'Bearer authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize"',
  `Bearer authorization_uri="https://evil.invalid/${sample.TenantId}/oauth2/authorize"`,
  `Basic authorization_uri="https://login.microsoftonline.com/${sample.TenantId}/oauth2/authorize"`,
  `Bearer authorization_uri="https://login.microsoftonline.com/${sample.TenantId}/oauth2/authorize", authorization_uri=https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/oauth2/authorize`,
  `Bearer authorization_uri="https://login.microsoftonline.com/${sample.TenantId}/oauth2/authorize", authorization_uri = "https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/oauth2/authorize"`,
  `Bearer authorization_uri="https://login.microsoftonline.com/${sample.TenantId}/oauth2/authorize", authorization_uri="https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/oauth2/authorize"`
]) test('invalid or ambiguous challenge cannot choose an authority or tenant', async () => {
  const f = fixture();
  f.response = request => request.url.startsWith(resource)
    ? Response.json(metadata(sample.EnvironmentId, { linkedEnvironmentMetadata: { instanceUrl: 'https://contoso.crm.dynamics.com' } }))
    : new Response(null, { status: 401, headers: { 'www-authenticate': header } });
  assert.notEqual(await run(command(), f), 0); assert.equal(f.requests.length, 2);
});

for (const status of [301, 302, 401, 403, 404, 429, 500])
  test(`HTTP ${status} is sanitized with no retry or resource fallback`, async () => {
    const f = fixture();
    f.response = () => new Response('private-body-sentinel', { status, headers: { location: 'https://evil.invalid/' } });
    assert.notEqual(await run(command(), f), 0);
    assert.match(f.err, new RegExp(`HTTP ${status}`)); assert.doesNotMatch(f.err, /private-body|evil/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.cli.calls.filter(args => args[1] === 'get-access-token').length, 1);
  });

test('CLI/token failures and principal drift fail closed without leaking output', async () => {
  for (const change of [
    f => { f.cli.tokenError = 'AADSTS65001 private-cli-sentinel'; },
    f => { f.cli.tokenOutput = token({ aud: 'https://api.powerplatform.com' }); },
    f => { f.cli.userType = 'servicePrincipal'; },
    f => { f.cli.cloud = 'AzureUSGovernment'; },
    f => { f.cli.tenant = 'select'; },
    f => { f.cli.afterToken = () => { f.cli.user = 'other@example.invalid'; }; }
  ]) {
    const f = fixture(); change(f);
    assert.notEqual(await run(command(), f), 0); assert.equal(f.requests.length, 0);
    assert.doesNotMatch(f.err, /private-cli|accessToken|eyJ|other@example/);
  }
  const f = fixture(); f.response = () => { f.cli.user = 'other@example.invalid'; return Response.json(metadata()); };
  assert.notEqual(await run(command(), f), 0);
  assert.match(f.err, /account|changed/i); assert.doesNotMatch(f.err, /other@example/);
});

test('malformed and oversized metadata bodies are rejected', async () => {
  for (const content of ['{broken private-body-sentinel', ' '.repeat(1024 * 1024 + 1)]) {
    const f = fixture(); f.response = () => new Response(content);
    assert.notEqual(await run(command(), f), 0);
    assert.match(f.err, /metadata|size/i); assert.doesNotMatch(f.err, /private-body/);
  }
});
test('metadata at the one-MiB boundary is accepted', async () => {
  const f = fixture(), body = JSON.stringify(metadata());
  f.response = () => new Response(body + ' '.repeat(1024 * 1024 - Buffer.byteLength(body)));
  assert.equal(await run(command(), f), 0, f.err);
  assert.equal(JSON.parse(f.err).tenantId, sample.TenantId);
});

test('cancellation does not start discovery and active cancellation aborts the owned request', async () => {
  const f = fixture();
  assert.equal(await run(command(), { ...f, signal: AbortSignal.abort() }), 130);
  assert.equal(f.cli.calls.length, 0); assert.equal(f.requests.length, 0);
  const active = fixture(), controller = new AbortController();
  active.response = request => { controller.abort(); return new Promise((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  }); };
  assert.equal(await run(command(), { ...active, signal: controller.signal }), 130);
  assert.equal(active.requests[0].signal.aborted, true);
});

test('HTTP deadline includes a response body that never finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let cancelled = false;
  f.response = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = run(command(), f);
  await setImmediate();
  t.mock.timers.tick(20000);
  assert.notEqual(await pending, 0);
  assert.match(f.err, /timed out/i); assert.equal(cancelled, true);
});

test('Public setup discovers tenant before offline config and documents the explicit fallback', async () => {
  for (const file of ['../README.md', '../skills/setup/SKILL.md', '../references/connection-patterns.md']) {
    const content = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(content.indexOf('resolve-environment --cloud Public --environment') >= 0, file);
    assert.ok(content.indexOf('resolve-environment --cloud Public --environment') <
      content.indexOf('config --profile work --cloud'), file);
    assert.match(content, /config[^.\n]*offline/i, file);
    assert.match(content, /manual|explicitly confirmed/i, file);
    assert.match(content, /Public.*discovery|discovery.*Public/i, file);
  }
  const setup = await readFile(new URL('../skills/setup/SKILL.md', import.meta.url), 'utf8');
  assert.match(setup, /[Dd]o not ask.*tenant.*up front/);
});

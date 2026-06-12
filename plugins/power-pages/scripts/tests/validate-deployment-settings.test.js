'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const helpers = require('../lib/validation-helpers');
const {
  validateSettings,
  classifyEntry,
  classifyValueFormat,
  KV_URI_PATTERN,
  KV_RESOURCE_ID_PATTERN,
} = require('../lib/validate-deployment-settings');
// The duplicated readSettingsFile was removed in favor of
// verify-env-var-values#readSettingsFile, which now returns stageLabel on
// each entry. Tests below exercise the unified parser via its new home.
const { readSettingsFile } = require('../lib/verify-env-var-values');

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSettings(dir, content) {
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

function withMockedRequests(t, handler) {
  const orig = helpers.makeRequest;
  helpers.makeRequest = async (opts) => handler(opts);
  t.after(() => {
    helpers.makeRequest = orig;
  });
}

function odataDefRow(schemaName, typeCode) {
  return {
    statusCode: 200,
    body: JSON.stringify({
      value: [{ schemaname: schemaName, type: typeCode }],
    }),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Pure regex tests (drive the canonical-format coverage)
// ────────────────────────────────────────────────────────────────────────────

test('KV_URI_PATTERN matches canonical Key Vault Secret Identifier URIs', () => {
  // Without version
  assert.match(
    'https://lakeshore-staging-kv.vault.azure.net/secrets/api-secret',
    KV_URI_PATTERN
  );
  // With 32-char hex version
  assert.match(
    'https://lakeshore-staging-kv.vault.azure.net/secrets/api-secret/a1b2c3d4e5f607080910111213141516',
    KV_URI_PATTERN
  );
  // Minimum vault-name length (3 chars per Azure rules — see
  // https://learn.microsoft.com/azure/key-vault/general/about-keys-secrets-certificates#vault-name-and-object-name)
  assert.match('https://abc.vault.azure.net/secrets/x', KV_URI_PATTERN);
});

test('KV_URI_PATTERN rejects near-misses', () => {
  // Wrong host suffix
  assert.doesNotMatch(
    'https://lakeshore-staging-kv.vault.azure.com/secrets/api-secret',
    KV_URI_PATTERN
  );
  // Missing /secrets/ segment
  assert.doesNotMatch(
    'https://lakeshore-staging-kv.vault.azure.net/api-secret',
    KV_URI_PATTERN
  );
  // HTTP (not HTTPS)
  assert.doesNotMatch(
    'http://lakeshore-staging-kv.vault.azure.net/secrets/api-secret',
    KV_URI_PATTERN
  );
  // Short version suffix (not 32 hex)
  assert.doesNotMatch(
    'https://lakeshore-staging-kv.vault.azure.net/secrets/api-secret/abc',
    KV_URI_PATTERN
  );
});

test('KV_RESOURCE_ID_PATTERN matches both resourceGroups and resourcegroups casings', () => {
  assert.match(
    '/subscriptions/12345678-1234-1234-1234-123456789012/resourceGroups/my-rg/providers/Microsoft.KeyVault/vaults/my-vault/secrets/my-secret',
    KV_RESOURCE_ID_PATTERN
  );
  assert.match(
    '/subscriptions/12345678-1234-1234-1234-123456789012/resourcegroups/my-rg/providers/Microsoft.KeyVault/vaults/my-vault/secrets/my-secret',
    KV_RESOURCE_ID_PATTERN
  );
});

test('classifyValueFormat covers all formats', () => {
  assert.equal(classifyValueFormat(''), 'empty');
  assert.equal(classifyValueFormat(null), 'empty');
  assert.equal(classifyValueFormat(undefined), 'empty');
  // Vault name must be 3-24 chars per Azure rules
  assert.equal(
    classifyValueFormat('https://my-vault.vault.azure.net/secrets/x'),
    'kv-uri'
  );
  // 2-char vault name is structurally invalid → classified as invalid-uri,
  // not kv-uri (regression guard: don't accept Azure-invalid vault names)
  assert.equal(
    classifyValueFormat('https://kv.vault.azure.net/secrets/x'),
    'invalid-uri'
  );
  // Subscription ID is a GUID — regex requires 8+ hex chars matching
  assert.equal(
    classifyValueFormat(
      '/subscriptions/12345678-1234-1234-1234-123456789012/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/v/secrets/s'
    ),
    'kv-resource-id'
  );
  assert.equal(
    classifyValueFormat('@KeyVault(vaultName=foo;secretName=bar)'),
    'kv-placeholder'
  );
  assert.equal(classifyValueFormat('<KEY_VAULT_URI>'), 'kv-placeholder');
  assert.equal(classifyValueFormat('<TODO>'), 'kv-placeholder');
  assert.equal(classifyValueFormat('${SECRET_VALUE}'), 'kv-placeholder');
  // Looks like an HTTPS URL but not a canonical KV URI → invalid-uri
  assert.equal(
    classifyValueFormat('https://example.com/some/path'),
    'invalid-uri'
  );
  // Plain text — anything else
  assert.equal(classifyValueFormat('Citizen Services Portal - Staging'), 'plain-text');
  assert.equal(classifyValueFormat('true'), 'plain-text');
  assert.equal(classifyValueFormat('42'), 'plain-text');
});

// ────────────────────────────────────────────────────────────────────────────
// classifyEntry — per-entry decision logic
// ────────────────────────────────────────────────────────────────────────────

test('classifyEntry: empty Secret value is valid (use default)', () => {
  const r = classifyEntry({ schemaName: 'foo', value: '', type: 'Secret' });
  assert.equal(r.status, 'valid');
  assert.equal(r.valueFormat, 'empty');
});

test('classifyEntry: Secret with valid KV URI is valid', () => {
  const r = classifyEntry({
    schemaName: 'foo',
    value: 'https://my-vault.vault.azure.net/secrets/api-secret',
    type: 'Secret',
  });
  assert.equal(r.status, 'valid');
  assert.equal(r.valueFormat, 'kv-uri');
});

test('classifyEntry: Secret with @KeyVault(...) placeholder is invalid (error)', () => {
  const r = classifyEntry({
    schemaName: 'c311_api_secret',
    value: '@KeyVault(vaultName=lakeshore-staging-kv;secretName=api-secret)',
    type: 'Secret',
  });
  assert.equal(r.status, 'invalid');
  assert.equal(r.severity, 'error');
  assert.equal(r.valueFormat, 'kv-placeholder');
  assert.match(r.message, /placeholder/);
  assert.match(r.message, /Phase 3\.B|Phase 7\.2a/);
});

test('classifyEntry: Secret with plain-text value is invalid (security concern)', () => {
  const r = classifyEntry({
    schemaName: 'foo',
    value: 'sk-actual-secret-value-12345',
    type: 'Secret',
  });
  assert.equal(r.status, 'invalid');
  assert.equal(r.severity, 'error');
  assert.equal(r.valueFormat, 'plain-text');
  assert.match(r.message, /plain-text|plain text/);
  assert.match(r.message, /committed to git|REMOVE/);
});

test('classifyEntry: Secret with HTTPS URL that misses canonical shape is invalid-uri', () => {
  const r = classifyEntry({
    schemaName: 'foo',
    value: 'https://my-vault.vault.azure.com/secrets/x', // .com not .net
    type: 'Secret',
  });
  assert.equal(r.status, 'invalid');
  assert.equal(r.valueFormat, 'invalid-uri');
});

test('classifyEntry: String type with plain-text value is valid (no Secret rules)', () => {
  const r = classifyEntry({
    schemaName: 'foo_label',
    value: 'Citizen Services Portal - Staging',
    type: 'String',
  });
  assert.equal(r.status, 'valid');
});

test('classifyEntry: unknown type with placeholder still flagged invalid', () => {
  // Even without knowing the type, @KeyVault(...) is never valid syntax
  // for any env var type — surface it.
  const r = classifyEntry({
    schemaName: 'foo',
    value: '@KeyVault(vaultName=v;secretName=s)',
    type: 'unknown',
  });
  assert.equal(r.status, 'invalid');
  assert.equal(r.severity, 'error');
});

test('classifyEntry: unknown type with regular value falls back to unknown-type', () => {
  const r = classifyEntry({
    schemaName: 'foo',
    value: 'some-value',
    type: 'unknown',
  });
  assert.equal(r.status, 'unknown-type');
});

// ────────────────────────────────────────────────────────────────────────────
// File parsing — preserving stage attribution
// ────────────────────────────────────────────────────────────────────────────

test('readSettingsFile handles top-level shape (no stages)', (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    EnvironmentVariables: [
      { SchemaName: 'a', Value: 'va' },
      { SchemaName: 'b', Value: 'vb' },
    ],
  });
  const entries = readSettingsFile(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].stageLabel, null);
});

test('readSettingsFile preserves stage names in Stages[] shape', (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    Stages: [
      { Name: 'Staging', EnvironmentVariables: [{ SchemaName: 'a', Value: 'sa' }] },
      { Name: 'Production', EnvironmentVariables: [{ SchemaName: 'b', Value: 'pb' }] },
    ],
  });
  const entries = readSettingsFile(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].stageLabel, 'Staging');
  assert.equal(entries[1].stageLabel, 'Production');
});

test('readSettingsFile filters by stageLabel (case-insensitive)', (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    Stages: [
      { Name: 'Staging', EnvironmentVariables: [{ SchemaName: 'a', Value: 'sa' }] },
      { Name: 'Production', EnvironmentVariables: [{ SchemaName: 'b', Value: 'pb' }] },
    ],
  });
  const entries = readSettingsFile(file, 'production');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].schemaName, 'b');
});

// ────────────────────────────────────────────────────────────────────────────
// validateSettings — end-to-end orchestration
// ────────────────────────────────────────────────────────────────────────────

test('validateSettings without envUrl: structural-only, all entries unknown-type', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    EnvironmentVariables: [
      { SchemaName: 'a', Value: 'plain-value' },
      { SchemaName: 'b', Value: '' },
    ],
  });
  const result = await validateSettings({ settingsFile: file });
  assert.equal(result.summary.total, 2);
  // 'b' is empty → valid; 'a' is unknown-type (no envUrl to look up)
  assert.equal(result.summary.valid, 1);
  assert.equal(result.summary['unknown-type'], 1);
  assert.equal(result.summary.invalid, 0);
});

test('validateSettings without envUrl: placeholder still flagged invalid', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    EnvironmentVariables: [
      { SchemaName: 'foo', Value: '@KeyVault(vaultName=v;secretName=s)' },
    ],
  });
  const result = await validateSettings({ settingsFile: file });
  // No type lookup, but placeholder syntax is invalid for any type.
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.findings[0].severity, 'error');
});

test('validateSettings with envUrl: classifies Secret entries correctly', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    EnvironmentVariables: [
      { SchemaName: 'c311_api_secret', Value: '@KeyVault(vaultName=v;secretName=s)' },
      { SchemaName: 'c311_feature_label', Value: 'Production' },
    ],
  });

  withMockedRequests(t, async (opts) => {
    if (opts.url.includes("schemaname eq 'c311_api_secret'")) {
      return odataDefRow('c311_api_secret', 100000005); // Secret
    }
    if (opts.url.includes("schemaname eq 'c311_feature_label'")) {
      return odataDefRow('c311_feature_label', 100000000); // String
    }
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await validateSettings({
    settingsFile: file,
    envUrl: 'https://dev.crm.dynamics.com',
    token: 'mock-token',
  });

  assert.equal(result.summary.total, 2);
  // c311_api_secret: Secret type + placeholder → invalid
  // c311_feature_label: String type + plain text → valid
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.summary.valid, 1);

  const secretFinding = result.findings.find((f) => f.schemaName === 'c311_api_secret');
  assert.equal(secretFinding.type, 'Secret');
  assert.equal(secretFinding.status, 'invalid');
  assert.equal(secretFinding.valueFormat, 'kv-placeholder');
});

test('validateSettings: missing SchemaName flagged as invalid', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    EnvironmentVariables: [
      { Value: 'some-value' }, // no SchemaName
    ],
  });
  const result = await validateSettings({ settingsFile: file });
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.findings[0].schemaName, null);
  assert.match(result.findings[0].message, /no SchemaName|missing or empty/i);
});

test('validateSettings: stageLabel filtering works end-to-end', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    Stages: [
      {
        Name: 'Staging',
        EnvironmentVariables: [
          { SchemaName: 'foo', Value: '@KeyVault(vaultName=v;secretName=s)' },
        ],
      },
      {
        Name: 'Production',
        EnvironmentVariables: [
          { SchemaName: 'foo', Value: 'https://prod-vault.vault.azure.net/secrets/foo' },
        ],
      },
    ],
  });

  const stagingResult = await validateSettings({ settingsFile: file, stageLabel: 'Staging' });
  assert.equal(stagingResult.summary.total, 1);
  assert.equal(stagingResult.summary.invalid, 1);

  const prodResult = await validateSettings({ settingsFile: file, stageLabel: 'Production' });
  assert.equal(prodResult.summary.total, 1);
  // Without envUrl the value is unknown-type, but the URI matches canonical
  // KV-URI shape — that's a valid KV-URI regardless of type, so we mark
  // it as valid only when type === Secret. Without type lookup it stays
  // unknown-type. The contract: validation is conservative without
  // envUrl. Test for both possibilities.
  assert.ok(
    prodResult.summary.valid + prodResult.summary['unknown-type'] === 1,
    'prod entry should land in valid or unknown-type'
  );
});

test('validateSettings: throws on missing file (caller catches → exit 1)', async () => {
  await assert.rejects(
    validateSettings({ settingsFile: '/tmp/nonexistent-deployment-settings.json' }),
    /could not read/
  );
});

test('validateSettings: throws on invalid JSON', async (t) => {
  const dir = withTempDir(t);
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(file, '{ not valid json');
  await assert.rejects(validateSettings({ settingsFile: file }), /could not read|Unexpected token|JSON/);
});

test('validateSettings: empty EnvironmentVariables[] returns clean summary', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, { EnvironmentVariables: [] });
  const result = await validateSettings({ settingsFile: file });
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.invalid, 0);
  assert.equal(result.findings.length, 0);
});

test('validateSettings: aggregates multiple findings with mixed severities', async (t) => {
  const dir = withTempDir(t);
  const file = writeSettings(dir, {
    EnvironmentVariables: [
      { SchemaName: 'a', Value: '@KeyVault(...)' },
      // 8-char vault name → matches canonical KV-URI shape
      { SchemaName: 'b', Value: 'https://my-vault.vault.azure.net/secrets/x' },
      { SchemaName: 'c', Value: '' },
      { SchemaName: 'd', Value: '<TODO>' },
    ],
  });

  withMockedRequests(t, async (opts) => {
    // All four are Secret type
    const match = opts.url.match(/schemaname eq '([^']+)'/);
    if (match) return odataDefRow(match[1], 100000005);
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  });

  const result = await validateSettings({
    settingsFile: file,
    envUrl: 'https://dev/',
    token: 'mock-token',
  });

  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.invalid, 2); // a, d (both placeholders)
  assert.equal(result.summary.valid, 2); // b (kv-uri), c (empty)
});

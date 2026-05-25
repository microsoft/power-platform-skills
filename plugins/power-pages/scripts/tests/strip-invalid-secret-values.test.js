'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripInvalidSecretValues } = require('../lib/strip-invalid-secret-values');

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}

test('strips a single invalid Secret value in the top-level-stage shape, preserves other entries', (t) => {
  const file = tempFile(t, {
    $schema: 'https://schemas.microsoft.com/.../deployment-settings/2024',
    description: 'Per-stage values',
    'Deploy to Staging': {
      EnvironmentVariables: [
        { SchemaName: 'c311_feature_label', Value: 'true' },
        { SchemaName: 'c311_api_secret', Value: '@KeyVault(vaultName=foo;secretName=bar)' },
      ],
      ConnectionReferences: [],
    },
  });

  const result = stripInvalidSecretValues({ settingsFile: file, schemaNames: 'c311_api_secret' });

  assert.equal(result.ok, true);
  assert.equal(result.stripped.length, 1);
  assert.equal(result.stripped[0].schemaName, 'c311_api_secret');
  assert.equal(result.stripped[0].stage, 'Deploy to Staging');
  assert.match(result.stripped[0].previousValue, /@KeyVault/);
  assert.deepEqual(result.notFound, []);

  // Verify the file on disk
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after['Deploy to Staging'].EnvironmentVariables[0].Value, 'true', 'other entry preserved');
  assert.equal(after['Deploy to Staging'].EnvironmentVariables[1].Value, '', 'invalid entry stripped to empty string');
  // Shape preserved
  assert.deepEqual(after['Deploy to Staging'].ConnectionReferences, []);
  assert.equal(after.$schema, 'https://schemas.microsoft.com/.../deployment-settings/2024');
});

test('strips entries across MULTIPLE stages when --stageLabel is omitted', (t) => {
  const file = tempFile(t, {
    'Deploy to Staging': {
      EnvironmentVariables: [
        { SchemaName: 'c311_api_secret', Value: '@KeyVault(staging-bad)' },
      ],
    },
    'Deploy to Production': {
      EnvironmentVariables: [
        { SchemaName: 'c311_api_secret', Value: '@KeyVault(prod-bad)' },
      ],
    },
  });

  const result = stripInvalidSecretValues({ settingsFile: file, schemaNames: 'c311_api_secret' });

  assert.equal(result.stripped.length, 2);
  assert.equal(result.totalStagesScanned, 2);
  const stages = result.stripped.map((s) => s.stage).sort();
  assert.deepEqual(stages, ['Deploy to Production', 'Deploy to Staging']);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after['Deploy to Staging'].EnvironmentVariables[0].Value, '');
  assert.equal(after['Deploy to Production'].EnvironmentVariables[0].Value, '');
});

test('--stageLabel scopes the strip to one stage, leaves other stages untouched', (t) => {
  const file = tempFile(t, {
    'Deploy to Staging': {
      EnvironmentVariables: [
        { SchemaName: 'c311_api_secret', Value: '@KeyVault(staging-bad)' },
      ],
    },
    'Deploy to Production': {
      EnvironmentVariables: [
        { SchemaName: 'c311_api_secret', Value: '@KeyVault(prod-bad)' },
      ],
    },
  });

  const result = stripInvalidSecretValues({
    settingsFile: file,
    schemaNames: 'c311_api_secret',
    stageLabel: 'Deploy to Staging',
  });

  assert.equal(result.stripped.length, 1);
  assert.equal(result.stripped[0].stage, 'Deploy to Staging');
  assert.equal(result.totalStagesScanned, 1);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after['Deploy to Staging'].EnvironmentVariables[0].Value, '', 'staging stripped');
  assert.equal(after['Deploy to Production'].EnvironmentVariables[0].Value, '@KeyVault(prod-bad)',
    'production left alone — caller scoped to staging only');
});

test('handles the nested-`stages` shape too', (t) => {
  const file = tempFile(t, {
    stages: {
      Staging: {
        EnvironmentVariables: [
          { SchemaName: 'c311_secret', Value: '@KeyVault(...)' },
        ],
      },
    },
  });

  const result = stripInvalidSecretValues({ settingsFile: file, schemaNames: 'c311_secret' });
  assert.equal(result.stripped.length, 1);
  assert.equal(result.totalStagesScanned, 1);

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.stages.Staging.EnvironmentVariables[0].Value, '');
});

test('preserves camelCase key shape (schemaName/value) when present', (t) => {
  const file = tempFile(t, {
    Staging: {
      EnvironmentVariables: [
        { schemaName: 'c311_secret', value: '@KeyVault(bad)' },
      ],
    },
  });

  stripInvalidSecretValues({ settingsFile: file, schemaNames: 'c311_secret' });

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The original schemaName/value (camelCase) keys are preserved
  assert.equal(after.Staging.EnvironmentVariables[0].schemaName, 'c311_secret');
  assert.equal(after.Staging.EnvironmentVariables[0].value, '');
});

test('reports notFound for schema names that don\'t exist in any stage', (t) => {
  const file = tempFile(t, {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'c311_real_one', Value: 'ok' },
      ],
    },
  });

  const result = stripInvalidSecretValues({
    settingsFile: file,
    schemaNames: 'c311_does_not_exist,c311_also_missing',
  });

  assert.equal(result.stripped.length, 0);
  assert.deepEqual(result.notFound.sort(), ['c311_also_missing', 'c311_does_not_exist']);

  // File unchanged
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.Staging.EnvironmentVariables[0].Value, 'ok');
});

test('does NOT rewrite the file when no changes were made (idempotent)', (t) => {
  const initialContent = JSON.stringify({
    Staging: { EnvironmentVariables: [{ SchemaName: 'unrelated', Value: 'keep' }] },
  }, null, 2);
  const file = tempFile(t, initialContent);
  const mtimeBefore = fs.statSync(file).mtimeMs;

  // Tiny delay to ensure mtime resolution can see a write if one happens
  return new Promise((resolve) => setTimeout(() => {
    stripInvalidSecretValues({ settingsFile: file, schemaNames: 'unrelated_does_not_match' });
    const mtimeAfter = fs.statSync(file).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, 'file mtime unchanged — no write when no strip happened');
    resolve();
  }, 20));
});

test('skips entries that are already empty (no double-write)', (t) => {
  const file = tempFile(t, {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'c311_secret', Value: '' },
      ],
    },
  });

  const result = stripInvalidSecretValues({ settingsFile: file, schemaNames: 'c311_secret' });
  assert.equal(result.stripped.length, 0, 'already-empty entry is not re-stripped');
});

test('rejects missing --settingsFile', () => {
  assert.throws(
    () => stripInvalidSecretValues({ schemaNames: 'foo' }),
    /--settingsFile is required/
  );
});

test('rejects empty schemaNames', (t) => {
  const file = tempFile(t, { Staging: { EnvironmentVariables: [] } });
  assert.throws(
    () => stripInvalidSecretValues({ settingsFile: file }),
    /must list at least one schema name/
  );
  assert.throws(
    () => stripInvalidSecretValues({ settingsFile: file, schemaNames: '' }),
    /must list at least one schema name/
  );
  assert.throws(
    () => stripInvalidSecretValues({ settingsFile: file, schemaNames: [] }),
    /must list at least one schema name/
  );
});

test('rejects unparseable settings file', (t) => {
  const file = tempFile(t, 'not valid json {{');
  assert.throws(
    () => stripInvalidSecretValues({ settingsFile: file, schemaNames: 'foo' }),
    /not valid JSON/
  );
});

test('rejects missing settings file', () => {
  assert.throws(
    () => stripInvalidSecretValues({ settingsFile: '/nonexistent/path/deployment-settings.json', schemaNames: 'foo' }),
    /settings file not found/
  );
});

test('accepts array form of schemaNames (programmatic use)', (t) => {
  const file = tempFile(t, {
    Staging: {
      EnvironmentVariables: [
        { SchemaName: 'c311_a', Value: '@bad(a)' },
        { SchemaName: 'c311_b', Value: '@bad(b)' },
      ],
    },
  });
  const result = stripInvalidSecretValues({
    settingsFile: file,
    schemaNames: ['c311_a', 'c311_b'],
  });
  assert.equal(result.stripped.length, 2);
});

test('ignores reserved root keys ($schema, description) when scanning stages', (t) => {
  // Regression guard — early implementation tried to scan $schema as a stage block
  // and produced spurious "no EnvironmentVariables array" warnings. The current
  // implementation skips $schema / description / stages / EnvironmentVariables /
  // ConnectionReferences at the root.
  const file = tempFile(t, {
    $schema: 'https://...',
    description: 'Some description',
    'Deploy to Staging': {
      EnvironmentVariables: [{ SchemaName: 'c311_secret', Value: '@bad' }],
    },
  });
  const result = stripInvalidSecretValues({ settingsFile: file, schemaNames: 'c311_secret' });
  assert.equal(result.totalStagesScanned, 1, 'only the actual stage was scanned; $schema + description were skipped');
  assert.equal(result.stripped.length, 1);
});

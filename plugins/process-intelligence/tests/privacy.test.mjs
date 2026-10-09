// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundleFixture, pluginRoot } from './bundle-fixtures.mjs';

test('connection guidance describes profile fields, data location and plaintext retention', async () => {
  const text = await readFile(path.join(pluginRoot, 'references', 'connection-patterns.md'), 'utf8');
  for (const field of ['Name', 'Cloud', 'TenantId', 'EnvironmentId', 'Audience', 'HomeAccountId', 'Revision']) {
    assert.match(text, new RegExp(`\\| \`${field}\` \\|`), field);
  }
  assert.match(text, /tenant-local object ID/);
  assert.match(text, /EUII/);
  assert.match(text, /EUPI/);
  assert.match(text, /OII/);
  assert.match(text, /plaintext JSON/i);
  assert.match(text, /no application-level encryption/i);
  assert.match(text, /per-user data directory/i);
  assert.match(text, /no automatic expiry/i);
  assert.doesNotMatch(text, /\| `Claims` \||\.challenge\.json|0700|0600|SDDL/);
  assert.doesNotMatch(text, /\| `AccountUsername` \|/);
  assert.match(text, /AccountUsername` is not persisted/);
  assert.match(text, /username.*transient.*RAM.*EUII/is);
  assert.match(text, /profile name.*EUII/is);
  assert.match(text, /cold.*diagnostics.*cannot verify.*OID/is);
});

test('setup guidance requests manual reauthentication without a claims-persistence workflow', async () => {
  for (const file of ['README.md', 'skills/setup/SKILL.md', 'references/connection-patterns.md']) {
    const text = (await readFile(path.join(pluginRoot, file), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /Conditional Access.*CAE/, file);
    assert.match(text, /login --profile (?:NAME|work) --sign-in true/, file);
    assert.match(text, /pi_activate_profile/, file);
    assert.match(text, /(?:not|never) (?:store|persist|save)[^.]*claims/i, file);
    assert.match(text, /(?:persists|continues)[^.]*administrator|administrator[^.]*policy/i, file);
    assert.doesNotMatch(text, /2\.80|--claims-challenge|\.challenge\.json|migration|legacy.store/i, file);
  }
});

test('setup shows host privacy notice and requires explicit integration instruction before connection', async () => {
  for (const file of ['README.md', 'references/connection-patterns.md', 'skills/setup/SKILL.md']) {
    const text = (await readFile(path.join(pluginRoot, ...file.split('/')), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /personal.*business data/i, file);
    assert.match(text, /unredacted.*customer-selected host/i, file);
    for (const term of ['model routing', 'history', 'retention', 'training', 'geography']) {
      assert.ok(text.toLowerCase().includes(term), `${file}: ${term}`);
    }
    assert.match(text, /settings.*contracts/i, file);
    assert.match(text, /explicit.*(?:instruction|confirmation).*environment.*host/i, file);
    assert.match(text, /installation.*not.*permission/i, file);
  }
  const setup = await readFile(path.join(pluginRoot, 'skills', 'setup', 'SKILL.md'), 'utf8');
  const beforeConnection = setup.slice(0, setup.indexOf('1. Check Node'));
  assert.match(beforeConnection, /Show.*notice/is);
  assert.match(beforeConnection, /AskUserQuestion/);
  assert.match(beforeConnection, /Do you instruct.*selected environment.*selected host/is);
  assert.match(beforeConnection, /Do not proceed.*until.*explicit/is);
  assert.match(beforeConnection, /not.*admin.*consent|not.*tenant.*control/is);
  assert.match(setup, /local diagnostics cannot verify.*OID/is);
  assert.match(setup, /username.*RAM/i);
});

test('local export and removal guidance separates selected files from shared credentials and host history', async () => {
  const text = await readFile(path.join(pluginRoot, 'references', 'connection-patterns.md'), 'utf8');
  for (const location of [
    '%LOCALAPPDATA%\\ProcessIntelligenceBridgeAzureCli',
    '~/Library/Application Support/ProcessIntelligenceBridgeAzureCli',
    '$XDG_DATA_HOME/ProcessIntelligenceBridgeAzureCli',
    '~/.local/share/ProcessIntelligenceBridgeAzureCli'
  ]) assert.ok(text.includes(location), location);
  assert.match(text, /work\.json/);
  assert.doesNotMatch(text, /work\.challenge\.json/);
  assert.match(text, /stop only.*affected.*sessions/i);
  assert.match(text, /export.*user-controlled.*directory/is);
  assert.match(text, /remove exactly.*work\.json/is);
  assert.match(text, /no wildcards|never use wildcards/i);
  assert.match(text, /local user/i);
  assert.match(text, /tenant administrator/i);
  assert.match(text, /host\/provider/i);
  assert.match(text, /backups.*exports/is);
  assert.match(text, /logout.*keeps.*configuration/is);
});

test('runtime has no claims persistence or explicit state permission enforcement', async () => {
  for (const file of ['src/private-files.mjs', 'src/state.mjs', 'src/connection-session.mjs', 'src/authentication.mjs',
    'src/http-auth.mjs', 'src/process.mjs', 'server/mcp.mjs']) {
    const text = await readFile(path.join(pluginRoot, file), 'utf8');
    assert.doesNotMatch(text,
      /normalizeClaims|readClaims|saveChallenge|loadChallenge|verifyPrivate|\.challenge\.json|--claims-challenge|icacls\.exe|whoami\.exe|powershell\.exe|SetAccessControl|\b(?:chmod|chown)\s*\(|0o(?:600|700)/,
      file);
  }
});

test('report drafts use supplied information without log collection or automatic submission', async () => {
  const skill = await readFile(path.join(pluginRoot, 'skills', 'report-issue', 'SKILL.md'), 'utf8');
  assert.match(skill, /allowed-tools: AskUserQuestion/);
  assert.doesNotMatch(skill, /telemetry|--session|--visibility|Read, Bash|provenance|optional collection/i);
  assert.match(skill, /user.*supplied/i);
  assert.match(skill, /Do not.*(?:collect|read).*logs/i);
  assert.match(skill, /Stop at the draft/);
  assert.match(skill, /explicit approval.*exact destination/i);
});

test('package and runtime contain no optional telemetry implementation or configuration', async () => {
  for (const file of ['src/telemetry', 'src/vendor/power-platform-telemetry', 'server/telemetry/ikey.json',
    'skills/telemetry/SKILL.md', 'references/telemetry.md'])
    await assert.rejects(access(path.join(pluginRoot, file)), { code: 'ENOENT' });
  const meta = JSON.parse(await readFile(path.join(pluginRoot, 'server', 'bundle-meta.json'), 'utf8'));
  assert.ok(Object.keys(meta.inputs).every(file => !/telemetry|vendor\//i.test(file)));
  const runtime = await readFile(path.join(pluginRoot, 'server', 'mcp.mjs'), 'utf8');
  assert.doesNotMatch(runtime, /ObservationSession|TelemetryPolicy|TelemetryEmitter|LocalMirror|OneCollector|privacyReady|instrumentationKey|operation_completed|\.power-platform-skills/);
});

test('source and bundle reject telemetry commands and leave former user settings untouched', async t => {
  const f = await bundleFixture(t), file = path.join(f.home, '.power-platform-skills');
  // A file where the former settings directory lived also detects attempted traversal.
  const sentinel = 'existing user data must not be read, migrated or cleared';
  await writeFile(file, sentinel);
  const profileBefore = await readFile(path.join(f.state.root, 'sample.json'), 'utf8');
  for (const entry of [path.join(pluginRoot, 'src', 'entry.mjs'), path.join(f.plugin, 'server', 'mcp.mjs')]) {
    const invoke = args => spawnSync(process.execPath, [entry, ...args],
      { env: f.env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
    const help = invoke(['--help']);
    assert.equal(help.status, 0, help.stderr); assert.doesNotMatch(help.stderr, /telemetry/i);
    for (const action of ['status', 'on', 'off', 'report']) {
      const result = invoke(['telemetry', '--action', action]);
      assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /Unknown command/);
      assert.equal(result.stdout, '');
    }
    const local = invoke(['diagnostics', '--profile', 'sample']);
    assert.equal(local.status, 0, local.stderr); assert.equal(local.stdout, '');
    assert.equal(await readFile(file, 'utf8'), sentinel);
    assert.equal(await readFile(path.join(f.state.root, 'sample.json'), 'utf8'), profileBefore);
  }
});

test('existing preference and log files remain untouched even with an old installed sidecar', async t => {
  const f = await bundleFixture(t);
  const files = new Map([
    [path.join(f.configDir, 'config.json'), JSON.stringify({ telemetry: { 'process-intelligence': 'on', 'another-plugin': 'off' } })],
    [path.join(f.configDir, 'telemetry', 'process-intelligence', 'sessions', 'old-session', 'events.jsonl'), 'private user history\n'],
    [path.join(f.plugin, 'server', 'telemetry', 'ikey.json'), '{"schemaVersion":1,"disabled":false,"privacyReady":true,"routes":[]}']
  ]);
  for (const [file, text] of files) {
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text);
  }
  for (const [args, status] of [[['--help'], 0], [['diagnostics', '--profile', 'sample'], 0],
    [['telemetry', '--action', 'off'], 2]]) {
    const result = spawnSync(process.execPath, [path.join(f.plugin, 'server', 'mcp.mjs'), ...args],
      { env: f.env, cwd: f.temp, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, status, result.stderr); assert.equal(result.stdout, '');
  }
  for (const [file, text] of files) assert.equal(await readFile(file, 'utf8'), text);
  await assert.rejects(access(path.join(f.configDir, '.process-intelligence')), { code: 'ENOENT' });
});

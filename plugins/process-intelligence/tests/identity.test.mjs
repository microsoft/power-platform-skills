// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '..', '..');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
test('public plugin identity and lockfile match the marketplace entry', async () => {
  assert.equal(path.basename(root), 'process-intelligence');
  for (const file of ['package.json', '.plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const manifest = await json(path.join(root, file));
    assert.equal(manifest.name, 'process-intelligence');
    assert.equal(manifest.version, '0.7.0');
  }
  const lock = await json(path.join(root, 'package-lock.json'));
  assert.equal(lock.name, 'process-intelligence');
  assert.equal(lock.packages[''].name, 'process-intelligence');
  assert.equal(lock.packages[''].dependencies['@modelcontextprotocol/sdk'], '1.30.0');
  assert.deepEqual(Object.keys((await json(path.join(root, '.mcp.json'))).mcpServers), ['process-intelligence']);
  for (const file of ['marketplace.json', '.claude-plugin/marketplace.json']) {
    const index = await json(path.join(workspace, file));
    assert.equal(index.name, 'power-platform-skills');
    assert.deepEqual(index.owner, { name: 'Microsoft' });
    assert.equal(index.metadata.pluginRoot, '.');
    const entries = index.plugins.filter(entry => entry.name === 'process-intelligence');
    assert.deepEqual(entries, [{ name: 'process-intelligence', source: './plugins/process-intelligence' }]);
    assert.ok(index.plugins.length > 1);
  }
});

test('plugin CI is path-filtered, read-only and runs the local build and test entrypoints', async () => {
  const manifest = await json(path.join(root, 'package.json'));
  assert.equal(manifest.scripts.test, 'node scripts/test.mjs');
  assert.equal(manifest.scripts.build, 'node scripts/build.mjs');
  await fs.access(path.join(root, 'scripts', 'test.mjs'));
  const workflowFile = '.github/workflows/process-intelligence-script-tests.yml';
  await assert.doesNotReject(fs.access(path.join(workspace, workflowFile)), 'Plugin CI must exist');
  const workflow = (await fs.readFile(path.join(workspace, workflowFile), 'utf8')).replace(/\r\n/g, '\n');
  // Match the complete trigger block, not a stray path in a comment or another event.
  const triggers = /^on:\n([\s\S]*?)(?=^\S)/m.exec(workflow)?.[1].trimEnd();
  const paths = ['plugins/process-intelligence/**', 'LICENSE', workflowFile];
  assert.equal(triggers, ['pull_request', 'push'].flatMap(event => [
    `    ${event}:`, '        branches:', '            - main', '        paths:',
    ...paths.map(value => `            - "${value}"`)
  ]).join('\n'));
  assert.match(workflow, /^permissions:\n    contents: read\n/m);
  assert.equal((workflow.match(/^\s*permissions:/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /pull_request_target|secrets[.[\s]|id-token|write-all|: write\b|azure\/login|az login/);
  const actions = [...workflow.matchAll(/^\s+uses: ([^ ]+) # v[\d.]+$/gm)].map(match => match[1]);
  assert.equal(actions.length, 2);
  assert.match(actions[0], /^actions\/checkout@[a-f0-9]{40}$/);
  assert.match(actions[1], /^actions\/setup-node@[a-f0-9]{40}$/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(workflow, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(workflow, /os:\n\s+- ubuntu-latest\n\s+- windows-latest\n\s+- macos-latest\n/);
  assert.match(workflow, /node:\n\s+- 22\n\s+- 24\n/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /working-directory: plugins\/process-intelligence/);
  assert.match(workflow, /shell: bash/);
  assert.deepEqual([...workflow.matchAll(/^\s+run: (.+)$/gm)].map(match => match[1]),
    ['npm ci --no-audit --no-fund', 'npm run build',
      'git diff --exit-code -- server/mcp.mjs server/bundle-meta.json', 'npm test']);
  for (const file of ['AGENTS.md', 'references/development.md']) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /local-only|no automatic CI|do not add automatic CI/i);
    assert.match(text, /path-filtered/i);
  }
});

test('repository README includes installation, local loading and every Process Intelligence skill', async () => {
  const readme = await fs.readFile(path.join(workspace, 'README.md'), 'utf8');
  assert.match(readme, /\/plugin install process-intelligence@power-platform-skills/);
  assert.doesNotMatch(readme, /\b(?:dev(?:elopment)?[- ]only|unpublished|prototype)\b/i);
  const localDevelopment = readme.split('## Local Development')[1]?.split('\n## ')[0];
  assert.ok(localDevelopment?.includes('claude --plugin-dir /path/to/power-platform-skills/plugins/process-intelligence'));
  const catalog = readme.split('### [Process Intelligence]')[1]?.split('\n## ')[0];
  assert.ok(catalog, 'Process Intelligence is missing from Available Plugins');
  const pluginReadme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  for (const entry of await fs.readdir(path.join(root, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.ok(catalog.includes(`/${entry.name}\``), `${entry.name} missing from root catalog`);
    assert.ok(pluginReadme.includes(`skills/${entry.name}/SKILL.md`), `${entry.name} missing from plugin skill table`);
  }
});

test('repository issue selectors include Process Intelligence', async () => {
  for (const file of ['bug_report.yml', 'feature_request.yml']) {
    const form = await fs.readFile(path.join(workspace, '.github', 'ISSUE_TEMPLATE', file), 'utf8');
    assert.equal(form.match(/^\s+- process-intelligence\s*$/gm)?.length, 1, file);
  }
});

test('Process Intelligence is not a telemetry adopter', async () => {
  const readme = await fs.readFile(path.join(workspace, 'README.md'), 'utf8');
  const disclosure = readme.split('## Telemetry')[1];
  assert.doesNotMatch(disclosure, /Process Intelligence/);
  const shared = await fs.readFile(path.join(workspace, 'shared', 'telemetry', 'README.md'), 'utf8');
  assert.doesNotMatch(shared, /Process Intelligence|process-intelligence/);
});

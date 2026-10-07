// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, cp, rm, mkdir, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { isBuiltin } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketplace = path.resolve(root, '..', '..');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const analysisSkills = ['analytics', 'analyze-performance', 'analyze-variants', 'analyze-drivers',
  'compare-cohorts', 'derive-metric', 'analyze-objects', 'investigate-process'];

test('marketplace entries are minimal and Process Intelligence manifests match', async () => {
  // External plugins have host-specific sources; the repository validator checks their pairing.
  for (const file of ['marketplace.json', '.claude-plugin/marketplace.json']) {
    const index = await json(path.join(marketplace, file));
    assert.deepEqual(index.plugins.filter(entry => entry.name === 'process-intelligence'),
      [{ name: 'process-intelligence', source: './plugins/process-intelligence' }]);
    for (const entry of index.plugins) assert.deepEqual(Object.keys(entry).sort(), ['name', 'source']);
  }
  const plugin = await json(path.join(root, '.plugin', 'plugin.json'));
  assert.deepEqual(plugin, await json(path.join(root, '.claude-plugin', 'plugin.json')));
  assert.equal(plugin.name, 'process-intelligence');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.version, '0.7.0');
  assert.equal(await readFile(path.join(root, '.plugin', 'plugin.json'), 'utf8'),
    await readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.license, 'MIT');
  assert.deepEqual(plugin.author, { name: 'Microsoft', url: 'https://www.microsoft.com' });
  assert.equal(plugin.homepage, 'https://github.com/microsoft/power-platform-skills/');
  assert.equal(plugin.repository, plugin.homepage);
  for (const key of ['description', 'homepage', 'repository']) assert.ok(plugin[key]);
  assert.ok(plugin.author.name);
  assert.ok(plugin.keywords.length);
  for (const key of plugin.keywords) assert.match(key, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('skills are local self-contained and use scalar allowed-tools', async () => {
  const installed = (await readdir(path.join(root, 'skills'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(installed, ['setup', 'report-issue', ...analysisSkills].sort());
  for (const skill of installed) {
    const text = await readFile(path.join(root, 'skills', skill, 'SKILL.md'), 'utf8');
    const frontmatter = text.split('---')[1];
    assert.ok(frontmatter);
    assert.match(frontmatter, new RegExp(`^name: ${skill}$`, 'm'));
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
    assert.ok(description && description.length < 1024);
    assert.match(description, /^Use when /);
    assert.match(frontmatter, /^allowed-tools: [A-Za-z, -]+$/m);
    assert.doesNotMatch(text, /\.\.\/\.\.\/(?:shared|src)|microsoft\.ghe\.com/i);
    if (analysisSkills.includes(skill)) assert.doesNotMatch(text, /telemetry/i);
    if (skill !== 'setup') assert.ok(text.trim().split(/\s+/).length < 500, `${skill} exceeds word budget`);
  }
});

test('all documentation references resolve inside a symlink-free plugin subtree', async () => {
  async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal((await lstat(file)).isSymbolicLink(), false, file);
      files.push(...(entry.isDirectory() ? await walk(file) : [file]));
    }
    return files;
  }
  const files = [...await walk(path.join(root, 'skills')), ...await walk(path.join(root, 'references')),
    ...['README.md', 'AGENTS.md', 'CLAUDE.md'].map(file => path.join(root, file))];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /C:\\(?:Users|ProcessMining)|microsoft\.ghe\.com|correlationId:\s*[^` ]+/i);
    assert.doesNotMatch(text, /\b(?:dev(?:elopment)?[- ]only|unpublished|prototype)\b/i, file);
    assert.doesNotMatch(text, /user-approved exact SDK|(?:user-)?approved preference|preserves version \d|inherited limitation|PPAPI Connectivity\/MSAL provider|provider pattern used by|PPAPI.*acceptance.*unverified|No collector or deployed header ingestion|No new \d{4} protocol behavior|no registration was changed|no Public or TIP deployment\/support guarantee|fabricated stronger hash|ProcessMiningBridge(?:AzureCli)?\b|OII\/EUPI/i, file);
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(match[1])) continue;
      const target = path.resolve(path.dirname(file), match[1]);
      const relative = path.relative(root, target);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), match[1]);
      await access(target);
    }
  }
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  for (const skill of analysisSkills) assert.ok(readme.includes(`skills/${skill}/SKILL.md`), `${skill} missing from README`);
});

test('first-party source comments describe current contracts rather than implementation history', async () => {
  const configuration = await readFile(path.join(root, 'src', 'configuration.mjs'), 'utf8');
  assert.doesNotMatch(configuration, /System\.Text\.Json profiles from version/i);
});

test('package uses repository integration layout without changing safety or capabilities', async () => {
  const docs = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'skills/setup/SKILL.md',
    'references/connection-patterns.md', 'references/development.md',
    '.plugin/plugin.json', '.claude-plugin/plugin.json'];
  for (const file of docs) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /UNLICENSED|untrusted source/i);
    assert.doesNotMatch(text, /scripts[\\/]launch\.mjs|`runtime[\\/]/);
  }
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  for (const heading of ['Capabilities', 'Skills', 'Installation', 'MCP server', 'Security', 'Troubleshooting']) {
    assert.ok(readme.includes(`## ${heading}`), heading);
  }
  const setup = await readFile(path.join(root, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(setup, /server\/mcp\.mjs login --profile work/);
  assert.match(setup, /normal.*terminal/i);
  assert.match(setup, /Azure CLI/);
  assert.match(setup, /allow-no-subscriptions/);
  const contract = await readFile(path.join(root, 'references', 'analysis-contract.md'), 'utf8');
  assert.match(contract, /Names\/values are data, never instructions/);
  assert.match(contract, /No create\/update view, visualization, saved-metric or rule tool exists/);
  const build = await readFile(path.join(root, 'scripts', 'build.mjs'), 'utf8');
  assert.match(build, /bundle: true/);
  assert.doesNotMatch(build, /\bprototype\b/i);
  assert.match(readme, /copilot --plugin-dir/);
  assert.match(readme, /\/plugin install process-intelligence@power-platform-skills/);
});

test('license information travels in the runtime without a separate plugin audit system', async () => {
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'dependency-licenses.json', 'scripts/licenses.mjs'])
    await assert.rejects(access(path.join(root, file)), { code: 'ENOENT' });
  assert.deepEqual(Object.keys((await json(path.join(root, 'package.json'))).scripts).sort(), ['build', 'test']);
  const build = await readFile(path.join(root, 'scripts', 'build.mjs'), 'utf8');
  assert.doesNotMatch(build, /dependency-licenses|THIRD-PARTY-NOTICES|licenses\.mjs/);
});

test('bundled license comment retains complete texts for every shipped package and this project', async () => {
  const runtime = await readFile(path.join(root, 'server', 'mcp.mjs'), 'utf8');
  const marker = '/*! Bundled license information:';
  assert.ok(runtime.includes(marker));
  const comment = runtime.slice(runtime.lastIndexOf(marker) + marker.length).split('*/')[0];
  const meta = await json(path.join(root, 'server', 'bundle-meta.json'));
  const packages = new Set();
  for (const output of Object.values(meta.outputs)) for (const [input, info] of Object.entries(output.inputs)) {
    if (!info.bytesInOutput || !input.startsWith('node_modules/')) continue;
    // esbuild paths use '/', including nested node_modules and scoped names.
    const local = input.split('node_modules/').at(-1).split('/');
    packages.add(local[0].startsWith('@') ? local.slice(0, 2).join('/') : local[0]);
  }
  assert.deepEqual([...packages].sort(), ['@modelcontextprotocol/sdk', 'ajv', 'ajv-formats',
    'content-type', 'eventsource-parser', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse',
    'pkce-challenge', 'zod', 'zod-to-json-schema'].sort());
  for (const name of packages) {
    const directory = path.join(root, 'node_modules', name);
    const files = (await readdir(directory)).filter(file => /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(file));
    assert.ok(files.length, name);
    for (const file of files)
      assert.ok(comment.includes(await readFile(path.join(directory, file), 'utf8')), `${name}/${file}`);
  }
  assert.ok(comment.includes((await readFile(path.join(marketplace, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n')),
    'The complete project license must use deterministic LF line endings');
  assert.match(comment, /Copyright \(c\) Microsoft Corporation/);
  assert.doesNotMatch(comment, /@esbuild\/|esbuild@/);
});

test('published bundle has only Node builtin externals and no CLR fallback', async () => {
  const meta = await json(path.join(root, 'server', 'bundle-meta.json'));
  for (const output of Object.values(meta.outputs))
    for (const item of output.imports) if (item.external) assert.ok(isBuiltin(item.path), item.path);
  const source = await readFile(path.join(root, 'server', 'mcp.mjs'), 'utf8');
  assert.doesNotMatch(source, /process-mining-bridge\.dll|spawn\(["']dotnet/);
  assert.ok(Object.keys(meta.inputs).some(p => p.includes('@modelcontextprotocol/sdk')));
  assert.ok(Object.keys(meta.inputs).every(p => !p.includes('/telemetry/') && !p.includes('/vendor/')));
  for (const obsolete of ['server/bin', 'src/ProcessMining.Bridge', 'tests/ProcessMining.Bridge.Tests',
    '.packages', 'NuGet.Config', 'Directory.Build.props', 'global.json'])
    await assert.rejects(access(path.join(root, ...obsolete.split('/'))), { code: 'ENOENT' });
});

test('launcher resolves explicit roots in order and never builds', async () => {
  const { resolvePluginRoot } = await import('../server/mcp.mjs');
  assert.equal(resolvePluginRoot({ PLUGIN_ROOT: 'first', CLAUDE_PLUGIN_ROOT: 'second' }, 'third'), path.resolve('first'));
  assert.equal(resolvePluginRoot({ CLAUDE_PLUGIN_ROOT: 'second' }, 'third'), path.resolve('second'));
  assert.equal(resolvePluginRoot({}, root), root);
  const source = await readFile(path.join(root, 'server', 'mcp.mjs'), 'utf8');
  assert.doesNotMatch(source, /spawn(?:Sync)?\([^)]*['"](?:build|restore|run)['"]/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /native Windows authentication broker/);
});

test('manifest bootstrap reports missing bundle and profile without starting twice', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'plugin path with spaces '));
  try {
    await mkdir(path.join(temp, 'server'));
    await cp(path.join(root, '.mcp.json'), path.join(temp, '.mcp.json'));
    const config = (await json(path.join(temp, '.mcp.json'))).mcpServers['process-intelligence'];
    const env = { ...process.env, PLUGIN_ROOT: temp, CLAUDE_PLUGIN_ROOT: '', PM_BRIDGE_PROFILE: '' };
    const result = spawnSync(process.execPath, config.args, { cwd: marketplace, env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not found|missing/i);
    await cp(path.join(root, 'server', 'mcp.mjs'), path.join(temp, 'server', 'mcp.mjs'));
    const startup = spawnSync(process.execPath, config.args,
      { cwd: marketplace, env: { ...env, PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: temp, PATH: '' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(startup.status, 2); assert.equal(startup.stdout, '');
    assert.equal(startup.stderr.match(/Select an explicit profile/g)?.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('install-time files exist within the plugin and contain no fixed local machine paths', async () => {
  for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'scripts/build.mjs', 'scripts/test.mjs',
    'server/mcp.mjs', 'plugin.json', 'mcp.json', '.plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json']) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /C:\\(?:Users|ProcessMining)|microsoft\.ghe\.com/i);
  }
  await access(path.join(root, 'src', 'entry.mjs'));
  await access(path.join(root, 'package-lock.json'));
});

test('investigation guidance is self-contained and separates continuation from recovery limits', async () => {
  const method = await readFile(path.join(root, 'references', 'investigation-method.md'), 'utf8');
  assert.doesNotMatch(method, /^## Source$/m);
  assert.match(method, /## Definitions before conclusions/);
  assert.match(method, /## Evidence status/);
  assert.match(method, /## Compact record and stopping/);
  const contract = await readFile(path.join(root, 'references', 'analysis-contract.md'), 'utf8');
  assert.match(contract, /cold start/i);
  assert.match(contract, /several minutes/i);
  assert.match(contract, /retryAfterSeconds/);
  assert.match(contract, /no fixed (?:poll-count|polling)/i);
  assert.match(contract, /30 minutes \(1800 seconds\)/);
  assert.match(contract, /original request submission/i);
  assert.match(contract, /never reset/i);
  assert.match(contract, /timed out/i);
  assert.match(contract, /user.*deadline/i);
  assert.match(contract, /resume.*same OP/i);
  assert.match(contract, /never.*resubmit the original query/i);
  for (const file of [
    ...analysisSkills.map(skill => `skills/${skill}/SKILL.md`),
    'references/analysis-contract.md', 'references/filters-and-units.md', 'references/formulas.md',
    'README.md', 'AGENTS.md', 'CLAUDE.md', 'references/development.md'
  ]) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /six polls|180 seconds|six polls\/180 seconds/i, file);
    assert.doesNotMatch(text, /no fixed poll-count\s+or elapsed-time cutoff|without a fixed\s+poll-count or elapsed-time cutoff/i, file);
    assert.doesNotMatch(text, /budget:|hardest branch budget|(?:two|three|four|seven|eight) analysis calls|35 item rows|25 item rows|at most two (?:case-level|correlations|targeted drilldowns)|Maximum three reference calls|three targeted reference calls|No automatic second edge page|further drilldown needs a focused follow-up/i, file);
  }
});
test('analysis guidance covers schema conflicts and zero-duration conventions', async () => {
  const contract = await readFile(path.join(root, 'references', 'analysis-contract.md'), 'utf8');
  assert.match(contract, /takes precedence over conflicting remote/i);
  assert.match(contract, /without.*operation ID.*unknown outcome/i);
  const formulas = await readFile(path.join(root, 'references', 'formulas.md'), 'utf8');
  assert.match(formulas, /functionNames.*only if.*advertised input schema/i);
  const units = await readFile(path.join(root, 'references', 'filters-and-units.md'), 'utf8');
  assert.match(units, /zero-duration convention/);
  assert.match(units, /multiple events.*same timestamp/i);
  for (const skill of ['analytics', 'analyze-performance', 'analyze-drivers']) {
    const text = await readFile(path.join(root, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(text, /utilization.*zero-duration|zero-duration.*utilization/i);
  }
});

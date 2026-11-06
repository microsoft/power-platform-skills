#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'code-apps');
const SKILLS = [
  'add-azuredevops', 'add-connector', 'add-datasource', 'add-dataverse',
  'add-excel', 'add-mcscopilot', 'add-office365', 'add-onedrive',
  'add-sharepoint', 'add-teams', 'add-workiq', 'create-code-app',
  'deploy', 'list-connections', 'report-issue',
];

function readPackageFile(file) {
  const relative = path.relative(fs.realpathSync(PLUGIN), fs.realpathSync(file));
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${file} must remain inside the plugin`);
  assert.ok(fs.lstatSync(file).isFile(), `${file} must be a regular file`);
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function validate() {
  const manifest = JSON.parse(readPackageFile(path.join(PLUGIN, 'plugin.json')));
  assert.equal(manifest.name, 'code-apps-preview', 'preserve the installed plugin identity');
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, 'marketplace.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(codex.name, marketplace.name, 'preserve the marketplace identity');
  // Only Code Apps is adapted here. Listing siblings would imply portable packages they do not supply.
  assert.equal(codex.plugins.length, 1, 'the Codex catalog must expose only Code Apps');
  assert.equal(codex.plugins[0].name, manifest.name);
  assert.deepEqual(codex.plugins[0].source, { source: 'local', path: './plugins/code-apps' });

  const skills = fs.readdirSync(path.join(PLUGIN, 'skills')).sort();
  assert.deepEqual(skills, SKILLS, 'preserve all 15 skill names');
  for (const name of skills) {
    const file = path.join(PLUGIN, 'skills', name, 'SKILL.md');
    const text = readPackageFile(file);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(frontmatter, `${name} must have YAML frontmatter`);
    assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, 'm'), `${name} must match its directory`);
    assert.match(frontmatter[1], /^description: \S/m, `${name} must have a description`);
    const tools = /^allowed-tools: (.+)$/m.exec(frontmatter[1]);
    assert.ok(tools, `${name} must retain its tool declaration`);
    assert.ok(tools[1].split(',').every((tool) => /^[A-Za-z][A-Za-z0-9]*$/.test(tool.trim())),
      `${name} must use the existing comma-separated tool format`);
    assert.match(frontmatter[1], /^user-invocable: true$/m, `${name} must remain user-invocable`);
    assert.match(frontmatter[1], /^model: (sonnet|opus|haiku)$/m, `${name} must retain its model declaration`);
  }

  const agent = 'code-app-architect';
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN, 'agents')), [`${agent}.md`]);
  assert.deepEqual(fs.readdirSync(path.join(PLUGIN, 'com.github.copilot', 'agents')), [`${agent}.agent.md`]);
  const legacy = readPackageFile(path.join(PLUGIN, 'agents', `${agent}.md`));
  const native = readPackageFile(path.join(PLUGIN, 'com.github.copilot', 'agents', `${agent}.agent.md`));
  assert.equal(native, legacy.replaceAll('../shared/', '../../shared/').replaceAll('../skills/', '../../skills/'),
    'the Copilot architect must match the legacy architect except for relative paths');
  assert.deepEqual(
    JSON.parse(readPackageFile(path.join(PLUGIN, 'com.github.copilot', 'hooks', 'hooks.json'))),
    JSON.parse(readPackageFile(path.join(PLUGIN, 'hooks.json'))),
    'portable Copilot hooks must preserve the existing native hook configuration');

  function checkResources(directory) {
    assert.ok(fs.lstatSync(directory).isDirectory(), `${directory} must be a regular directory`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `${file} must not be a symbolic link`);
      if (entry.isDirectory()) {
        checkResources(file);
      } else if (entry.name.endsWith('.md')) {
        const text = readPackageFile(file);
        assert.ok(!/\$\{(?:CLAUDE_)?PLUGIN_ROOT\}/.test(text), `${file} must use document-relative resource paths`);
        for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (target.startsWith('./') || target.startsWith('../')) {
            readPackageFile(path.resolve(path.dirname(file), target.split('#')[0]));
          }
        }
      }
    }
  }
  for (const directory of ['skills', 'shared', 'agents', 'com.github.copilot']) {
    checkResources(path.join(PLUGIN, directory));
  }
}

try {
  validate();
  console.log('Code Apps skill metadata, agent copies, catalog, and resource paths are valid.');
} catch (error) {
  console.error(`Code Apps compatibility check failed: ${error.message}`);
  process.exitCode = 1;
}

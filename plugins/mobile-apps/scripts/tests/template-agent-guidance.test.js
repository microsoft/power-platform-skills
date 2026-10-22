'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const templateRoot = path.resolve(__dirname, '../../template');
const read = (relativePath) => fs.readFileSync(path.join(templateRoot, relativePath), 'utf8');

test('template guidance has one app-local canonical source', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /Expo, React Native, and TypeScript/);
  assert.match(agents, /Power Apps mobile app/);
  assert.match(agents, /skills advertised by the current agent host/);
  for (const skill of ['create-mobile-app', 'edit-app', 'add-native', 'add-datasource', 'debug-app']) {
    assert.ok(agents.includes(`\`${skill}\``), skill);
  }
  assert.match(agents, /Confirmed fresh starter/);
  assert.match(agents, /ask through\s+the host's question tool before loading or invoking `edit-app`/);
  assert.match(agents, /Do not route explanations, typo fixes, or\s+bounded bug fixes through full app planning/);
});

test('Claude and Copilot wrappers resolve to the same app-local guidance', () => {
  const claude = read('CLAUDE.md');
  const copilot = read('.github/copilot-instructions.md');
  assert.equal(claude.trim(), '@AGENTS.md');
  const target = copilot.match(/\[[^\]]+\]\(([^)]*AGENTS\.md)\)/)?.[1];
  assert.equal(target, '../AGENTS.md');
  assert.equal(
    path.resolve(templateRoot, '.github', target),
    path.resolve(templateRoot, claude.trim().slice(1)),
  );
  assert.ok(copilot.trimEnd().split('\n').length <= 3);
  for (const relativePath of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) {
    assert.equal(fs.lstatSync(path.join(templateRoot, relativePath)).isSymbolicLink(), false);
    assert.doesNotMatch(read(relativePath), /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|~\/|\.claude\/plugins|\.copilot\/installed-plugins)/);
  }
  assert.match(read('README.md'), /\[AGENTS\.md\]\(AGENTS\.md\)/);
});

test('plugin fallback matches public manual commands without automatic installation', () => {
  const rootReadme = fs.readFileSync(path.resolve(__dirname, '../../../../README.md'), 'utf8');
  const commands = [
    '/plugin marketplace add microsoft/power-platform-skills',
    '/plugin install mobile-app@power-platform-skills',
  ];
  for (const relativePath of ['AGENTS.md', 'README.md']) {
    const content = read(relativePath);
    for (const command of commands) {
      assert.ok(rootReadme.includes(command));
      assert.ok(content.includes(command));
    }
    assert.match(content, /https:\/\/github\.com\/microsoft\/power-platform-skills#manual-installation/);
    assert.match(content, /inside a Claude Code or GitHub\s+Copilot CLI\s+session/);
  }
  const agents = read('AGENTS.md');
  assert.match(agents, /never install or enable skills automatically/);
  assert.match(agents, /If declined, do not repeatedly prompt/);
  assert.match(agents, /Do not search private\s+plugin caches/);
});

test('startup routing keeps approvals, upgrades, generated ownership, and privacy boundaries', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /startup\s+failures, QR\/Metro connection errors, missing or incorrectly installed dependencies/);
  assert.match(agents, /invoke the available `debug-app`\s+skill before attempting fixes/);
  assert.match(agents, /approval before dependency repair or server restarts/);
  assert.match(agents, /dependency\/template\s+upgrades to `check-updates`/);
  assert.match(agents, /Power Apps generators own `src\/generated\/`/);
  assert.match(agents, /Do not patch `node_modules\/`/);
  assert.match(agents, /pass symptoms and sanitized evidence as JSON task context/);
  assert.match(agents, /Never interpolate these fields into shell commands/);
  assert.match(agents, /Exclude tokens, `\.npmrc` credentials, `\.env\*`/);
});

test('app diagnosis is recommended before reporting without blocking direct or unavailable-skill reports', () => {
  const agents = read('AGENTS.md').replace(/\s+/g, ' ');
  assert.match(agents, /startup failures, QR\/Metro connection errors/);
  assert.match(agents, /invoke the available `debug-app` skill before attempting fixes or escalating to `report-issue`/);
  assert.match(agents, /If `debug-app` is unavailable, follow the opt-in skill installation flow/);

  const readme = read('README.md').replace(/\s+/g, ' ');
  assert.match(readme, /dependency installation, startup, runtime, or QR opening/);
  assert.match(readme, /`\/debug-app` skill first before reporting an issue/);
  assert.match(readme, /recommendation, not a prerequisite/);
  assert.match(readme, /honor explicit direct report requests/);
  assert.match(readme, /Plugin installation\/loading failures can make app diagnosis unavailable/);
  assert.match(readme, /do not block reporting in those cases/);
  assert.doesNotMatch(readme, /`\/?debug-app` agent/);
});

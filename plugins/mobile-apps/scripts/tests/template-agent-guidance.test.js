'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const templateRoot = path.resolve(__dirname, '../../template');
const read = (relativePath) => fs.readFileSync(path.join(templateRoot, relativePath), 'utf8');

test('template guidance has one concise, app-local canonical source', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.trimEnd().split('\n').length <= 90, 'Keep app guidance at most 90 lines');
  assert.match(agents, /Expo \/ React Native \/ TypeScript/);
  assert.match(agents, /Power Apps mobile app/);
  assert.match(agents, /template content, not repository or plugin/);
  assert.match(agents, /advertised skill inventory/);
  for (const skill of ['create-mobile-app', 'edit-app', 'add-native', 'add-datasource', 'debug-app']) {
    assert.ok(agents.includes(`\`${skill}\``), skill);
  }
  assert.match(agents, /fresh only; never rerun over an existing app/);
  assert.match(agents, /Ask before starting costly integration/);
  assert.match(agents, /question or small edit does not require full\s+integration, a deep scan/);
});

test('Claude and Copilot wrappers resolve to the same app-local guidance', () => {
  const claude = read('CLAUDE.md');
  const copilot = read('.github/copilot-instructions.md');
  assert.equal(claude.trim(), '@AGENTS.md');
  const target = copilot.match(/\[AGENTS\.md\]\(([^)]+)\)/)?.[1];
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
    assert.match(content, /inside a Claude Code or GitHub\s+Copilot CLI session|inside a Claude Code or GitHub Copilot\s+CLI session/);
  }
  const agents = read('AGENTS.md');
  assert.match(agents, /Never install automatically/);
  assert.match(agents, /user declines[\s\S]*do not nag/);
  assert.match(agents, /private installation paths/);
});

test('startup routing keeps approvals, upgrades, generated ownership, and privacy boundaries', () => {
  const agents = read('AGENTS.md');
  for (const symptom of ['npm run dev fails', "app won't start", "QR won't open", 'runtime failures']) {
    assert.ok(agents.includes(symptom), symptom);
  }
  assert.match(agents, /before the app has loaded/);
  assert.match(agents, /agent already running creation[\s\S]*reuse `debug-app` startup diagnosis/);
  assert.match(agents, /npm run dev` alone cannot wake an agent/);
  assert.match(agents, /Do not add automatic hooks/);
  assert.match(agents, /Ask before dependency[\s\S]*same-lock restoration[\s\S]*Metro[\s\S]*deployment/);
  assert.match(agents, /upgrades in the separate upgrade workflow/);
  assert.match(agents, /not `debug-app`/);
  assert.match(agents, /Do not delete a lockfile or change versions/);
  assert.match(agents, /power\.config\.json` and `src\/generated\/` are CLI-owned/);
  assert.match(agents, /modules shipped with the template/);
  assert.match(agents, /Do not patch native-host or MSAL source/);
  assert.match(agents, /Keep raw diagnostics, credentials, tokens/);
});

test('app diagnosis is recommended before reporting without blocking direct or unavailable-skill reports', () => {
  for (const relativePath of ['AGENTS.md', 'README.md']) {
    const content = read(relativePath).replace(/\s+/g, ' ');
    assert.match(content, /dependency installation, startup, runtime, or QR opening/);
    assert.match(content, /`\/?debug-app` skill (?:first )?before reporting an issue/);
    assert.match(content, /recommendation, not a prerequisite/);
    assert.match(content, /honor explicit direct report requests/);
    assert.match(content, /Plugin installation\/loading failures can make app diagnosis unavailable/);
    assert.match(content, /do not block reporting in those cases/);
    assert.doesNotMatch(content, /`\/?debug-app` agent/);
  }
});

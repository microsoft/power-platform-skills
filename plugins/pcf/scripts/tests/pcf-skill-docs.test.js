'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMatrix, renderHostsTable, renderPlatformLibrariesTable } = require('../lib/pcf-matrix.js');

const ROOT = path.join(__dirname, '..', '..');
const PCF_REFERENCE_FILES = [
  'references/pcf-best-practices.md',
  'references/pcf-deploy.md',
  'references/pcf-troubleshooting.md',
  'references/pcf-hosts.md',
  'references/pcf-power-pages.md',
  'references/pcf-recipes.md',
  'references/pcf-testing.md',
];
const PCF_FLOW_FILES = [
  'skills/pcf/create-flow.md',
  'skills/pcf/deploy-flow.md',
  'skills/pcf/bind-flow.md',
  'skills/pcf/pages-flow.md',
  'skills/pcf/upgrade-flow.md',
];
const PCF_DOC_FILES = ['skills/pcf/SKILL.md', ...PCF_FLOW_FILES, ...PCF_REFERENCE_FILES];
const PLUGIN_CHECK_LINE = '> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.';
const ALLOWED_PLATFORM_ERROR_MESSAGES = [
  // The stock React template has been observed with a Fluent version that the platform rejects.
  'platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.',
];

// Read a plugin doc with LF line endings. Windows CI runners check files out with CRLF, while the
// render functions these docs are compared against emit LF, so a verbatim comparison must not depend
// on the checkout's line endings.
function readPluginFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function parseTroubleshootingEntries(text) {
  return text
    .split(/^### /m)
    .slice(1)
    .map((entry) => {
      const [title] = entry.split(/\r?\n/, 1);
      return { title: title.trim(), body: entry };
    });
}

function assertTroubleshootingEntry(entry) {
  for (const label of ['Symptom', 'Candidate causes', 'Discriminating checks', 'Fix', 'Verify']) {
    assert.match(entry.body, new RegExp(`\\*\\*${label}\\*\\*:`), `${entry.title} is missing ${label}`);
  }
  assert.doesNotMatch(entry.body, /\bAll causes\b/i, `${entry.title} must not claim an exhaustive list of causes`);
}

function verificationPacPrerequisites(text) {
  const offenders = [];
  for (const section of text.split(/(?=^#{1,6}\s)/m)) {
    const heading = section.split(/\r?\n/, 1)[0];
    // A "## Verify registration" heading also scopes a later "check-auth.js --require-pac"
    // example; checking command lines alone would miss that prerequisite regression.
    const readOnlyHeading = /^#{1,6}\s+(?:verify|verification|inventory)\b/i.test(heading) ? heading : '';
    for (const statement of section.split(/(?<=[.!?;])\s+|\r?\n/)) {
      const instruction = `${readOnlyHeading} ${statement}`.trim();
      if (!/\b(?:verify(?:-pcf\.js)?|verification|inventory|pcf-inventory\.js)\b/i.test(instruction)) continue;
      if (!/--require-pac|\bPAC\s+(?:auth(?:entication)?|login)\b|\bpac\s+auth\s+(?:create|select)\b/i.test(statement)) continue;
      if (/\b(?:not|never|without)\b[^.;]*(?:--require-pac|\bPAC\b)/i.test(statement)) continue;
      if (/\bPAC\b[^.;]*\b(?:not required|not needed|only for push|only for packag)/i.test(statement)) continue;
      offenders.push(instruction);
    }
  }
  return offenders;
}

function versionSelectorsFromMatrix(matrix) {
  const versionPattern = /\b\d+(?:\.(?:\d+|x+)){1,3}(?:-[0-9A-Za-z.-]+)?\b/g;
  const versions = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(versionPattern)) versions.add(match[0]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };

  visit(matrix);
  return Array.from(versions).filter(Boolean).sort((a, b) => b.length - a.length);
}

function stripRenderedBlocks(text) {
  return text
    .replace(/<!-- pcf-matrix:begin -->[\s\S]*?<!-- pcf-matrix:end -->\n?/g, '')
    .replace(/<!-- pcf-platform-libraries:begin -->[\s\S]*?<!-- pcf-platform-libraries:end -->\n?/g, '');
}

function matrixOwnedVersionLeaks(text, versions) {
  const body = stripRenderedBlocks(text);
  const leaks = [];
  for (const version of versions) {
    const pattern = new RegExp(`(^|[^\\d.])${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\d.]|\\.(?!\\d|x))`, 'g');
    for (const match of body.matchAll(pattern)) {
      const lineStart = body.lastIndexOf('\n', match.index) + 1;
      const lineEnd = body.indexOf('\n', match.index);
      const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd);
      const versionStartInLine = match.index + match[1].length - lineStart;
      const versionEndInLine = versionStartInLine + version.length;
      const isAllowlistedPlatformError = /^\*\*Symptom\*\*:/.test(line)
        && ALLOWED_PLATFORM_ERROR_MESSAGES.some((message) => {
          const messageStart = line.indexOf(message);
          return messageStart !== -1 && versionStartInLine >= messageStart && versionEndInLine <= messageStart + message.length;
        });
      if (isAllowlistedPlatformError) continue;
      leaks.push({ version, line: line.trim() });
    }
  }
  return leaks;
}

test('all PCF reference docs exist', () => {
  for (const relativePath of PCF_REFERENCE_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} is missing`);
  }
});

test('/pcf skill frontmatter and size stay installable', () => {
  const text = readPluginFile('skills/pcf/SKILL.md');
  const lines = text.split(/\r?\n/);
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);

  assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
  assert.ok(lines.length < 500, `SKILL.md must stay under 500 lines; found ${lines.length}`);
  assert.match(frontmatter[1], /^name: pcf$/m, 'SKILL.md frontmatter must declare name: pcf');

  const description = frontmatter[1].match(/^description:\s*(.*)$/m);
  assert.ok(description, 'SKILL.md frontmatter must declare a description');
  assert.ok(description[1].length <= 1024, `description must be <= 1024 chars; found ${description[1].length}`);

  const allowedTools = frontmatter[1].match(/^allowed-tools:\s*(.*)$/m);
  assert.ok(allowedTools, 'SKILL.md frontmatter must declare allowed-tools');
  assert.doesNotMatch(allowedTools[1], /^\s*\[/, 'allowed-tools must be a comma-separated list, not JSON array syntax');
  assert.match(allowedTools[1], /,\s*/, 'allowed-tools must contain comma-separated tool names');

  const afterFrontmatter = text.slice(frontmatter[0].length).split(/\r?\n/)[0];
  assert.equal(afterFrontmatter, PLUGIN_CHECK_LINE, 'the plugin version-check line must immediately follow the frontmatter');
});

test('/pcf flow files are linked from SKILL.md', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');

  for (const relativePath of PCF_FLOW_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, relativePath)), `${relativePath} is missing`);
    const name = path.basename(relativePath);
    assert.match(skill, new RegExp(`\\(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), `SKILL.md must link ${name}`);
  }
});

test('/pcf skill links troubleshooting guidance for repair flows', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');

  assert.match(
    skill,
    /\.\.\/\.\.\/references\/pcf-troubleshooting\.md/,
    'SKILL.md must link references/pcf-troubleshooting.md for build/import/render repair paths',
  );
});

test('/pcf Pages compatibility gate precedes deploy phase', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');
  const pagesGate = skill.indexOf('## Phase 5 — Pages compatibility gate');
  const deploy = skill.indexOf('## Phase 6 — deploy');

  assert.notEqual(pagesGate, -1, 'SKILL.md must have a pre-deploy Pages compatibility phase');
  assert.notEqual(deploy, -1, 'SKILL.md must have a deploy phase');
  assert.ok(pagesGate < deploy, 'Pages compatibility gate must run before deploy');
});

test('/pcf docs use boolean apply plus --steps for scoped upgrades', () => {
  const offenders = [];
  const badApplyValue = /--apply(?:=|\s+)(?!-|\[|authority\b)([A-Za-z0-9_.,-]+)/g;

  for (const relativePath of PCF_DOC_FILES) {
    const text = readPluginFile(relativePath);
    for (const match of text.matchAll(badApplyValue)) {
      offenders.push(`${relativePath}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, []);
});

test('/pcf verification and inventory instructions do not require PAC authentication', () => {
  for (const instruction of [
    'Environment verification needs az plus PAC auth.',
    'Run verify-pcf.js after check-auth.js --require-pac.',
    'Inventory requires PAC authentication.',
    '## Verify registration\n\nnode check-auth.js --require-pac\n',
    '## Inventory\n\nRun pac auth create first.\n',
  ]) {
    assert.equal(verificationPacPrerequisites(instruction).length, 1, instruction);
  }
  for (const instruction of [
    'Verification and inventory require az auth but not PAC.',
    'PAC auth is not required for verification.',
    'Do not use --require-pac for inventory.',
    'Use --require-pac only for push/package paths. Verification needs Azure CLI auth.',
  ]) {
    assert.deepEqual(verificationPacPrerequisites(instruction), [], instruction);
  }

  const files = [
    'skills/pcf/SKILL.md',
    ...fs.readdirSync(path.join(ROOT, 'skills', 'pcf')).filter((name) => name.endsWith('-flow.md'))
      .map((name) => `skills/pcf/${name}`),
    ...fs.readdirSync(path.join(ROOT, 'references')).filter((name) => name.endsWith('.md'))
      .map((name) => `references/${name}`),
  ];
  const offenders = files.flatMap((file) => verificationPacPrerequisites(readPluginFile(file))
    .map((instruction) => `${file}: ${instruction}`));
  assert.deepEqual(offenders, []);
});

test('redeploy guidance requires a separate previous-manifest comparison', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');
  const gates = skill.slice(skill.indexOf('## Phase 4'), skill.indexOf('## Phase 5'));
  const deploy = readPluginFile('skills/pcf/deploy-flow.md').split('\nRun:')[0];
  const upgrade = readPluginFile('skills/pcf/upgrade-flow.md');
  assert.match(gates, /Before redeploying an existing control,[^\n]*compare[^\n]*previous manifest/);
  assert.match(deploy, /Preconditions:[\s\S]*Existing controls[^\n]*have passed `lint-pcf\.js[^\n]*--against/);
  assert.match(upgrade, /Before redeploying over an existing registration,[^\n]*run `lint-pcf\.js[^\n]*--against/);
  for (const [name, text] of [['SKILL.md gates phase', gates], ['deploy prerequisites', deploy], ['upgrade flow', upgrade]]) {
    assert.match(text, /existing control|existing registration/i, `${name} must cover existing controls`);
    assert.match(text, /lint-pcf\.js"?`?\s+--manifest\s+<[^>]+>\s+--against\s+<[^>]+>/,
      `${name} must run lint-pcf.js --against separately before redeploy`);
  }
});

test('redeploy guidance discloses when no baseline comparison was possible', () => {
  for (const file of ['skills/pcf/SKILL.md', 'skills/pcf/deploy-flow.md', 'skills/pcf/upgrade-flow.md']) {
    const text = readPluginFile(file);
    assert.match(text, /If no (?:previous manifest is available|baseline exists)[^\n]*compatibility was not compared/i,
      `${file} must disclose an unavailable previous manifest`);
  }
  assert.match(readPluginFile('skills/pcf/SKILL.md'), /do not claim[^\n]*backwards-compatible[^\n]*gates alone/i);
});

test('capability and design docs keep breaking-change comparison outside pcf-gates', () => {
  const capabilities = readPluginFile('docs/pcf-capabilities.md');
  const design = readPluginFile('docs/pcf-design.md');
  assert.match(capabilities, /Breaking-change comparison is a separate manifest check:[^\n]*lint-pcf\.js[^\n]*--against/);
  assert.match(design, /Breaking-change diff checks[^\n]*are not part of `pcf-gates\.js`[^\n]*lint-pcf\.js[^\n]*--against[^\n]*separately/);
  for (const [name, text] of [['pcf-capabilities.md', capabilities], ['pcf-design.md', design]]) {
    assert.doesNotMatch(text, /pcf-gates\.js[^\n]*(?:runs?|includes?|performs?)[^\n]*breaking-change/i,
      `${name} must not advertise a breaking-change diff inside pcf-gates.js`);
  }
});

test('troubleshooting helpers have descriptive public names', () => {
  const source = readPluginFile('scripts/tests/pcf-skill-docs.test.js');
  assert.doesNotMatch(source, /\bassert[A-Z]\d+(?:Entry|Case|Test|Fix)\b/);
  assert.match(source, /function assertTroubleshootingEntry\(/);
});

test('PCF docs use real newline bytes instead of literal escape endings', () => {
  for (const file of PCF_DOC_FILES) {
    const text = readPluginFile(file);
    assert.doesNotMatch(text, /\\(?:r\\n|n)$/m, `${file} contains a literal newline escape at a line end`);
    assert.ok(text.endsWith('\n'), `${file} must have a final newline`);
  }
});

test('gated evidence definition includes the production build', () => {
  const testing = readPluginFile('references/pcf-testing.md');

  assert.match(
    testing,
    /`gated`[^\n]*pcf-gates\.js[^\n]*production build/i,
    '`gated` evidence must mean all pcf-gates.js gates including the production build',
  );
});

function scriptUsage(scriptPath) {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const usageConst = source.match(/const USAGE\s*=\s*(?:`([\s\S]*?)`|'([^']*)'|"([^"]*)")/);
  if (usageConst) return usageConst[1] || usageConst[2] || usageConst[3] || '';
  const commentUsage = source.match(/\/\/ Usage:\r?\n((?:\/\/.*\r?\n)+)/);
  if (commentUsage) return commentUsage[1].replace(/^\/\/\s?/gm, '');
  return source;
}

function flagsFromUsage(scriptPath) {
  const usage = scriptUsage(scriptPath);
  return new Set(Array.from(usage.matchAll(/--[A-Za-z][A-Za-z0-9-]*/g), (match) => match[0]));
}

function docScriptFlagMentions(text) {
  const mentions = [];
  const scriptLine = /scripts\/([A-Za-z0-9_-]+\.js)([^\r\n]*)/g;
  for (const match of text.matchAll(scriptLine)) {
    const flags = Array.from(match[2].matchAll(/--[A-Za-z][A-Za-z0-9-]*/g), (flag) => flag[0]);
    mentions.push({ script: match[1], flags });
  }
  return mentions;
}

test('/pcf docs mention only shipped script paths and flags', () => {
  const missing = [];
  const unknownFlags = [];

  for (const relativePath of PCF_DOC_FILES) {
    const text = readPluginFile(relativePath);
    for (const mention of docScriptFlagMentions(text)) {
      const scriptPath = path.join(ROOT, 'scripts', mention.script);
      if (!fs.existsSync(scriptPath)) {
        missing.push(`${relativePath}: scripts/${mention.script}`);
        continue;
      }
      const knownFlags = flagsFromUsage(scriptPath);
      for (const flag of mention.flags) {
        if (!knownFlags.has(flag)) unknownFlags.push(`${relativePath}: scripts/${mention.script} mentions ${flag}, but its usage omits it`);
      }
    }
  }

  assert.deepEqual(missing, []);
  assert.deepEqual(unknownFlags, []);
});

test('pcf-hosts.md contains the rendered compatibility matrix block verbatim', () => {
  const text = readPluginFile('references/pcf-hosts.md');
  const expected = renderHostsTable(loadMatrix());

  assert.ok(text.includes(expected), 'pcf-hosts.md must include renderHostsTable(loadMatrix()) output verbatim');
  assert.match(
    text,
    /renderHostsTable\(loadMatrix\(\)\)[^\n]*\n<!-- pcf-matrix:begin -->/,
    'the matrix markers need a maintainer comment naming renderHostsTable(loadMatrix())',
  );
});

test('pcf-hosts.md contains the rendered platform-library block verbatim', () => {
  const text = readPluginFile('references/pcf-hosts.md');
  const expected = renderPlatformLibrariesTable(loadMatrix());

  assert.ok(text.includes(expected), 'pcf-hosts.md must include renderPlatformLibrariesTable(loadMatrix()) output verbatim');
  assert.match(
    text,
    /renderPlatformLibrariesTable\(loadMatrix\(\)\)[^\n]*\n<!-- pcf-platform-libraries:begin -->/,
    'the platform-library markers need a maintainer comment naming renderPlatformLibrariesTable(loadMatrix())',
  );
});

test('pcf-recipes.md contains the rendered recipe catalog block verbatim', () => {
  const { renderRecipesTable } = require('../lib/pcf-scaffold.js');
  const text = readPluginFile('references/pcf-recipes.md');
  const expected = renderRecipesTable();

  assert.ok(text.includes(expected), 'pcf-recipes.md must include renderRecipesTable() output verbatim');
  assert.match(
    text,
    /renderRecipesTable\(\)[^\n]*\n<!-- pcf-recipes:begin -->/,
    'the recipe markers need a maintainer comment naming renderRecipesTable()',
  );
});

test('recipe directories and pcf-recipes catalog rows stay in sync', () => {
  const recipesRoot = path.join(ROOT, 'recipes');
  const recipeDirs = fs.readdirSync(recipesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const text = readPluginFile('references/pcf-recipes.md');
  const rowIds = Array.from(text.matchAll(/\(`([^`]+)`\)/g), (match) => match[1]).sort();

  assert.deepEqual(rowIds, recipeDirs);
});

test('PCF reference docs do not link to GitHub issue trackers', () => {
  for (const relativePath of PCF_DOC_FILES) {
    const text = readPluginFile(relativePath);
    assert.doesNotMatch(
      text,
      /https?:\/\/github\.com\/[^\s)]+\/(?:issues|discussions)\//i,
      `${relativePath} must not contain GitHub issue or discussion links`,
    );
  }
});

test('every pcf-upgrade manual note has a guide heading', () => {
  const source = readPluginFile('scripts/lib/pcf-upgrade.js');
  const manualNoteIds = Array.from(source.matchAll(/manual\.push\(\s*\{[\s\S]*?\bid:\s*'([A-Z0-9_]+)'/g), (match) => match[1])
    .sort();
  const uniqueManualNoteIds = Array.from(new Set(manualNoteIds));
  const upgradeFlow = readPluginFile('skills/pcf/upgrade-flow.md');

  assert.ok(uniqueManualNoteIds.length >= 3, `expected at least 3 manual note ids, found ${uniqueManualNoteIds.length}`);
  for (const id of uniqueManualNoteIds) {
    assert.match(upgradeFlow, new RegExp(`^#{2,4}\\s+${id}\\b`, 'm'), `upgrade-flow.md needs a heading for ${id}`);
  }
});

test('every troubleshooting entry uses the symptom-led diagnostic format', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  const entries = parseTroubleshootingEntries(text);
  assert.ok(entries.length > 10, 'expected multiple troubleshooting entries under ### headings');

  for (const entry of entries) {
    assertTroubleshootingEntry(entry);
  }
});

test('troubleshooting covers the required PCF failure modes', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  const entries = parseTroubleshootingEntries(text);
  const requiredEntries = [
    { title: '[pcf-1041]', body: "Not a valid sub-command 'production'" },
    { title: '[pcf-1014]', body: '[pcf-1014]' },
    { title: 'Missing required tool', body: 'Missing required tool' },
    { title: 'Web resource content size is too big', body: 'Web resource content size is too big' },
    { title: 'Solution checker web-avoid-eval rule', body: 'web-avoid-eval' },
    { title: 'Fluent platform library rejection', body: 'platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform' },
    { title: 'npm ERESOLVE', body: 'ERESOLVE' },
    { title: 'MSB4036', body: 'MSB4036' },
    { title: 'NuGet restore fails', body: 'Microsoft.PowerApps.MSBuild.Pcf' },
    { title: 'Custom control declaration for form factor', body: 'Custom control declaration for form factor(s) 0,1 is missing' },
    { title: 'Error loading control', body: 'Error loading control' },
    { title: 'Error loading control', body: 'BigInt' },
    { title: 'Harness Web API not implemented', body: 'not implemented' },
    { title: 'Dataset refresh loop or page reset', body: 'refresh will reset paging to page 1' },
    { title: 'Pages virtual control does not render', body: 'Power Pages does not support platform-library declarations' },
    { title: 'Pages dataset sub-grid or list is not supported', body: 'not supported in this release' },
    { title: 'Bound control cannot be deleted', body: 'The CustomControl({…}) component cannot be deleted because it is referenced' },
    { title: 'Dataverse rejects an OData `in` operator', body: 'The query node In is not supported' },
  ];

  for (const required of requiredEntries) {
    const matches = entries.filter((entry) => entry.title.includes(required.title) && entry.body.includes(required.body));
    assert.equal(matches.length, 1, `expected one troubleshooting entry for ${required.title} / ${required.body}`);
    assertTroubleshootingEntry(matches[0]);
  }
});

test('allowed platform error messages appear verbatim in troubleshooting', () => {
  const text = readPluginFile('references/pcf-troubleshooting.md');
  for (const message of ALLOWED_PLATFORM_ERROR_MESSAGES) {
    assert.ok(text.includes(message), `missing allowlisted platform error message: ${message}`);
  }
});

test('matrix-owned versions are detected when planted outside rendered blocks', () => {
  const [version] = versionSelectorsFromMatrix(loadMatrix());
  const leaks = matrixOwnedVersionLeaks(`This paragraph hard-codes ${version} outside the matrix.\n`, [version]);

  assert.deepEqual(leaks, [{ version, line: `This paragraph hard-codes ${version} outside the matrix.` }]);
});

test('matrix-owned Pages requirement versions are detected when planted outside rendered blocks', () => {
  const versions = versionSelectorsFromMatrix(loadMatrix());
  const leaks = matrixOwnedVersionLeaks('This paragraph hard-codes 9.3.3.x outside the matrix.\n', versions);

  assert.deepEqual(leaks, [{ version: '9.3.3.x', line: 'This paragraph hard-codes 9.3.3.x outside the matrix.' }]);
});

test('platform-library symptom exemptions do not hide extra matrix-owned versions', () => {
  const versions = versionSelectorsFromMatrix(loadMatrix());
  const text = '**Symptom**: Import fails with `platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.` Extra 9.3.3.x.\n';
  const leaks = matrixOwnedVersionLeaks(text, versions);

  assert.deepEqual(leaks, [{ version: '9.3.3.x', line: text.trim() }]);
});

test('PCF reference prose does not hand-copy matrix-owned versions outside rendered blocks', () => {
  const versions = versionSelectorsFromMatrix(loadMatrix());
  const leaks = [];
  for (const relativePath of PCF_REFERENCE_FILES) {
    for (const leak of matrixOwnedVersionLeaks(readPluginFile(relativePath), versions)) {
      leaks.push(`${relativePath}: ${leak.version}: ${leak.line}`);
    }
  }

  assert.deepEqual(leaks, []);
});

test('unattended guidance keeps session files out of the scaffold output directory', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');
  const create = readPluginFile('skills/pcf/create-flow.md');
  for (const text of [skill, create]) {
    assert.match(text, /pcf-intent\.json/);
    assert.match(text, /pcf-plan\.md/);
    assert.match(text, /workflow-log\.md/);
    assert.match(text, /working directory/);
    assert.match(text, /new, empty subdirectory/);
    assert.match(text, /before scaffold runs/);
  }
  assert.match(skill, /pcf-intent\.json` or `pcf-plan\.md`/);
  assert.match(skill, /workflow-log\.md` is not a session marker/);
});

test('scaffold guidance reports resolvedOutDir when the redirect info note appears', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');
  const create = readPluginFile('skills/pcf/create-flow.md');
  const note = /If the scaffold JSON includes the `PCF_SCAFFOLD_OUT_REDIRECTED` note, tell the user the files were written to `resolvedOutDir`/;

  for (const text of [skill, create]) {
    assert.match(text, note);
    assert.match(text, /`info` finding/);
    assert.doesNotMatch(text, /PCF_SCAFFOLD_OUT_REDIRECTED` warning/);
  }
});

test('create flow reads a recipe README only when a recipe was selected', () => {
  const skill = readPluginFile('skills/pcf/SKILL.md');
  const create = readPluginFile('skills/pcf/create-flow.md');
  assert.match(skill, /selected recipe's README, if a recipe was selected/);
  assert.match(create, /selected recipe's README, if a recipe was selected/);
});

test('create flow documents connectivity as the host connection mode', () => {
  const create = readPluginFile('skills/pcf/create-flow.md');
  assert.match(create, /offline \(mobile offline\) hosts are not supported in this release/);
  assert.match(create, /makes no network calls still uses "online"/);
});

test('upgrade flow documents REINSTALL as selectable and required by DEPS_TO_MATRIX', () => {
  const text = readPluginFile('skills/pcf/upgrade-flow.md');
  assert.match(text, /REINSTALL is a selectable step when the plan contains it/);
  assert.match(text, /requiresStep/);
  assert.match(text, /Selecting `DEPS_TO_MATRIX` includes that required step/);
});

test('Power Pages guidance is standard field controls only', () => {
  const files = [
    'skills/pcf/SKILL.md',
    'skills/pcf/pages-flow.md',
    'skills/pcf/create-flow.md',
    'references/pcf-power-pages.md',
    'references/pcf-hosts.md',
    'references/pcf-testing.md',
    'references/pcf-best-practices.md',
    'docs/pcf-design.md',
    'docs/pcf-capabilities.md',
    'README.md',
  ];
  const boundary = 'This release supports Power Pages only for standard field controls: the form-field journey and the standalone Liquid journey (`{% codecomponent %}`), both guided.';
  const unsupported = 'Dataset controls on Pages (form sub-grid and list) are not supported in this release.';
  // Instructional leftovers from the removed sub-grid and list journeys. A fenced
  // "not supported" mention is allowed; a how-to is not.
  const supportedJourney = /Journey 2 — form sub-grid|Journey 3 — list|Type: Subgrid|Use a configured code component = Yes|paging and selection work|configured forms\/lists/;

  for (const relativePath of files) {
    const text = readPluginFile(relativePath);
    assert.ok(text.includes(boundary), `${relativePath} must state the field-only Pages boundary`);
    assert.ok(text.includes(unsupported), `${relativePath} must state dataset Pages journeys are not supported`);
    assert.doesNotMatch(text, supportedJourney, `${relativePath} must not present a sub-grid or list Pages journey as supported`);
  }

  for (const relativePath of ['skills/pcf/pages-flow.md', 'references/pcf-power-pages.md', 'references/pcf-hosts.md']) {
    const text = readPluginFile(relativePath);
    assert.match(text, /openDatasetItem/, `${relativePath} must name openDatasetItem as the reason dataset Pages journeys are out of scope`);
    assert.match(text, /model-driven and canvas apps only/, `${relativePath} must cite the Learn host limit for paging and openDatasetItem`);
  }
});

test('create flow shows the allowed Pages intent journeys and documents their field-only boundary', () => {
  const text = readPluginFile('skills/pcf/create-flow.md');
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);
  assert.ok(example.hosts.includes('pages'));
  assert.deepEqual(example.pages?.journeys, ['form-field', 'liquid']);
  assert.match(text, /`pages\.journeys`/);
  assert.match(text, /`form-field`.*`liquid`/);
  assert.match(text, /standalone Liquid.*bindings.*empty/i);
});

test('Pages flow and reference show the documented registered-name Liquid tag and rendering check', () => {
  for (const relativePath of ['skills/pcf/pages-flow.md', 'references/pcf-power-pages.md']) {
    const text = readPluginFile(relativePath);
    assert.ok(text.includes("{% codecomponent name:<registered control name> <property>:'<value>' %}"), relativePath);
    assert.match(text, /registered (?:Dataverse )?control name/i, relativePath);
    assert.match(text, /confirm (?:that )?the control renders/i, relativePath);
  }
});

test('documented CLI invocations include required flags', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  };
  for (const relativeDir of ['references', 'skills', 'docs']) walk(path.join(ROOT, relativeDir));

  const rules = [
    { script: 'pcf-gates.js', required: ['--project'] },
    { script: 'pcf-build.js', required: ['--project'] },
    { script: 'lint-pcf.js', requiredAny: [['--manifest', '--project']] },
    { script: 'pcf-inventory.js', required: ['--env'] },
    { script: 'pcf-push.js', required: ['--project', '--env'], requiredAny: [['--solution', '--publisher-prefix']] },
    { script: 'write-pcf-plan.js', required: ['--intent'] },
    { script: 'verify-pcf.js', required: ['--env', '--control'] },
  ];
  const offenders = [];

  for (const file of files) {
    const relativePath = path.relative(ROOT, file);
    const lines = readPluginFile(relativePath).split('\n');
    lines.forEach((line, index) => {
      for (const rule of rules) {
        const escaped = rule.script.replace('.', '\\.');
        const flagged = new RegExp(`${escaped}(?:\`|")?\\s+--`).test(line);
        const nodeCall = new RegExp(`node\\s+.*${escaped}`).test(line);
        if (!flagged && !nodeCall) continue;
        const missing = [];
        for (const flag of rule.required || []) {
          if (!line.includes(flag)) missing.push(flag);
        }
        for (const group of rule.requiredAny || []) {
          if (!group.some((flag) => line.includes(flag))) missing.push(group.join(' or '));
        }
        if (missing.length) offenders.push(`${relativePath}:${index + 1} missing ${missing.join(', ')}`);
      }
    });
  }

  assert.deepEqual(offenders, []);
});

test('Microsoft Learn links in PCF references use the en-us canonical prefix', () => {
  for (const relativePath of PCF_REFERENCE_FILES) {
    const text = readPluginFile(relativePath);
    const links = text.match(/https:\/\/learn\.microsoft\.com[^\s)>"']*/g) || [];
    assert.ok(links.length > 0, `${relativePath} should cite Microsoft Learn`);
    for (const link of links) {
      assert.ok(
        link.startsWith('https://learn.microsoft.com/en-us/'),
        `${relativePath} has non-en-us Microsoft Learn link: ${link}`,
      );
    }
  }
});

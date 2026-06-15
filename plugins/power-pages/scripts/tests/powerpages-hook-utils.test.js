const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../lib/powerpages-hook-utils');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

test('detectTrackedSkill recognizes tracked skill references', () => {
  assert.equal(detectTrackedSkill('create-site'), 'create-site');
  assert.equal(detectTrackedSkill('/power-pages:setup-auth'), 'setup-auth');
  assert.equal(detectTrackedSkill('power-pages:add-seo'), 'add-seo');
  assert.equal(detectTrackedSkill('/power-pages:deploy-site'), null);
});

test('detectTrackedSkill recognizes slash command aliases without plugin prefix', () => {
  assert.equal(detectTrackedSkill('/create-site'), 'create-site');
  assert.equal(detectTrackedSkill('/setup-auth'), 'setup-auth');
  assert.equal(detectTrackedSkill('/add-server-logic'), 'add-server-logic');
  assert.equal(detectTrackedSkill('/add-cloud-flow'), 'add-cloud-flow');
  assert.equal(detectTrackedSkill('/integrate-webapi'), 'integrate-webapi');
  assert.equal(detectTrackedSkill('/audit-permissions'), 'audit-permissions');
  assert.equal(detectTrackedSkill('/deploy-site'), null);
});

test('getTrackedSkillFromToolInput finds a tracked skill in common fields', () => {
  assert.equal(getTrackedSkillFromToolInput({ skill_name: 'create-site' }), 'create-site');
  assert.equal(getTrackedSkillFromToolInput({ name: '/power-pages:setup-auth' }), 'setup-auth');
  assert.equal(
    getTrackedSkillFromToolInput({ command: 'run /power-pages:add-server-logic for this repo' }),
    'add-server-logic'
  );
  assert.equal(
    getTrackedSkillFromToolInput({ command: 'run /power-pages:integrate-webapi for this repo' }),
    'integrate-webapi'
  );
  assert.equal(getTrackedSkillFromToolInput({ name: 'deploy-site' }), null);
});

test('getValidatorScript returns validator paths only for command-backed skills', () => {
  assert.match(getValidatorScript('create-site'), /validate-site\.js$/);
  assert.match(getValidatorScript('add-server-logic'), /validate-serverlogic\.js$/);
  assert.equal(getValidatorScript('test-site'), null);
  assert.equal(getValidatorScript('missing-skill'), null);
});

test('getValidatorScript covers every ALM skill that previously declared a Stop hook', () => {
  // These seven skills carried Stop hook frontmatter in their SKILL.md; the
  // centralized PostToolUse hook in hooks/hooks.json now drives validation
  // for them, so each must resolve to its validator script.
  assert.match(getValidatorScript('setup-solution'), /validate-solution\.js$/);
  assert.match(getValidatorScript('export-solution'), /validate-export\.js$/);
  assert.match(getValidatorScript('import-solution'), /validate-import\.js$/);
  assert.match(getValidatorScript('setup-pipeline'), /validate-pipeline\.js$/);
  assert.match(getValidatorScript('deploy-pipeline'), /validate-deploy-pipeline\.js$/);
  assert.match(getValidatorScript('configure-env-variables'), /validate-env-variables\.js$/);
  assert.match(getValidatorScript('plan-alm'), /validate-plan-alm\.js$/);
});

test('detectTrackedSkill recognizes the newly registered ALM skills', () => {
  assert.equal(detectTrackedSkill('/power-pages:setup-solution'), 'setup-solution');
  assert.equal(detectTrackedSkill('/power-pages:export-solution'), 'export-solution');
  assert.equal(detectTrackedSkill('/power-pages:import-solution'), 'import-solution');
  assert.equal(detectTrackedSkill('/power-pages:setup-pipeline'), 'setup-pipeline');
  assert.equal(detectTrackedSkill('/power-pages:deploy-pipeline'), 'deploy-pipeline');
  assert.equal(detectTrackedSkill('/power-pages:configure-env-variables'), 'configure-env-variables');
  assert.equal(detectTrackedSkill('/power-pages:plan-alm'), 'plan-alm');
  assert.equal(detectTrackedSkill('/power-pages:force-link-environment'), 'force-link-environment');
});

test('force-link-environment is wired into TRACKED_SKILLS with its validator', () => {
  assert.match(getValidatorScript('force-link-environment'), /validate-force-link\.js$/);
});

test('detectTrackedSkill recognizes the Inner Dev Loop skills', () => {
  assert.equal(detectTrackedSkill('/power-pages:plan-inner-loop'), 'plan-inner-loop');
  assert.equal(detectTrackedSkill('/power-pages:git-configure'), 'git-configure');
  // 'commit-to-git', 'sync-from-git', and 'resolve-conflicts' were merged into
  // 'git-sync' (one mode-aware validator). Their slugs no longer route.
  assert.equal(detectTrackedSkill('/power-pages:git-sync'), 'git-sync');
  assert.equal(detectTrackedSkill('/power-pages:revert-workspace'), 'revert-workspace');
  assert.equal(detectTrackedSkill('/power-pages:revert-branch'), 'revert-branch');
  assert.equal(detectTrackedSkill('/power-pages:open-pr'), 'open-pr');
  assert.equal(detectTrackedSkill('/power-pages:diagnose-git-integration'), 'diagnose-git-integration');
  assert.equal(detectTrackedSkill('/power-pages:setup-git-integration'), null);
  assert.equal(detectTrackedSkill('/power-pages:connect-solution-to-git'), null);
  assert.equal(detectTrackedSkill('/power-pages:branch-switch'), null);
  // Merged-away inner-loop slugs are no longer routed — should now return null.
  assert.equal(detectTrackedSkill('commit-to-git'), null);
  assert.equal(detectTrackedSkill('sync-from-git'), null);
  assert.equal(detectTrackedSkill('resolve-conflicts'), null);
  assert.equal(detectTrackedSkill('/power-pages:validate-pending-changes'), null);
});

test('every Inner Dev Loop skill resolves to its validator script', () => {
  // All inner-loop skills MUST be registered with command-backed validators
  // — they all write markers under docs/inner-loop/ that the PostToolUse hook
  // checks. commit-to-git + sync-from-git + resolve-conflicts were merged into
  // git-sync (one validator).
  assert.match(getValidatorScript('plan-inner-loop'), /validate-plan-inner-loop\.js$/);
  assert.match(getValidatorScript('git-configure'), /validate-git-configure\.js$/);
  assert.match(getValidatorScript('git-sync'), /validate-git-sync\.js$/);
  assert.match(getValidatorScript('revert-workspace'), /validate-revert-workspace\.js$/);
  assert.match(getValidatorScript('revert-branch'), /validate-revert-branch\.js$/);
  assert.match(getValidatorScript('open-pr'), /validate-open-pr\.js$/);
  assert.match(getValidatorScript('diagnose-git-integration'), /validate-diagnose-git-integration\.js$/);
  assert.equal(getValidatorScript('setup-git-integration'), null);
  assert.equal(getValidatorScript('connect-solution-to-git'), null);
  assert.equal(getValidatorScript('branch-switch'), null);
  // Legacy slugs must NOT resolve to validators post-merge.
  assert.equal(getValidatorScript('validate-pending-changes'), null);
});

test('every TRACKED_SKILLS validatorScript path resolves to an existing file on disk', () => {
  // Guardrail: registering a skill with a wrong path silently disables
  // validation. The test catches typos and stale registrations at CI time.
  const { TRACKED_SKILLS } = require('../lib/powerpages-hook-utils');
  const pluginRoot = path.join(__dirname, '..', '..');
  const missing = [];
  for (const [skillName, entry] of Object.entries(TRACKED_SKILLS)) {
    if (!entry.validatorScript) continue;
    const full = path.join(pluginRoot, entry.validatorScript);
    if (!fs.existsSync(full)) {
      missing.push(`${skillName} → ${entry.validatorScript}`);
    }
  }
  assert.deepEqual(missing, [], `These TRACKED_SKILLS validatorScript paths do not exist: ${missing.join('; ')}`);
});

test('no SKILL.md declares its own hooks frontmatter (centralized PostToolUse only)', () => {
  // Skill-specific Stop hooks are an anti-pattern documented in
  // PLUGIN_DEVELOPMENT_GUIDE.md — they duplicate the centralized PostToolUse
  // hook in hooks/hooks.json and fire too often. This guardrail catches any
  // SKILL.md that re-introduces a `hooks:` block in frontmatter.
  const offenders = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    if (/^hooks\s*:/m.test(frontmatter)) {
      offenders.push(entry.name);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `These SKILL.md files declare hooks frontmatter — register the skill in TRACKED_SKILLS instead: ${offenders.join(', ')}`
  );
});

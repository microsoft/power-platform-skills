const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  TRACKED_SKILLS,
  ALM_PLAN_SKILLS,
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
  isAlmPlanSkill,
} = require('../lib/powerpages-hook-utils');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

test('detectTrackedSkill recognizes tracked skill references', () => {
  assert.equal(detectTrackedSkill('create-site'), 'create-site');
  assert.equal(detectTrackedSkill('/power-pages:setup-auth'), 'setup-auth');
  assert.equal(detectTrackedSkill('power-pages:add-seo'), 'add-seo');
  assert.equal(detectTrackedSkill('/power-pages:deploy-site'), 'deploy-site');
});

test('detectTrackedSkill recognizes slash command aliases without plugin prefix', () => {
  assert.equal(detectTrackedSkill('/create-site'), 'create-site');
  assert.equal(detectTrackedSkill('/setup-auth'), 'setup-auth');
  assert.equal(detectTrackedSkill('/add-server-logic'), 'add-server-logic');
  assert.equal(detectTrackedSkill('/add-cloud-flow'), 'add-cloud-flow');
  assert.equal(detectTrackedSkill('/add-ai-webapi'), 'add-ai-webapi');
  assert.equal(detectTrackedSkill('/integrate-webapi'), 'integrate-webapi');
  assert.equal(detectTrackedSkill('/audit-permissions'), 'audit-permissions');
  assert.equal(detectTrackedSkill('/deploy-site'), 'deploy-site');
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
  assert.equal(getTrackedSkillFromToolInput({ name: 'deploy-site' }), 'deploy-site');
});

test('getValidatorScript returns discovered validator paths when present', () => {
  assert.match(getValidatorScript('create-site'), /validate-site\.js$/);
  assert.match(getValidatorScript('add-server-logic'), /validate-serverlogic\.js$/);
  assert.match(getValidatorScript('deploy-pipeline'), /validate-deploy-pipeline\.js$/);
  assert.match(getValidatorScript('add-ai-webapi'), /validate-ai-webapi\.js$/);
});

test('getValidatorScript returns null for tracked skills without validators', () => {
  assert.equal(detectTrackedSkill('deploy-site'), 'deploy-site');
  assert.equal(detectTrackedSkill('diagnose-deployment'), 'diagnose-deployment');
  assert.equal(getValidatorScript('test-site'), null);
  assert.equal(getValidatorScript('deploy-site'), null);
  assert.equal(getValidatorScript('diagnose-deployment'), null);
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

test('TRACKED_SKILLS is derived from every skill folder', () => {
  // The `telemetry` skill is intentionally excluded from tracking so checking/
  // toggling telemetry never self-emits (see EXCLUDED_FROM_TRACKING).
  const skillFolders = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillName) => fs.existsSync(path.join(SKILLS_DIR, skillName, 'SKILL.md')))
    .filter((skillName) => skillName !== 'telemetry')
    .sort();

  assert.deepEqual(Object.keys(TRACKED_SKILLS).sort(), skillFolders);
  for (const skillName of skillFolders) {
    assert.equal(detectTrackedSkill(`/power-pages:${skillName}`), skillName);
    assert.equal(detectTrackedSkill(`/${skillName}`), skillName);
  }
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

test('the telemetry skill is excluded from tracking (no self-emit)', () => {
  assert.equal(TRACKED_SKILLS.telemetry, undefined);
  assert.equal(detectTrackedSkill('/power-pages:telemetry'), null);
  assert.equal(detectTrackedSkill('telemetry'), null);
  assert.equal(getTrackedSkillFromToolInput({ skill: 'power-pages:telemetry' }), null);
});

test('Object.prototype keys are not mistaken for tracked skills', () => {
  // TRACKED_SKILLS is a null-prototype map. With a plain {} these names would
  // resolve to inherited functions on bracket access and emit bogus events.
  assert.equal(detectTrackedSkill('toString'), null);
  assert.equal(detectTrackedSkill('constructor'), null);
  assert.equal(detectTrackedSkill('hasOwnProperty'), null);
  assert.equal(detectTrackedSkill('__proto__'), null);
  assert.equal(getTrackedSkillFromToolInput({ skill: 'toString' }), null);
});

// --- ALM_PLAN_SKILLS / isAlmPlanSkill (reconcile-trigger gating) -------------

test('isAlmPlanSkill: true for ALM plan skills, normalizing prefixes', () => {
  assert.equal(isAlmPlanSkill('activate-site'), true);
  assert.equal(isAlmPlanSkill('/power-pages:activate-site'), true);
  assert.equal(isAlmPlanSkill('/activate-site'), true);
  assert.equal(isAlmPlanSkill('ensure-pipelines-host'), true);
  assert.equal(isAlmPlanSkill('setup-pipeline'), true);
});

test('isAlmPlanSkill: false for non-ALM skills and junk', () => {
  assert.equal(isAlmPlanSkill('create-site'), false);
  assert.equal(isAlmPlanSkill('add-seo'), false);
  assert.equal(isAlmPlanSkill('not-a-real-skill'), false);
  assert.equal(isAlmPlanSkill(null), false);
  assert.equal(isAlmPlanSkill(undefined), false);
});

test('ALM_PLAN_SKILLS members are all real tracked skills', () => {
  for (const name of ALM_PLAN_SKILLS) {
    assert.ok(TRACKED_SKILLS[name], `ALM_PLAN_SKILLS member "${name}" must be a tracked skill (have a SKILL.md)`);
  }
});

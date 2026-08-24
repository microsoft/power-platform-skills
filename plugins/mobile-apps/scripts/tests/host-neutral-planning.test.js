'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), 'utf8');
}

function tools(relativePath) {
  const frontmatter = read(relativePath).match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, `${relativePath} must have frontmatter`);
  return [...frontmatter[1].matchAll(/^\s+-\s+(\w+)$/gm)].map((match) => match[1]);
}

test('Copilot CLI-like draft agent surface can plan without plan-mode or question tools', () => {
  const required = ['Read', 'Task', 'Bash', 'Grep', 'Glob'];
  for (const relativePath of [
    'agents/native-app-planner.md',
    'agents/data-model-architect.md',
    'agents/screen-planner.md',
  ]) {
    const declared = tools(relativePath);
    for (const tool of required) assert.ok(declared.includes(tool), `${relativePath} needs ${tool}`);
    assert.equal(declared.includes('Edit'), false, `${relativePath} must not require Edit`);
    assert.equal(declared.includes('Write'), false, `${relativePath} must not require Write`);
    assert.equal(declared.includes('EnterPlanMode'), false, `${relativePath} must not require EnterPlanMode`);
    assert.equal(declared.includes('ExitPlanMode'), false, `${relativePath} must not require ExitPlanMode`);
    assert.equal(declared.includes('AskUserQuestion'), false, `${relativePath} must not require AskUserQuestion`);
  }
  const planner = read('agents/native-app-planner.md');
  assert.match(planner, /return-only planning agent/);
  assert.match(planner, /The foreground workflow is the sole owner of[\s\S]*(?:artifact|filesystem) persistence/);
  assert.doesNotMatch(planner, /plan-checkpoints\.js/);
  assert.doesNotMatch(planner, /BLOCKED: tool surface missing/);
});

  test('specialist planning agents return structured drafts without owning project artifacts', () => {
    const architect = read('agents/data-model-architect.md');
    const screenPlanner = read('agents/screen-planner.md');
    assert.match(architect, /"dataModelMarkdown"/);
    assert.match(architect, /"dataverseSchemaContract"/);
    assert.match(screenPlanner, /"screensMarkdown"/);
    assert.match(screenPlanner, /"experienceScreenContract"/);
    assert.match(screenPlanner, /"experienceFoundationContract"/);
    for (const content of [architect, screenPlanner]) {
      assert.match(content, /return-only/);
      assert.match(content, /never (?:write|persist)/i);
      assert.doesNotMatch(content, /plan-checkpoints\.js/);
    }
  });

test('prototype workflow uses four outer textual checkpoints without nested gate UI', () => {
  const prototype = read('skills/create-mobile-prototype/SKILL.md');
  assert.match(prototype, /return one complete[\s\S]*mobile-plan-artifact-bundle/i);
  assert.match(prototype, /local mock[\s\S]*generation/i);
  assert.match(prototype, /Four textual prototype checkpoints/);
  assert.match(prototype, /data-model\|native-capabilities\|connectors\|screen-plan/);
  assert.match(prototype, /plan-checkpoints\.js/);
  assert.doesNotMatch(prototype, /If a nested leaf cannot persist/);
  assert.match(prototype, /test -f "\$PROJECT_DIR\/\.tmp\/mobile-plan-status\.json"/);
  const declared = tools('skills/create-mobile-prototype/SKILL.md');
  assert.equal(declared.includes('EnterPlanMode'), false);
  assert.equal(declared.includes('ExitPlanMode'), false);
  assert.equal(declared.includes('AskUserQuestion'), false);
});

test('screen builders return artifacts without requiring a writable agent workspace', () => {
  const builder = read('agents/screen-builder.md');
  const declared = tools('agents/screen-builder.md');
  assert.equal(declared.includes('Write'), false);
  assert.equal(declared.includes('Edit'), false);
  assert.equal(declared.includes('Bash'), false);
  assert.match(builder, /return-only agent/);
  assert.match(builder, /mobile-screen-artifact/);
  assert.match(builder, /input_file_sha256/);
  assert.match(builder, /foreground writer/);

  for (const relativePath of [
    'scripts/schema-screen-artifact.json',
    'scripts/validate-screen-artifact.js',
    'scripts/write-screen-artifact.js',
  ]) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relativePath)), true, `${relativePath} must exist`);
  }
});

test('real workflow uses textual approval and validates it before external mutation', () => {
  const real = read('skills/create-mobile-app/SKILL.md');
  const planner = read('agents/native-app-planner.md');
  assert.match(planner, /NEEDS_USER_APPROVAL/);
  assert.match(planner, /mobile-plan-artifact-bundle/);
  assert.match(planner, /all five fixed artifacts/);
  assert.match(planner, /schema version 3/);
  assert.match(planner, /executionContract/);
  assert.match(real, /Textual plan approval protocol/);
  assert.match(real, /prepare-mobile-plan-execution-contract\.js/);
  assert.match(real, /mobile-plan-execution-contract\.json/);
  assert.match(real, /planner-artifact-bundle\.json/);
  assert.match(real, /validate-plan-artifact-bundle\.js/);
  assert.match(real, /write-plan-artifact-bundle\.js/);
  assert.match(real, /validate-mobile-files\.js[\s\S]*experience-foundation-contract\.json/);
  assert.match(real, /plan-checkpoints\.js/);
  assert.match(real, /--action draft/);
  assert.match(real, /--action approve/);
  assert.match(real, /External mutation authorization/);
  assert.match(real, /--action status/);
  assert.match(real, /mayAuthorizeExternalMutations: true/);
  assert.doesNotMatch(real, /planner writes are restricted/);
  assert.doesNotMatch(real, /Inline-gate fallback/);
});

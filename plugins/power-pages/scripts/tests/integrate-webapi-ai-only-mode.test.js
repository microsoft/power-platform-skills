const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The AI-only read mode is implemented as conditional branches inside the
// integrate-webapi SKILL.md markdown (the skill has no runnable parser —
// Claude reads the SKILL.md and follows its instructions). These tests guard
// against accidental removal of the AI-only branches, which would silently
// break /add-ai-webapi's delegation contract.

const SKILL_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'integrate-webapi',
  'SKILL.md'
);

const skill = fs.readFileSync(SKILL_PATH, 'utf8');

test('integrate-webapi declares the AI-only read mode core principle', () => {
  assert.match(skill, /AI-only read mode is opt-in/);
  assert.match(skill, /\[AI-READ-ONLY\]/);
});

test('Phase 1.6 documents the sentinel parser contract', () => {
  assert.match(skill, /### 1\.6 Detect AI-only read mode/);
  assert.match(skill, /`mode=ai-read-only`/);
  assert.match(skill, /`primary=<logical_name>`/);
  assert.match(skill, /`tables=<csv>`/);
  assert.match(skill, /`expand-targets=<csv>`/);
});

test('Phase 1.6 documents the regression guard for human invocations', () => {
  const p16 = skill.substring(skill.indexOf('### 1.6'), skill.indexOf('## Phase 2'));
  assert.match(
    p16,
    /When the sentinel is absent.*proceed exactly as today/s,
    'Phase 1.6 must document that human invocations see no behavior change'
  );
});

test('Phase 2 Explore prompt branches for AI-only mode', () => {
  const p2 = skill.substring(skill.indexOf('## Phase 2'), skill.indexOf('## Phase 3'));
  assert.match(p2, /When AI-only read mode is active/);
  assert.match(p2, /Operations needed for every table in that list = \*\*read only\*\*/);
  assert.match(
    p2,
    /Do NOT report create\/update\/delete/,
    'AI-only Phase 2 must forbid reporting mutation candidates'
  );
});

test('Phase 3 skips interactive confirmation in AI-only mode', () => {
  const p3Start = skill.indexOf('## Phase 3: Review Integration Plan');
  const p3End = skill.indexOf('## Phase 4: Implement Integrations');
  const p3 = skill.substring(p3Start, p3End);
  assert.match(p3, /skip this step entirely/);
  assert.match(p3, /`tables` list parsed from the sentinel verbatim/);
});

test('Phase 4.1 webapi-integration prompt branches for AI-only mode', () => {
  const p4Start = skill.indexOf('## Phase 4: Implement Integrations');
  const p4End = skill.indexOf('## Phase 5: Verify Integrations');
  const p4 = skill.substring(p4Start, p4End);
  assert.match(p4, /Operations needed: read-only/);
  assert.match(p4, /Do NOT emit create, update, or delete functions/);
  assert.match(p4, /`list<Table>` \(paginated\) and `get<Table>ById`/);
  assert.match(
    p4,
    /no mutation hooks/,
    'AI-only hook language must explicitly exclude mutation hooks'
  );
});

test('Phase 6 table-permissions-architect prompt branches for AI-only mode', () => {
  const p6Start = skill.indexOf('## Phase 6: Setup Permissions & Settings');
  const p6End = skill.indexOf('## Phase 7: Review & Deploy');
  const p6 = skill.substring(p6Start, p6End);
  const tpStart = p6.indexOf('#### Table Permissions Agent');
  const tpEnd = p6.indexOf('#### Web API Settings Agent');
  const tpSection = p6.substring(tpStart, tpEnd);
  assert.match(tpSection, /AI-only read integration/);
  assert.match(tpSection, /`read: true` \*\*only\*\*/);
  assert.match(tpSection, /Do NOT propose `create`, `write`, or `delete`/);
  assert.match(tpSection, /Parent scope.*`appendTo: true`/s);
});

test('Phase 6 webapi-settings-architect prompt branches for AI-only mode', () => {
  const p6Start = skill.indexOf('## Phase 6: Setup Permissions & Settings');
  const p6End = skill.indexOf('## Phase 7: Review & Deploy');
  const p6 = skill.substring(p6Start, p6End);
  const wsStart = p6.indexOf('#### Web API Settings Agent');
  const wsEnd = p6.indexOf('### 6.4 Create Permission & Settings Files');
  const wsSection = p6.substring(wsStart, wsEnd);
  assert.match(wsSection, /AI-only read integration/);
  assert.match(wsSection, /Do \*\*not\*\* include the primary key column/);
  assert.match(wsSection, /`_<col>_value` OData read form/);
  assert.match(wsSection, /Do NOT add the write form/);
});

test('Phase 6.4.2 Path A defaults table permissions to read-only in AI mode', () => {
  const section = skill.substring(
    skill.indexOf('#### 6.4.2 Create Table Permissions'),
    skill.indexOf('#### 6.4.3 Create Site Settings')
  );
  assert.match(section, /When AI-only read mode is active/);
  assert.match(section, /the default flag set is `--read` only/);
  assert.match(section, /Do NOT pass `--create`, `--write`, or `--delete`/);
});

test('Phase 6.4.3 Path A tightens fields rules in AI mode', () => {
  const section = skill.substring(
    skill.indexOf('#### 6.4.3 Create Site Settings'),
    skill.indexOf('### 6.5 Git Commit')
  );
  assert.match(section, /AI-only read mode/);
  assert.match(section, /Do NOT include the primary key/);
  assert.match(section, /only the `_<col>_value` read form/);
  assert.match(section, /Omit the LogicalName write form/);
});

test('backward compatibility: default CRUD prompts are still present unchanged', () => {
  // These strings are the pre-existing human-invocation prompts. They must
  // survive the AI-only mode additions — removing them would break normal
  // /integrate-webapi usage.
  assert.match(
    skill,
    /Operations needed: \[read\/create\/update\/delete\]/,
    'Default Phase 4.1 prompt template must still offer full CRUD'
  );
  assert.match(
    skill,
    /Create the TypeScript types, CRUD service layer, and framework-specific hooks\/composables/,
    'Default Phase 4.1 prompt must still request full CRUD code'
  );
  assert.match(
    skill,
    /Prompt \(default — full CRUD\):/,
    'Phase 6 prompts must be explicitly split into default vs. AI-only variants'
  );
});

test('architect agent prompts preserve default CRUD text when AI mode is absent', () => {
  const p6 = skill.substring(skill.indexOf('## Phase 6'), skill.indexOf('## Phase 7'));
  const tpDefault = p6.substring(
    p6.indexOf('Table Permissions Agent'),
    p6.indexOf('**Prompt (AI-only read mode active)')
  );
  assert.match(
    tpDefault,
    /Propose a complete table permissions plan covering all integrated tables/,
    'Default table-permissions prompt must still describe full-coverage CRUD flow'
  );
});

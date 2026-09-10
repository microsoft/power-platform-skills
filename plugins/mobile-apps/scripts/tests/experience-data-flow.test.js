'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readScreenDataAudit } = require('../read-screen-data-audit');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const planning = read('skills/create-mobile-app/references/phase-02-planning.md');
const architect = read('agents/data-model-architect.md');
const coverage = read('shared/references/screen-data-coverage.md');

test('experience and information needs precede data discovery without a new approval gate', () => {
  const experience = planning.indexOf('## 3.0 — Experience and information needs before data');
  const data = planning.indexOf('### Verified data evidence and proposal');
  const dispatch = planning.indexOf('Dispatch `mobile-app:data-model-architect`');
  assert.ok(experience >= 0 && data > experience && dispatch > data);
  const section = planning.slice(experience, data);
  for (const phrase of ['Experience outline', 'Information needs', 'explicit requirement',
    'safe presentation', 'sample value', 'proposed scope', 'interruption/recovery']) {
    assert.ok(section.includes(phrase), `missing experience-planning input: ${phrase}`);
  }
  assert.match(section, /No new questionnaire or approval gate/);
  assert.match(section, /`--no-design` still requires useful journeys\/data coverage/);
  assert.match(section, /not an approved route graph or a commitment to a screen count/);
  assert.match(planning, /Experience outline and Information needs: <foreground-derived journey/);
  assert.match(planning, /Experience outline and Information needs: <current proposed\/approved journey/);
});

test('data reuse requires complete support rather than a percentage of matching fields', () => {
  const reuse = architect.split('\n').find(line => line.startsWith('> 1. **Downgrade to Reuse**'));
  assert.ok(reuse);
  assert.match(reuse, /all required persisted columns, relationships, keys and read\/write semantics/);
  assert.match(reuse, /derived needs have supported inputs and read paths/);
  assert.doesNotMatch(reuse, /\d+\s*%/);
  assert.match(architect, /Field overlap ranks a reuse candidate/);
  assert.match(architect, /not a budget that permits discarding useful approved information/);
  assert.match(architect, /simplest\s+complete model, not the smallest schema/);
});

test('full audit consumes detailed plans and retains compatibility without graph fallback', () => {
  const audit = architect.split('## Step 6a — Information and interaction audit')[1]
    ?.split('## Step 7')[0];
  assert.ok(audit);
  assert.match(audit, /explicit `screen-data-audit` or its compatibility alias `cross-entity-audit`/);
  assert.match(audit, /explicitly supplied staged plan/);
  assert.match(audit, /Never\s+read `_screens_section.md` in preference to it or fall back/);
  assert.match(audit, /No `related_entity_fields` blocks is not a skip/);
  assert.match(audit, /Audit modes write no\s+plan, `_dm_section.md`, normalized contract, receipt or application source/);
  assert.match(coverage, /read-screen-data-audit.js/);
  assert.match(coverage, /cannot establish\s+semantic completeness/);
  assert.doesNotMatch(architect, /Look for.*_screens_section\.md.*first/);
});

test('coverage includes primary and related facts, metrics, filters, writes, artifacts and local state', () => {
  for (const kind of ['Primary field', 'Derived value or metric', 'Related fact',
    'Filter/search/sort', 'Action or transition', 'Artifact', 'Native or external capability',
    'Auth, local or static content', 'Sample-only detail']) {
    assert.ok(coverage.includes(`| ${kind} |`), `missing coverage kind: ${kind}`);
  }
  assert.match(coverage, /units, calculation, complete aggregation scope and freshness/);
  assert.match(coverage, /one Image column is not a multi-photo history/);
  assert.match(coverage, /No `related_entity_fields` is not evidence of completeness/);
  assert.match(coverage, /explicitly accepted and removed consistently/);
  assert.match(coverage, /export\/signature pending generation/);
  assert.match(coverage, /missing business source is not a routine\s+generation placeholder/);
});

test('create, edit, design and standalone data planning share the full reconciliation loop', () => {
  for (const file of [
    'skills/create-mobile-app/references/phase-02-planning.md',
    'skills/create-mobile-app/references/phase-04-design.md',
    'skills/edit-app/SKILL.md',
    'skills/setup-datamodel/SKILL.md',
    'skills/design-system/SKILL.md',
    'agents/screen-planner.md',
    'shared/references/screen-planning/spec-contract.md',
  ]) assert.ok(read(file).includes('screen-data-coverage.md'), `${file} must use the shared audit`);
  assert.match(planning, /before Gate 4b acceptance/);
  assert.match(planning, /Connector-only, local and auth-only screens are included/);
  const edit = read('skills/edit-app/SKILL.md');
  assert.match(edit, /Before Step 3 approval/);
  assert.match(edit, /plan_path: <working_dir>\/.tmp\/edit-native-app-plan.md/);
  assert.match(edit, /Never fall back to the live plan/);
  assert.match(read('skills/setup-datamodel/SKILL.md'), /request is schema-only, record that limit/);
});

test('data coverage is resolved against real services before builders and rechecked after implementation', () => {
  const data = read('skills/create-mobile-app/references/phase-06-data.md');
  const shell = read('skills/create-mobile-app/references/phase-08-screens.md');
  const build = read('skills/create-mobile-app/references/phase-09-build.md');
  assert.match(shell, /Resolve every generation-pending entry/);
  assert.match(shell, /actual methods, fields, lookup bindings and upload\/download signatures/);
  assert.match(shell, /before the navigation\/skeleton gate can pass/);
  assert.match(build, /data_coverage:/);
  assert.match(build, /every generation-pending entry must now be\s+resolved/);
  assert.match(build, /design_reference:/);
  assert.match(build, /component_interfaces:/);
  assert.match(data, /Before applying or skipping data work/);
  assert.match(data, /legacy resume\s+with missing coverage or unresolved required support/);
  assert.match(data, /previously valid receipt alone does not establish UX\s+completeness/);
  assert.match(shell, /If a resumed plan predates coverage/);
});

// These are existing authored contract fixtures, not generated-model quality results.
for (const domain of ['shopping', 'learning', 'expense-approval', 'inspection']) {
  test(`${domain} detailed audit retains all screen content, not only related-field annotations`, () => {
    const planPath = `scripts/tests/fixtures/screen-planning/${domain}.md`;
    const result = readScreenDataAudit({ projectRoot: root, planPath });
    const document = read(planPath);
    const expected = [...document.matchAll(/^- \*\*Screen ID\*\* — ([a-z0-9-]+)$/gm)]
      .map(match => match[1]);
    assert.ok(expected.length > 0);
    assert.deepEqual(result.screens.map(screen => screen.screenId), expected);
    assert.ok(result.screens.every(screen => screen.spec.includes('**Data**')));
    assert.ok(result.screens.some(screen => screen.spec.includes('**UX contract**')));
    assert.match(result.planSha256, /^[a-f0-9]{64}$/);
  });
}

test('prompt-only evaluations remain separate from authoring and report unverified native scope', () => {
  const evaluation = read('shared/references/ux-generation-evaluation.md');
  assert.match(evaluation, /not an app authoring\s+reference/);
  assert.match(evaluation, /Do not give expected plan fixtures/);
  assert.match(evaluation, /Repeat each selected prompt in independent projects/);
  assert.match(evaluation, /Record failed and interrupted\s+runs/);
  assert.match(evaluation, /Missing evidence is unverified, never passed/);
  assert.match(evaluation, /tests of authored fixtures alone/);
  assert.ok(read('README.md').includes('ux-generation-evaluation.md'));
  for (const file of ['skills/create-mobile-app/SKILL.md', 'skills/design-system/SKILL.md']) {
    assert.ok(!read(file).includes('ux-generation-evaluation.md'), 'test prompts must not bias ordinary generation');
  }
});

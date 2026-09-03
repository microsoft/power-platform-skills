'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../..');
const agentRoot = path.join(pluginRoot, 'agents');
const skillRoot = path.join(pluginRoot, 'skills');
const removedPlanningAgents = [
  'native-app-planner',
  'data-model-architect',
  'screen-planner',
  'offline-profile-architect',
];

function markdownFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && (entry.name.startsWith('.') || entry.name === 'node_modules')) {
      return [];
    }
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.name.endsWith('.md') ? [target] : [];
  });
}

test('screen builder is the only runtime agent', () => {
  assert.deepStrictEqual(
    fs.readdirSync(agentRoot).filter((entry) => entry.endsWith('.md')).sort(),
    ['screen-builder.md'],
  );
});

test('screen builder defers model selection to the host', () => {
  const source = fs.readFileSync(path.join(agentRoot, 'screen-builder.md'), 'utf8');
  assert.doesNotMatch(source, /^model:\s*sonnet\s*$/m);
  assert.match(source, /channel: direct-write \| return-only/);
  assert.match(source, /The channel changes transport only/);
  assert.match(source, /Make no tool calls/);
  assert.match(source, /Write only `target_file`/);
  assert.match(source, /sealed `tokenInterfaces`/);
  assert.match(source, /Every string in sealed `testIds` must appear literally/);
  assert.match(source, /canonical scenario-facts projection/);
  assert.match(source, /`sharedDesignInputs` as the exact approved experience directive/);
  assert.match(source, /Test fixtures, snapshots, benchmark implementations,[\s\S]*prohibited/);
  assert.match(source, /human-first `identityHierarchy`/);
  assert.match(source, /`experienceDirective` is the product-wide visual and experiential authority/);
  assert.match(source, /Archetype shards and sample screens provide code and API idioms only/);
  assert.match(source, /one coherent native canvas/);
  assert.match(source, /Do not turn each[\s\S]*into an equal-weight card/);
  assert.doesNotMatch(source, /validate-screen-implementation\.js|AST check/);
  assert.doesNotMatch(source, /\bAskUserQuestion\b|\bEnterPlanMode\b|\bExitPlanMode\b|nested `Task`/);
});

test('mobile guidance contains no runtime planning-agent dependency', () => {
  const findings = [];
  for (const file of markdownFiles(pluginRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const agent of removedPlanningAgents) {
      if (source.includes(agent)) {
        findings.push(`${path.relative(pluginRoot, file)} references ${agent}`);
      }
    }
  }
  assert.deepStrictEqual(findings, []);
});

test('setup-datamodel owns foreground plan-only decisions', () => {
  const setup = fs.readFileSync(path.join(skillRoot, 'setup-datamodel', 'SKILL.md'), 'utf8');
  const add = fs.readFileSync(path.join(skillRoot, 'add-dataverse', 'SKILL.md'), 'utf8');
  assert.match(setup, /`--plan-only` is the foreground planning API/);
  assert.match(setup, /Never replace a column in place/);
  assert.match(setup, /validate-dataverse-planning-decisions\.js/);
  assert.match(add, /\/setup-datamodel` with `--plan-only`/);
  for (const source of [setup, add]) {
    assert.doesNotMatch(source, /mobile-app:(?:native-app-planner|data-model-architect)/);
    assert.doesNotMatch(source, /Spawn (?:the )?`?data-model-architect/i);
  }
});

test('setup-offline-profile owns architecture and never dispatches a planner', () => {
  const source = fs.readFileSync(path.join(skillRoot, 'setup-offline-profile', 'SKILL.md'), 'utf8');
  assert.match(source, /Design the profile in foreground/);
  assert.match(source, /deterministic row-scope cascade/);
  assert.match(source, /Register relationship associations on the parent/);
  assert.match(source, /Do not infer offline from mobile usage/);
  assert.doesNotMatch(source, /mobile-app:offline-profile-architect/);
});

test('create planning is one foreground path over the existing contracts', () => {
  const phase = fs.readFileSync(
    path.join(skillRoot, 'create-mobile-app', 'references', 'phase-3-planning.md'),
    'utf8',
  );
  assert.match(phase, /Planning uses one path on every host/);
  assert.match(phase, /\/setup-datamodel` in the foreground/);
  for (const tool of [
    'validate-product-experience.js',
    'validate-product-scope.js',
    'validate-workflow-journey.js',
    'compile-screen-build-pack.js',
    'mobile-pipeline-state.json',
  ]) {
    assert.match(phase, new RegExp(tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(phase, /All questions and approvals use foreground/);
  assert.match(phase, /Prefer one coherent bounded workspace/);
  assert.match(phase, /Never split the same job merely because its facts map to different entities/);
  assert.doesNotMatch(phase, /\bTask\b/);
  assert.doesNotMatch(phase, /mobile-app:(?:native-app-planner|data-model-architect|screen-planner)/);
});

test('screen work orders carry implementation contracts and bounded scenario facts', () => {
  const source = fs.readFileSync(
    path.join(skillRoot, 'create-mobile-app', 'references', 'phase-11-screens.md'),
    'utf8',
  );
  assert.match(source, /deterministic `implementationContract` unchanged/);
  assert.match(source, /one `scenarioFacts` projection/);
  assert.match(source, /Object\.values\(implementationContract\.testIds\)/);
  assert.match(source, /root `compiledRevision` and `experienceDirective` copied unchanged/);
  assert.match(source, /exact `sharedDesignInputs` copied unchanged/);
  assert.match(source, /product-experience-final-preview-contract\.json/);
  assert.match(source, /same[\s\S]*generated token values\/revision,[\s\S]*navigation projection,[\s\S]*signature-component contracts/);
  assert.match(source, /rejects a missing[\s\S]*directive drift/);
  assert.match(source, /rejects missing or changed shared design inputs/);
  assert.doesNotMatch(source, /validate-screen-implementation\.js|TypeScript AST/);
  assert.match(source, /Do not include the whole Markdown plan/);
  assert.match(source, /complete scenario artifact/);
});

test('edit-app keeps planning foreground and uses the sealed screen-builder channels', () => {
  const source = fs.readFileSync(path.join(skillRoot, 'edit-app', 'SKILL.md'), 'utf8');
  assert.match(source, /Planning is always foreground/);
  assert.match(source, /only child-agent boundary remains\s+screen implementation/);
  assert.match(source, /\/setup-datamodel --plan-only/);
  for (const artifact of [
    'product-experience-contract.json',
    'product-scope-contract.json',
    'workflow-journey-contract.json',
    'compiled-screen-build-pack.json',
  ]) {
    assert.match(source, new RegExp(artifact.replaceAll('.', '\\.')));
  }
  assert.match(source, /Direct-write:/);
  assert.match(source, /Return-only:/);
  assert.match(source, /then `4`; reject values outside `1\.\.6`/);
  assert.match(source, /second failure moves only that screen to foreground/);
});

test('automatic design mode preserves experience quality without another pause', () => {
  const design = fs.readFileSync(path.join(skillRoot, 'design-system', 'SKILL.md'), 'utf8');
  const automatic = fs.readFileSync(
    path.join(skillRoot, 'design-system', 'references', 'auto-experience.md'),
    'utf8',
  );
  const finalPreview = fs.readFileSync(
    path.join(skillRoot, 'design-system', 'references', 'final-experience-preview.md'),
    'utf8',
  );
  const designSchema = fs.readFileSync(
    path.join(skillRoot, 'design-system', 'references', 'design-system-schema.md'),
    'utf8',
  );
  const scaffold = fs.readFileSync(
    path.join(skillRoot, 'create-mobile-app', 'references', 'phase-4-scaffold.md'),
    'utf8',
  );
  assert.match(design, /`--auto-experience`/);
  assert.match(design, /references\/auto-experience\.md/);
  assert.match(automatic, /without another design\s+question/);
  assert.match(automatic, /brand\/signature-components\.ts/);
  assert.match(automatic, /one to three frames/);
  assert.match(automatic, /compact collapsed `All screens`/);
  assert.match(automatic, /never claim React[\s\S]{0,20}Native or native pixels were rendered/);
  assert.ok(
    automatic.indexOf('brand/tokens.ts') < automatic.indexOf('Author the approval preview'),
    'automatic design must produce tokens before authoring the final preview',
  );
  assert.match(automatic, /final-experience-preview\.md/);
  assert.match(automatic, /same model\s+invocation/);
  assert.match(automatic, /validate-product-experience-preview\.js/);
  assert.match(automatic, /Do not invoke another model/);
  assert.doesNotMatch(automatic, /--mode final|render-product-experience-preview\.js/);
  assert.match(finalPreview, /credible mobile product screen/);
  assert.match(finalPreview, /parser-based structural quality gate/);
  assert.match(finalPreview, /Browser absence[\s\S]*non-blocking/);
  assert.match(finalPreview, /one focused edit of[\s\S]*_plan_preview\.html/);
  assert.match(finalPreview, /Rerun the same validator exactly once/);
  assert.match(finalPreview, /Do not rerun planning, regenerate[\s\S]*design system/);
  assert.match(finalPreview, /preserving the current Product Experience,[\s\S]*`experienceDirective`, tokens, signature components,[\s\S]*screen packs/);
  assert.doesNotMatch(finalPreview, /Flight|Gym|ICRC|commerce|field-operation/i);
  assert.match(finalPreview, /Do not inspect generated React Native TSX[\s\S]*with AST or regex/);
  assert.match(finalPreview, /product-experience-final-preview-contract\.json/);
  assert.match(finalPreview, /only completion validator/);
  assert.match(finalPreview, /literal `"ok": true`/);
  assert.match(finalPreview, /Do not substitute[\s\S]*Python HTML parsing[\s\S]*TypeScript compilation/);
  assert.match(automatic, /no `npm install`, TypeScript, or ad hoc check/);
  assert.match(automatic, /canonical final-[\s\S]*preview contract sidecar/);
  assert.match(design, /product-experience-final-preview-contract\.json/);
  assert.match(design, /literal `"ok": true`/);
  assert.match(designSchema, /Export `tokens`, not `brandTokens`/);
  for (const key of ['bg', 'surface', 'primary', 'accent', 'text', 'textMuted', 'border',
    'statusSuccess', 'statusWarning', 'statusDanger', 'statusInfo']) {
    assert.match(designSchema, new RegExp(`\\b${key}:`));
  }
  assert.match(designSchema, /typography:[\s\S]*heading:/);
  assert.match(scaffold, /pass `--auto-experience`/);
  assert.doesNotMatch(design, /^allowed-tools:.*\bTask\b/m);
});

test('preview-screens validates final HTML or renders a separate structural diagnostic', () => {
  const source = fs.readFileSync(path.join(skillRoot, 'preview-screens', 'SKILL.md'), 'utf8');
  assert.match(source, /validate-product-experience-preview\.js/);
  assert.match(source, /render-product-experience-preview\.js/);
  assert.match(source, /root `experienceDirective`/);
  assert.match(source, /\.tmp\/navigation-manifest\.json/);
  assert.match(source, /\.tmp\/scenario-facts\.json/);
  assert.match(source, /primary product\s+destination, key-flow entry, and strongest decision\/action screen/);
  assert.match(source, /React Native is authoritative after implementation/);
  assert.match(source, /_plan_preview\.structural\.html/);
  assert.match(source, /neutral-structural-preview/);
  assert.match(source.replace(/\s+/g, ' '), /do not overwrite the final file or hide the failure behind structural output/);
  assert.doesNotMatch(source, /--mode final|--mode structural/);
  assert.doesNotMatch(source, /<working_dir>\/preview\.html|Read the full TSX|Generate equivalent HTML\/CSS|programmatic TSX parsing/);
  assert.doesNotMatch(source, /npx expo start/);
});

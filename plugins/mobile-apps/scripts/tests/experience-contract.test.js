'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { validateExperienceContract } = require('../validate-experience-contract');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'experience-contracts.json'), 'utf8'));

function toPlan(fixture) {
  return `# ${fixture.id} — Native App Plan

## Product Experience
- Contract version: 1
- Industry context: ${fixture.industryContext}
- Product archetype: ${fixture.productArchetype}
- Classification confidence: high
- Classification evidence: primary repeated loop from approved fixture
- Workflow capabilities: ${fixture.workflowCapabilities}
- Operating context: ${fixture.operatingContext}
- Visual personality: ${fixture.visualPersonality}
- Visual ambition: ${fixture.visualAmbition}
- Content emphasis: ${fixture.contentEmphasis}
- Home composition: ${fixture.homeComposition}
- Navigation mood: ${fixture.navigationMood}
- Navigation silhouette: ${fixture.navigationSilhouette}
- Density: ${fixture.density}
- Reference fidelity: ${fixture.referenceFidelity}
- Media strategy: ${fixture.mediaStrategy}
- Media source: ${fixture.mediaSource}
- Media fallback: ${fixture.mediaFallback}

### First Viewport Contract
| Field | Requirement |
|---|---|
| Signature component | ${fixture.signature} |
| Viewport share | ${fixture.viewportShare} |
| Minimum height | ${fixture.minimumHeight} |
| Media | ${fixture.media} |
| Headline minimum | ${fixture.headlineMinimum} |
| Supporting metrics maximum | ${fixture.metricsMaximum} |
| Primary action | ${fixture.primaryAction} |
| Next section visible | ${fixture.nextSectionVisible} |
| Duplicate action with tab | ${fixture.duplicateActionWithTab} |

### Reference Contract
_None._

## Design Direction
density: ${fixture.density}
surface: Group related content only when it clarifies ownership; otherwise use full-width content and separators
motion: Functional state and spatial transitions with reduced-motion support
list_style: Entity-specific full-width rows ordered by the fields users scan first
tone: Direct human labels, actionable errors, and domain-specific empty states
primary_action_shape: Stable high-contrast action with a visible verb label
primary_action_position: Bottom-reachable owner on workflow screens; native navigation only when approved
status_treatment: One contained status cue with text and accessible contrast
empty_state: Domain condition, next-step explanation, and one recovery action
heading_font: Approved brand heading family or project default
body_font: Approved readable body family or project default

## Design
Complete materialization.

## Screens
### Navigation Pattern
**Tabs + Stack**

### Screen Map
| Screen | Route | File | Source |
|---|---|---|---|
| Home | \`/(app)/home\` | \`app/(app)/home.tsx\` | replace template |
| Profile | \`/(app)/profile\` | \`app/(app)/profile.tsx\` | new |

### Shared Conventions
**Tab-root silhouettes**
- Home: ${fixture.homeComposition} signature
- Profile: grouped settings rows

### Per-Screen Specs
#### Home (\`/(app)/home\`)
- **Home composition:** \`${fixture.homeComposition}\`
- **First viewport materialization:** ${fixture.signature}, share ${fixture.viewportShare}, minimum ${fixture.minimumHeight}dp
`;
}

test('fixtures use concrete free-form product and visual contracts', () => {
  for (const fixture of fixtures) {
    assert.match(fixture.productArchetype, /\s/);
    assert.match(fixture.visualPersonality, /\s/);
    assert.match(fixture.homeComposition, /\s/);
  }
});

for (const fixture of fixtures) {
  test(`validates prompt-derived experience fixture: ${fixture.id}`, () => {
    assert.deepStrictEqual(validateExperienceContract(toPlan(fixture), { projectRoot: __dirname }), []);
  });
}

test('product structure remains independent from supporting capabilities', () => {
  const fixture = fixtures.find((item) => item.id === 'cmms-premium');
  assert.match(fixture.productArchetype, /maintenance lifecycle/i);
  assert.match(fixture.workflowCapabilities, /ordered checks/i);
  assert.doesNotMatch(fixture.visualPersonality, /inspection/i);
});

test('rejects placeholder Design Direction materialization', () => {
  const fixture = fixtures[0];
  const plan = toPlan(fixture).replace(`density: ${fixture.density}`, 'density: <choose later>');
  const issues = validateExperienceContract(plan, { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'missing-field' && issue.field === 'density'));
});

test('rejects invalid first-viewport geometry', () => {
  const fixture = fixtures[0];
  const plan = toPlan(fixture).replace(`| Minimum height | ${fixture.minimumHeight} |`, '| Minimum height | 100 |');
  const issues = validateExperienceContract(plan, { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'invalid-range' && issue.field === 'minimum height'));
});

test('rejects required media without a source', () => {
  const fixture = { ...fixtures[0], mediaSource: 'none' };
  const issues = validateExperienceContract(toPlan(fixture), { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'missing-required-media'));
});

test('accepts a concrete free-form Home composition', () => {
  const fixture = fixtures.find((item) => item.id === 'retail-immersive');
  assert.deepStrictEqual(validateExperienceContract(toPlan(fixture), { projectRoot: __dirname }), []);
});

test('rejects incomplete Home composition materialization', () => {
  const plan = toPlan(fixtures[0]).replace('- **First viewport materialization:**', '- **Layout delta:**');
  const issues = validateExperienceContract(plan, { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'missing-first-viewport-materialization'));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRODUCT_ARCHETYPES,
  VISUAL_PERSONALITIES,
  validateExperienceContract,
} = require('../validate-experience-contract');

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
visual_personality: ${fixture.visualPersonality}
visual_ambition: ${fixture.visualAmbition}
materialization_profile: custom
product_archetype: ${fixture.productArchetype}
home_composition: ${fixture.homeComposition}
content_emphasis: ${fixture.contentEmphasis}
reference_fidelity: ${fixture.referenceFidelity}
first_viewport_signature: ${fixture.signature}
first_viewport_share: ${fixture.viewportShare}
first_viewport_min_height: ${fixture.minimumHeight}
first_viewport_media: ${fixture.media}
first_viewport_headline_min: ${fixture.headlineMinimum}
first_viewport_metrics_max: ${fixture.metricsMaximum}
first_viewport_action: ${fixture.primaryAction}
first_viewport_next_section_visible: ${fixture.nextSectionVisible === 'yes'}
duplicate_action_with_tab: ${fixture.duplicateActionWithTab}
media_strategy: ${fixture.mediaStrategy}
media_source: ${fixture.mediaSource}
media_fallback: ${fixture.mediaFallback}
navigation_silhouette: ${fixture.navigationSilhouette}

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

test('registries accept all fixture archetypes and personalities', () => {
  for (const fixture of fixtures) {
    assert.ok(PRODUCT_ARCHETYPES.has(fixture.productArchetype), fixture.productArchetype);
    assert.ok(VISUAL_PERSONALITIES.has(fixture.visualPersonality), fixture.visualPersonality);
  }
});

for (const fixture of fixtures) {
  test(`validates independent archetype/personality fixture: ${fixture.id}`, () => {
    assert.deepStrictEqual(validateExperienceContract(toPlan(fixture), { projectRoot: __dirname }), []);
  });
}

test('CMMS remains asset maintenance when inspection is a supporting capability', () => {
  const fixture = fixtures.find((item) => item.id === 'cmms-premium');
  assert.match(fixture.workflowCapabilities, /ordered-checklist/);
  assert.strictEqual(fixture.productArchetype, 'asset-maintenance-cmms');
  assert.strictEqual(fixture.visualPersonality, 'premium-brand-forward');
  assert.strictEqual(fixture.homeComposition, 'asset-command');
});

test('operational archetypes are not forced to utility personality', () => {
  const operational = fixtures.filter((fixture) => ['asset-maintenance-cmms', 'inventory-scan-first'].includes(fixture.productArchetype));
  assert.ok(operational.some((fixture) => fixture.visualPersonality === 'premium-brand-forward'));
  assert.ok(operational.some((fixture) => fixture.visualPersonality === 'playful-consumer'));
});

test('rejects Design Direction drift from Product Experience', () => {
  const fixture = fixtures[0];
  const plan = toPlan(fixture).replace('visual_personality: premium-brand-forward', 'visual_personality: utility');
  const issues = validateExperienceContract(plan, { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'direction-contract-drift' && issue.field === 'visual personality'));
});

test('rejects first-viewport geometry drift from Product Experience', () => {
  const fixture = fixtures[0];
  const plan = toPlan(fixture).replace(`first_viewport_min_height: ${fixture.minimumHeight}`, 'first_viewport_min_height: 180');
  const issues = validateExperienceContract(plan, { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'direction-contract-drift' && issue.field === 'first viewport min height'));
});

test('rejects required media without a source', () => {
  const fixture = { ...fixtures[0], mediaSource: 'none' };
  const issues = validateExperienceContract(toPlan(fixture), { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'missing-required-media'));
});

test('rejects media-command when media is not required', () => {
  const fixture = { ...fixtures.find((item) => item.id === 'retail-immersive'), media: 'optional' };
  const issues = validateExperienceContract(toPlan(fixture), { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'media-command-contract'));
});

test('rejects incomplete Home composition materialization', () => {
  const plan = toPlan(fixtures[0]).replace('- **First viewport materialization:**', '- **Layout delta:**');
  const issues = validateExperienceContract(plan, { projectRoot: __dirname });
  assert.ok(issues.some((issue) => issue.rule === 'missing-first-viewport-materialization'));
});

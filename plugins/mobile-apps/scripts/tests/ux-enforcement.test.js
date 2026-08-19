'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkProvenance, compareVersions } = require('../check-template-provenance');
const { VALIDATORS } = require('../lib/mobile-validator-manifest');
const contrast = require('../../hooks/validate-color-contrast');
const composition = require('../../hooks/validate-screen-composition');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function compositionPlan() {
  return `# App

## Product Experience
- Contract version: 1
- Industry context: fitness
- Product archetype: Equipment maintenance lifecycle from inspection through return to service
- Classification confidence: high
- Classification evidence: equipment lifecycle
- Workflow capabilities: QR lookup and preventive maintenance
- Operating context: Indoor one-handed mobile work
- Visual personality: Precise equipment-focused interface with quiet premium detailing
- Visual ambition: Distinct branded experience with production-level polish
- Content emphasis: Current equipment identity and health dominate supporting maintenance metrics
- Home composition: Equipment identity and health lead into next service and one integrated action
- Navigation mood: Branded native navigation subordinate to equipment content
- Navigation silhouette: branded bottom tabs
- Density: Comfortable scanning rhythm for repeated technician use
- Reference fidelity: none
- Media strategy: record-media
- Media source: equipment image
- Media fallback: stable tinted identity

### First Viewport Contract
| Field | Requirement |
|---|---|
| Signature component | EquipmentCommandHero |
| Viewport share | 0.42 |
| Minimum height | 320 |
| Media | required |
| Headline minimum | 38 |
| Supporting metrics maximum | 2 |
| Primary action | integrated |
| Next section visible | yes |
| Duplicate action with tab | forbidden |

### Reference Contract
_None._

## Screens
### Navigation Pattern
**Tabs + Stack**

### Screen Map
| Screen | Route | File | Source |
|---|---|---|---|
| Home | \`/(app)/home\` | \`app/(app)/home.tsx\` | replace template |
| Profile | \`/(app)/profile\` | \`app/(app)/profile.tsx\` | new |

### Per-Screen Specs
#### Home (\`/(app)/home\`)
- **Home composition:** Equipment identity and health lead into next service and one integrated action
- **First viewport materialization:** EquipmentCommandHero
`;
}

function writeCompositionFixture(root, heroSource) {
  fs.mkdirSync(path.join(root, 'app', '(app)'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'native-app-plan.md'), compositionPlan());
  fs.writeFileSync(path.join(root, 'app', '(app)', 'home.tsx'), `import { EquipmentCommandHero } from '@/components/EquipmentCommandHero'; export default function Home(){ return <><EquipmentCommandHero/><YStack testID="experience-next-section" /></>; }`);
  fs.writeFileSync(path.join(root, 'app', '(app)', 'profile.tsx'), 'export default function Profile(){ return <YStack><Text>Profile</Text></YStack>; }');
  fs.writeFileSync(path.join(root, 'src', 'components', 'EquipmentCommandHero.tsx'), heroSource);
}

test('composition validator accepts a materialized first viewport', () => {
  const root = tempDir('composition-pass-');
  writeCompositionFixture(root, `
    import { Image } from 'expo-image';
    import { useWindowDimensions } from 'react-native';
    export function EquipmentCommandHero(){
      const { height: viewportHeight } = useWindowDimensions();
      const signatureHeight = Math.max(320, Math.round(viewportHeight * 0.42));
      const mediaError = false;
      return <YStack testID="experience-signature" minH={signatureHeight}>
        {mediaError ? <Fallback /> : <Image testID="experience-media" onError={() => {}} />}
        <Text testID="experience-headline" fontSize="$11">Asset</Text>
        <MetricCard testID="experience-metric-1" />
        <MetricCard testID="experience-metric-2" />
        <Button testID="experience-primary-action">Open asset</Button>
      </YStack>;
    }
  `);
  assert.deepStrictEqual(composition.validateProject(root, []), []);
});

test('composition validator rejects dashboard drift and missing geometry/media', () => {
  const root = tempDir('composition-fail-');
  writeCompositionFixture(root, `export function EquipmentCommandHero(){ return <YStack testID="experience-signature"><Text testID="experience-headline" fontSize="$8">Asset</Text><Stat/><Stat/><Stat/><Button testID="experience-primary-action">Open</Button></YStack>; }`);
  const rules = new Set(composition.validateProject(root, []).map((issue) => issue.rule));
  for (const rule of ['signature-min-height-not-materialized', 'viewport-share-not-materialized', 'headline-minimum-not-materialized', 'dashboard-drift', 'required-media-not-rendered', 'runtime-measurement-id']) assert.ok(rules.has(rule), rule);
});

test('contrast validator computes resolved brand-token ratios', () => {
  assert.ok(Math.abs(contrast.contrastRatio('#000000', '#ffffff') - 21) < 0.001);
  const root = tempDir('contrast-');
  fs.mkdirSync(path.join(root, 'brand'));
  fs.writeFileSync(path.join(root, 'brand', 'tokens.ts'), `export const tokens={color:{bg:'#ffffff',surface:'#ffffff',text:'#777777'}} as const;`);
  const small = '<YStack bg="$surface1"><Text color="$text0" fontSize="$5">Body</Text></YStack>';
  const large = '<YStack bg="$surface1"><Text color="$text0" fontSize="$8">Large</Text></YStack>';
  assert.ok(contrast.findIssues(small, root).some((issue) => issue.type.startsWith('resolved contrast 4.48:1')));
  assert.ok(!contrast.findIssues(large, root).some((issue) => issue.type.startsWith('resolved contrast')));
});

test('template provenance supports strict and legacy modes', () => {
  assert.strictEqual(compareVersions('0.2.0', '0.2.0'), 0);
  assert.strictEqual(compareVersions('0.3.0', '0.2.0'), 1);
  const root = tempDir('provenance-');
  fs.mkdirSync(path.join(root, '.powerapps-native'));
  fs.writeFileSync(path.join(root, '.powerapps-native', 'version.json'), JSON.stringify({
    schemaVersion: 2,
    templateVersion: 1,
    templateOwner: 'power-platform-skills/mobile-app',
    pluginVersion: '0.3.0',
    source: 'pa-wrap-tools/templates/expo-app-standalone',
    sourceRef: 'main',
    experienceContractVersion: 1,
    minimumPluginVersion: '0.3.0',
  }));
  assert.strictEqual(checkProvenance(root, { mode: 'strict', pluginVersion: '0.3.0' }).status, 'ok');
  assert.strictEqual(checkProvenance(tempDir('legacy-'), { mode: 'legacy', pluginVersion: '0.3.0' }).status, 'legacy');
  assert.strictEqual(checkProvenance(tempDir('strict-'), { mode: 'strict', pluginVersion: '0.3.0' }).status, 'blocked');
});

test('mobile validator manifest registers experience and composition validators', () => {
  const names = VALIDATORS.map((validator) => validator.script);
  assert.ok(names.includes('validate-experience-contract.js'));
  assert.ok(names.includes('validate-screen-composition.js'));
  const root = path.resolve(__dirname, '..', '..');
  for (const validator of VALIDATORS) assert.ok(fs.existsSync(path.join(root, 'hooks', validator.script)), validator.script);
});

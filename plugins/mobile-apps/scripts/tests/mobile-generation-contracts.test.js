'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pluginRoot = path.resolve(__dirname, '..', '..');

function runHook(name, projectRoot, filePath, content) {
  return spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', name)], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: projectRoot,
      tool_name: 'Write',
      tool_input: { file_path: filePath, content },
    }),
  });
}

test('create flow keeps native and connector interpretation visible in Gate 1', () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8',
  );
  const discovery = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'references', 'requirements-discovery.md'),
    'utf8',
  );

  assert.match(skill, /Capability and integration interpretation \(approved here\):/);
  assert.match(skill, /Native outcomes\s+<comma-separated explicit\/inferred outcomes/);
  assert.match(skill, /External connectors\s+<comma-separated API\/service names/);
  assert.match(skill, /exact bindings confirmed at Gate 2/);
  assert.match(skill, /Gate 1 capability interpretation: <capability_summary verbatim>/);
  assert.match(skill, /informational only; outside Gate 1 and Gate 2 approval/);
  assert.doesNotMatch(skill, /Connectors\s+<N> inferred[^\n]+confirm at Gate 3/);
  assert.match(discovery, /every prompt-richness tier/);
  assert.match(discovery, /scan barcode/);
  assert.match(discovery, /low-stock alerts.*Dataverse records/);
  assert.match(discovery, /do not add a separate `Look right\?` prompt/);

  const connectorPlanning = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'references', 'connector-planning.md'),
    'utf8',
  );
  assert.match(connectorPlanning, /Do not ask a separate\s+connector question/);
  assert.match(connectorPlanning, /exact connector architecture only inside\s+Gate 2/);
  assert.doesNotMatch(connectorPlanning, /native-app-planner` \(Gate 3\)/);
});

test('Dataverse planning expands summary-only candidates before Gate 2', () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8',
  );
  const architect = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'data-model-architect.md'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'native-app-planner.md'),
    'utf8',
  );

  assert.match(skill, /every named data noun and workflow family/);
  assert.match(skill, /detailed-dataverse-metadata:<logical names>/);
  assert.match(architect, /must also have a full entry in `snapshot\.tables`/);
  assert.match(architect, /NEEDS_CONTEXT: detailed-dataverse-metadata:/);
  assert.match(planner, /bounded exact-name\s+expansion/);
});

test('mobile planning requires reviewable ER columns and bounded screen progress', () => {
  const architect = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'data-model-architect.md'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'native-app-planner.md'),
    'utf8',
  );
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  assert.match(architect, /Every entity named in a relationship MUST also have an `\{ \.\.\. \}` attribute/);
  assert.match(architect, /primary key marked `PK`/);
  assert.match(architect, /marked `FK`/);
  assert.match(screenPlanner, /Focused single-workflow app \| 6–10/);
  assert.match(screenPlanner, /More than 18 is a mandatory consolidation review threshold/);
  assert.match(screenPlanner, /batches of at most 4 screens/);
  assert.match(screenPlanner, /Expanding screen specs <END>\/<N>/);
  assert.match(planner, /Expanding <N> screens in <B> visible batches/);
});

test('screen planning consolidates workflows before expanding specifications', () => {
  const skill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'native-app-planner.md'),
    'utf8',
  );
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  assert.match(screenPlanner, /Build traceability inventory/);
  assert.match(screenPlanner, /Classify each entity's representation/);
  assert.match(screenPlanner, /lookup\/picker only/);
  assert.match(screenPlanner, /join managed through its parent/);
  assert.match(screenPlanner, /evidence\/audit timeline/);
  assert.match(screenPlanner, /related lists → one segmented or filtered hub/);
  assert.match(screenPlanner, /create \+ edit → one parameterized form/);
  assert.match(screenPlanner, /manager review\/approval → actions or a section/);
  assert.match(screenPlanner, /Run separation tests/);
  assert.match(screenPlanner, /independent deep link/);
  assert.match(screenPlanner, /### Consolidation Decisions/);
  assert.doesNotMatch(screenPlanner, /For a typical CRUD app/);
  assert.doesNotMatch(screenPlanner, /every entity.*MUST have at least a List \+ Detail pair/i);
  assert.doesNotMatch(screenPlanner, /under 8 for v0/);

  assert.match(
    planner,
    /If `<N> > 18`,[\s\S]*re-dispatch `phase: graph` once[\s\S]*Do not\s+start `phase: specs`/,
  );
  assert.match(
    skill,
    /Before Gate 3,[\s\S]*generated\/modified Screen Map rows[\s\S]*Fail closed/,
  );
});

test('external projections produce explicit non-blocking server recommendations', () => {
  const architect = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'data-model-architect.md'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'native-app-planner.md'),
    'utf8',
  );
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  const screenBuilder = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-builder.md'),
    'utf8',
  );
  const gateContract = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'references', 'four-gate-planning.md'),
    'utf8',
  );
  const createSkill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8',
  );

  assert.match(architect, /Dataverse rollup column/);
  assert.match(architect, /Power Automate-maintained summary field/);
  assert.match(architect, /Dataverse plug-in or custom API/);
  assert.match(architect, /Default to `deferred-nonblocking`/);
  assert.match(architect, /Use `blocking` only when an explicit requirement/);
  assert.match(screenPlanner, /projection_criticality: deferred-nonblocking \| blocking/);
  assert.match(screenPlanner, /safe_fallback:/);
  assert.match(planner, /`deferred-nonblocking` rows continue\s+to Gate 3/);
  assert.match(screenBuilder, /build the named safe\s+fallback and continue/);
  assert.match(gateContract, /non-blocking server-side projection recommendations/);
  assert.match(createSkill, /server-side projection recommendations, why each is needed/);
});

test('screen navigation keeps forward intent separate from back behavior', () => {
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  const screenBuilder = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-builder.md'),
    'utf8',
  );

  assert.match(screenPlanner, /Use `back` for `router\.back\(\)`/);
  assert.match(screenPlanner, /Never write `push back`/);
  assert.match(screenPlanner, /`Intent` means \*\*how a caller enters the/);
  assert.match(screenBuilder, /return behavior `back`/);
  assert.match(screenBuilder, /never generate `router\.push\(\.\.\.\)` merely because a stale spec says “push back/);
});

test('untouched template screens receive preservation contracts instead of full specs', () => {
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'native-app-planner.md'),
    'utf8',
  );

  assert.match(screenPlanner, /Source is\s+`template \(keep\)` does not receive a `####` per-screen specification/);
  assert.match(screenPlanner, /### Template Screens \(preserve\)/);
  assert.match(screenPlanner, /mark its Source\s+`template \(modify\)`/);
  assert.match(screenPlanner, /not `template \(keep\)`/);
  assert.match(planner, /Do not expand Source `template \(keep\)` rows/);
});

test('screen contracts require escaped user-entered OData values', () => {
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  const screenBuilder = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-builder.md'),
    'utf8',
  );
  const dataverseUtils = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'samples', 'src', 'utils', 'dataverse.ts'),
    'utf8',
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-odata-contract-'));
  const file = path.join(root, 'app', 'inventory.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unsafe = [
    'export default function Inventory() {',
    "  const query = \"O'Brien\";",
    "  const filter = `contains(new_name, '${query}')`;",
    '  return null;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, unsafe);

  assert.match(screenPlanner, /MUST use `containsFilter/);
  assert.match(screenBuilder, /User-entered OData values must be escaped/);
  assert.match(dataverseUtils, /export function odataString/);
  assert.match(dataverseUtils, /odataString\(trimmed\)/);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /unsafe-odata-interpolation/);
});

test('experience previews prominently identify themselves as design concepts', () => {
  const mapping = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'references', 'tamagui-html-mapping.md'),
    'utf8',
  );
  const renderer = fs.readFileSync(
    path.join(pluginRoot, 'scripts', 'render-mobile-plan.js'),
    'utf8',
  );

  assert.match(mapping, /DESIGN CONCEPT — NOT THE GENERATED APP/);
  assert.match(mapping, /border: 3px solid/);
  assert.match(renderer, /class="concept-banner"/);
  assert.match(renderer, /Generated TSX and the live device are authoritative/);
});

test('create flow opens an event-driven planning companion immediately after Gate 1', () => {
  const createSkill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8',
  );
  const nativePlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'native-app-planner.md'),
    'utf8',
  );
  const screenPlanner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  const gateContract = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'references', 'four-gate-planning.md'),
    'utf8',
  );

  assert.match(createSkill, /Start the loopback-only planning companion/);
  assert.match(createSkill, /Do not wait for Gate 2/);
  assert.match(createSkill, /Server-Sent Events—no interval polling and no periodic/);
  assert.match(createSkill, /Apply browser revision/);
  assert.match(createSkill, /phase: architecture/);
  assert.match(createSkill, /phase: experience/);
  assert.match(nativePlanner, /verify that `mobile-app-status\.json\.updatedAt`/);
  assert.match(nativePlanner, /Never perform\s+`architecture` and `experience` in one invocation/);
  assert.match(nativePlanner, /Screen graph ready — expanding <N> detailed screen specs/);
  assert.match(gateContract, /Present Gate 2 as soon as architecture is ready/);
  assert.match(gateContract, /Only after Gate 2 approval/);
  assert.match(gateContract, /Server-Sent\s+Events/);
  assert.match(screenPlanner, /Verify the helper changed the file's/);
  assert.match(screenPlanner, /completed: 2` \/ `total: 4` while batches are running/);
  assert.doesNotMatch(screenPlanner, /est ~\$\(\(N \* 60\)\)s/);
});

test('mobile visual quality contract is shared across planning, design, preview, and build', () => {
  const contract = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'references', 'mobile-visual-quality-contract.md'),
    'utf8',
  );
  const planner = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-planner.md'),
    'utf8',
  );
  const builder = fs.readFileSync(
    path.join(pluginRoot, 'agents', 'screen-builder.md'),
    'utf8',
  );
  const designSystem = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'design-system', 'SKILL.md'),
    'utf8',
  );
  const mapping = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'references', 'tamagui-html-mapping.md'),
    'utf8',
  );
  const components = fs.readFileSync(
    path.join(pluginRoot, 'shared', 'samples', 'src', 'components', 'index.tsx'),
    'utf8',
  );

  assert.match(contract, /## 1\. Typography roles/);
  assert.match(contract, /## 5\. Screen composition recipes/);
  assert.match(contract, /## 6\. Domain imagery eligibility/);
  assert.match(planner, /\*\*Composition recipe\*\* — REQUIRED/);
  assert.match(planner, /\*\*Imagery contract\*\* — REQUIRED only when imagery is eligible/);
  assert.match(builder, /mobile-visual-quality-contract\.md/);
  assert.match(builder, /Prefer `PrimaryActionButton`/);
  assert.match(designSystem, /## Composition/);
  assert.match(designSystem, /## Imagery/);
  assert.match(mapping, /same named composition recipe/);
  assert.match(components, /export function PrimaryActionButton/);
  assert.match(components, /export function SecondaryActionButton/);
  assert.match(components, /export function DestructiveActionButton/);
});

test('screen validator enforces semantic typography and primary action geometry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-visual-contract-'));
  const file = path.join(root, 'app', 'checkout.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const invalid = [
    "import { Button, Text, YStack } from 'tamagui';",
    'export default function Checkout() {',
    '  return <YStack>',
    '    <Text fontSize={18}>Order total</Text>',
    '    <Button bg="$accentBase"><Button.Text color="$accentOnAccent">Place order</Button.Text></Button>',
    '  </YStack>;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, invalid);

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Raw numeric typography/);
  assert.match(result.stderr, /Primary button missing approved mobile height/);
  assert.match(result.stderr, /Primary button missing the app radius policy/);
});

test('screen validator accepts semantic typography and approved primary action geometry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-visual-valid-'));
  const file = path.join(root, 'app', 'checkout.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const valid = [
    "import { Button, Text, YStack } from 'tamagui';",
    "import { SafeAreaView } from 'react-native-safe-area-context';",
    'export default function Checkout() {',
    '  return <SafeAreaView><YStack>',
    '    <Text fontSize="$6">Order total</Text>',
    '    <Button bg="$accentBase" minH={48} rounded="$3"><Button.Text color="$accentOnAccent">Place order</Button.Text></Button>',
    '  </YStack></SafeAreaView>;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, valid);

  assert.strictEqual(result.status, 0, result.stderr);
});

test('screen validator blocks invalid mobile and Tamagui generation patterns', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-screen-contract-'));
  const file = path.join(root, 'app', 'home.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "import { Input, Text, YStack } from 'tamagui';",
    'export default function Home() {',
    '  return <YStack alignSelf="center" contentContainerStyle={{ padding: 4 }}>',
    '    <Input onChange={(e) => console.log(e.target.value)} />',
    "    <Text fontFamily={true ? '$mono' : undefined}>42</Text>",
    '  </YStack>;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, content);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Undefined Tamagui monospace font token/);
  assert.match(result.stderr, /Web-style text input handler/);
  assert.match(result.stderr, /Unsupported longhand prop/);
  assert.match(result.stderr, /React Native container prop used on a Tamagui primitive/);
});

test('screen validator allows React Native contentContainerStyle and typed onChangeText', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-screen-valid-'));
  const file = path.join(root, 'app', 'home.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "import { ScrollView } from 'react-native';",
    "import { Input, Text } from 'tamagui';",
    "import { SafeAreaView } from 'react-native-safe-area-context';",
    'export default function Home() {',
    '  return <SafeAreaView><ScrollView contentContainerStyle={{ padding: 4 }}>',
    '    <Input onChangeText={(value: string) => console.log(value)} />',
    "    <Text style={{ fontFamily: 'monospace' }}>42</Text>",
    '  </ScrollView></SafeAreaView>;',
    '}',
  ].join('\n');
  const result = runHook('validate-screen-quality.js', root, file, content);
  assert.strictEqual(result.status, 0, result.stderr);
});

test('source import validator blocks packages absent from the live project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-import-contract-'));
  const file = path.join(root, 'app', 'form.tsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0' },
  }));
  const result = runHook(
    'validate-source-imports.js',
    root,
    file,
    "import { zodResolver } from '@hookform/resolvers/zod';\nexport default function Form() { return null; }\n",
  );
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /@hookform\/resolvers/);
});

test('source import validator blocks dynamic imports and require calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-dynamic-import-contract-'));
  const file = path.join(root, 'src', 'load.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '19.0.0' },
  }));
  for (const content of [
    "export async function load() { return import('undeclared-dynamic'); }\n",
    "const missing = require('undeclared-required');\nexport { missing };\n",
  ]) {
    const result = runHook('validate-source-imports.js', root, file, content);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /undeclared-/);
  }
});

test('template path aliases include root and wildcard entries', () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'template', 'tsconfig.json'), 'utf8'));
  for (const alias of ['components', 'hooks', 'utils', 'tokens', 'generated', 'native']) {
    assert.ok(tsconfig.compilerOptions.paths[`@/${alias}`]);
    assert.ok(tsconfig.compilerOptions.paths[`@/${alias}/*`]);
  }
});

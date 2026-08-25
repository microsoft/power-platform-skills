'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nativeCanaryDispatch } = require('../prepare-native-canary');
const { validateCanarySource } = require('../validate-native-canary');

function screen(id, role, productRole) {
  return {
    id,
    route: `/(app)/${id}`,
    file: `app/(app)/${id}.tsx`,
    role,
    productRole,
    headerMode: role === 'primary' ? 'root' : 'back',
    header: { mode: role === 'primary' ? 'root' : 'back', title: id },
    purpose: `Complete ${id} work.`,
    presentation: { pattern: 'summary', density: 'balanced', hierarchy: ['Title', 'Content'] },
    regions: [{ id: `${id}-content`, kind: 'content', priority: 1, viewport: 'first', mediaRequired: false }],
    firstViewport: { regionIds: [`${id}-content`], focalPoint: `${id} content`, maxRegions: 1, visiblePrimaryAction: false, primaryActionPlacement: 'none', nextContentVisible: true, maxFeatureViewportShare: 0 },
    context: { placementIntent: 'none', entries: [], assumptions: [], forbiddenInferences: [] },
    signatureComponent: { kind: 'summary', required: false, testId: null },
    primaryAction: null,
    media: { required: false, role: 'supporting', aspectRatio: '4:3', minCoverage: 0, fallback: 'text-only', prominence: 'none', source: 'bundled', delivery: 'bundled', sizing: 'not-applicable', maxViewportShare: 0 },
    states: ['loading', 'empty', 'error', 'offline', 'recovery'],
    qualityCriteria: ['One focal point.', 'No overlap.', 'Large text reflows.'],
    dependencies: { foundation: [], fixtures: [], screens: [], artifacts: [] },
    testIds: [`screen-${id}`],
    forbiddenDefaults: [],
    data: { operations: [] },
    journey: {}, actionState: {}, signatureComponents: [], semanticColorRoles: [], capabilityComposition: [], layoutBudgets: {},
  };
}

test('native canary dispatch preserves pack order and existing screen-builder work orders', () => {
  const home = screen('home', 'primary', 'primary-hub');
  const detail = screen('detail', 'key-flow', 'detail');
  const pack = {
    revision: 'a'.repeat(64),
    nativeCanary: { primaryScreenId: 'home', keyFlowScreenIds: ['detail'], screenIds: ['home', 'detail'], outcome: 'Inspect one complete flow.' },
    screens: [home, detail],
    experience: {}, context: {}, design: {}, shell: {}, navigation: {}, execution: {}, fixtures: {}, journey: {}, capabilityBindings: [], productStructure: {},
  };
  const dispatch = nativeCanaryDispatch(pack, (screenId) => ({ screenId, file: `${screenId}.tsx`, inputFileSha256: screenId === 'home' ? 'b'.repeat(64) : 'c'.repeat(64) }));
  assert.equal(dispatch.kind, 'native-canary-dispatch');
  assert.deepEqual(dispatch.targets.map((target) => target.screenId), ['home', 'detail']);
  assert.equal(dispatch.targets[0].workOrder.target.screenId, 'home');
  assert.equal(dispatch.targets[1].workOrder.constraints.ownership, 'single-screen-file');
});

test('native canary source rejects a hash-only skeleton', () => {
  const value = screen('home', 'primary', 'primary-hub');
  const source = `import { ScreenShell } from '@/components';\nexport default function Home() { return <ScreenShell headerMode="root" title="Home">{/* TODO: screen-builder fills JSX here */}</ScreenShell>; }\n`;
  const issues = validateCanarySource(source, value, { design: { recipe: { spacing: { minimumControlSize: 44 } } } });
  assert.ok(issues.some((entry) => entry.rule === 'unfinished-canary-screen'));
});

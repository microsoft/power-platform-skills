'use strict';

// Tests for validate-product-scope.js — the adaptive budget and anti-inflation layer.
// Run with: node --test plugins/mobile-apps/scripts/tests/
//
// The rules under test all answer one question: does this surface or table exist because a
// user has a job, or because an entity existed? Budgets are adaptive review budgets — a
// multi-role product is expected to reach 20 screens, and nothing here caps every product at
// a small number.

const test = require('node:test');
const assert = require('node:assert');

const { validateScopeContract } = require('../validate-product-scope');
const {
  ABSOLUTE_SCREEN_CEILING,
  SCREEN_BUDGETS,
  contractRevision,
} = require('../lib/product-experience-contracts');
const { buildExperience, buildScope } = require('./helpers/product-experience-fixtures');
const { bundleFor } = require('./helpers/product-experience-scenarios');
const { cleanup, codes, makeProjectDir, runCli, writeContracts } = require('./helpers/contract-cli');

const EXPERIENCE = buildExperience();

function job(id, overrides = {}) {
  return {
    id,
    statement: `As a user I want to complete ${id} so that the work moves forward`,
    actor: 'Primary user',
    outcome: `${id} is complete`,
    criticality: 'critical',
    surface: { kind: 'screen', screenId: `${id}-screen` },
    criticalSteps: [`${id}-step`],
    ...overrides,
  };
}

function screen(id, overrides = {}) {
  return {
    id,
    title: id.slice(0, 60),
    purpose: `Serves the ${id} part of the release journey`,
    userFacing: true,
    pattern: 'workflow-step',
    jobIds: overrides.jobIds || ['job-a'],
    justification: `Exists because a declared job needs the ${id} surface`,
    ...overrides,
  };
}

function entity(name, overrides = {}) {
  return { name, role: 'primary', realization: 'view-model-only', screenIds: [], ...overrides };
}

function newTable(name, overrides = {}) {
  return {
    name,
    jobIds: ['job-a'],
    lifecycleJustification: {
      reasons: ['independent-lifecycle'],
      statement: `${name} is created, updated, and retained independently of its parent record`,
    },
    ...overrides,
  };
}

/** Screens that satisfy the band without triggering any composition rule. */
function fillerScreens(count, jobId = 'job-a') {
  return Array.from({ length: count }, (_, index) => screen(`filler-${index + 1}`, {
    pattern: 'overview',
    jobIds: [jobId],
  }));
}

// ── Baseline ─────────────────────────────────────────────────────────────────

test('every scenario bundle produces a valid scope contract', () => {
  for (const key of ['commerce', 'inspection', 'scheduling', 'finance', 'learning', 'community', 'analytics', 'logistics', 'niche']) {
    const { experience, scope } = bundleFor(key);
    const result = validateScopeContract(scope, experience);
    assert.deepStrictEqual(result.errors, [], `${key} scope produced errors`);
    assert.match(result.revision, /^[0-9a-f]{64}$/);
  }
});

test('scope binds to the experience revision it was derived from', () => {
  const { experience, scope } = bundleFor('commerce');
  assert.strictEqual(validateScopeContract(scope, experience).ok, true);

  const edited = { ...experience, informationDensity: 'dense' };
  const stale = validateScopeContract(scope, edited);
  assert.strictEqual(stale.ok, false);
  assert.ok(codes(stale).includes('stale-contract-binding'));
});

// ── Adaptive budgets ─────────────────────────────────────────────────────────

test('each complexity band accepts a screen count inside its own range', () => {
  const cases = [
    ['focused', 6, 7],
    ['standard', 10, 12],
    ['complex', 14, 16],
    ['multi-role', 18, 20],
  ];
  for (const [complexity, count, max] of cases) {
    const scope = buildScope(EXPERIENCE, {
      productComplexity: complexity,
      complexityJustification: `Classified ${complexity} because of the number of independent journeys involved`,
      coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
      screenBudget: { target: count, max },
      screens: fillerScreens(count),
      newTableBudget: { target: 1, max: 2 },
      newTables: [],
      dataEntities: [entity('Work item')],
    });
    const result = validateScopeContract(scope, EXPERIENCE);
    assert.deepStrictEqual(result.errors, [], `${complexity} with ${count} screens should pass`);
    assert.strictEqual(result.summary.userFacingScreenCount, count);
    assert.deepStrictEqual(result.summary.screenBand, SCREEN_BUDGETS[complexity]);
  }
});

test('a screen count above the declared complexity band is rejected rather than silently allowed', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 6, max: 7 },
    screens: fillerScreens(9),
    dataEntities: [entity('Work item')],
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('screen-count-over-budget'));
  assert.ok(codes(result).includes('screen-count-over-complexity-band'));
});

test('a budget raised above its band is rejected instead of unlocking more screens', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 9, max: 12 },
    screens: fillerScreens(9),
    dataEntities: [entity('Work item')],
  });
  assert.ok(codes(validateScopeContract(scope, EXPERIENCE)).includes('screen-budget-exceeds-band'));
});

test('a screen count below the band is a warning, not a rejection', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 4, max: 7 },
    screens: fillerScreens(3),
    dataEntities: [entity('Work item')],
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some((entry) => entry.code === 'screen-count-under-band'));
});

test('infrastructure routes do not consume screen budget', () => {
  const screens = [
    ...fillerScreens(4),
    { ...screen('auth-callback', { pattern: 'infrastructure', userFacing: false }) },
    { ...screen('root-layout', { pattern: 'infrastructure', userFacing: false }) },
  ];
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 4, max: 7 },
    screens,
    dataEntities: [entity('Work item')],
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.summary.userFacingScreenCount, 4);
});

test(`more than ${ABSOLUTE_SCREEN_CEILING} screens is rejected without an exceptional justification`, () => {
  const screens = fillerScreens(22);
  const base = {
    productComplexity: 'multi-role',
    complexityJustification: 'Four independent roles each with their own workspace and journey',
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 20, max: 20 },
    screens,
    dataEntities: [entity('Work item')],
  };

  const rejected = validateScopeContract(buildScope(EXPERIENCE, base), EXPERIENCE);
  assert.strictEqual(rejected.ok, false);
  assert.ok(codes(rejected).includes('screen-ceiling-without-exceptional-justification'));

  const accepted = validateScopeContract(buildScope(EXPERIENCE, {
    ...base,
    productComplexity: 'exceptional',
    complexityJustification: 'Five independent role workspaces that cannot be composed into shared surfaces',
    screenBudget: { target: 22, max: 24 },
    exceptionalJustification: {
      statement: 'Five roles each own an end-to-end journey with no shared surface; composing them would hide each role behind another role\u2019s navigation.',
      independentRoles: ['Dispatcher', 'Operator', 'Supervisor', 'Auditor', 'Client'],
      independentJourneys: ['Dispatch run', 'Operate run', 'Review exceptions', 'Audit closed runs'],
    },
  }), EXPERIENCE);
  assert.deepStrictEqual(accepted.errors, []);
});

// ── Table budgets ────────────────────────────────────────────────────────────

test('new tables over the declared budget without lifecycle justification are rejected', () => {
  const tables = ['t-one', 't-two', 't-three', 't-four', 't-five'];
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 4, max: 7 },
    screens: fillerScreens(4),
    newTableBudget: { target: 2, max: 4 },
    newTables: tables.map((name) => newTable(name)),
    dataEntities: tables.map((name) => entity(name, { realization: 'new-table' })),
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('new-table-count-over-budget'));
  assert.strictEqual(result.summary.newTableCount, 5);
});

test('new tables over budget with a lifecycle reason and a written rationale downgrade to a warning', () => {
  const tables = ['t-one', 't-two', 't-three', 't-four', 't-five'];
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screenBudget: { target: 4, max: 7 },
    screens: fillerScreens(4),
    newTableBudget: {
      target: 2,
      max: 4,
      rationale: 'Each additional table carries its own retention period, so they cannot be merged into one.',
    },
    newTables: tables.map((name) => newTable(name, {
      lifecycleJustification: {
        reasons: ['independent-lifecycle', 'explicit-history-or-audit'],
        statement: `${name} is retained on its own schedule and reported on separately`,
      },
    })),
    dataEntities: tables.map((name) => entity(name, { realization: 'new-table' })),
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some((entry) => entry.code === 'new-table-count-over-budget-justified'));
});

test('a new table must match a declared data entity', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screens: fillerScreens(4),
    newTables: [newTable('Orphan table')],
    dataEntities: [entity('Work item')],
  });
  assert.ok(codes(validateScopeContract(scope, EXPERIENCE)).includes('new-table-entity-mismatch'));
});

test('a noun realized as a Choice column needs no table and no screen', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screens: fillerScreens(4),
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
    dataEntities: [
      entity('Work item'),
      entity('Priority', { role: 'reference', realization: 'choice-column' }),
      entity('Region', { role: 'supporting', realization: 'parent-column' }),
    ],
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.deepStrictEqual(result.errors, []);
  assert.ok(result.summary.entitiesWithoutScreens.includes('Priority'));
  assert.ok(result.summary.entitiesWithoutScreens.includes('Region'));
});

// ── Anti-CRUD-multiplication ─────────────────────────────────────────────────

test('two generic screens for one entity serving the identical job set are rejected', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'orders-list' } })],
    screenBudget: { target: 4, max: 7 },
    screens: [
      screen('orders-list', { pattern: 'list', entity: 'Order', jobIds: ['job-a'] }),
      screen('orders-detail', { pattern: 'detail', entity: 'Order', jobIds: ['job-a'] }),
      ...fillerScreens(2),
    ],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
    dataEntities: [entity('Order', { screenIds: ['orders-list', 'orders-detail'] })],
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('entity-crud-multiplication'));
});

test('generic screens for one entity are fine when each serves a distinct declared job', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [
      job('job-a', { surface: { kind: 'screen', screenId: 'orders-list' } }),
      job('job-b', { criticality: 'important', surface: { kind: 'screen', screenId: 'orders-detail' } }),
    ],
    screenBudget: { target: 4, max: 7 },
    screens: [
      screen('orders-list', { pattern: 'list', entity: 'Order', jobIds: ['job-a'] }),
      screen('orders-detail', { pattern: 'detail', entity: 'Order', jobIds: ['job-b'] }),
      ...fillerScreens(2),
    ],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
    dataEntities: [entity('Order', { screenIds: ['orders-list', 'orders-detail'] })],
  });
  assert.deepStrictEqual(validateScopeContract(scope, EXPERIENCE).errors, []);
});

test('generating a list, detail, and editor for every entity is rejected as template expansion', () => {
  const entities = ['Order', 'Customer', 'Product'];
  const screens = [];
  const coreJobs = [];
  for (const [index, name] of entities.entries()) {
    const key = name.toLowerCase();
    for (const [suffix, pattern] of [['list', 'list'], ['detail', 'detail'], ['form', 'form']]) {
      const jobId = `${key}-${suffix}-job`;
      screens.push(screen(`${key}-${suffix}`, { pattern, entity: name, jobIds: [jobId] }));
      coreJobs.push(job(jobId, {
        criticality: index === 0 && suffix === 'list' ? 'critical' : 'important',
        surface: { kind: 'screen', screenId: `${key}-${suffix}` },
      }));
    }
  }
  const scope = buildScope(EXPERIENCE, {
    productComplexity: 'standard',
    complexityJustification: 'Three record types each managed end to end by the same operations role',
    coreJobs,
    screenBudget: { target: 9, max: 12 },
    screens,
    newTables: [],
    newTableBudget: { target: 0, max: 4 },
    dataEntities: entities.map((name) => entity(name)),
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('entity-crud-template-expansion'));
  assert.strictEqual(result.summary.entitiesWithFullCrudTriplet, 3);
});

test('a supporting entity given its own record screen with no core job is rejected', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    supportingJobs: [{
      id: 'job-lookup',
      statement: 'As a user I want to look up a code while working',
      actor: 'Primary user',
      outcome: 'The code is understood',
      surface: { kind: 'screen', screenId: 'codes-list' },
    }],
    screenBudget: { target: 4, max: 7 },
    screens: [
      ...fillerScreens(3),
      screen('codes-list', { pattern: 'list', entity: 'Code', jobIds: ['job-lookup'] }),
    ],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
    dataEntities: [
      entity('Work item'),
      entity('Code', { role: 'supporting', realization: 'existing-table', screenIds: ['codes-list'] }),
    ],
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('reference-entity-dedicated-screen'));
});

// ── Coverage ─────────────────────────────────────────────────────────────────

test('a critical job whose surface does not exist is rejected as missing coverage', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'nowhere' } })],
    screens: fillerScreens(4),
    dataEntities: [entity('Work item')],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.strictEqual(result.ok, false);
  assert.ok(codes(result).includes('missing-critical-job-coverage'));
});

test('a job may be covered by a section, sheet, modal, flow step, or contextual action', () => {
  for (const kind of ['section', 'sheet', 'modal', 'flow-step', 'contextual-action']) {
    const scope = buildScope(EXPERIENCE, {
      coreJobs: [
        job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } }),
        job('job-b', {
          criticality: 'important',
          surface: { kind, screenId: 'filler-2', detail: `Rendered as a ${kind} on the same surface` },
        }),
      ],
      screens: fillerScreens(4),
      dataEntities: [entity('Work item')],
      newTables: [],
      newTableBudget: { target: 0, max: 2 },
    });
    const result = validateScopeContract(scope, EXPERIENCE);
    assert.deepStrictEqual(result.errors, [], `${kind} coverage should not require its own route`);
  }
});

test('a whole-screen surface must be acknowledged by the screen it claims', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [
      job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } }),
      job('job-b', { criticality: 'important', surface: { kind: 'screen', screenId: 'filler-2' } }),
    ],
    screens: fillerScreens(4),
    dataEntities: [entity('Work item')],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
  });
  assert.ok(codes(validateScopeContract(scope, EXPERIENCE)).includes('job-surface-mismatch'));
});

test('a screen serving a job that does not exist or has been deferred is rejected', () => {
  const unknown = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    screens: [...fillerScreens(3), screen('extra', { jobIds: ['job-ghost'] })],
    dataEntities: [entity('Work item')],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
  });
  assert.ok(codes(validateScopeContract(unknown, EXPERIENCE)).includes('screen-without-known-job'));

  const deferred = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } })],
    deferredJobs: [{ id: 'job-later', statement: 'Bulk export for the whole team', deferralReason: 'Not needed for the first release' }],
    screens: [...fillerScreens(3), screen('extra', { jobIds: ['job-later'] })],
    dataEntities: [entity('Work item')],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
  });
  assert.ok(codes(validateScopeContract(deferred, EXPERIENCE)).includes('screen-serves-deferred-job'));
});

test('duplicate screen and job identifiers are rejected', () => {
  const scope = buildScope(EXPERIENCE, {
    coreJobs: [job('job-a', { surface: { kind: 'screen', screenId: 'filler-1' } }), job('job-a')],
    screens: [...fillerScreens(4), screen('filler-1')],
    dataEntities: [entity('Work item')],
    newTables: [],
    newTableBudget: { target: 0, max: 2 },
  });
  const result = validateScopeContract(scope, EXPERIENCE);
  assert.ok(codes(result).includes('duplicate-screen-id'));
  assert.ok(codes(result).includes('duplicate-job-id'));
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test('CLI validates scope against the experience contract found beside it', () => {
  const projectRoot = makeProjectDir('scope-cli');
  try {
    const { experience, scope } = bundleFor('logistics');
    writeContracts(projectRoot, { experience, scope });

    const ok = runCli('validate-product-scope.js', ['--project-root', projectRoot]);
    assert.strictEqual(ok.code, 0);
    assert.strictEqual(ok.json.ok, true);
    assert.strictEqual(ok.json.revision, contractRevision(scope));
    assert.strictEqual(ok.json.summary.userFacingScreenCount, 4);

    writeContracts(projectRoot, { experience, scope: { ...scope, experienceRevision: 'f'.repeat(64) } });
    const stale = runCli('validate-product-scope.js', ['--project-root', projectRoot]);
    assert.strictEqual(stale.code, 1);
    assert.ok(codes(stale.json).includes('stale-contract-binding'));
  } finally {
    cleanup(projectRoot);
  }
});

test('CLI exits 2 when the scope contract is missing', () => {
  const projectRoot = makeProjectDir('scope-cli-missing');
  try {
    const result = runCli('validate-product-scope.js', ['--project-root', projectRoot]);
    assert.strictEqual(result.code, 2);
    assert.strictEqual(result.json.fatal, true);
  } finally {
    cleanup(projectRoot);
  }
});

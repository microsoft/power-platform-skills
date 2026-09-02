'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ARTIFACTS,
  deriveBuildPlanModel,
  renderBuildPlanHtml,
  revisionOf,
  updateProgress,
  writeBuildPlan,
} = require('../lib/mobile-build-plan');
const {
  analyzeDataModelRemoval,
  applyDataModelEdit,
  undoLastDataModelEdit,
} = require('../lib/mobile-build-plan-edits');
const { validateScopeContract } = require('../validate-product-scope');
const { cleanup } = require('./helpers/contract-cli');
const { bundleFor } = require('./helpers/product-experience-scenarios');

function makeProjectDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function writeJson(projectRoot, relativePath, value) {
  const file = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('Build Plan composes progress and canonical planning artifacts', () => {
  const projectRoot = makeProjectDir('mobile-build-plan');
  try {
    writeJson(projectRoot, '.tmp/product-experience-contract.json', {
      productName: 'Field North',
      operatingContext: { environment: 'field' },
      promptEvidence: {
        target: [{
          text: 'Tenant 22222222-3333-4444-5555-666666666666',
          source: 'user-prompt',
        }],
      },
    });
    writeJson(projectRoot, '.tmp/product-scope-contract.json', {
      jobs: [{ id: 'inspect', statement: 'Inspect assigned equipment' }],
    });
    writeJson(projectRoot, '.tmp/workflow-journey-contract.json', {
      journeys: [{
        id: 'inspect',
        name: 'Inspect tenant 44444444-5555-6666-7777-888888888888',
        steps: [{
          order: 1,
          label: 'Open https://contoso.crm.dynamics.com',
          userAction: 'Review the assignment',
        }],
      }],
    });
    writeJson(projectRoot, '.tmp/compiled-screen-build-pack.json', {
      screens: [{ screenId: 'assignments', title: 'Assignments', pack: { purpose: 'Choose the next inspection' } }],
    });
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', {
      schemaVersion: 1,
      publisherPrefix: 'ct',
      tables: [{
        logicalName: 'ct_inspection',
        schemaName: 'ct_inspection',
        plannedDecision: 'create',
        dependencyTier: 0,
        columns: [{ logicalName: 'ct_name', schemaName: 'ct_name', type: 'string', plannedDecision: 'create', primaryName: true }],
        relationships: [],
        alternateKeys: [],
      }],
    });
    writeJson(projectRoot, '.tmp/data-model-usage.json', {
      schemaVersion: 1,
      contractType: 'data-model-usage',
      scopeRevision: 'a'.repeat(64),
      persistenceRevision: 'b'.repeat(64),
      journeyRevision: 'c'.repeat(64),
      dataModelRevision: 'd'.repeat(64),
      usageRevision: 'e'.repeat(64),
      requirements: [
        { requirementId: 'record-inspection', persistable: true, owner: 'dataverse' },
        { requirementId: 'view-help', persistable: false, owner: null },
      ],
      tables: [{
        tableLogicalName: 'ct_inspection',
        consumers: [{ kind: 'requirement', id: 'record-inspection' }],
        fields: [
          {
            logicalName: 'ct_name',
            consumers: [],
            exemption: { kind: 'primary-name', reason: 'raw-secret-exemption' },
          },
          {
            logicalName: 'ct_result',
            consumers: [
              { kind: 'requirement', id: 'record-inspection' },
              { kind: 'screen', id: 'inspection', reason: 'raw-secret-consumer' },
            ],
          },
        ],
        relationships: [{
          schemaName: 'ct_Inspection_Asset',
          consumers: [{ kind: 'job', id: 'inspect-equipment' }],
        }],
      }],
    });
    writeJson(projectRoot, '.tmp/dataverse-operation-manifest.json', {
      binding: {
        environmentUrl: 'https://contoso.crm.dynamics.com',
        tenantId: '11111111-2222-3333-4444-555555555555',
      },
      execution: { phases: { tableCreates: { operations: [{ id: 'create' }] } } },
      summary: { metadataOperationCount: 1 },
    });
    fs.writeFileSync(path.join(projectRoot, 'native-app-plan.md'), [
      '# Field North',
      '## App Requirements',
      'Use https://contoso.crm.dynamics.com in tenant 11111111-2222-3333-4444-555555555555.',
      '## Native Capabilities',
      '- Camera capture',
      '## Plan Provenance',
      '- Internal detail that must not reach the browser',
    ].join('\n'));

    const progress = updateProgress(projectRoot, {
      phase: 'data-model',
      status: 'active',
      detail: 'Preparing one table in 33333333-4444-5555-6666-777777777777',
    }, '2026-09-01T10:00:00.000Z');
    assert.strictEqual(progress.revision, 1);

    const model = deriveBuildPlanModel(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    assert.strictEqual(model.projectName, 'Field North');
    assert.strictEqual(model.progress.currentPhase, 'data-model');
    assert.strictEqual(model.tables[0].columns[0].logicalName, 'ct_name');
    assert.strictEqual(model.screens[0].screenId, 'assignments');
    assert.strictEqual(model.dataverse.operationCount, 1);
    assert.deepStrictEqual(model.dataModelUsage, {
      present: true,
      bound: true,
      validLooking: true,
      totalRequirementCount: 2,
      persistableRequirementCount: 1,
      ownedRequirementCount: 1,
      tableCount: 1,
      fieldCount: 2,
      relationshipCount: 1,
      consumerLinkCount: 3,
    });
    assert.strictEqual(model.experience.promptEvidence, undefined);
    assert.doesNotMatch(
      JSON.stringify(model),
      /contoso\.crm|11111111-2222|Internal detail|raw-secret/,
    );
    assert.doesNotMatch(JSON.stringify(model), /44444444-5555/);
    assert.match(model.journey.journeys[0].name, /\[identifier\]/);
    assert.match(model.journey.journeys[0].steps[0].label, /\[environment\]/);
    assert.match(model.planSections['App Requirements'], /\[environment\].*\[identifier\]/);

    const result = writeBuildPlan(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    const html = fs.readFileSync(result.output, 'utf8');
    assert.match(html, /Build Plan/);
    assert.match(html, /Field North/);
    assert.match(html, /Preparing one table in \[identifier\]/);
    assert.match(html, /ct_inspection/);
    assert.match(html, /ct_name/);
    assert.match(html, /Usage traceability/);
    assert.match(html, /1 owned · 1 persistable · 2 total/);
    assert.match(html, /1 tables · 2 fields · 1 relationships/);
    assert.match(html, /Assignments/);
    assert.match(html, /role="tab"/);
    assert.match(html, /id="tab-plan"[^>]+tabindex="0"/);
    assert.match(html, /id="tab-progress"[^>]+tabindex="-1"/);
    assert.match(html, /event\.key==='ArrowRight'/);
    assert.match(html, /event\.key==='ArrowLeft'/);
    assert.match(html, /event\.key==='Home'/);
    assert.match(html, /event\.key==='End'/);
    assert.match(html, /build-plan-active-tab/);
    assert.match(html, /build-plan-focus-id/);
    assert.match(html, /id="live-announcer" role="status" aria-live="polite"/);
    assert.match(html, /id="reload-latest"[^>]+hidden>Reload latest plan/);
    assert.match(html, /Save conflict; form values preserved/);
    assert.match(html, /id="relationship-text-title"/);
    assert.match(html, /@media\(forced-colors:active\)/);
    assert.match(html, /@media\(prefers-reduced-motion:no-preference\)/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /id="edit-dialog"/);
    assert.match(html, /id="er-canvas"/);
    assert.match(html, /new EventSource/);
    assert.match(html, /data-add-table disabled/);
    assert.match(html, /data-edit-column="ct_name"/);
    assert.match(html, /data-editor-view="simple"/);
    assert.match(html, /data-editor-view="advanced"/);
    assert.match(html, /name="table-ownership" required><option value="">/);
    assert.match(html, /name="table-service" required><option value="">/);
    assert.match(html, /No Dataverse change occurs from this page/);
    assert.match(html, /<summary>Advanced<\/summary>/);
    assert.match(html, /id="removal-dialog"/);
    assert.match(html, /\/api\/data-model\/impact/);
    assert.match(html, /data-remove-column="ct_name"/);
    assert.doesNotMatch(html, /name="table-service"[^>]*checked/);
    assert.doesNotMatch(html, /ownershipType:'UserOwned'/);
    assert.doesNotMatch(html, /\.splice\([^)]*data-remove/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /22222222-3333|33333333-4444/);
  } finally {
    cleanup(projectRoot);
  }
});

test('Build Plan bundles templates deterministically into one standalone document', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-bundle');
  try {
    updateProgress(projectRoot, {
      phase: 'requirements',
      status: 'active',
      detail: 'Reviewing requirements',
    }, '2026-09-01T10:00:00.000Z');
    const model = deriveBuildPlanModel(projectRoot, { now: '2026-09-01T10:00:01.000Z' });

    const first = renderBuildPlanHtml(model, { live: true });
    const second = renderBuildPlanHtml(model, { live: true });

    assert.strictEqual(second, first);
    assert.match(first, /const BUILD_PLAN_LIVE=true;/);
    assert.doesNotMatch(first, /__BUILD_PLAN_LIVE__/);
    assert.doesNotMatch(first, /<script[^>]+src=|<link[^>]+rel=["']stylesheet/);
    assert.strictEqual((first.match(/<!doctype html>/g) || []).length, 1);
  } finally {
    cleanup(projectRoot);
  }
});

test('connector-owned persistence makes the Dataverse data model not applicable', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-connector-persistence');
  try {
    writeJson(projectRoot, '.tmp/product-scope-contract.json', {
      dataEntities: [{
        name: 'Booking',
        role: 'primary',
        realization: 'connector-source',
        screenIds: ['trip'],
      }],
    });
    writeJson(projectRoot, '.tmp/persistence-contract.json', {
      schemaVersion: 1,
      contractType: 'persistence-contract',
      mode: 'connector-only',
      conceptOwners: [{
        conceptId: 'booking',
        conceptName: 'Booking',
        role: 'primary',
        realization: 'connector-source',
        owner: 'connector:booking-api',
        reason: 'The approved booking connector is the system of record.',
      }],
    });
    updateProgress(projectRoot, {
      phase: 'dataverse',
      status: 'complete',
      detail: 'Not applicable - application data is connector-owned',
    }, '2026-09-01T10:00:00.000Z');

    const model = deriveBuildPlanModel(projectRoot);
    assert.equal(model.dataModelApplicable, false);
    assert.equal(model.makerSummary.persistenceMode, 'connector-only');
    assert.equal(model.makerSummary.dataOwnership[0].owner, 'connector:booking-api');
    assert.deepStrictEqual(
      model.progress.phases.find((phase) => phase.id === 'dataverse'),
      {
        id: 'dataverse',
        label: 'Dataverse',
        status: 'complete',
        detail: 'Not applicable - application data is connector-owned',
        updatedAt: '2026-09-01T10:00:00.000Z',
      },
    );
    const html = renderBuildPlanHtml(model, { live: true });
    assert.match(html, /Not applicable/);
    assert.match(html, /approved connectors/);
    assert.match(html, /booking-api/);
    assert.match(html, /Not applicable - application data is connector-owned/);
    assert.doesNotMatch(html, /<button[^>]+data-add-table/);
  } finally {
    cleanup(projectRoot);
  }
});

test('offline integration is displayed only from its canonical artifact', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-offline-integration');
  try {
    writeJson(projectRoot, '.tmp/product-experience-contract.json', {
      productName: 'Field North',
      operatingContext: { connectivity: 'offline-first' },
    });

    assert.equal(
      ARTIFACTS.offlineIntegration,
      '.tmp/offline-integration-contract.json',
    );
    let model = deriveBuildPlanModel(projectRoot);
    assert.deepStrictEqual(model.offlineIntegration, {
      selected: false,
      owner: null,
      adapter: null,
      runtimeStates: [],
      mediaBindingCount: 0,
      profileRequired: false,
    });
    assert.doesNotMatch(
      renderBuildPlanHtml(model, { live: true }),
      /<h3>Offline integration<\/h3>/,
    );

    writeJson(projectRoot, '.tmp/offline-integration-contract.json', {
      schemaVersion: 1,
      contractType: 'offline-integration-contract',
      selected: false,
      owner: 'offline-package',
      adapter: 'dataverse-mobile-offline-profile',
      runtimeStates: ['connection-status', 'queued', 'syncing', 'failed', 'retry', 'conflict'],
      mediaBindings: [{
        screenId: 'home',
        assetKey: 'hero-photo',
        source: { kind: 'cdn', value: 'https://media.example.test/private.jpg' },
        fallback: 'Private fallback copy',
      }],
      mobileOfflineProfileRequired: true,
      environmentUrl: 'https://contoso.crm.dynamics.com',
    });

    model = deriveBuildPlanModel(projectRoot);
    assert.deepStrictEqual(model.offlineIntegration, {
      selected: true,
      owner: 'offline-package',
      adapter: 'dataverse-mobile-offline-profile',
      runtimeStates: ['connection-status', 'queued', 'syncing', 'failed', 'retry', 'conflict'],
      mediaBindingCount: 1,
      profileRequired: true,
    });
    assert.deepStrictEqual(model.makerSummary.offlineIntegration, model.offlineIntegration);
    assert.doesNotMatch(JSON.stringify(model), /contoso\.crm|private\.jpg|Private fallback copy/);
    const html = renderBuildPlanHtml(model, { live: true });
    assert.match(html, /<h3>Offline integration<\/h3>/);
    assert.match(html, /Owner:<\/strong> offline package/);
    assert.match(html, /dataverse mobile offline profile/);
    assert.match(html, /connection status/);
    assert.match(html, /1 media binding delegated to the package cache/);
    assert.match(html, /Mobile Offline Profile required/);
  } finally {
    cleanup(projectRoot);
  }
});

test('scenario facts project only revision bindings and counts', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-scenario-facts');
  try {
    assert.equal(ARTIFACTS.scenarioFacts, '.tmp/scenario-facts.json');
    writeJson(projectRoot, '.tmp/scenario-facts.json', {
      schemaVersion: 1,
      contractType: 'scenario-facts',
      scopeRevision: 'a'.repeat(64),
      journeyRevision: 'b'.repeat(64),
      screenPackRevision: 'c'.repeat(64),
      persistenceRevision: 'd'.repeat(64),
      navigationRevision: 'e'.repeat(64),
      scenarioRevision: 'f'.repeat(64),
      records: [{ id: 'secret-record', fields: { name: 'Do not project me' } }],
      scenarios: [{ id: 'happy-path', recordIds: ['secret-record'] }],
      screenBindings: [{ screenId: 'home', mediaAssetKeys: ['private-photo'] }],
      mediaAssets: [{ key: 'private-photo', source: { kind: 'cdn', value: 'https://media.example.test/private.jpg' } }],
      invariants: [{ operator: 'field-lte-field' }],
    });

    const model = deriveBuildPlanModel(projectRoot);
    assert.deepStrictEqual(model.scenarioFacts, {
      present: true,
      bound: true,
      validLooking: true,
      revision: 'f'.repeat(64),
      recordCount: 1,
      scenarioCount: 1,
      screenBindingCount: 1,
      mediaCount: 1,
      invariantCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(model.scenarioFacts), /Do not project me|private\.jpg|secret-record/);
    const html = renderBuildPlanHtml(model, { live: true });
    assert.match(html, /Scenario artifact/);
    assert.match(html, /1 records · 1 scenarios · 1 screens/);
    assert.doesNotMatch(html, /Do not project me|private\.jpg|secret-record/);
  } finally {
    cleanup(projectRoot);
  }
});

test('Product Scope screens appear before a compiled screen pack exists', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-scope-screens');
  try {
    writeJson(projectRoot, '.tmp/product-scope-contract.json', {
      contractType: 'product-scope',
      screens: [
        {
          id: 'home',
          route: '/home',
          title: 'Home',
          purpose: 'Show the user what needs attention next.',
          userFacing: true,
          jobIds: ['review-work'],
          classification: 'durable-destination',
          interactionSignature: 'work-priority-list',
          justification: 'The primary job needs a stable starting workspace.',
          cannotMergeBecause: {
            kind: 'durable-destination',
            evidence: 'Users return here between work items to choose their next action.',
          },
        },
        {
          id: 'work-detail',
          route: '/work/[id]',
          title: 'Work details',
          purpose: 'Review one work item and choose the next action.',
          userFacing: true,
          jobIds: ['review-work'],
          classification: 'nested-detail',
          parentScreenId: 'home',
          hideTabs: true,
          tabVisibilityReason: 'The focused detail flow keeps the current work item in context.',
          interactionSignature: 'work-detail-actions',
          justification: 'The detail decision needs the full record context.',
          cannotMergeBecause: {
            kind: 'decision-boundary',
            evidence: 'The item-level decision requires context that does not fit in the overview.',
          },
        },
      ],
      navigation: {
        pattern: 'tabs-plus-stacks',
        durableDestinationIds: ['home'],
        visibleTabIds: ['home'],
        returnHomeMechanism: 'Use Back to return to Home after reviewing a work item.',
      },
    });

    const model = deriveBuildPlanModel(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    assert.deepStrictEqual(model.screens.map((screen) => screen.screenId), [
      'home',
      'work-detail',
    ]);
    assert.strictEqual(model.screens[0].status, 'Planned');
    assert.strictEqual(model.screens[1].parentScreenId, 'home');

    const html = writeBuildPlan(projectRoot, {
      now: '2026-09-01T10:00:01.000Z',
    });
    const rendered = fs.readFileSync(html.output, 'utf8');
    assert.match(rendered, /Home/);
    assert.match(rendered, /Work details/);
    assert.match(rendered, /Planned/);
    assert.doesNotMatch(rendered, /Screens not compiled yet/);
  } finally {
    cleanup(projectRoot);
  }
});

test('screen overlays preserve Product Scope hierarchy and navigation', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-screen-overlays');
  try {
    writeJson(projectRoot, '.tmp/product-scope-contract.json', {
      contractType: 'product-scope',
      screens: [
        {
          id: 'detail',
          route: '/items/[id]',
          title: 'Item details',
          purpose: 'Review the selected item in context.',
          userFacing: true,
          jobIds: ['review-item'],
          classification: 'nested-detail',
          parentScreenId: 'home',
          justification: 'Item decisions require the selected record context.',
        },
        {
          id: 'home',
          route: '/home',
          title: 'Home',
          purpose: 'Choose the next item that needs attention.',
          userFacing: true,
          jobIds: ['review-item'],
          classification: 'durable-destination',
          justification: 'Users revisit this queue between item decisions.',
        },
      ],
      navigation: {
        pattern: 'stack-only',
        durableDestinationIds: ['home'],
        visibleTabIds: [],
        returnHomeMechanism: 'Back returns to Home.',
      },
    });
    writeJson(projectRoot, '.tmp/workflow-journey-contract.json', {
      journeys: [{
        id: 'review-journey',
        name: 'Review an item',
        steps: [{
          id: 'choose-item',
          order: 1,
          label: 'Choose item',
          surface: { kind: 'screen', screenId: 'home' },
          states: { loading: 'Queue skeleton', empty: 'No items need attention' },
        }],
      }],
    });
    writeJson(projectRoot, '.tmp/compiled-screen-build-pack.json', {
      screens: [
        {
          screenId: 'home',
          title: 'Compiler must not rename this',
          status: 'Built',
          pack: {
            classification: 'nested-detail',
            purpose: 'Compiler must not replace scope purpose.',
            firstViewport: { primaryAction: 'Open item' },
          },
        },
        {
          screenId: 'detail',
          status: 'Validated',
          pack: { firstViewport: { primaryAction: 'Resolve item' } },
        },
      ],
    });

    const model = deriveBuildPlanModel(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    assert.deepStrictEqual(model.screens.map((screen) => screen.screenId), ['home', 'detail']);
    assert.strictEqual(model.screens[0].title, 'Home');
    assert.strictEqual(model.screens[0].classification, 'durable-destination');
    assert.strictEqual(model.screens[0].status, 'Built');
    assert.strictEqual(model.screens[0].journeySteps[0].id, 'choose-item');
    assert.strictEqual(model.screens[1].parentScreenId, 'home');
    assert.strictEqual(model.screens[1].status, 'Validated');
  } finally {
    cleanup(projectRoot);
  }
});

test('screen build progress overlays status without changing the planned graph', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-screen-status');
  try {
    writeJson(projectRoot, '.tmp/product-scope-contract.json', {
      screens: [
        {
          id: 'home',
          title: 'Home',
          purpose: 'Choose the next job.',
          userFacing: true,
          jobIds: ['choose-job'],
          classification: 'durable-destination',
        },
        {
          id: 'job-detail',
          title: 'Job details',
          purpose: 'Complete the chosen job.',
          userFacing: true,
          jobIds: ['choose-job'],
          classification: 'nested-detail',
          parentScreenId: 'home',
        },
      ],
      navigation: {
        durableDestinationIds: ['home'],
        visibleTabIds: ['home'],
      },
    });
    writeJson(projectRoot, '.tmp/compiled-screen-build-pack.json', {
      screens: [{ screenId: 'home', pack: { firstViewport: { primaryAction: 'Open job' } } }],
    });
    updateProgress(projectRoot, {
      phase: 'screens',
      status: 'active',
      detail: 'Building Home',
      screenIds: ['home'],
      screenStatus: 'building',
    });
    updateProgress(projectRoot, {
      phase: 'validation',
      status: 'active',
      detail: 'Job details validated',
      screenIds: ['job-detail'],
      screenStatus: 'validated',
    });

    const model = deriveBuildPlanModel(projectRoot);
    assert.deepStrictEqual(model.screens.map((screen) => ({
      id: screen.screenId,
      parent: screen.parentScreenId,
      status: screen.status,
    })), [
      { id: 'home', parent: null, status: 'Building' },
      { id: 'job-detail', parent: 'home', status: 'Validated' },
    ]);
  } finally {
    cleanup(projectRoot);
  }
});

test('maker summary and scope health match canonical contracts and validator output', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-scope-health');
  try {
    const bundle = bundleFor('inspection');
    writeJson(projectRoot, '.tmp/product-experience-contract.json', bundle.experience);
    writeJson(projectRoot, '.tmp/product-scope-contract.json', bundle.scope);
    writeJson(projectRoot, '.tmp/workflow-journey-contract.json', bundle.journey);
    writeJson(projectRoot, '.tmp/mobile-plan-status.json', {
      approvals: {
        nativeCapabilities: { status: 'approved' },
        connectors: { status: 'approved' },
      },
      architectureSummary: {
        nativeCapabilities: ['Barcode scanning'],
        connectors: ['SharePoint'],
      },
    });
    const scopedTable = bundle.scope.newTables[0];
    const scopedEntity = bundle.scope.dataEntities.find(
      (entity) => entity.name === scopedTable.name,
    );
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', {
      schemaVersion: 1,
      publisherPrefix: 'ct',
      tables: [{
        logicalName: 'ct_inspection',
        displayName: scopedTable.name,
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        ownershipType: 'UserOwned',
        columns: [],
        relationships: [],
      }],
    });

    const expectedHealth = validateScopeContract(bundle.scope, bundle.experience);
    const model = deriveBuildPlanModel(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    assert.deepStrictEqual(model.scopeHealth, expectedHealth);
    assert.strictEqual(
      model.makerSummary.userFacingScreenCount,
      expectedHealth.summary.userFacingScreenCount,
    );
    assert.strictEqual(model.makerSummary.primaryGoal, bundle.experience.primaryGoal);
    assert.deepStrictEqual(model.makerSummary.nativeCapabilities, ['Barcode scanning']);
    assert.deepStrictEqual(model.makerSummary.connectors, ['SharePoint']);
    assert.deepStrictEqual(
      model.makerSummary.navigation.durableDestinations.map((item) => item.id),
      bundle.scope.navigation.durableDestinationIds,
    );
    assert.deepStrictEqual(model.tables[0].scopeEvidence.table, scopedTable);
    assert.deepStrictEqual(model.tables[0].scopeEvidence.entity, scopedEntity);
    assert.deepStrictEqual(model.makerProgress, {
      phase: 1,
      phaseCount: 10,
      phaseId: 'requirements',
      phaseLabel: 'Requirements',
      state: 'Building',
      estimatedRemainingMs: null,
    });

    const result = writeBuildPlan(projectRoot, { now: '2026-09-01T10:00:01.000Z' });
    const html = fs.readFileSync(result.output, 'utf8');
    assert.match(html, /What we are building/);
    assert.match(html, /Barcode scanning/);
    assert.match(html, /SharePoint/);
    assert.match(html, /Scope health/);
    assert.match(html, new RegExp(
      `${expectedHealth.summary.coveredShippingRequirementCount} \/ ${expectedHealth.summary.shippingRequirementCount}`,
    ));
    for (const finding of [...expectedHealth.errors, ...expectedHealth.warnings]) {
      assert.match(html, new RegExp(finding.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(html, /<summary>Technical details<\/summary>/);
    assert.match(html, /Phase 1 of 10/);
    assert.doesNotMatch(html, /Completion<\/small>/);
    assert.doesNotMatch(html, /Completion[^<]*%/);
  } finally {
    cleanup(projectRoot);
  }
});

test('maker progress exposes review, attention, and completion states', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-maker-progress');
  try {
    updateProgress(projectRoot, { phase: 'experience', status: 'waiting' });
    assert.strictEqual(deriveBuildPlanModel(projectRoot).makerProgress.state, 'Waiting for review');
    updateProgress(projectRoot, { phase: 'experience', status: 'warning' });
    assert.strictEqual(deriveBuildPlanModel(projectRoot).makerProgress.state, 'Needs attention');
    updateProgress(projectRoot, {
      phase: 'validation',
      status: 'complete',
      overallStatus: 'complete',
    });
    const completed = deriveBuildPlanModel(projectRoot).makerProgress;
    assert.strictEqual(completed.phase, 10);
    assert.strictEqual(completed.state, 'Complete');
  } finally {
    cleanup(projectRoot);
  }
});

test('Build Plan rejects unknown progress phases and path escapes', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-invalid');
  try {
    assert.throws(
      () => updateProgress(projectRoot, { phase: 'surprise', status: 'active' }),
      /Unknown build phase/,
    );
    assert.throws(
      () => writeBuildPlan(projectRoot, { output: '../outside.html' }),
      /escapes project root/,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test('data model revision uses canonical normalization rather than stored ordering', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-normalized-revision');
  try {
    const contract = minimalContract();
    contract.tables.reverse();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    const model = deriveBuildPlanModel(projectRoot);
    assert.doesNotThrow(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: model.dataModelRevision,
      tableLogicalName: 'ct_asset',
      column: {
        logicalName: 'ct_note',
        displayName: 'Note',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'None',
      },
    }));
  } finally {
    cleanup(projectRoot);
  }
});

function minimalContract() {
  return {
    schemaVersion: 1,
    publisherPrefix: 'ct',
    tables: [
      {
        logicalName: 'ct_asset',
        schemaName: 'ct_asset',
        displayName: 'Asset',
        displayCollectionName: 'Assets',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        ownershipType: 'UserOwned',
        columns: [{
          logicalName: 'ct_name',
          schemaName: 'ct_name',
          displayName: 'Name',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
          primaryName: true,
        }],
        relationships: [],
        alternateKeys: [],
      },
      {
        logicalName: 'ct_site',
        schemaName: 'ct_site',
        displayName: 'Site',
        displayCollectionName: 'Sites',
        plannedDecision: 'create',
        dependencyTier: 0,
        serviceRequired: true,
        ownershipType: 'UserOwned',
        columns: [{
          logicalName: 'ct_name',
          schemaName: 'ct_name',
          displayName: 'Name',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'ApplicationRequired',
          primaryName: true,
        }],
        relationships: [],
        alternateKeys: [],
      },
    ],
  };
}

test('data-model edits validate, normalize, invalidate approvals, and clear stale state', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-edit');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/mobile-plan-status.json', {
      schemaVersion: 1,
      workflow: 'create-mobile-app',
      approvals: {
        dataModel: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        dataModelUsage: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        nativeCapabilities: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        connectors: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
        screenPlan: { status: 'approved', approvedAt: '2026-09-01T09:00:00.000Z' },
      },
      integritySha256: 'stale',
    });
    writeJson(projectRoot, '.tmp/pipeline-state.json', {
      schemaVersion: 2,
      completedStep: '6.75',
    });
    writeJson(projectRoot, '.tmp/dataverse-operation-manifest.json', { stale: true });
    writeJson(projectRoot, '.tmp/data-model-usage.json', {
      schemaVersion: 1,
      contractType: 'data-model-usage',
      usageRevision: 'a'.repeat(64),
      requirements: [],
      tables: [],
    });
    writeJson(projectRoot, '.tmp/scenario-facts.json', { scenarioRevision: 'b'.repeat(64) });
    writeJson(projectRoot, '.tmp/offline-integration-contract.json', {
      integrationRevision: 'c'.repeat(64),
    });
    const unrelatedScope = {
      contractType: 'product-scope',
      screens: [{ id: 'home', title: 'Unrelated Home contract' }],
    };
    const unrelatedScreens = {
      contractType: 'compiled-screen-build-pack',
      compiledRevision: 'd'.repeat(64),
      screens: [{ screenId: 'home', title: 'Unrelated compiled Home' }],
    };
    writeJson(projectRoot, '.tmp/product-scope-contract.json', unrelatedScope);
    writeJson(projectRoot, '.tmp/compiled-screen-build-pack.json', unrelatedScreens);

    const result = applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      column: {
        logicalName: 'ct_serialnumber',
        schemaName: 'ct_serialnumber',
        displayName: 'Serial number',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'None',
        maxLength: 100,
      },
    }, '2026-09-01T10:00:00.000Z');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.requiresReapproval, true);
    const edited = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
      'utf8',
    ));
    assert.ok(edited.tables[0].columns.some(
      (column) => column.logicalName === 'ct_serialnumber',
    ));
    const receipt = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/mobile-plan-status.json'),
      'utf8',
    ));
    assert.strictEqual(receipt.approvals.dataModel.status, 'pending');
    assert.strictEqual(receipt.approvals.dataModelUsage.status, 'pending');
    assert.strictEqual(receipt.approvals.screenPlan.status, 'pending');
    assert.strictEqual(receipt.approvedContract, undefined);
    assert.match(receipt.integritySha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp/pipeline-state.json')), false);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/dataverse-operation-manifest.json')),
      false,
    );
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/data-model-usage.json')),
      false,
    );
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp/scenario-facts.json')), true);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/offline-integration-contract.json')),
      true,
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(projectRoot, '.tmp/product-scope-contract.json'))),
      unrelatedScope,
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(projectRoot, '.tmp/compiled-screen-build-pack.json'))),
      unrelatedScreens,
    );
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '_build_plan.html')), true);
  } finally {
    cleanup(projectRoot);
  }
});

test('many-to-one relationship edits create a matching lookup atomically', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-relationship');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    const result = applyDataModelEdit(projectRoot, {
      type: 'add-relationship',
      expectedRevision: revisionOf(contract),
      relationship: {
        kind: 'many-to-one',
        schemaName: 'ct_Site_Asset',
        plannedDecision: 'create',
        parentTable: 'ct_site',
        childTable: 'ct_asset',
        lookup: {
          logicalName: 'ct_siteid',
          schemaName: 'ct_siteid',
          displayName: 'Site',
          requiredLevel: 'None',
        },
      },
    });
    assert.strictEqual(result.ok, true);
    const edited = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
      'utf8',
    ));
    const asset = edited.tables.find((table) => table.logicalName === 'ct_asset');
    assert.strictEqual(
      asset.columns.find((column) => column.logicalName === 'ct_siteid').type,
      'lookup',
    );
    assert.strictEqual(asset.relationships[0].lookup.logicalName, 'ct_siteid');
  } finally {
    cleanup(projectRoot);
  }
});

test('invalid and stale edits leave canonical artifacts unchanged', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-rollback');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    const file = path.join(projectRoot, '.tmp/dataverse-schema-contract.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: '0'.repeat(64),
      tableLogicalName: 'ct_asset',
      column: { logicalName: 'ct_code', type: 'string' },
    }), /changed since/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);

    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      column: { logicalName: 'ct_name', type: 'string' },
    }), /already exists/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/mobile-build-plan-edits.json')),
      false,
    );

    writeJson(projectRoot, '.tmp/dataverse-foreground-planning-snapshot.json', {
      version: 0,
      tables: [],
    });
    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'add-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      column: { logicalName: 'ct_code', type: 'string' },
    }), /needs refreshed Dataverse evidence/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  } finally {
    cleanup(projectRoot);
  }
});

test('data-model editing stops once Dataverse metadata execution has evidence', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-executing');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/dataverse-metadata-execution-journal.json', {
      schemaVersion: 1,
      completed: {},
      inFlight: { operationId: 'table:create' },
    });
    assert.throws(() => applyDataModelEdit(projectRoot, {
      type: 'update-table',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      table: { displayName: 'Equipment' },
    }), /use \/edit-app/);
  } finally {
    cleanup(projectRoot);
  }
});

test('adding a table updates and validates its explicit Product Scope mapping', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-table-scope');
  try {
    const bundle = bundleFor('inspection');
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/product-experience-contract.json', bundle.experience);
    writeJson(projectRoot, '.tmp/product-scope-contract.json', bundle.scope);
    writeJson(projectRoot, '.tmp/scenario-facts.json', { scenarioRevision: 'b'.repeat(64) });
    writeJson(projectRoot, '.tmp/offline-integration-contract.json', {
      integrationRevision: 'c'.repeat(64),
    });
    const jobId = bundle.scope.coreJobs[0].id;

    const result = applyDataModelEdit(projectRoot, {
      type: 'add-table',
      expectedRevision: revisionOf(contract),
      logicalName: 'ct_safetyobservation',
      table: {
        displayName: 'Safety observation',
        displayCollectionName: 'Safety observations',
        plannedDecision: 'create',
        dependencyTier: 1,
        serviceRequired: true,
        ownershipType: 'UserOwned',
      },
      primaryColumn: {
        logicalName: 'ct_name',
        displayName: 'Observation',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
        maxLength: 200,
      },
      scope: {
        role: 'supporting',
        screenIds: [],
        jobIds: [jobId],
        lifecycleJustification: {
          reasons: ['independent-lifecycle'],
          statement: 'A safety observation remains actionable after its originating inspection.',
        },
      },
    });

    assert.strictEqual(result.ok, true);
    const scope = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/product-scope-contract.json'),
      'utf8',
    ));
    assert.ok(scope.newTables.some((table) => table.name === 'Safety observation'));
    assert.ok(scope.dataEntities.some((entity) => (
      entity.name === 'Safety observation' && entity.realization === 'new-table'
    )));
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp/scenario-facts.json')), false);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/offline-integration-contract.json')),
      false,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test('adding a table requires explicit ownership and service decisions', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-table-decisions');
  try {
    const contract = minimalContract();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    const file = path.join(projectRoot, '.tmp/dataverse-schema-contract.json');
    const before = fs.readFileSync(file, 'utf8');
    const baseCommand = {
      type: 'add-table',
      expectedRevision: revisionOf(contract),
      logicalName: 'ct_observation',
      table: {
        displayName: 'Observation',
        displayCollectionName: 'Observations',
        plannedDecision: 'create',
        dependencyTier: 0,
      },
      primaryColumn: {
        logicalName: 'ct_name',
        displayName: 'Observation',
        type: 'string',
        plannedDecision: 'create',
        requiredLevel: 'ApplicationRequired',
        primaryName: true,
        maxLength: 200,
      },
    };

    assert.throws(() => applyDataModelEdit(projectRoot, {
      ...baseCommand,
      table: { ...baseCommand.table, serviceRequired: false },
    }), /ownership/i);
    assert.throws(() => applyDataModelEdit(projectRoot, {
      ...baseCommand,
      table: { ...baseCommand.table, ownershipType: 'UserOwned' },
    }), /service/i);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/mobile-build-plan-edits.json')),
      false,
    );
  } finally {
    cleanup(projectRoot);
  }
});

function contractWithRelationship() {
  const contract = minimalContract();
  const asset = contract.tables.find((table) => table.logicalName === 'ct_asset');
  asset.columns.push({
    logicalName: 'ct_siteid',
    schemaName: 'ct_siteid',
    displayName: 'Site',
    type: 'lookup',
    lookupTarget: 'ct_site',
    plannedDecision: 'create',
    requiredLevel: 'None',
  });
  asset.relationships.push({
    kind: 'many-to-one',
    schemaName: 'ct_Site_Asset',
    plannedDecision: 'create',
    parentTable: 'ct_site',
    childTable: 'ct_asset',
    lookup: {
      logicalName: 'ct_siteid',
      schemaName: 'ct_siteid',
      displayName: 'Site',
      requiredLevel: 'None',
    },
  });
  return contract;
}

test('redundant tables, columns, and relationships can be removed after impact review', () => {
  for (const scenario of [
    {
      label: 'table',
      contract: minimalContract(),
      command: { type: 'remove-table', tableLogicalName: 'ct_site' },
      verify(edited) {
        assert.strictEqual(edited.tables.some((table) => table.logicalName === 'ct_site'), false);
      },
    },
    {
      label: 'column',
      contract: (() => {
        const value = minimalContract();
        value.tables[0].columns.push({
          logicalName: 'ct_note',
          schemaName: 'ct_note',
          displayName: 'Note',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'None',
        });
        return value;
      })(),
      command: {
        type: 'remove-column',
        tableLogicalName: 'ct_asset',
        columnLogicalName: 'ct_note',
      },
      verify(edited) {
        assert.strictEqual(edited.tables[0].columns.some(
          (column) => column.logicalName === 'ct_note',
        ), false);
      },
    },
    {
      label: 'relationship',
      contract: contractWithRelationship(),
      command: {
        type: 'remove-relationship',
        tableLogicalName: 'ct_asset',
        relationshipSchemaName: 'ct_Site_Asset',
      },
      verify(edited) {
        assert.strictEqual(edited.tables[0].relationships.length, 0);
        assert.strictEqual(edited.tables[0].columns.some(
          (column) => column.logicalName === 'ct_siteid',
        ), false);
      },
    },
  ]) {
    const projectRoot = makeProjectDir(`mobile-build-plan-remove-${scenario.label}`);
    try {
      writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', scenario.contract);
      const command = {
        ...scenario.command,
        expectedRevision: revisionOf(scenario.contract),
      };
      const impact = analyzeDataModelRemoval(projectRoot, command);
      assert.strictEqual(impact.allowed, true, JSON.stringify(impact.blockers));
      assert.match(impact.impactRevision, /^[a-f0-9]{64}$/);
      const result = applyDataModelEdit(projectRoot, {
        ...command,
        expectedImpactRevision: impact.impactRevision,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.type, scenario.command.type);
      scenario.verify(JSON.parse(fs.readFileSync(
        path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
        'utf8',
      )));
    } finally {
      cleanup(projectRoot);
    }
  }
});

test('removal that breaks relationships or screen data operations is rejected atomically', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-remove-blocked');
  try {
    const contract = contractWithRelationship();
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/workflow-journey-contract.json', {
      journeys: [{
        id: 'asset-work',
        steps: [{
          id: 'load-site',
          surface: { screenId: 'home' },
          dataOperation: { kind: 'read', entity: 'Site', classification: 'schema-backed' },
        }],
      }],
    });
    const file = path.join(projectRoot, '.tmp/dataverse-schema-contract.json');
    const before = fs.readFileSync(file);
    const command = {
      type: 'remove-table',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_site',
    };
    const impact = analyzeDataModelRemoval(projectRoot, command);
    assert.strictEqual(impact.allowed, false);
    assert.ok(impact.blockers.some((item) => item.code === 'relationship-dependency'));
    assert.ok(impact.blockers.some((item) => item.code === 'journey-operation-dependency'));
    assert.throws(() => applyDataModelEdit(projectRoot, {
      ...command,
      expectedImpactRevision: impact.impactRevision,
    }), /cannot be removed/i);
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.strictEqual(
      fs.existsSync(path.join(projectRoot, '.tmp/mobile-build-plan-edits.json')),
      false,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test('usage consumers block exact table, column, and relationship removals', () => {
  const scenarios = [
    {
      label: 'table',
      contract: minimalContract(),
      command: { type: 'remove-table', tableLogicalName: 'ct_site' },
      usage: { tableLogicalName: 'ct_site', consumers: [{ kind: 'requirement', id: 'keep-site' }], fields: [], relationships: [] },
      consumerId: 'keep-site',
    },
    {
      label: 'column',
      contract: (() => {
        const value = minimalContract();
        value.tables[0].columns.push({
          logicalName: 'ct_note',
          schemaName: 'ct_note',
          displayName: 'Note',
          type: 'string',
          plannedDecision: 'create',
          requiredLevel: 'None',
        });
        return value;
      })(),
      command: { type: 'remove-column', tableLogicalName: 'ct_asset', columnLogicalName: 'ct_note' },
      usage: { tableLogicalName: 'ct_asset', consumers: [], fields: [{ logicalName: 'ct_note', consumers: [{ kind: 'screen', id: 'asset-detail' }] }], relationships: [] },
      consumerId: 'asset-detail',
    },
    {
      label: 'relationship',
      contract: contractWithRelationship(),
      command: { type: 'remove-relationship', tableLogicalName: 'ct_asset', relationshipSchemaName: 'ct_Site_Asset' },
      usage: { tableLogicalName: 'ct_asset', consumers: [], fields: [], relationships: [{ schemaName: 'ct_Site_Asset', consumers: [{ kind: 'domain-operation', id: 'asset-flow:load-site' }] }] },
      consumerId: 'asset-flow:load-site',
    },
  ];
  for (const scenario of scenarios) {
    const projectRoot = makeProjectDir(`mobile-build-plan-usage-${scenario.label}`);
    try {
      writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', scenario.contract);
      writeJson(projectRoot, '.tmp/data-model-usage.json', {
        schemaVersion: 1,
        contractType: 'data-model-usage',
        requirements: [],
        tables: [scenario.usage],
      });
      const impact = analyzeDataModelRemoval(projectRoot, {
        ...scenario.command,
        expectedRevision: revisionOf(scenario.contract),
      });
      assert.strictEqual(impact.allowed, false);
      assert.ok(impact.blockers.some(
        (item) => item.code === 'usage-consumer-dependency',
      ));
      assert.ok(impact.affectedItems.some(
        (item) => item.kind === 'usage-consumer' && item.id === scenario.consumerId,
      ));
    } finally {
      cleanup(projectRoot);
    }
  }
});

test('system exemptions do not replace existing removal rules or become usage blockers', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-usage-exemption');
  try {
    const contract = minimalContract();
    contract.tables[0].columns.push({
      logicalName: 'ct_note',
      schemaName: 'ct_note',
      displayName: 'Note',
      type: 'string',
      plannedDecision: 'create',
      requiredLevel: 'None',
    });
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/data-model-usage.json', {
      schemaVersion: 1,
      contractType: 'data-model-usage',
      requirements: [],
      tables: [{
        tableLogicalName: 'ct_asset',
        consumers: [],
        fields: [
          {
            logicalName: 'ct_name',
            consumers: [],
            exemption: { kind: 'primary-name', reason: 'Dataverse requires a primary name.' },
          },
          {
            logicalName: 'ct_note',
            consumers: [],
            exemption: { kind: 'platform-required', reason: 'Reserved for platform metadata.' },
          },
        ],
        relationships: [],
      }],
    });
    const noteImpact = analyzeDataModelRemoval(projectRoot, {
      type: 'remove-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      columnLogicalName: 'ct_note',
    });
    assert.strictEqual(noteImpact.allowed, true, JSON.stringify(noteImpact.blockers));
    const primaryImpact = analyzeDataModelRemoval(projectRoot, {
      type: 'remove-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      columnLogicalName: 'ct_name',
    });
    assert.strictEqual(primaryImpact.allowed, false);
    assert.ok(primaryImpact.blockers.some(
      (item) => item.code === 'primary-name-dependency',
    ));
    assert.equal(primaryImpact.blockers.some(
      (item) => item.code === 'usage-consumer-dependency',
    ), false);
  } finally {
    cleanup(projectRoot);
  }
});

test('Undo restores the exact prior unexecuted revision and approval checkpoints', () => {
  const projectRoot = makeProjectDir('mobile-build-plan-undo');
  try {
    const contract = minimalContract();
    contract.tables[0].columns.push({
      logicalName: 'ct_note',
      schemaName: 'ct_note',
      displayName: 'Note',
      type: 'string',
      plannedDecision: 'create',
      requiredLevel: 'None',
    });
    const approval = {
      approvals: {
        requirements: { status: 'approved' },
        dataModel: { status: 'approved' },
        dataModelUsage: { status: 'approved' },
        nativeCapabilities: { status: 'approved' },
        connectors: { status: 'approved' },
        screenPlan: { status: 'approved' },
      },
      experience: { status: 'approved' },
      implementation: { status: 'approved' },
      integritySha256: 'prior',
    };
    const pipeline = { schemaVersion: 2, completedStep: '6.75' };
    const manifest = { schemaVersion: 1, summary: { metadataOperationCount: 3 } };
    const usage = {
      schemaVersion: 1,
      contractType: 'data-model-usage',
      usageRevision: 'a'.repeat(64),
      requirements: [],
      tables: [],
    };
    writeJson(projectRoot, '.tmp/dataverse-schema-contract.json', contract);
    writeJson(projectRoot, '.tmp/mobile-plan-status.json', approval);
    writeJson(projectRoot, '.tmp/pipeline-state.json', pipeline);
    writeJson(projectRoot, '.tmp/dataverse-operation-manifest.json', manifest);
    writeJson(projectRoot, '.tmp/data-model-usage.json', usage);
    const command = {
      type: 'remove-column',
      expectedRevision: revisionOf(contract),
      tableLogicalName: 'ct_asset',
      columnLogicalName: 'ct_note',
    };
    const impact = analyzeDataModelRemoval(projectRoot, command);
    const removed = applyDataModelEdit(projectRoot, {
      ...command,
      expectedImpactRevision: impact.impactRevision,
    }, '2026-09-01T10:00:00.000Z');
    const undoModel = deriveBuildPlanModel(projectRoot);
    assert.deepStrictEqual(undoModel.undo, { available: true, target: 'ct_asset.ct_note' });
    const undoHtml = writeBuildPlan(projectRoot, { live: true }).output;
    assert.match(fs.readFileSync(undoHtml, 'utf8'), /id="undo-edit"/);
    const invalidated = JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/mobile-plan-status.json'),
      'utf8',
    ));
    assert.strictEqual(invalidated.approvals.requirements.status, 'approved');
    assert.strictEqual(invalidated.approvals.dataModel.status, 'pending');
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp/pipeline-state.json')), false);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.tmp/data-model-usage.json')), false);

    const undone = undoLastDataModelEdit(projectRoot, {
      expectedRevision: removed.revision,
    }, '2026-09-01T10:01:00.000Z');
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(undone.revision, revisionOf(contract));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-schema-contract.json'),
      'utf8',
    )), contract);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/mobile-plan-status.json'),
      'utf8',
    )), approval);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/pipeline-state.json'),
      'utf8',
    )), pipeline);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/dataverse-operation-manifest.json'),
      'utf8',
    )), manifest);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.tmp/data-model-usage.json'),
      'utf8',
    )), usage);
    assert.strictEqual(deriveBuildPlanModel(projectRoot).undo.available, false);
  } finally {
    cleanup(projectRoot);
  }
});
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fileToRoute } = require('../validate-navigation-layout');
const { readyFiles } = require('./mobile-authoring-candidate');
const protocol = require('./authoring-protocol');
const { validateDomain } = require('./prototype-domain');
const { validateRules, generateRulesRuntime } = require('./authoring-rules');
const { refreshPrototypeRules } = require('./prototype-rules');
const { registeredContext, inspectEdit, DOMAIN_PATH } = require('./authoring-edit-context');
const { planAuthoring, assertAuthoringDelta } = require('./authoring-edit-registration');
const { requiresAuthoringCheck } = require('./mobile-authoring-registration');
const {
  integrationRoute, allowedIntegrationFile, validateIntegrationPlan, sameIntegration,
  assertArchitectureSelection, assertIntegrationPreserved, assertIntegrationPrepared, integrationReviewItems,
  captureOutputFiles, localCaptureOutputs,
  assertIntegrationWorkflow,
} = require('./authoring-edit-integration');
const {
  digest, canonicalJson, inside, readFile, readJson, exists, atomicWrite, journalPath, relativePath,
} = require('./mobile-authoring-files');

const RULES_PATH = '.tmp/prototype-rules.json';
const RULE_OUTPUTS = [RULES_PATH, 'src/data/rules.ts', '.tmp/prototype-generated.json', '.tmp/data-access-registry.json'];
const TEST_WRITE_PERMISSION = 'src/data/test-write-permission.json';
const PLAN_FILES = new Set([
  'native-app-plan.md', 'memory-bank.md', '_plan_preview.html',
  '.tmp/product-experience-contract.json', '.tmp/product-scope-contract.json',
  '.tmp/workflow-journey-contract.json', '.tmp/screen-build-pack.json',
  '.tmp/compiled-screen-build-pack.json', '.tmp/product-experience-final-preview-contract.json',
  '.tmp/mobile-plan-status.json', '.tmp/pipeline-state.json',
]);
const PROTECTED_PACK_KEYS = ['screenId', 'route', 'primaryActions', 'secondaryActions', 'navigation', 'dataAssumptions'];

function source(root) {
  return require('./authoring-source').captureSource(root);
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`);
}

function planLocation(descriptor, planId) {
  if (!/^edit-[a-f0-9]{40}$/.test(planId)) throw new Error('Invalid sealed edit plan ID');
  return journalPath(descriptor, `proposals/${planId}.json`);
}

function stateLocation(descriptor, planId) {
  return journalPath(descriptor, `edits/${planId}.json`);
}

function sourceDelta(before, after) {
  const oldFiles = new Map(before.files.map((file) => [file.path, file.sha256]));
  const newFiles = new Map(after.files.map((file) => [file.path, file.sha256]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()
    .filter((file) => oldFiles.get(file) !== newFiles.get(file))
    .map((file) => ({ path: file, before: oldFiles.get(file) || null, after: newFiles.get(file) || null }));
}

function approvedFileBaselines(root, files) {
  return files.map((file) => ({
    path: file, sha256: exists(root, file) ? digest(readFile(inside(root, file), 2 * 1024 * 1024)) : null,
  }));
}

function ruleOutputPaths(root) {
  const manifest = readJson(root, '.tmp/prototype-generated.json');
  return [...RULE_OUTPUTS, ...(manifest.files?.[TEST_WRITE_PERMISSION] || exists(root, TEST_WRITE_PERMISSION) ? [TEST_WRITE_PERMISSION] : [])];
}

function ruleContract(root, input, entityId) {
  const domain = validateDomain(readJson(root, DOMAIN_PATH));
  const entity = domain.entities.find((entry) => entry.id === entityId);
  if (!entity) throw new Error('Teach must reference an existing app entity');
  const proposed = validateRules(domain, input);
  const current = validateRules(domain, readJson(root, RULES_PATH));
  if (canonicalJson(current.rules.filter((rule) => rule.entityId !== entityId))
    !== canonicalJson(proposed.rules.filter((rule) => rule.entityId !== entityId))) {
    throw new Error('An all-saves teaching proposal must preserve rules for other entities');
  }
  const relevant = proposed.rules.filter((rule) => rule.entityId === entityId);
  if (!relevant.length) throw new Error('Teach requires an explicit bounded rule for the selected entity');
  const groups = new Map();
  for (const rule of relevant) {
    const key = canonicalJson({ when: rule.when, require: rule.require });
    const operations = groups.get(key) || new Set();
    const action = domain.actions.find((entry) => entry.id === rule.actionId);
    (action.operation === 'save' ? ['create', 'update'] : [action.operation]).forEach((operation) => operations.add(operation));
    groups.set(key, operations);
  }
  for (const operations of groups.values()) {
    if (entity.operations.filter((operation) => ['create', 'update'].includes(operation))
      .some((operation) => !operations.has(operation))) {
      throw new Error('All saves must cover every declared create/update path; clarify the existing save actions');
    }
  }
  return proposed;
}

function allowedFile(kind, file, selected, screenFiles, integration, ruleFiles) {
  relativePath(file);
  if (kind === 'business-rule') return ruleFiles.includes(file) || ['native-app-plan.md', 'memory-bank.md'].includes(file);
  if (PLAN_FILES.has(file)) return true;
  if (kind === 'integration') return allowedIntegrationFile(file, integration, screenFiles);
  if (kind === 'global-style') return /^(?:brand\/|src\/(?:tokens|theme)\/)/.test(file) || file === 'tamagui.config.ts';
  if (kind === 'target-layout') return file === selected.screen?.sourceFile;
  return screenFiles.includes(file) || /^(?:src\/components\/|brand\/)/.test(file);
}

function proposedScreens(root, input, compiled, kind) {
  const proposed = input.newScreens || [];
  if (!Array.isArray(proposed) || proposed.length > 5 || (proposed.length && !['screen', 'integration'].includes(kind))) {
    throw new Error('Only a screen or integration edit can propose up to five bounded new screens');
  }
  const ids = new Set((compiled.screens || []).map((screen) => screen.screenId));
  const routes = new Set((compiled.screens || []).map((screen) => screen.route));
  return proposed.map((value) => {
    protocol.object(value, 'new screen');
    if (Object.keys(value).some((key) => !['screenId', 'route', 'sourceFile'].includes(key))) throw new Error('Unsupported new-screen proposal field');
    const screenId = protocol.id(value.screenId, 'new screen ID');
    const route = protocol.assertScreen({ id: screenId, title: screenId, route: value.route }).route;
    const sourceFile = relativePath(value.sourceFile);
    if (!sourceFile.startsWith('app/') || !sourceFile.endsWith('.tsx')
      || fileToRoute(path.join(root, sourceFile), path.join(root, 'app')) !== route
      || exists(root, sourceFile) || ids.has(screenId) || routes.has(route)) {
      throw new Error('A new screen needs a unique new ID, route, and nonexistent matching source file');
    }
    ids.add(screenId);
    routes.add(route);
    return { screenId, route, sourceFile };
  });
}

function normalizePlan(root, descriptor, input) {
  protocol.object(input, 'edit proposal');
  if (input.schemaVersion !== 1 || Object.keys(input).some((key) => ![
    'schemaVersion', 'summary', 'kind', 'screenIds', 'newScreens', 'allowedFiles', 'entityId', 'rules', 'connectorName',
    'authoringRuntime', 'authoringSources',
  ].includes(key))) throw new Error('Edit proposal has an unsupported shape');
  const kind = protocol.enumeration(input.kind, ['global-style', 'target-layout', 'screen', 'business-rule', 'integration'], 'edit kind');
  if (!!descriptor.integration !== (kind === 'integration')) {
    throw new Error('A catalogue-selected edit must use its bound integration proposal, not an unrelated edit kind');
  }
  if (input.connectorName !== undefined && (kind !== 'integration' || descriptor.integration?.kind !== 'connector')) {
    throw new Error('Only a connector integration may bind an architecture connectorName');
  }
  const selected = registeredContext(root, descriptor);
  if (kind === 'target-layout' && (!selected.target || selected.target.role !== 'collection')) {
    throw new Error('A list-layout edit needs a registered collection target; ask a targeted clarification');
  }
  const screenIds = protocol.strings(input.screenIds || [], 'edit screenIds', 20).map((id) => protocol.id(id, 'edit screenId'));
  if (new Set(screenIds).size !== screenIds.length) throw new Error('Edit screen IDs must be unique');
  if (kind === 'target-layout' && (screenIds.length !== 1 || screenIds[0] !== selected.screen.screenId)) {
    throw new Error('A selected collection edit cannot widen to other screens');
  }
  if (kind === 'global-style' && screenIds.length) throw new Error('App-background edits default to global styling, not the selected screen');
  const compiled = readJson(root, '.tmp/compiled-screen-build-pack.json');
  if (compiled.contractType !== 'compiled-screen-build-pack' || !Array.isArray(compiled.screens)) {
    throw new Error('An edit requires the actual compiled screen contract');
  }
  const newScreens = proposedScreens(root, input, compiled, kind);
  for (const id of screenIds) {
    if (!compiled.screens.some((pack) => pack.screenId === id) && !newScreens.some((screen) => screen.screenId === id)) {
      throw new Error('Edit names an unknown compiled or explicitly proposed screen');
    }
  }
  if (newScreens.some((screen) => !screenIds.includes(screen.screenId))) throw new Error('Every proposed screen must be part of the approved screen set');
  const registry = exists(root, '.tmp/authoring-registry.json') ? readJson(root, '.tmp/authoring-registry.json') : null;
  const assignedSources = registry?.screens || (Array.isArray(input.authoringSources) ? input.authoringSources : []);
  const screenFiles = assignedSources.filter((screen) => screen && screenIds.includes(screen.screenId)).map((screen) => screen.sourceFile);
  const unmapped = screenIds.filter((id) => !newScreens.some((screen) => screen.screenId === id)
    && !assignedSources.some((screen) => screen?.screenId === id));
  if (unmapped.length && !registry && (input.authoringRuntime !== undefined || requiresAuthoringCheck(root))) {
    throw new Error('Initial authoring installation requires explicit authoringSources; source paths are never inferred from routes');
  }
  if (unmapped.length) screenFiles.push(...readyFiles(root, source(root), unmapped));
  screenFiles.push(...newScreens.map((screen) => screen.sourceFile));
  const layouts = new Set();
  for (const screen of newScreens) {
    for (let directory = path.posix.dirname(screen.sourceFile); directory === 'app' || directory.startsWith('app/'); directory = path.posix.dirname(directory)) {
      layouts.add(`${directory}/_layout.tsx`);
    }
  }
  if (!Array.isArray(input.allowedFiles) || !input.allowedFiles.length || input.allowedFiles.length > 40
    || new Set(input.allowedFiles).size !== input.allowedFiles.length) {
    throw new Error('An edit requires 1-40 exact approved files, not globs or directory access');
  }
  const allowedFiles = [...input.allowedFiles].sort();
  if (newScreens.some((screen) => !allowedFiles.includes(screen.sourceFile))) throw new Error('A new screen must have its exact source file in the approved scope');
  const authoring = planAuthoring(root, input, { kind, compiled, registry, newScreens });
  const integration = kind === 'integration' ? validateIntegrationPlan(root, descriptor, input) : null;
  const ruleFiles = kind === 'business-rule' ? ruleOutputPaths(root) : [];
  for (const file of allowedFiles) {
    if (!layouts.has(file) && !authoring.allowed.has(file)
      && !allowedFile(kind, file, selected, screenFiles, integration, ruleFiles)) throw new Error('An edit file exceeds the proposed contextual scope');
  }
  let rules;
  let entityId;
  if (kind === 'business-rule') {
    entityId = protocol.id(input.entityId, 'teach entityId');
    rules = ruleContract(root, input.rules, entityId);
    if (ruleFiles.some((file) => !allowedFiles.includes(file))) throw new Error('A teaching plan must include its rules, ownership/registry files, and any existing test-write permission');
  } else if (input.rules !== undefined || input.entityId !== undefined) throw new Error('Only a teaching proposal may change saved rules');
  return {
    schemaVersion: 1, kind,
    summary: protocol.text(input.summary, 'edit summary', 1000),
    scope: integration ? integration.kind : kind === 'global-style' ? 'app' : kind === 'business-rule' ? 'all-saves' : kind === 'target-layout' ? 'target' : 'screen',
    screenIds, allowedFiles,
    ...(authoring.authoringSources ? { authoringSources: authoring.authoringSources } : {}),
    ...(authoring.authoringRuntime ? { authoringRuntime: authoring.authoringRuntime } : {}),
    ...(newScreens.length ? { newScreens } : {}),
    ...(kind === 'target-layout' ? { targetId: selected.target.id, targetFile: selected.screen.sourceFile } : {}),
    ...(rules ? { rules, entityId } : {}),
    ...(integration ? { integration: integration.selection, integrationRoute: integration } : {}),
    preservedBehavior: ['navigation', 'queries', 'actions', 'paging'],
    remoteEffects: false,
  };
}

async function inspect(client, intent = 'general') {
  await client.verify({ refresh: true });
  const current = source(client.descriptor.workspaceDir);
  if (current.revision !== client.descriptor.baseRevision) throw new Error('The captured edit context is stale; preserve the last-good preview and reopen the edit');
  return {
    ...inspectEdit(client.descriptor.workspaceDir, client.descriptor, intent), sourceRevision: current.revision,
    ...(client.descriptor.integration ? { integrationRoute: integrationRoute(client.descriptor.workspaceDir, client.descriptor) } : {}),
  };
}

async function prepare(client, input) {
  await client.verify({ refresh: true });
  client.assertSafe(input);
  const { descriptor } = client;
  if (!['edit', 'teach'].includes(descriptor.operation)) throw new Error('The contextual edit wrapper requires an edit or teach job');
  const root = descriptor.workspaceDir;
  const baseline = source(root);
  if (baseline.revision !== descriptor.baseRevision) throw new Error('Candidate source no longer matches the captured edit base revision');
  const plan = {
    ...normalizePlan(root, descriptor, input),
    appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId,
    baseRevision: descriptor.baseRevision, context: descriptor.context || null,
    baseline,
  };
  plan.approvedFileBaselines = approvedFileBaselines(root, plan.allowedFiles);
  if (plan.kind === 'business-rule') {
    plan.ruleWrites = Object.entries(ruleOutputs(root, plan)).map(([file, bytes]) => ({ path: file, sha256: digest(bytes) }));
  }
  client.assertSafe(plan);
  plan.id = `edit-${digest(canonicalJson(plan)).slice(0, 40)}`;
  const planPath = planLocation(descriptor, plan.id);
  if (exists(root, planPath)) {
    if (canonicalJson(readJson(root, planPath)) !== canonicalJson(plan)) throw new Error('Sealed edit proposal was modified');
    return { planId: plan.id, planPath, scope: plan.scope, status: 'proposed' };
  }
  // Backups are limited to the explicitly proposed code/contracts. Runtime
  // records, media stores, remote journals, and unrelated files are not copied.
  for (const file of plan.allowedFiles) {
    if (exists(root, file)) {
      const backup = journalPath(descriptor, `backups/${plan.id}/${digest(file)}`);
      const bytes = readFile(inside(root, file), 2 * 1024 * 1024);
      if (digest(bytes) !== plan.approvedFileBaselines.find((entry) => entry.path === file).sha256) {
        throw new Error('An approved edit file changed while sealing its backup');
      }
      if (exists(root, backup)) {
        if (digest(readFile(inside(root, backup), 2 * 1024 * 1024)) !== digest(bytes)) throw new Error('The immutable edit backup changed');
      } else atomicWrite(root, backup, bytes, { bytes: true, exclusive: true });
    }
  }
  if (source(root).revision !== baseline.revision
    || canonicalJson(approvedFileBaselines(root, plan.allowedFiles)) !== canonicalJson(plan.approvedFileBaselines)) {
    throw new Error('The candidate source changed while sealing the edit proposal');
  }
  atomicWrite(root, planPath, plan, { exclusive: true });
  atomicWrite(root, stateLocation(descriptor, plan.id), { schemaVersion: 1, planId: plan.id, state: 'proposed' }, { exclusive: true });
  return { planId: plan.id, planPath, scope: plan.scope, status: 'proposed' };
}

function loadPlan(client, planId) {
  const plan = readJson(client.descriptor.workspaceDir, planLocation(client.descriptor, planId));
  const { id, ...unsigned } = plan;
  if (id !== planId || id !== `edit-${digest(canonicalJson(unsigned)).slice(0, 40)}`
    || plan.appInstanceId !== client.descriptor.appInstanceId || plan.jobId !== client.descriptor.jobId
    || plan.attemptId !== client.descriptor.attemptId || plan.baseRevision !== client.descriptor.baseRevision
    || !sameIntegration(plan.integration, client.descriptor.integration)) {
    throw new Error('The sealed edit plan is stale or belongs to another operation');
  }
  return plan;
}

async function authorize(client, planId, { waitMs } = {}) {
  const plan = loadPlan(client, planId);
  if (source(client.descriptor.workspaceDir).revision !== plan.baseRevision) throw new Error('Approve preparation before changing candidate source');
  const entity = plan.entityId ? readJson(client.descriptor.workspaceDir, DOMAIN_PATH).entities.find((entry) => entry.id === plan.entityId) : null;
  const items = [
    `Scope: ${plan.scope === 'all-saves' ? `All ${entity.label.toLowerCase()} saves` : plan.scope}.`,
    'Prepare an isolated candidate only. Apply is a separate maker decision.',
    ...(plan.integrationRoute ? integrationReviewItems(plan.integrationRoute)
      : ['No remote data, schema, sample-data import, or active-preview replacement is authorized.']),
    'Preserve existing navigation, collection queries, record actions, and paging unless the reviewed feature adds a new surface.',
    ...(plan.authoringSources ? ['Derive authoring registration only from the sealed source assignments and explicit authoringTargets exports.'] : []),
    ...(plan.authoringRuntime ? [`${plan.authoringRuntime === 'install' ? 'Install' : 'Upgrade'} the compiler-owned authoring runtime and its root/import wiring; do not mint an active publisher stamp or native readiness acknowledgement.`] : []),
    ...(plan.kind === 'business-rule' && plan.allowedFiles.includes(TEST_WRITE_PERMISSION)
      ? ['Revoke existing temporary test-write permission; preserve all business records and remote evidence.'] : []),
  ];
  let files = 'Files: ';
  for (const file of plan.allowedFiles) {
    if (files.length + file.length + 2 > 950) { items.push(files); files = 'Files: '; }
    files += `${files === 'Files: ' ? '' : ', '}${file}`;
  }
  if (files !== 'Files: ') items.push(files);
  if (items.length > 30) throw new Error('The edit review exceeds the bounded maker card; narrow the proposed scope');
  const result = await client.requestQuestion({
    gateId: `prepare-${plan.id}`, kind: 'plan', title: plan.kind === 'business-rule' ? 'Prepare this saved rule?' : 'Prepare this edit?',
    summary: plan.summary,
    items,
    fields: [],
  }, { bind: [planLocation(client.descriptor, planId)], waitMs });
  const state = { schemaVersion: 1, planId, state: result.receipt.action === 'approve' ? 'authorized' : result.receipt.action, receiptPath: result.receiptPath };
  atomicWrite(client.descriptor.workspaceDir, stateLocation(client.descriptor, planId), state);
  return { planId, status: state.state, action: result.receipt.action, answer: result.receipt.answer, receipt: result.receiptPath, applied: false };
}

async function authorizedPlan(client, planId) {
  await client.verify({ refresh: true });
  const plan = loadPlan(client, planId);
  const state = readJson(client.descriptor.workspaceDir, stateLocation(client.descriptor, planId));
  if (!['authorized', 'preparing-integration', 'writing', 'prepared', 'checked', 'submitted'].includes(state.state)) {
    throw new Error('The maker has not approved preparing this edit');
  }
  // The approval binds the immutable proposal, not the candidate's changing
  // source. The proposal itself embeds the complete base source manifest.
  const saved = await client.verifySavedDecision(state.receiptPath, { gateId: `prepare-${plan.id}` });
  if (saved.binding.files?.length !== 1 || saved.binding.files[0].path !== planLocation(client.descriptor, plan.id)) {
    throw new Error('Preparation receipt is not bound to this sealed edit proposal');
  }
  return { plan, state };
}

function behaviorSignature(root, content) {
  let ts;
  try { ts = createRequire(path.join(root, 'package.json'))('typescript'); }
  catch { throw new Error('Scoped screen behavior validation needs the app existing TypeScript dependency'); }
  const file = ts.createSourceFile('screen.tsx', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length) throw new Error('A screen must parse before scoped behavior comparison');
  const printer = ts.createPrinter({ removeComments: true });
  const expressions = [];
  const declarations = new Map();
  const references = new Set();
  const identifiers = (node) => {
    const found = new Set();
    function scan(child) {
      if (ts.isIdentifier(child)) found.add(child.text);
      ts.forEachChild(child, scan);
    }
    scan(node);
    return found;
  };
  const names = (node) => ts.isIdentifier(node) ? [node.text]
    : (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))
      ? node.elements.filter(ts.isBindingElement).flatMap((element) => names(element.name)) : [];
  const declare = (name, text, refs = []) => {
    declarations.set(name, [...(declarations.get(name) || []), { text, refs }]);
  };
  function visit(node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      const text = printer.printNode(ts.EmitHint.Expression, node.initializer, file);
      for (const name of names(node.name)) declare(name, text, identifiers(node.initializer));
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      declare(node.name.text, printer.printNode(ts.EmitHint.Unspecified, node, file), identifiers(node));
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      const module = node.moduleSpecifier.getText(file);
      if (node.importClause.name) declare(node.importClause.name.text, `default:${module}`);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) declare(bindings.name.text, `namespace:${module}`);
      else for (const item of bindings?.elements || []) declare(item.name.text, `${item.propertyName?.text || item.name.text}:${module}`);
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file);
      if (/\b(?:router|navigation)\b|\buse[A-Z]\w*|getRepository|\b\w*Service\b|\.(?:list|get|query|create|update|delete|save|submit|mutate|mutateAsync|filter|sort|slice|fetchNextPage|refetch)\b/.test(name)) {
        expressions.push(printer.printNode(ts.EmitHint.Expression, node, file));
        identifiers(node).forEach((reference) => references.add(reference));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const dependencies = [];
  const pending = [...references];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    for (const declaration of declarations.get(name) || []) {
      dependencies.push({ name, text: declaration.text });
      pending.push(...declaration.refs);
    }
  }
  // Include referenced initializers/imports: preserving `list(query)` while
  // changing query.pageSize or swapping its repository is not a layout edit.
  dependencies.sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return canonicalJson({ expressions, dependencies });
}

function protectedPacks(value) {
  if (value.contractType === 'compiled-screen-build-pack') {
    return value.screens.map((screen) => ({
      screenId: screen.screenId, route: screen.route, navigationShell: screen.navigationShell,
      journeySteps: screen.journeySteps,
      requiredOperations: screen.implementationContract?.requiredOperations,
      pack: Object.fromEntries(PROTECTED_PACK_KEYS.filter((key) => screen.pack[key] !== undefined).map((key) => [key, screen.pack[key]])),
    }));
  }
  if (value.contractType !== 'screen-build-pack' || !Array.isArray(value.packs)) throw new Error('Invalid protected screen pack');
  return value.packs.map((pack) => Object.fromEntries(PROTECTED_PACK_KEYS
    .filter((key) => pack[key] !== undefined).map((key) => [key, pack[key]])));
}

function originalBytes(root, descriptor, plan, file) {
  const baseline = (plan.approvedFileBaselines || plan.baseline.files).find((entry) => entry.path === file);
  if (!baseline?.sha256) throw new Error('The protected edit artifact did not exist at proposal time');
  const bytes = readFile(inside(root, journalPath(descriptor, `backups/${plan.id}/${digest(file)}`)), 2 * 1024 * 1024);
  if (digest(bytes) !== baseline.sha256) throw new Error('The protected edit backup does not match the approved source');
  return bytes;
}

function semanticContract(value) {
  const copy = structuredClone(value);
  for (const key of ['experienceRevision', 'scopeRevision', 'journeyRevision', 'compiledRevision', 'buildPackRevision']) delete copy[key];
  return copy;
}

function assertScopedDelta(root, descriptor, plan) {
  const current = source(root);
  const beforeFiles = new Map(plan.baseline.files.map((entry) => [entry.path, entry]));
  const afterFiles = new Map(current.files.map((entry) => [entry.path, entry]));
  for (const entry of plan.approvedFileBaselines || []) {
    beforeFiles.set(entry.path, entry);
    const [after] = approvedFileBaselines(root, [entry.path]);
    afterFiles.set(entry.path, after);
  }
  const changes = sourceDelta({ files: [...beforeFiles.values()] }, { files: [...afterFiles.values()] });
  if (changes.some((change) => !plan.allowedFiles.includes(change.path))) {
    throw new Error('Candidate contains out-of-scope source changes; preserve them and reopen the proposal');
  }
  assertAuthoringDelta(root, plan, changes, (file) => JSON.parse(originalBytes(root, descriptor, plan, file).toString('utf8')));
  if (plan.kind === 'integration') {
    if (!sameIntegration(plan.integration, descriptor.integration)) throw new Error('The integration selection changed after preparation approval');
    assertIntegrationPreserved(root, plan, changes, (file) => JSON.parse(originalBytes(root, descriptor, plan, file).toString('utf8')));
  }
  if (plan.kind === 'target-layout') {
    const before = originalBytes(root, descriptor, plan, plan.targetFile).toString('utf8');
    const after = readFile(inside(root, plan.targetFile)).toString('utf8');
    if (behaviorSignature(root, before) !== behaviorSignature(root, after)) {
      throw new Error('A collection layout edit changed protected queries, navigation, actions, or paging');
    }
  }
  if (['target-layout', 'global-style'].includes(plan.kind)) {
    for (const file of ['.tmp/screen-build-pack.json', '.tmp/compiled-screen-build-pack.json']) {
      if (!changes.some((entry) => entry.path === file)) continue;
      const old = JSON.parse(originalBytes(root, descriptor, plan, file).toString('utf8'));
      const next = readJson(root, file);
      if (canonicalJson(protectedPacks(old)) !== canonicalJson(protectedPacks(next))) {
        throw new Error('A visual edit changed protected compiled actions, navigation, or data assumptions');
      }
    }
    for (const file of ['.tmp/product-scope-contract.json', '.tmp/workflow-journey-contract.json']) {
      if (!changes.some((entry) => entry.path === file)) continue;
      const before = JSON.parse(originalBytes(root, descriptor, plan, file).toString('utf8'));
      if (canonicalJson(semanticContract(before)) !== canonicalJson(semanticContract(readJson(root, file)))) {
        throw new Error('A visual edit changed the product scope or workflow instead of only its presentation');
      }
    }
  }
  return { sourceRevision: current.revision, changes };
}

async function check(client, planId) {
  const { plan, state } = await authorizedPlan(client, planId);
  const result = assertScopedDelta(client.descriptor.workspaceDir, client.descriptor, plan);
  if (!result.changes.length) throw new Error('The approved edit has no candidate changes');
  if (plan.kind === 'business-rule') {
    if (!plan.ruleWrites?.length || plan.ruleWrites.some((entry) => (
      !exists(client.descriptor.workspaceDir, entry.path)
      || digest(readFile(inside(client.descriptor.workspaceDir, entry.path))) !== entry.sha256
    ))) throw new Error('The teaching candidate does not match its exact approved compiler outputs');
    refreshPrototypeRules(client.descriptor.workspaceDir, { check: true });
  }
  if (plan.kind === 'integration') {
    if (!state.gateReceipt) throw new Error('The integration must pass its own current Gate 1 before candidate verification');
    const gate = await client.verifySavedDecision(state.gateReceipt, { gateId: 'gate1' });
    if (gate.binding.type !== 'gate' || gate.binding.gate !== 1) throw new Error('The integration requires a canonical Gate 1 receipt');
    assertArchitectureSelection(client.descriptor.workspaceDir, plan.integrationRoute);
    assertIntegrationPrepared(client.descriptor.workspaceDir, plan, result.changes);
  }
  atomicWrite(client.descriptor.workspaceDir, stateLocation(client.descriptor, planId), {
    ...state, state: 'checked', sourceRevision: result.sourceRevision, changes: result.changes,
  });
  return { planId, status: 'scope-checked', ...result, applied: false };
}

async function integration(client, planId, gateReceipt) {
  const { plan, state } = await authorizedPlan(client, planId);
  if (plan.kind !== 'integration' || !gateReceipt) throw new Error('An integration requires its sealed proposal and --gate-receipt');
  assertIntegrationWorkflow(plan.integrationRoute);
  const saved = await client.verifySavedDecision(gateReceipt, { gateId: 'gate1' });
  if (saved.binding.type !== 'gate' || saved.binding.gate !== 1) throw new Error('The integration requires a canonical Gate 1 receipt');
  const root = client.descriptor.workspaceDir;
  assertScopedDelta(root, client.descriptor, plan);
  assertArchitectureSelection(root, plan.integrationRoute);
  atomicWrite(root, stateLocation(client.descriptor, planId), { ...state, state: 'preparing-integration', gateReceipt });
  // This is a fixed foreground skill handoff, not a shell-command router and
  // not evidence that generation, preview, or Apply has completed.
  return { planId, status: 'authorized-handoff', ...plan.integrationRoute, applied: false };
}

async function capture(client, planId) {
  const { plan, state } = await authorizedPlan(client, planId);
  if (plan.kind !== 'integration' || !plan.integrationRoute.localCapture || !state.gateReceipt
    || captureOutputFiles(plan.integrationRoute).some((file) => !plan.allowedFiles.includes(file))) {
    throw new Error('Local capture refresh requires its approved exact output scope and completed integration handoff');
  }
  assertIntegrationWorkflow(plan.integrationRoute);
  const gate = await client.verifySavedDecision(state.gateReceipt, { gateId: 'gate1' });
  if (gate.binding.type !== 'gate' || gate.binding.gate !== 1) throw new Error('Local capture requires its canonical Gate 1 receipt');
  const root = client.descriptor.workspaceDir;
  assertArchitectureSelection(root, plan.integrationRoute);
  // The full prototype generator also refreshes fixture metadata. Native edits
  // retain those bytes and use only the existing capture/registry producers.
  const outputs = localCaptureOutputs(root, plan.integrationRoute,
    (file) => JSON.parse(originalBytes(root, client.descriptor, plan, file).toString('utf8')));
  client.assertSafe(Object.fromEntries(Object.entries(outputs).map(([file, bytes]) => [file, bytes.toString('utf8')])));
  const writes = Object.entries(outputs).map(([file, bytes]) => ({ path: file, sha256: digest(bytes) }));
  if (state.captureWrites && canonicalJson(state.captureWrites) !== canonicalJson(writes)) {
    throw new Error('The approved capture compiler inputs changed during recovery; reopen the owning proposal');
  }
  const current = new Map();
  for (const [file, bytes] of Object.entries(outputs)) {
    const value = exists(root, file) ? readFile(inside(root, file)) : null;
    const hash = value === null ? null : digest(value);
    const baseline = plan.approvedFileBaselines.find((entry) => entry.path === file)?.sha256;
    if (hash !== baseline && hash !== digest(bytes)) throw new Error('A capture output changed outside its sealed before/after bytes');
    current.set(file, { bytes: value, sha256: hash });
  }
  // Exclude only verified before/after capture bytes from this partial-write
  // check. Every other source and canonical artifact keeps its sealed baseline.
  const projected = (files) => files.map((entry) => current.has(entry.path)
    ? { ...entry, sha256: current.get(entry.path).sha256 } : entry);
  assertScopedDelta(root, client.descriptor, {
    ...plan, baseline: { ...plan.baseline, files: projected(plan.baseline.files) },
    approvedFileBaselines: projected(plan.approvedFileBaselines),
  });
  atomicWrite(root, stateLocation(client.descriptor, planId), { ...state, state: 'writing', captureWrites: writes });
  try {
    for (const [file, bytes] of Object.entries(outputs)) atomicWrite(root, file, bytes, { bytes: true });
    const checked = assertScopedDelta(root, client.descriptor, plan);
    await client.verifySavedDecision(state.gateReceipt, { gateId: 'gate1' });
    atomicWrite(root, stateLocation(client.descriptor, planId), {
      ...state, state: 'prepared', captureWrites: writes, sourceRevision: checked.sourceRevision,
    });
    return { planId, status: 'prepared', files: Object.keys(outputs), applied: false, remoteEffects: false };
  } catch (error) {
    for (const [file, value] of [...current].reverse()) {
      const observed = exists(root, file) ? digest(readFile(inside(root, file))) : null;
      if (observed !== digest(outputs[file]) && observed !== value.sha256) {
        throw new Error('Capture recovery found conflicting source; preserve it and reopen the proposal');
      }
      if (value.bytes === null) { if (exists(root, file)) fs.unlinkSync(inside(root, file)); }
      else atomicWrite(root, file, value.bytes, { bytes: true });
    }
    atomicWrite(root, stateLocation(client.descriptor, planId), state);
    throw error;
  }
}

function ruleOutputs(root, plan) {
  const domain = validateDomain(readJson(root, DOMAIN_PATH));
  const rules = validateRules(domain, plan.rules);
  const original = (file) => plan.id
    ? JSON.parse(originalBytes(root, plan, plan, file).toString('utf8')) : readJson(root, file);
  const generated = original('.tmp/prototype-generated.json');
  const registry = original('.tmp/data-access-registry.json');
  const code = generateRulesRuntime(domain, rules);
  const inputRevision = digest(canonicalJson(rules));
  if (!generated.files?.['src/data/rules.ts'] || !registry.inputRevisions || !generated.inputRevisions) {
    throw new Error('Teach requires the actual app-owned repository generator contracts');
  }
  const currentCode = digest(readFile(inside(root, 'src/data/rules.ts')));
  if (currentCode !== generated.files['src/data/rules.ts'] && currentCode !== digest(code)) {
    throw new Error('The existing saved-rule runtime was edited outside its owning compiler');
  }
  generated.inputRevisions.rules = inputRevision;
  generated.files['src/data/rules.ts'] = digest(code);
  registry.inputRevisions.rules = inputRevision;
  delete registry.registryRevision;
  registry.registryRevision = digest(canonicalJson(registry));
  const outputs = {
    [RULES_PATH]: jsonBytes(rules), 'src/data/rules.ts': Buffer.from(code),
    '.tmp/data-access-registry.json': Buffer.from(`${JSON.stringify(registry, null, 2)}\n`),
  };
  if (generated.files[TEST_WRITE_PERMISSION] || exists(root, TEST_WRITE_PERMISSION)) {
    if (!generated.files[TEST_WRITE_PERMISSION]) throw new Error('Test-write permission is not compiler-owned');
    outputs[TEST_WRITE_PERMISSION] = Buffer.from('null\n');
    generated.files[TEST_WRITE_PERMISSION] = digest(outputs[TEST_WRITE_PERMISSION]);
  }
  outputs['.tmp/prototype-generated.json'] = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, inputRevisions: generated.inputRevisions, files: generated.files,
  }, null, 2)}\n`);
  return Object.fromEntries(ruleOutputPaths(root).map((file) => [file, outputs[file]]));
}

async function teach(client, planId) {
  const { plan, state } = await authorizedPlan(client, planId);
  if (plan.kind !== 'business-rule') throw new Error('Teach requires an approved bounded rule proposal');
  const root = client.descriptor.workspaceDir;
  assertScopedDelta(root, client.descriptor, plan);
  const outputs = ruleOutputs(root, plan);
  if (canonicalJson(plan.ruleWrites) !== canonicalJson(Object.entries(outputs).map(([file, bytes]) => ({ path: file, sha256: digest(bytes) })))) {
    throw new Error('The owning rules compiler changed; reopen the teaching proposal');
  }
  const writes = Object.entries(outputs).map(([file, bytes]) => ({ path: file, after: digest(bytes) }));
  const writing = { ...state, state: 'writing', writes };
  atomicWrite(root, stateLocation(client.descriptor, planId), writing);
  for (const [file, bytes] of Object.entries(outputs)) {
    const beforeHash = (plan.approvedFileBaselines || plan.baseline.files).find((entry) => entry.path === file)?.sha256 || null;
    const currentHash = exists(root, file) ? digest(readFile(inside(root, file))) : null;
    if (currentHash !== beforeHash && currentHash !== digest(bytes)) {
      throw new Error('A teaching output changed during recovery; do not overwrite the conflicting file');
    }
  }
  atomicWrite(root, RULES_PATH, outputs[RULES_PATH], { bytes: true });
  refreshPrototypeRules(root);
  assertScopedDelta(root, client.descriptor, plan);
  for (const [file, bytes] of Object.entries(outputs)) {
    if (digest(readFile(inside(root, file))) !== digest(bytes)) throw new Error('The owning rules generator produced an unexpected scoped artifact');
  }
  atomicWrite(root, stateLocation(client.descriptor, planId), { ...writing, state: 'prepared' });
  return { planId, status: 'prepared', files: Object.keys(outputs), applied: false, remoteEffects: false };
}

async function submit(client, planId, candidateOptions) {
  const checked = await check(client, planId);
  const result = await require('./mobile-authoring-candidate').prepareCandidate(client, candidateOptions);
  if (result.candidate.sourceRevision !== checked.sourceRevision) throw new Error('Candidate changed after scoped edit verification');
  const { plan, state } = await authorizedPlan(client, planId);
  const undo = {
    schemaVersion: 1, kind: 'eligible-code-only-undo',
    appInstanceId: client.descriptor.appInstanceId, jobId: client.descriptor.jobId,
    candidateId: result.candidate.id, baseRevision: plan.baseRevision, afterRevision: result.candidate.sourceRevision,
    files: checked.changes, remoteEffects: false, businessDataIncluded: false,
    publicationOwner: 'bridge',
  };
  const undoPath = journalPath(client.descriptor, `undo/${planId}.json`);
  atomicWrite(client.descriptor.workspaceDir, undoPath, undo);
  atomicWrite(client.descriptor.workspaceDir, stateLocation(client.descriptor, planId), {
    ...state, state: 'submitted', candidateId: result.candidate.id, sourceRevision: result.candidate.sourceRevision, undoPath,
  });
  return { ...result, undoReceipt: undoPath, applied: false };
}

function undoEligible(root, receipt) {
  return receipt?.schemaVersion === 1 && receipt.kind === 'eligible-code-only-undo'
    && receipt.remoteEffects === false && receipt.businessDataIncluded === false
    && source(root).revision === receipt.afterRevision;
}

module.exports = {
  RULES_PATH, RULE_OUTPUTS, TEST_WRITE_PERMISSION, planLocation, stateLocation, sourceDelta, normalizePlan,
  inspect, prepare, loadPlan, authorize, authorizedPlan, assertScopedDelta,
  behaviorSignature, originalBytes, protectedPacks, check, teach, integration, capture, ruleOutputs, submit, undoEligible,
};

#!/usr/bin/env node
'use strict';

/**
 * Validate a Canvas/MSAPP adapter package before `/create-mobile-app` imports it.
 * This is intentionally dependency-free so the check works before npm install.
 *
 * Usage:
 *   node scripts/validate-mobile-plugin-input.js --dir <mobile-plugin-input-dir> [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathContains } = require('./lib/modernizer-paths.js');
const {
  WORKFLOW_APPROVAL_STATUSES,
  WORKFLOW_EXECUTION_OWNERS,
  WORKFLOW_UX_MODES,
  deriveWorkflowStats,
} = require('./lib/workflow-plan.js');
const { attachWorkflowRefs, buildBehaviorArtifacts } = require('./lib/behavior-contract.js');
const {
  derivePcfStats,
  projectPcfControlIntents,
} = require('./lib/pcf-control-intent.js');
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MARKDOWN_ENTRIES = 10000;
const MAX_MARKDOWN_DEPTH = 8;

function parseArgs(argv) {
  const args = { dir: '', json: false, requirePcfApproval: false, requireWorkflowApproval: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i] || '';
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--require-pcf-approval') args.requirePcfApproval = true;
    else if (argv[i] === '--require-workflow-approval') args.requireWorkflowApproval = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node scripts/validate-mobile-plugin-input.js --dir <mobile-plugin-input-dir> [--json] [--require-pcf-approval] [--require-workflow-approval]\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dir) throw new Error('Missing required --dir <mobile-plugin-input-dir>');
  return args;
}

function readJson(file, errors, label) {
  if (!fs.existsSync(file)) {
    errors.push(`${label} is missing: ${file}`);
    return null;
  }
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      errors.push(`${label} must be a regular file, not a symlink/directory: ${file}`);
      return null;
    }
    if (stat.size > MAX_PACKAGE_FILE_BYTES) {
      errors.push(`${label} exceeds ${MAX_PACKAGE_FILE_BYTES} bytes: ${file}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${label} is invalid JSON: ${error.message}`);
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scanIntentHintForRawSource(value, at, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanIntentHintForRawSource(entry, `${at}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:sourceStatement|sourceFormula|formula|expression|raw|args|fields|context|baseRecord|from|value)$/i.test(key)) {
      errors.push(`regenerable intent hint must not contain raw Power Fx payload: ${at}.${key}`);
    }
    scanIntentHintForRawSource(child, `${at}.${key}`, errors);
  }
}

function safePackagePath(root, relativePath, errors, label) {
  if (!relativePath || typeof relativePath !== 'string') {
    errors.push(`${label} is missing`);
    return null;
  }
  const resolved = path.resolve(root, relativePath);
  if (!pathContains(root, resolved)) {
    errors.push(`${label} escapes the migration package: ${relativePath}`);
    return null;
  }
  return resolved;
}

function validNativeRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  if (/[\\?#\u0000-\u001f\u007f]/.test(value) || value.includes('//')) return false;
  return path.posix.normalize(value) === value;
}

function validTargetFile(value) {
  if (typeof value !== 'string' || !value.startsWith('app/') || !value.endsWith('.tsx')) return false;
  if (/[\\:\u0000-\u001f\u007f]/.test(value) || path.posix.normalize(value) !== value) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_@().\[\]-]+$/.test(segment));
}

function validWorkflowModule(value) {
  if (typeof value !== 'string' || !value.startsWith('src/features/') || !/\.tsx?$/.test(value)) return false;
  if (/[\\:\u0000-\u001f\u007f]/.test(value) || path.posix.normalize(value) !== value) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..' && /^[A-Za-z0-9_.-]+$/.test(segment));
}

function validWorkflowCallSite(value) {
  return value === 'src/bootstrap.ts' || validTargetFile(value);
}

function validTypeScriptIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(value);
}

function validSourceLabel(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validDecisionText(value, maxLength = 4000) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validDataverseName(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
}

const SECRET_LIKE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:client[_-]?secret|password|accountkey|sharedaccesskey|signature|sig)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{16,}/i,
];

function containsSecretLikeText(value) {
  const text = String(value || '');
  return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

function scanSecrets(value, at, errors) {
  if (typeof value === 'string') {
    if (containsSecretLikeText(value)) errors.push(`secret-like text must be removed from migration package: ${at}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${at}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(accessToken|refreshToken|clientSecret|client_secret|password|authorization|instrumentationKey|accountName|authorEmail)$/i.test(key) && child) {
      errors.push(`sensitive field must not be present in migration package: ${at}.${key}`);
    }
    if (/^(connectionId|connectionInstanceId|flowId|workflowEntityId)$/i.test(key) && child) {
      errors.push(`environment-bound identifier must be resolved in the target, not imported: ${at}.${key}`);
    }
    scanSecrets(child, `${at}.${key}`, errors);
  }
}

function scanMarkdownTree(root, at, errors, state, depth = 0) {
  if (state.exceeded) return;
  if (!fs.existsSync(root)) return;
  if (depth > MAX_MARKDOWN_DEPTH) {
    errors.push(`migration Markdown tree exceeds depth ${MAX_MARKDOWN_DEPTH}: ${at}`);
    return;
  }
  state.count += 1;
  if (state.count > MAX_MARKDOWN_ENTRIES) {
    errors.push(`migration Markdown tree exceeds ${MAX_MARKDOWN_ENTRIES} entries`);
    state.exceeded = true;
    return;
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    errors.push(`symbolic links are not allowed in migration package: ${at}`);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(root)) {
      scanMarkdownTree(path.join(root, entry), `${at}/${entry}`, errors, state, depth + 1);
      if (state.exceeded) break;
    }
    return;
  }
  if (stat.isFile() && root.toLowerCase().endsWith('.md')) {
    if (stat.size > MAX_PACKAGE_FILE_BYTES) {
      errors.push(`migration Markdown exceeds ${MAX_PACKAGE_FILE_BYTES} bytes: ${at}`);
      return;
    }
    const text = fs.readFileSync(root, 'utf8');
    if (containsSecretLikeText(text)) errors.push(`secret-like text must be removed from migration package: ${at}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.dir);
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Migration package directory not found: ${root}`);
  }

  const input = readJson(path.join(root, 'mobile-plugin-input.json'), errors, 'mobile-plugin-input.json');
  const behaviors = readJson(path.join(root, 'behaviors.json'), errors, 'behaviors.json');
  const coverage = readJson(path.join(root, 'control-intent-coverage.json'), errors, 'control-intent-coverage.json');
  const serverSideAssets = readJson(path.join(root, 'server-side-assets.json'), errors, 'server-side-assets.json');
  let behaviorContract = null;
  let pcfPlan = null;
  let workflowPlan = null;

  for (const required of ['native-app-plan.md', path.join('state', 'app-state.md'), 'migration-checklist.md']) {
    const file = path.join(root, required);
    if (!fs.existsSync(file)) errors.push(`${required} is missing`);
    else {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) errors.push(`${required} must be a regular file`);
      else if (stat.size > MAX_PACKAGE_FILE_BYTES) errors.push(`${required} exceeds ${MAX_PACKAGE_FILE_BYTES} bytes`);
    }
  }

  let knownScreens = new Set();
  if (input) {
    if (String(input.schemaVersion) !== '3') errors.push(`unsupported mobile-plugin-input schemaVersion: ${input.schemaVersion}`);
    if (!validSourceLabel(input.app?.name)) errors.push('app.name is missing or contains unsafe control characters');
    if (!input.app?.startScreen && !input.migrationCheck) errors.push('app.startScreen is missing');
    if (input.app?.auth != null && !['entra', 'none'].includes(input.app.auth)) errors.push(`unsupported app.auth mode: ${input.app.auth}`);
    const briefPath = input.source?.appBriefPath;
    if (briefPath && (path.isAbsolute(briefPath) || /^[A-Za-z]:[\\/]/.test(briefPath) || /[\u0000-\u001f\u007f]/.test(briefPath))) {
      errors.push('source.appBriefPath must be a portable relative path');
    }
    const pcfPlanFile = safePackagePath(root, input.pcfPlan?.file, errors, 'pcfPlan.file');
    if (pcfPlanFile) pcfPlan = readJson(pcfPlanFile, errors, 'pcf-plan.json');
    const workflowPlanFile = safePackagePath(root, input.workflowPlan?.file, errors, 'workflowPlan.file');
    if (workflowPlanFile) workflowPlan = readJson(workflowPlanFile, errors, 'workflows.json');
    const behaviorContractFile = safePackagePath(root, input.behaviorPlan?.file, errors, 'behaviorPlan.file');
    if (behaviorContractFile) behaviorContract = readJson(behaviorContractFile, errors, 'behavior-contract.json');

    const screens = input.screenPlan?.screens;
    if (!Array.isArray(screens)) errors.push('screenPlan.screens must be an array');
    else if (screens.length === 0 && !input.migrationCheck) errors.push('screenPlan.screens is empty for a runnable app');

    const names = new Set();
    const routes = new Set();
    const files = new Set();
    for (const [index, screen] of (screens || []).entries()) {
      if (!validSourceLabel(screen?.name)) {
        errors.push(`screenPlan.screens[${index}].name is missing or contains unsafe control characters`);
        continue;
      }
      if (names.has(screen.name)) errors.push(`duplicate screen name: ${screen.name}`);
      names.add(screen.name);
      const routeKey = String(screen.route || '').toLowerCase();
      if (!validNativeRoute(screen.route)) errors.push(`screen ${screen.name} has invalid route: ${screen.route || 'missing'}`);
      else if (routes.has(routeKey)) errors.push(`duplicate native route: ${screen.route}`);
      else routes.add(routeKey);
      if (!validTargetFile(screen.file)) {
        errors.push(`screen ${screen.name} has unsafe/missing target file: ${screen.file || 'missing'}`);
      } else if (files.has(screen.file.toLowerCase())) errors.push(`duplicate native target file: ${screen.file}`);
      else files.add(screen.file.toLowerCase());
      const planFile = safePackagePath(root, screen.planFile, errors, `screen ${screen.name} planFile`);
      if (planFile && !fs.existsSync(planFile)) errors.push(`screen plan is missing for ${screen.name}: ${screen.planFile}`);
      if (screen.controlsFile) {
        const controlsFile = safePackagePath(root, screen.controlsFile, errors, `screen ${screen.name} controlsFile`);
        if (controlsFile && !fs.existsSync(controlsFile)) errors.push(`screen controls file is missing for ${screen.name}: ${screen.controlsFile}`);
      }
    }
    if (input.app?.startScreen && !names.has(input.app.startScreen)) errors.push(`app.startScreen references unknown source screen: ${input.app.startScreen}`);

    for (const [index, edge] of (input.screenPlan?.navigationEdges || []).entries()) {
      if (edge?.from && !names.has(edge.from)) errors.push(`navigationEdges[${index}].from references unknown screen: ${edge.from}`);
      if (edge?.to && !names.has(edge.to)) errors.push(`navigationEdges[${index}].to references unknown screen: ${edge.to}`);
    }
    knownScreens = names;

    for (const [index, table] of (input.dataModelPlan?.dataverseTables || []).entries()) {
      if (!validDataverseName(table?.logicalName)) errors.push(`dataverseTables[${index}].logicalName is missing or invalid`);
      for (const [columnIndex, column] of (table?.columns || []).entries()) {
        if (!validDataverseName(column?.name)) errors.push(`dataverseTables[${index}].columns[${columnIndex}].name is missing or invalid`);
      }
      if (!['reuse', 'extend', 'new'].includes(table?.status)) warnings.push(`Dataverse table ${table?.logicalName || index} has unresolved status: ${table?.status || 'missing'}`);
      if (['new', 'extend'].includes(table?.status) && (!Array.isArray(table.columns) || table.columns.length === 0)) {
        errors.push(`Dataverse table ${table.logicalName || index} is ${table.status} but has no captured columns; do not create an empty target table`);
      }
    }

    for (const source of (input.dataModelPlan?.unresolvedDataSources || [])) {
      warnings.push(`unresolved data source: ${source.name || '(unnamed)'}${source.screen ? ` on ${source.screen}` : ''}`);
    }
    for (const connector of (input.dataModelPlan?.connectorInventory || [])) {
      if (connector.classification === 'custom' && connector.apiId) {
        errors.push(`source custom connector API ID must be resolved in target: ${connector.name || '(unnamed)'}`);
      }
    }
    for (const requirement of (input.dataModelPlan?.connectionRequirements || [])) {
      if (requirement.classification === 'custom' && requirement.apiId) {
        errors.push(`source custom connector requirement must not carry apiId: ${requirement.connector || requirement.id || '(unnamed)'}`);
      }
    }
    for (const flow of (input.dataModelPlan?.flows || [])) {
      if (flow.id) errors.push(`environment-bound flow id must be resolved in the target: ${flow.name || flow.displayName || '(unnamed)'}`);
      if (!(flow.flowId || flow.id)) warnings.push(`flow needs an ID before generation: ${flow.name || flow.displayName || '(unnamed)'}`);
    }
    scanSecrets(input, 'mobile-plugin-input', errors);
  }

  const behaviorById = new Map();
  const behaviorOrder = new Map();
  if (behaviors) {
    if ((behaviors.stats?.droppedEventActionCount || 0) !== 0) {
      errors.push(`behaviors.json droppedEventActionCount is ${behaviors.stats.droppedEventActionCount}; expected 0`);
    }
    if (!Array.isArray(behaviors.actions)) errors.push('behaviors.actions must be an array');
    const sourceCount = behaviors.stats?.sourceEventActionCount;
    const accountedCount = behaviors.stats?.accountedEventActionCount;
    const droppedCount = behaviors.stats?.droppedEventActionCount || 0;
    if (Number.isFinite(sourceCount) && Number.isFinite(accountedCount) && sourceCount !== accountedCount + droppedCount) {
      errors.push(`behavior event accounting mismatch: source=${sourceCount}, accounted=${accountedCount}, dropped=${droppedCount}`);
    }
    const behaviorIds = new Set();
    const allowedControlFlowKinds = new Set(['if', 'switch', 'ifError', 'forAll', 'with', 'concurrent']);
    for (const group of ['actions', 'visibility', 'validations', 'derivations', 'unmatchedFormulas']) {
      for (const [index, entry] of (behaviors[group] || []).entries()) {
        if (entry.screen && entry.screen !== 'App' && !knownScreens.has(entry.screen)) {
          errors.push(`behaviors.${group}[${index}] references unknown screen: ${entry.screen}`);
        }
        if (group !== 'unmatchedFormulas') {
          if (!/^b-[0-9a-f]{16}$/.test(String(entry.behaviorId || ''))) {
            errors.push(`behaviors.${group}[${index}] has missing/invalid behaviorId`);
          } else if (behaviorIds.has(entry.behaviorId)) {
            errors.push(`duplicate behaviorId: ${entry.behaviorId}`);
          } else {
            behaviorIds.add(entry.behaviorId);
            behaviorById.set(entry.behaviorId, { ...entry, group });
            if (group === 'actions') behaviorOrder.set(entry.behaviorId, index);
          }
        }
        if (group === 'actions' && entry.controlFlow != null && !Array.isArray(entry.controlFlow)) {
          errors.push(`behaviors.${group}[${index}].controlFlow must be an array`);
        }
        if (group === 'actions') {
          for (const [frameIndex, frame] of (entry.controlFlow || []).entries()) {
            if (!allowedControlFlowKinds.has(frame?.kind)) errors.push(`behaviors.${group}[${index}].controlFlow[${frameIndex}].kind is invalid`);
            if (!/^[A-Za-z]+-[0-9a-f]{8}$/.test(String(frame?.id || ''))) errors.push(`behaviors.${group}[${index}].controlFlow[${frameIndex}].id is invalid`);
          }
        }
      }
    }
    scanSecrets(behaviors, 'behaviors', errors);
  }

  if (behaviorContract && behaviors && input) {
    if (behaviorContract.$schema !== 'behavior-contract-v1') errors.push(`unsupported behavior-contract.json schema: ${behaviorContract.$schema || 'missing'}`);
    if (input.behaviorPlan?.schema !== 'behavior-contract-v1') errors.push('mobile-plugin-input behaviorPlan.schema must be behavior-contract-v1');
    if (input.behaviorPlan?.file !== 'behavior-contract.json') errors.push('mobile-plugin-input behaviorPlan.file must be behavior-contract.json');
    if (!behaviorContract.generatedAt || !Number.isFinite(Date.parse(behaviorContract.generatedAt))) {
      errors.push('behavior-contract.generatedAt must be an ISO timestamp');
    }
    const expectedArtifacts = buildBehaviorArtifacts(
      behaviors,
      input.screenPlan?.screens || [],
      behaviorContract.generatedAt || '1970-01-01T00:00:00.000Z',
      coverage
    );
    attachWorkflowRefs(expectedArtifacts, workflowPlan);
    if (canonicalJson(behaviorContract) !== canonicalJson(expectedArtifacts.contract)) {
      errors.push('behavior-contract.json differs from deterministic dependency analysis of behaviors.json');
    }
    if (canonicalJson(input.behaviorPlan?.stats) !== canonicalJson(expectedArtifacts.contract.stats)) {
      errors.push('mobile-plugin-input behaviorPlan.stats differs from behavior-contract.json');
    }
    if (input.behaviorPlan?.appShard !== expectedArtifacts.contract.appShard) {
      errors.push(`mobile-plugin-input behaviorPlan.appShard mismatch: expected ${expectedArtifacts.contract.appShard}`);
    }

    const expectedShardFiles = new Set(expectedArtifacts.shards.keys());
    const shardRoot = path.join(root, 'behavior-shards');
    if (!fs.existsSync(shardRoot) || fs.lstatSync(shardRoot).isSymbolicLink() || !fs.lstatSync(shardRoot).isDirectory()) {
      errors.push('behavior-shards must be a real directory');
    } else {
      for (const entry of fs.readdirSync(shardRoot, { withFileTypes: true })) {
        const relative = `behavior-shards/${entry.name}`;
        if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
          errors.push(`unexpected behavior shard entry: ${relative}`);
        } else if (!expectedShardFiles.has(relative)) {
          errors.push(`unexpected behavior shard file: ${relative}`);
        }
      }
    }
    for (const [relativePath, expectedShard] of expectedArtifacts.shards) {
      const shardPath = safePackagePath(root, relativePath, errors, `behavior shard ${relativePath}`);
      const actualShard = shardPath ? readJson(shardPath, errors, relativePath) : null;
      if (actualShard && canonicalJson(actualShard) !== canonicalJson(expectedShard)) {
        errors.push(`${relativePath} differs from deterministic core-and-intent projection`);
      }
      if (actualShard) {
        scanIntentHintForRawSource(actualShard.intentHints || [], `${relativePath}.intentHints`, errors);
        scanSecrets(actualShard, relativePath, errors);
      }
    }
    for (const screen of input.screenPlan?.screens || []) {
      const expected = expectedArtifacts.contract.shards.find((shard) => shard.screen === screen.name)?.file;
      if (screen.behaviorShard !== expected) errors.push(`screen ${screen.name} behaviorShard mismatch: expected ${expected}`);
    }
    scanIntentHintForRawSource(behaviorContract.intentHints || [], 'behavior-contract.intentHints', errors);
    scanSecrets(behaviorContract, 'behavior-contract', errors);
  } else if (input && !behaviorContract) {
    errors.push('behavior-contract.json is required');
  }

  if (workflowPlan) {
    const workflows = Array.isArray(workflowPlan.workflows) ? workflowPlan.workflows : [];
    if (workflowPlan.$schema !== 'workflow-plan-v1') errors.push(`unsupported workflows.json schema: ${workflowPlan.$schema || 'missing'}`);
    if (!Array.isArray(workflowPlan.workflows)) errors.push('workflows.workflows must be an array');
    if (input?.workflowPlan?.schema !== 'workflow-plan-v1') errors.push('mobile-plugin-input workflowPlan.schema must be workflow-plan-v1');
    if (input?.workflowPlan?.file !== 'workflows.json') errors.push('mobile-plugin-input workflowPlan.file must be workflows.json');

    const allowedDecisionTypes = new Set([
      'partial-failure-policy',
      'retry-policy',
      'batch-failure-policy',
      'async-completion-policy',
      'source-contract',
    ]);
    const workflowPhaseSuffix = new Map([
      ['validate', 'Validate'],
      ['derive-data', 'DeriveData'],
      ['prepare-state', 'PrepareState'],
      ['persist-data', 'PersistData'],
      ['invoke-integration', 'InvokeIntegration'],
      ['persist-local-state', 'PersistLocalState'],
      ['invoke-device-action', 'InvokeDeviceAction'],
      ['complete-workflow', 'CompleteWorkflow'],
      ['source-operation', 'SourceOperation'],
    ]);
    const workflowMutationIntents = new Set(['patch', 'update', 'updateIf', 'remove', 'removeIf', 'submitForm']);
    const workflowExternalIntents = new Set(['connectorCall', 'flowCall', 'aiCall']);
    const workflowStateIntents = new Set(['setVar', 'setContext', 'collect', 'clearCollect', 'clear', 'reset', 'resetForm', 'newForm', 'editForm', 'viewForm', 'setProperty', 'setFocus']);
    const workflowCompletionIntents = new Set(['navigate', 'back', 'notify', 'refresh', 'exitApp', 'requestHide']);
    const phaseForIntent = (intent) => {
      if (intent === 'confirm' || intent === 'predicate-only') return 'validate';
      if (workflowMutationIntents.has(intent)) return 'persist-data';
      if (workflowExternalIntents.has(intent)) return 'invoke-integration';
      if (['read', 'literal', 'projection', 'paramRead'].includes(intent)) return 'derive-data';
      if (workflowStateIntents.has(intent)) return 'prepare-state';
      if (workflowCompletionIntents.has(intent)) return 'complete-workflow';
      if (['saveData', 'loadData', 'clearOfflineData'].includes(intent)) return 'persist-local-state';
      if (['launch', 'download', 'downloadJson', 'print'].includes(intent)) return 'invoke-device-action';
      return 'source-operation';
    };
    const workflowTarget = (action) => {
      if (workflowMutationIntents.has(action?.intent)) return action.source || action.form || null;
      if (action?.intent === 'connectorCall' || action?.intent === 'aiCall') return action.connector || null;
      if (action?.intent === 'flowCall') return action.flow || null;
      if (action?.intent === 'navigate') return action.target || null;
      return null;
    };
    const approvalStatuses = new Set(WORKFLOW_APPROVAL_STATUSES);
    const executionOwners = new Set(WORKFLOW_EXECUTION_OWNERS);
    const uxModes = new Set(WORKFLOW_UX_MODES);
    const requirementIds = new Set((input?.dataModelPlan?.connectionRequirements || []).map((row) => row.id).filter(Boolean));
    const screenFiles = new Map((input?.screenPlan?.screens || []).map((screen) => [screen.name, screen.file]));
    const behaviorClassificationById = new Map((behaviorContract?.classifications || []).map((row) => [row.behaviorId, row]));
    const behaviorHintBySourceId = new Map();
    for (const hint of behaviorContract?.intentHints || []) {
      for (const behaviorId of hint.sourceBehaviorIds || []) behaviorHintBySourceId.set(behaviorId, hint);
    }
    const workflowIds = new Set();
    const handlerKeys = new Set();
    const modulePaths = new Set();
    const mappedBehaviorIds = new Set();

    for (const [workflowIndex, workflow] of workflows.entries()) {
      const at = `workflows.workflows[${workflowIndex}]`;
      if (!/^wf-[0-9a-f]{16}$/.test(String(workflow?.workflowId || ''))) errors.push(`${at}.workflowId is missing or invalid`);
      else if (workflowIds.has(workflow.workflowId)) errors.push(`duplicate workflowId: ${workflow.workflowId}`);
      else workflowIds.add(workflow.workflowId);

      const source = workflow?.source || {};
      if (source.screen !== 'App' && !knownScreens.has(source.screen)) errors.push(`${at}.source.screen references unknown screen: ${source.screen || 'missing'}`);
      if (!validSourceLabel(source.control || '__screen__')) errors.push(`${at}.source.control is unsafe or missing`);
      if (!validSourceLabel(source.event)) errors.push(`${at}.source.event is unsafe or missing`);
      const handlerKey = JSON.stringify([source.screen, source.controlPath || source.control, source.event]);
      if (handlerKeys.has(handlerKey)) errors.push(`${at} duplicates another workflow for the same source event handler`);
      else handlerKeys.add(handlerKey);

      if (workflow?.detection?.pathological !== true || !Array.isArray(workflow?.detection?.reasons) || workflow.detection.reasons.length === 0) {
        errors.push(`${at} must include deterministic pathological-handler evidence`);
      }
      const sourceBehaviorIds = Array.isArray(source.behaviorIds) ? source.behaviorIds : [];
      if (sourceBehaviorIds.length === 0) errors.push(`${at}.source.behaviorIds must not be empty`);
      const expectedCoreBehaviorIds = sourceBehaviorIds.filter((behaviorId) => behaviorClassificationById.get(behaviorId)?.tier === 'core');
      const expectedRegenerableBehaviorIds = sourceBehaviorIds.filter((behaviorId) => behaviorClassificationById.get(behaviorId)?.tier === 'regenerable');
      if (canonicalJson(source.coreBehaviorIds || []) !== canonicalJson(expectedCoreBehaviorIds)) {
        errors.push(`${at}.source.coreBehaviorIds differs from behavior-contract classification`);
      }
      if (canonicalJson(source.regenerableBehaviorIds || []) !== canonicalJson(expectedRegenerableBehaviorIds)) {
        errors.push(`${at}.source.regenerableBehaviorIds differs from behavior-contract classification`);
      }
      for (const behaviorId of sourceBehaviorIds) {
        if (mappedBehaviorIds.has(behaviorId)) errors.push(`behavior is mapped by more than one workflow: ${behaviorId}`);
        else mappedBehaviorIds.add(behaviorId);
      }
      for (const behaviorId of sourceBehaviorIds) {
        const behavior = behaviorById.get(behaviorId);
        if (!behavior || behavior.group !== 'actions') {
          errors.push(`${at} references unknown/non-action behavior: ${behaviorId}`);
          continue;
        }
        if (behavior.screen !== source.screen
            || (behavior.controlPath || behavior.control) !== (source.controlPath || source.control)
            || behavior.event !== source.event) {
          errors.push(`${at} behavior ${behaviorId} does not belong to the declared source handler`);
        }
      }

      const sourceActions = sourceBehaviorIds.map((behaviorId) => behaviorById.get(behaviorId)).filter(Boolean);
      const mutationActions = sourceActions.filter((action) => workflowMutationIntents.has(action.intent));
      const externalActions = sourceActions.filter((action) => workflowExternalIntents.has(action.intent));
      const handlerUnmatched = (behaviors?.unmatchedFormulas || []).filter((entry) =>
        entry?.screen === source.screen
        && (entry.controlPath || entry.control) === (source.controlPath || source.control)
        && entry.property === source.event);
      if (source.unmatchedCount !== handlerUnmatched.length) errors.push(`${at}.source.unmatchedCount mismatch: expected ${handlerUnmatched.length}`);
      const derivedMetrics = {
        classifiedActions: sourceActions.length,
        unmatchedActions: handlerUnmatched.length,
        sourceStatementCount: new Set(sourceActions.map((action) => action.sourceStatementIndex).filter(Number.isInteger)).size,
        formulaLength: Math.max(0, ...sourceActions.map((action) => String(action.sourceFormula || '').length)),
        responsibilityCount: new Set(sourceActions.map((action) => phaseForIntent(action.intent))).size,
        mutationCount: mutationActions.length,
        externalCallCount: externalActions.length,
        remoteSideEffectCount: mutationActions.length + externalActions.length,
        remoteTargets: [...new Set([...mutationActions, ...externalActions].map(workflowTarget).filter(Boolean))].sort(),
        maxControlFlowDepth: Math.max(0, ...sourceActions.map((action) => Array.isArray(action.controlFlow) ? action.controlFlow.length : 0)),
        loopMutationCount: mutationActions.filter((action) => (action.controlFlow || []).some((frame) => frame?.kind === 'forAll')).length,
        concurrentActionCount: sourceActions.filter((action) => (action.controlFlow || []).some((frame) => frame?.kind === 'concurrent')).length,
        errorBoundActionCount: sourceActions.filter((action) => (action.controlFlow || []).some((frame) => frame?.kind === 'ifError')).length,
      };
      for (const [metric, expected] of Object.entries(derivedMetrics)) {
        if (JSON.stringify(workflow?.detection?.metrics?.[metric]) !== JSON.stringify(expected)) {
          errors.push(`${at}.detection.metrics.${metric} mismatch: expected ${JSON.stringify(expected)}`);
        }
      }
      const expectedReasons = [];
      if (derivedMetrics.classifiedActions >= 8) expectedReasons.push('ACTION_COUNT');
      if (derivedMetrics.sourceStatementCount >= 6) expectedReasons.push('STATEMENT_COUNT');
      if (derivedMetrics.formulaLength >= 3000 && derivedMetrics.classifiedActions >= 4) expectedReasons.push('FORMULA_SIZE');
      if (derivedMetrics.classifiedActions >= 5 && derivedMetrics.responsibilityCount >= 4) expectedReasons.push('MIXED_RESPONSIBILITIES');
      if (derivedMetrics.mutationCount >= 2 && (derivedMetrics.externalCallCount >= 1 || derivedMetrics.maxControlFlowDepth >= 2)) expectedReasons.push('MULTI_SYSTEM_SIDE_EFFECTS');
      if (derivedMetrics.loopMutationCount >= 1 && derivedMetrics.classifiedActions >= 4) expectedReasons.push('LOOPED_MUTATION');
      if (derivedMetrics.maxControlFlowDepth >= 3 && derivedMetrics.classifiedActions >= 5) expectedReasons.push('DEEP_CONTROL_FLOW');
      if (JSON.stringify(workflow?.detection?.reasons || []) !== JSON.stringify(expectedReasons)) {
        errors.push(`${at}.detection.reasons mismatch: expected ${JSON.stringify(expectedReasons)}`);
      }
      const expectedScore = derivedMetrics.classifiedActions
        + (derivedMetrics.responsibilityCount * 2)
        + (derivedMetrics.remoteSideEffectCount * 2)
        + (derivedMetrics.maxControlFlowDepth * 2)
        + (derivedMetrics.loopMutationCount * 3)
        + Math.min(5, Math.floor(derivedMetrics.formulaLength / 1000));
      if (workflow?.detection?.score !== expectedScore) errors.push(`${at}.detection.score mismatch: expected ${expectedScore}`);

      const proposal = workflow?.proposal || {};
      if (proposal.architecture !== 'named-step-orchestrator') errors.push(`${at}.proposal.architecture must be named-step-orchestrator`);
      const target = proposal.target || {};
      if (target.implementationOwner !== 'workflow-orchestrator') errors.push(`${at}.proposal.target.implementationOwner must be workflow-orchestrator`);
      if (!validWorkflowModule(target.module)) errors.push(`${at}.proposal.target.module is unsafe or invalid: ${target.module || 'missing'}`);
      else if (modulePaths.has(target.module.toLowerCase())) errors.push(`duplicate workflow target module: ${target.module}`);
      else modulePaths.add(target.module.toLowerCase());
      const expectedImport = typeof target.module === 'string'
        ? `@/${target.module.replace(/^src\//, '').replace(/\.tsx?$/, '')}`
        : '';
      if (target.importPath !== expectedImport) errors.push(`${at}.proposal.target.importPath must match target.module`);
      if (!validTypeScriptIdentifier(target.exportName)) errors.push(`${at}.proposal.target.exportName is invalid`);
      if (!validWorkflowCallSite(target.callSiteFile)) errors.push(`${at}.proposal.target.callSiteFile is unsafe or invalid`);
      const expectedCallSite = source.screen === 'App' ? 'src/bootstrap.ts' : screenFiles.get(source.screen);
      if (expectedCallSite && target.callSiteFile !== expectedCallSite) errors.push(`${at}.proposal.target.callSiteFile must be ${expectedCallSite}`);

      const steps = Array.isArray(proposal.steps) ? proposal.steps : [];
      if (steps.length < 1) errors.push(`${at}.proposal.steps must contain at least one named core step`);
      const stepIds = new Set();
      const stepFunctions = new Set();
      const stepBehaviorIds = [];
      for (const [stepIndex, step] of steps.entries()) {
        const stepAt = `${at}.proposal.steps[${stepIndex}]`;
        if (!/^wfs-[0-9a-f]{16}$/.test(String(step?.stepId || ''))) errors.push(`${stepAt}.stepId is missing or invalid`);
        else if (stepIds.has(step.stepId)) errors.push(`${at} contains duplicate stepId: ${step.stepId}`);
        else stepIds.add(step.stepId);
        if (step?.sequence !== stepIndex + 1) errors.push(`${stepAt}.sequence must be ${stepIndex + 1}`);
        if (!workflowPhaseSuffix.has(step?.phase)) errors.push(`${stepAt}.phase is invalid: ${step?.phase || 'missing'}`);
        if (!validTypeScriptIdentifier(step?.targetFunction)) errors.push(`${stepAt}.targetFunction is invalid`);
        else if (stepFunctions.has(step.targetFunction)) errors.push(`${at} contains duplicate targetFunction: ${step.targetFunction}`);
        else {
          stepFunctions.add(step.targetFunction);
          const expectedFunction = `step${String(stepIndex + 1).padStart(2, '0')}${workflowPhaseSuffix.get(step.phase) || ''}`;
          if (step.targetFunction !== expectedFunction) errors.push(`${stepAt}.targetFunction must be ${expectedFunction}`);
        }
        if (stepIndex === 0 && step?.sourceOrderAfter != null) errors.push(`${stepAt}.sourceOrderAfter must be null for the first step`);
        if (stepIndex > 0 && step?.sourceOrderAfter !== steps[stepIndex - 1]?.stepId) errors.push(`${stepAt}.sourceOrderAfter must reference the preceding step`);
        const ids = Array.isArray(step?.behaviorIds) ? step.behaviorIds : [];
        if (ids.length === 0) errors.push(`${stepAt}.behaviorIds must not be empty`);
        const stepControlFlow = Array.isArray(step?.controlFlow) ? step.controlFlow : [];
        if (!Array.isArray(step?.controlFlow)) errors.push(`${stepAt}.controlFlow must be an array`);
        const expectedKinds = [...new Set(stepControlFlow.map((frame) => frame?.kind).filter(Boolean))].sort();
        const expectedIds = [...new Set(stepControlFlow.map((frame) => frame?.id).filter(Boolean))].sort();
        if (JSON.stringify(step?.controlFlowKinds || []) !== JSON.stringify(expectedKinds)) errors.push(`${stepAt}.controlFlowKinds does not match controlFlow`);
        if (JSON.stringify(step?.controlFlowIds || []) !== JSON.stringify(expectedIds)) errors.push(`${stepAt}.controlFlowIds does not match controlFlow`);
        for (const behaviorId of ids) {
          if (!expectedCoreBehaviorIds.includes(behaviorId)) errors.push(`${stepAt} references non-core or out-of-handler behavior: ${behaviorId}`);
          const behavior = behaviorById.get(behaviorId);
          if (behavior && JSON.stringify(behavior.controlFlow || []) !== JSON.stringify(stepControlFlow)) {
            errors.push(`${stepAt}.controlFlow differs from behavior ${behaviorId}`);
          }
          if (stepBehaviorIds.includes(behaviorId)) errors.push(`${at} maps behavior more than once: ${behaviorId}`);
          stepBehaviorIds.push(behaviorId);
        }
      }
      if (stepBehaviorIds.length !== expectedCoreBehaviorIds.length
          || expectedCoreBehaviorIds.some((behaviorId) => !stepBehaviorIds.includes(behaviorId))) {
        errors.push(`${at} steps must account for every exact core behavior exactly once`);
      }
      const sourceOrder = expectedCoreBehaviorIds.map((behaviorId) => behaviorOrder.get(behaviorId));
      const stepOrder = stepBehaviorIds.map((behaviorId) => behaviorOrder.get(behaviorId));
      if (sourceOrder.length === stepOrder.length && sourceOrder.some((value, index) => value !== stepOrder[index])) {
        errors.push(`${at} step behavior order differs from the source behavior ledger`);
      }
      const expectedIntentHintIds = expectedRegenerableBehaviorIds
        .map((behaviorId) => behaviorHintBySourceId.get(behaviorId)?.hintId)
        .filter(Boolean);
      if (canonicalJson(proposal.intentHintIds || []) !== canonicalJson(expectedIntentHintIds)) {
        errors.push(`${at}.proposal.intentHintIds differs from behavior-contract mapping`);
      }

      const decisions = Array.isArray(workflow?.requiredDecisions) ? workflow.requiredDecisions : [];
      const decisionIds = new Set();
      for (const [decisionIndex, decision] of decisions.entries()) {
        const decisionAt = `${at}.requiredDecisions[${decisionIndex}]`;
        if (!/^wfd-[0-9a-f]{16}$/.test(String(decision?.decisionId || ''))) errors.push(`${decisionAt}.decisionId is missing or invalid`);
        else if (decisionIds.has(decision.decisionId)) errors.push(`${at} contains duplicate decisionId: ${decision.decisionId}`);
        else decisionIds.add(decision.decisionId);
        if (!allowedDecisionTypes.has(decision?.type)) errors.push(`${decisionAt}.type is invalid`);
        if (decision?.requiresUserInput !== true && decision?.requiresUserInput !== false) errors.push(`${decisionAt}.requiresUserInput must be boolean`);
        if (!['choice', 'text'].includes(decision?.answerKind)) errors.push(`${decisionAt}.answerKind is invalid`);
        if (!validSourceLabel(decision?.prompt) || !validSourceLabel(decision?.whyRequired)) errors.push(`${decisionAt} prompt/reason is missing or unsafe`);
        const options = Array.isArray(decision?.options) ? decision.options : [];
        const optionValues = new Set();
        if (decision?.answerKind === 'choice' && options.length < 2) errors.push(`${decisionAt} choice decisions require at least two options`);
        if (decision?.answerKind === 'text' && options.length !== 0) errors.push(`${decisionAt} text decisions must not contain options`);
        for (const option of options) {
          if (!validSourceLabel(option?.value) || !validSourceLabel(option?.label) || !validSourceLabel(option?.effect)) errors.push(`${decisionAt} contains an invalid option`);
          if (optionValues.has(option?.value)) errors.push(`${decisionAt} contains duplicate option value: ${option?.value}`);
          optionValues.add(option?.value);
        }
        if (decision?.recommended != null && !optionValues.has(decision.recommended)) errors.push(`${decisionAt}.recommended must reference an option`);
      }

      const approval = workflow?.approval || {};
      if (!approvalStatuses.has(approval.status)) errors.push(`${at}.approval.status is invalid`);
      const resolutions = Array.isArray(approval.decisions) ? approval.decisions : [];
      const resolutionIds = new Set();
      for (const [resolutionIndex, resolution] of resolutions.entries()) {
        const resolutionAt = `${at}.approval.decisions[${resolutionIndex}]`;
        if (!decisionIds.has(resolution?.decisionId)) errors.push(`${resolutionAt} references unknown decisionId: ${resolution?.decisionId || 'missing'}`);
        if (resolutionIds.has(resolution?.decisionId)) errors.push(`${at} contains duplicate decision resolution: ${resolution?.decisionId}`);
        resolutionIds.add(resolution?.decisionId);
        if (resolution?.status !== 'resolved') errors.push(`${resolutionAt}.status must be resolved`);
        if (!['user', 'ai'].includes(resolution?.resolvedBy)) errors.push(`${resolutionAt}.resolvedBy must be user or ai`);
        if (!validDecisionText(resolution?.value) || !validDecisionText(resolution?.reason, 2000)) errors.push(`${resolutionAt} value/reason is missing, oversized, or unsafe`);
        const decision = decisions.find((entry) => entry.decisionId === resolution?.decisionId);
        if (decision?.requiresUserInput === true && resolution?.resolvedBy !== 'user') errors.push(`${resolutionAt} requires a user answer`);
        if (decision?.answerKind === 'choice' && !decision.options.some((option) => option.value === resolution?.value)) {
          errors.push(`${resolutionAt}.value is not an allowed option`);
        }
      }

      if (approval.status === 'approved') {
        const approvedStepIds = Array.isArray(approval.approvedStepIds) ? approval.approvedStepIds : [];
        if (approvedStepIds.length !== steps.length || steps.some((step) => !approvedStepIds.includes(step.stepId))) {
          errors.push(`${at}.approval.approvedStepIds must contain every proposed step exactly once`);
        }
        if (decisions.some((decision) => !resolutionIds.has(decision.decisionId))) errors.push(`${at} has unresolved correctness-critical decisions`);
        if (!executionOwners.has(approval.executionOwner)) errors.push(`${at}.approval.executionOwner is invalid`);
        if (!uxModes.has(approval.uxMode)) errors.push(`${at}.approval.uxMode is invalid`);
        if (!validSourceLabel(approval.reason)) errors.push(`${at}.approval.reason is required`);
        if (approval.approvedBy !== 'user') errors.push(`${at}.approval.approvedBy must be user`);
        if (!approval.approvedAt || !Number.isFinite(Date.parse(approval.approvedAt))) errors.push(`${at}.approval.approvedAt must be an ISO timestamp`);
        const selectedValues = new Set(resolutions.map((resolution) => resolution.value));
        const needsServer = ['server-transaction', 'whole-workflow-idempotency', 'server-batch']
          .some((value) => selectedValues.has(value));
        if (needsServer) {
          if (approval.executionOwner !== 'server-orchestrator') errors.push(`${at} selected a server policy but executionOwner is not server-orchestrator`);
          if (!approval.serverDependency?.connectionRequirementId
              || !requirementIds.has(approval.serverDependency.connectionRequirementId)) {
            errors.push(`${at} selected a server policy without a valid serverDependency connection requirement`);
          }
        }
        if (selectedValues.has('compensate-client') && !validDecisionText(approval.compensationPlan)) {
          errors.push(`${at} selected client compensation without an explicit compensationPlan`);
        }
        if (selectedValues.has('block')) errors.push(`${at} cannot be approved with a blocking decision`);
      }
      if (approval.status === 'blocked' && !validSourceLabel(approval.reason)) errors.push(`${at}.approval.reason is required when blocked`);
      if (args.requireWorkflowApproval) {
        if (approval.status === 'pending') errors.push(`${at} still requires explicit workflow approval`);
        if (approval.status === 'blocked') errors.push(`${at} is a hard workflow blocker`);
      }
    }

    const derivedWorkflowStats = deriveWorkflowStats(workflows, {
      handlersScanned: workflowPlan.stats?.handlersScanned,
      handlersSkippedUnclassified: workflowPlan.stats?.handlersSkippedUnclassified,
    });
    for (const [key, value] of Object.entries(derivedWorkflowStats)) {
      if (JSON.stringify(workflowPlan.stats?.[key]) !== JSON.stringify(value)) {
        errors.push(`workflows.stats.${key} mismatch: expected ${JSON.stringify(value)}`);
      }
      if (JSON.stringify(input?.workflowPlan?.stats?.[key]) !== JSON.stringify(value)) {
        errors.push(`mobile-plugin-input workflowPlan.stats.${key} mismatch: expected ${JSON.stringify(value)}`);
      }
    }
    scanSecrets(workflowPlan, 'workflows', errors);
  }

  if (coverage) {
    if (coverage.$schema !== 'control-intent-coverage-v1') errors.push(`unsupported control-intent coverage schema: ${coverage.$schema || 'missing'}`);
    if (!Array.isArray(coverage.rows)) errors.push('control-intent-coverage.rows must be an array');
    const expected = coverage.stats?.totalControls;
    if (Number.isFinite(expected) && expected !== coverage.rows?.length) {
      errors.push(`control intent row count mismatch: stats=${expected}, rows=${coverage.rows?.length || 0}`);
    }
    if (input?.controlIntentCoverage?.file !== 'control-intent-coverage.json') {
      errors.push('mobile-plugin-input controlIntentCoverage.file must be control-intent-coverage.json');
    }
    if (input?.controlIntentCoverage?.schema !== 'control-intent-coverage-v1') {
      errors.push('mobile-plugin-input controlIntentCoverage.schema must be control-intent-coverage-v1');
    }
    if (canonicalJson(input?.controlIntentCoverage?.stats) !== canonicalJson(coverage.stats)) {
      errors.push('mobile-plugin-input controlIntentCoverage.stats differs from control-intent-coverage.json');
    }
    for (const [index, row] of (coverage.rows || []).entries()) {
      if (!validSourceLabel(row?.role)) errors.push(`control-intent-coverage.rows[${index}].role is missing or unsafe`);
      if (!row?.roleEvidence || typeof row.roleEvidence !== 'object') {
        errors.push(`control-intent-coverage.rows[${index}].roleEvidence is missing`);
      } else if (!Array.isArray(row.roleEvidence.signals)) {
        errors.push(`control-intent-coverage.rows[${index}].roleEvidence.signals must be an array`);
      }
    }
    for (const row of (coverage.rows || []).filter((entry) => entry.businessRisk === 'high')) {
      const accounted = row.nativeSuggestion || row.nativeHints?.length || /unsupported/i.test(String(row.support || ''));
      if (!accounted) errors.push(`high-risk control lacks native/unsupported strategy: ${row.screen}/${row.control}`);
    }
    if (pcfPlan) {
      try {
        const projected = projectPcfControlIntents(coverage, pcfPlan);
        if (canonicalJson(projected) !== canonicalJson(coverage)) {
          errors.push('PCF control-intent projection is stale; run sync-pcf-control-intents.js after Gate 2b approval changes');
        }
      } catch (error) {
        errors.push(`PCF control-intent projection is invalid: ${error.message}`);
      }
    }
    scanSecrets(coverage, 'control-intent-coverage', errors);
  }

  if (pcfPlan) {
    const allowedDispositions = new Set(['native-replacement', 'server-dependency', 'explicit-unsupported', 'blocker']);
    const allowedStatuses = new Set(['pending', 'approved', 'blocked']);
    const controls = Array.isArray(pcfPlan.controls) ? pcfPlan.controls : [];
    if (!Array.isArray(pcfPlan.controls)) errors.push('pcf-plan.controls must be an array');
    const coveragePcfs = (coverage?.rows || []).filter((row) => row?.flags?.isPcf);
    if (controls.length !== coveragePcfs.length) {
      errors.push(`PCF accounting mismatch: pcf-plan=${controls.length}, control coverage=${coveragePcfs.length}`);
    }
    if (input?.pcfPlan?.stats?.total !== controls.length) {
      errors.push(`pcfPlan.stats.total mismatch: input=${input?.pcfPlan?.stats?.total}, rows=${controls.length}`);
    }
    const sourceSignals = pcfPlan.discovery?.sourceSignals || {};
    const sourceIndicatesPcf = sourceSignals.containsThirdPartyPcfControls === true
      || Number(sourceSignals.extractedPackageCount || 0) > 0
      || Number(sourceSignals.extractedControlCount || 0) > 0;
    const discoveryComplete = pcfPlan.discovery?.complete === true;
    if (pcfPlan.stats?.discoveryComplete !== discoveryComplete || input?.pcfPlan?.stats?.discoveryComplete !== discoveryComplete) {
      errors.push(`PCF discovery summary mismatch: expected discoveryComplete=${discoveryComplete}`);
    }
    if (sourceIndicatesPcf && controls.length === 0) {
      const message = 'source reports PCF content but per-control PCF discovery is incomplete';
      if (args.requirePcfApproval) errors.push(message);
      else warnings.push(message);
    }
    if (!discoveryComplete) {
      if (!Array.isArray(pcfPlan.discovery?.blockers) || pcfPlan.discovery.blockers.length === 0) {
        errors.push('incomplete PCF discovery must include a discovery blocker');
      }
      if (args.requirePcfApproval) errors.push('PCF discovery is incomplete and blocks generation');
    }
    const requirementIds = new Set((input?.dataModelPlan?.connectionRequirements || []).map((row) => row.id).filter(Boolean));
    const ids = new Set();
    for (const [index, row] of controls.entries()) {
      const at = `pcf-plan.controls[${index}]`;
      if (!/^pcf-[0-9a-f]{16}$/.test(String(row.pcfId || ''))) errors.push(`${at}.pcfId is missing or invalid`);
      else if (ids.has(row.pcfId)) errors.push(`duplicate PCF ID: ${row.pcfId}`);
      else ids.add(row.pcfId);
      if (!knownScreens.has(row.screen)) errors.push(`${at}.screen references unknown screen: ${row.screen}`);
      const matchingCoverage = coveragePcfs.find((entry) =>
        entry.path === row.path
        && entry.screen === row.screen
        && entry.control === row.control);
      if (!matchingCoverage) errors.push(`${at} has no matching PCF control-intent row: ${row.screen}/${row.path}`);
      if (!allowedDispositions.has(row.proposal?.disposition)) errors.push(`${at}.proposal.disposition is invalid`);
      if (!allowedStatuses.has(row.approval?.status)) errors.push(`${at}.approval.status is invalid`);

      const approval = row.approval || {};
      if (approval.status === 'approved') {
        if (!allowedDispositions.has(approval.disposition)) errors.push(`${at}.approval.disposition is invalid`);
        if (!['essential', 'optional'].includes(approval.essentiality)) errors.push(`${at}.approval.essentiality must be essential or optional`);
        if (!approval.reason || typeof approval.reason !== 'string') errors.push(`${at}.approval.reason is required`);
        if (approval.approvedBy !== 'user') errors.push(`${at}.approval.approvedBy must be user`);
        if (!approval.approvedAt || !Number.isFinite(Date.parse(approval.approvedAt))) errors.push(`${at}.approval.approvedAt must be an ISO timestamp`);
        if (approval.disposition === 'blocker') errors.push(`${at} cannot approve a blocker for generation`);
        if (approval.disposition === 'native-replacement') {
          if (!approval.targetStrategy?.primitive) errors.push(`${at} native replacement requires targetStrategy.primitive`);
          if (!Array.isArray(approval.targetStrategy?.packages)) errors.push(`${at} native replacement requires targetStrategy.packages`);
          for (const packageName of approval.targetStrategy?.packages || []) {
            if (typeof packageName !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i.test(packageName)) {
              errors.push(`${at} contains unsafe/invalid native package name: ${packageName}`);
            }
          }
        }
        if (approval.disposition === 'server-dependency') {
          const dependencies = approval.targetStrategy?.dependencies;
          if (!Array.isArray(dependencies) || dependencies.length === 0) errors.push(`${at} server dependency requires targetStrategy.dependencies`);
          for (const dependency of dependencies || []) {
            if (!dependency.connectionRequirementId || !requirementIds.has(dependency.connectionRequirementId)) {
              errors.push(`${at} references unknown connection requirement: ${dependency.connectionRequirementId || 'missing'}`);
            }
          }
        }
        if (approval.disposition === 'explicit-unsupported') {
          if (approval.essentiality !== 'optional') errors.push(`${at} explicit unsupported is allowed only for user-approved optional PCFs`);
          if (!approval.unsupportedUx || typeof approval.unsupportedUx !== 'string') errors.push(`${at} explicit unsupported requires visible unsupportedUx copy`);
        }
      }
      if (approval.status === 'blocked' && approval.disposition !== 'blocker') {
        errors.push(`${at} blocked approval must use blocker disposition`);
      }
      if (args.requirePcfApproval) {
        if (approval.status === 'pending') errors.push(`${at} still requires explicit PCF approval`);
        if (approval.status === 'blocked' || approval.disposition === 'blocker') errors.push(`${at} is a hard PCF blocker`);
      }
    }
    const derivedPcfStats = derivePcfStats(pcfPlan);
    for (const key of ['pendingApproval', 'approved', 'blocked']) {
      if (pcfPlan.stats?.[key] !== derivedPcfStats[key]) errors.push(`pcf-plan.stats.${key} mismatch: expected ${derivedPcfStats[key]}`);
      if (input?.pcfPlan?.stats?.[key] !== derivedPcfStats[key]) errors.push(`mobile-plugin-input pcfPlan.stats.${key} mismatch: expected ${derivedPcfStats[key]}`);
    }
    for (const disposition of allowedDispositions) {
      if (pcfPlan.stats?.byDisposition?.[disposition] !== derivedPcfStats.byDisposition[disposition]) {
        errors.push(`pcf-plan.stats.byDisposition.${disposition} mismatch: expected ${derivedPcfStats.byDisposition[disposition]}`);
      }
      if (input?.pcfPlan?.stats?.byDisposition?.[disposition] !== derivedPcfStats.byDisposition[disposition]) {
        errors.push(`mobile-plugin-input pcfPlan.stats.byDisposition.${disposition} mismatch: expected ${derivedPcfStats.byDisposition[disposition]}`);
      }
      if (pcfPlan.stats?.proposed?.[disposition] !== derivedPcfStats.proposed[disposition]) {
        errors.push(`pcf-plan.stats.proposed.${disposition} mismatch: expected ${derivedPcfStats.proposed[disposition]}`);
      }
      if (input?.pcfPlan?.stats?.proposed?.[disposition] !== derivedPcfStats.proposed[disposition]) {
        errors.push(`mobile-plugin-input pcfPlan.stats.proposed.${disposition} mismatch: expected ${derivedPcfStats.proposed[disposition]}`);
      }
    }
    scanSecrets(pcfPlan, 'pcf-plan', errors);
  }

  if (serverSideAssets) scanSecrets(serverSideAssets, 'server-side-assets', errors);
  for (const optional of ['flows.json', 'localization.json', 'assets.json']) {
    const file = path.join(root, optional);
    if (fs.existsSync(file)) scanSecrets(readJson(file, errors, optional), optional.replace(/\.json$/, ''), errors);
  }
  const markdownState = { count: 0, exceeded: false };
  scanMarkdownTree(path.join(root, 'native-app-plan.md'), 'native-app-plan.md', errors, markdownState);
  scanMarkdownTree(path.join(root, 'screens'), 'screens', errors, markdownState);
  scanMarkdownTree(path.join(root, 'state'), 'state', errors, markdownState);
  for (const optional of ['requirements-brief.md', 'components.md', 'migration-checklist.md']) {
    scanMarkdownTree(path.join(root, optional), optional, errors, markdownState);
  }

  const result = {
    ok: errors.length === 0,
    packageDir: root,
    app: input?.app?.name || null,
    screens: input?.screenPlan?.screens?.length || 0,
    tables: input?.dataModelPlan?.dataverseTables?.length || 0,
    connectors: input?.dataModelPlan?.connectionRequirements?.length || 0,
    behaviors: behaviors?.actions?.length || 0,
    totalBehaviors: behaviorContract?.stats?.totalBehaviors || 0,
    coreBehaviors: behaviorContract?.stats?.coreBehaviors || 0,
    regenerableBehaviors: behaviorContract?.stats?.regenerableBehaviors || 0,
    controls: coverage?.rows?.length || 0,
    pcfs: pcfPlan?.controls?.length || 0,
    pcfDiscoveryComplete: pcfPlan?.discovery?.complete !== false,
    workflows: workflowPlan?.workflows?.length || 0,
    workflowDecisionsUnresolved: workflowPlan?.stats?.unresolvedDecisions || 0,
    errors,
    warnings,
  };

  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Migration package: ${result.ok ? 'VALID' : 'INVALID'}\n`);
    process.stdout.write(`App: ${result.app || '(unknown)'} | screens ${result.screens} | tables ${result.tables} | connectors ${result.connectors} | behaviors ${result.totalBehaviors} (${result.coreBehaviors} core / ${result.regenerableBehaviors} intent) | controls ${result.controls} | PCFs ${result.pcfs} | workflows ${result.workflows}\n`);
    warnings.forEach((warning) => process.stdout.write(`WARN: ${warning}\n`));
    errors.forEach((error) => process.stderr.write(`ERROR: ${error}\n`));
  }

  process.exitCode = result.ok ? 0 : 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`Validation failed: ${error.message}\n`);
  process.exit(1);
}

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
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MARKDOWN_ENTRIES = 10000;
const MAX_MARKDOWN_DEPTH = 8;

function parseArgs(argv) {
  const args = { dir: '', json: false, requirePcfApproval: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i] || '';
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--require-pcf-approval') args.requirePcfApproval = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: node scripts/validate-mobile-plugin-input.js --dir <mobile-plugin-input-dir> [--json] [--require-pcf-approval]\n');
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

function validSourceLabel(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
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
  let pcfPlan = null;

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
          }
        }
      }
    }
    scanSecrets(behaviors, 'behaviors', errors);
  }

  if (coverage) {
    if (!Array.isArray(coverage.rows)) errors.push('control-intent-coverage.rows must be an array');
    const expected = coverage.stats?.totalControls;
    if (Number.isFinite(expected) && expected !== coverage.rows?.length) {
      errors.push(`control intent row count mismatch: stats=${expected}, rows=${coverage.rows?.length || 0}`);
    }
    for (const row of (coverage.rows || []).filter((entry) => entry.businessRisk === 'high')) {
      const accounted = row.nativeSuggestion || row.nativeHints?.length || /unsupported/i.test(String(row.support || ''));
      if (!accounted) errors.push(`high-risk control lacks native/unsupported strategy: ${row.screen}/${row.control}`);
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
    const derivedPcfStats = {
      pendingApproval: controls.filter((row) => row.approval?.status === 'pending').length,
      approved: controls.filter((row) => row.approval?.status === 'approved').length,
      blocked: controls.filter((row) => row.approval?.status === 'blocked').length,
      byDisposition: Object.fromEntries([...allowedDispositions].map((disposition) => [
        disposition,
        controls.filter((row) => row.approval?.disposition === disposition).length,
      ])),
    };
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
    controls: coverage?.rows?.length || 0,
    pcfs: pcfPlan?.controls?.length || 0,
    pcfDiscoveryComplete: pcfPlan?.discovery?.complete !== false,
    errors,
    warnings,
  };

  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Migration package: ${result.ok ? 'VALID' : 'INVALID'}\n`);
    process.stdout.write(`App: ${result.app || '(unknown)'} | screens ${result.screens} | tables ${result.tables} | connectors ${result.connectors} | behaviors ${result.behaviors} | controls ${result.controls} | PCFs ${result.pcfs}\n`);
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

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { inside, readJson, atomicWrite, revision, assertRevision } = require('./prototype-files');
const { sha256Hex } = require('./product-experience-contracts');
const { validateDomain, validateBindings, projectFixtures } = require('./prototype-domain');
const { validateRules } = require('./authoring-rules');
const { validateConnectorSelection, environmentId } = require('./prototype-connections');
const { validatePersistenceArtifacts } = require('../compile-persistence-contract');

const STATE = '.tmp/prototype-connector-startup.json';
const PENDING = '.tmp/prototype-connector-pending.json';
const PROFILE = '.tmp/prototype-profile.json';
const MANIFEST = '.tmp/prototype-generated.json';
const REGISTRY = '.tmp/data-access-registry.json';
const CONFIG = 'src/data/connector-startup.json';
const PROVIDER = 'src/data/PrototypeConnectorProvider.tsx';
const BOUNDARY = 'src/data/ConnectorPreviewBoundary.tsx';
const ROOT = 'app/_layout.tsx';
const AUTH_ROUTES = ['app/login.tsx', 'app/oauth-callback.tsx'];
const WRITABLE = new Set([STATE, PROFILE, MANIFEST, REGISTRY, CONFIG, PROVIDER, BOUNDARY, ROOT, ...AUTH_ROUTES, 'package.json']);

function readText(root, file) {
  const target = inside(root, file);
  if (!fs.statSync(target).isFile() || fs.statSync(target).size > 4 * 1024 * 1024) throw new Error(`Expected bounded regular file: ${file}`);
  return fs.readFileSync(target, 'utf8');
}

function dataPreview(value) {
  if (!value || !['active', 'candidate'].includes(value.previewKind)
    || Object.keys(value).some((key) => !['previewKind', 'dataNamespace', 'baseDataNamespace'].includes(key))) {
    throw new Error('An explicit typed data preview is required');
  }
  for (const name of ['dataNamespace', 'baseDataNamespace']) {
    if (name === 'baseDataNamespace' && value[name] === undefined) continue;
    if (typeof value[name] !== 'string' || value[name].length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value[name])
      || /[\r\n]/.test(value[name])) throw new Error('Invalid connector preview data namespace');
  }
  if (value.previewKind === 'candidate' && (value.dataNamespace === 'active' || value.dataNamespace === (value.baseDataNamespace || 'active'))) {
    throw new Error('Connector candidate local data must be isolated from active data');
  }
  return structuredClone(value);
}

function normalizeApi(value) {
  if (typeof value !== 'string') throw new Error('Official connector reference has no API ID');
  const name = value.replace(/^\/providers\/Microsoft\.PowerApps\/apis\//i, '');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(name) || /[\r\n]/.test(name)) throw new Error('Invalid official connector API ID');
  return name;
}

function verifyLocalOutputs(root, manifest) {
  if (manifest.schemaVersion !== 1 || !manifest.files?.['src/data/runtime.ts']) throw new Error('Existing local repository ownership is required');
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!file.startsWith('src/data/') || sha256Hex(readText(root, file)) !== hash) throw new Error(`Compiler-owned local source changed: ${file}`);
  }
}

function generatedSchemas(root, requireFromApp, source) {
  const ts = requireFromApp('typescript');
  const parsed = ts.createSourceFile('connectorSchemas.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length) throw new Error('Official connector schemaMap must parse');
  const declarations = parsed.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'schemaMap');
  let value = declarations.length === 1 ? declarations[0].initializer : null;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
  if (!value || !ts.isObjectLiteralExpression(value)) throw new Error('Official schemaMap needs its generated static source-name projection');
  const imports = new Map(parsed.statements.filter(ts.isImportDeclaration)
    .filter((statement) => statement.importClause?.name)
    .map((statement) => [statement.importClause.name.text, statement.moduleSpecifier.text]));
  const revisions = [];
  const names = value.properties.map((property) => {
    if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      throw new Error('Unsupported generated schemaMap source key');
    }
    const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    const imported = ts.isIdentifier(initializer) ? imports.get(initializer.text) : null;
    if (!imported || !imported.startsWith('.')) throw new Error('Official schemaMap values must use generated JSON imports');
    const file = path.posix.normalize(path.posix.join('src/generated', imported));
    if (!file.startsWith('.power/schemas/') || !file.endsWith('.json')) throw new Error('Official schemaMap import escapes its schema directory');
    const schema = readJson(root, file);
    const runtime = new URL(schema.properties?.primaryRuntimeUrl);
    if (typeof schema.name !== 'string' || !schema.name || runtime.protocol !== 'https:' || runtime.username || runtime.password || runtime.search || runtime.hash) {
      throw new Error('Official connector schema requires its valid runtime endpoint');
    }
    revisions.push({ file, hash: sha256Hex(readText(root, file)) });
    return property.name.text;
  });
  return { names, revision: revision(revisions.sort((a, b) => a.file.localeCompare(b.file))) };
}

function inputs(root) {
  const domain = validateDomain(readJson(root, '.tmp/prototype-domain.json'));
  const bindings = readJson(root, '.tmp/prototype-bindings.json');
  const rules = validateRules(domain, readJson(root, '.tmp/prototype-rules.json'));
  const persistence = assertRevision(readJson(root, '.tmp/persistence-contract.json'), 'persistenceRevision', 'Persistence contract');
  const facts = assertRevision(readJson(root, '.tmp/scenario-facts.json'), 'scenarioRevision', 'Scenario facts');
  const registry = assertRevision(readJson(root, REGISTRY), 'registryRevision', 'Data-access registry');
  const manifest = readJson(root, MANIFEST);
  const profile = readJson(root, PROFILE);
  if (!['prototype', 'connector'].includes(profile.profile) || domain.appInstanceId.length !== 36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(domain.appInstanceId)
    || profile.appInstanceId !== domain.appInstanceId
    || readJson(root, 'app.json').expo?.extra?.telemetry?.appInstanceId !== domain.appInstanceId) throw new Error('Connector startup requires the existing prototype identity');
  const connectorOwners = persistence.conceptOwners.filter((entry) => /^connector:[a-z0-9][a-z0-9-]*$/.test(entry.owner));
  const expectedMode = connectorOwners.length ? 'connector-only' : 'local-prototype';
  if (persistence.mode !== expectedMode || !Array.isArray(persistence.dataverseConceptIds) || persistence.dataverseConceptIds.length
    || !Array.isArray(persistence.connectorConceptIds) || persistence.connectorConceptIds.length !== connectorOwners.length
    || persistence.conceptOwners.some((entry) => !['local', 'transient'].includes(entry.owner) && !connectorOwners.includes(entry))) {
    throw new Error('Retained-local connector startup requires compiler-derived persistence mode and no Dataverse owners');
  }
  const artifacts = validatePersistenceArtifacts(root, persistence);
  if (!artifacts.ok) throw new Error(artifacts.errors.map((error) => error.message).join('; '));
  validateBindings(domain, bindings, persistence);
  if (facts.persistenceRevision !== persistence.persistenceRevision || facts.scopeRevision !== persistence.scopeRevision) {
    throw new Error('Approve and rebind canonical scenario facts to the selected persistence contract first');
  }
  if (registry.mode !== 'local-prototype' || registry.contractType !== 'data-access-registry'
    || registry.entities.some((entry) => !['local', 'transient'].includes(entry.owner))) throw new Error('Connector startup must retain the local repository registry');
  const stable = { domain: revision(domain), bindings: revision(bindings), rules: revision(rules) };
  for (const [key, value] of Object.entries(stable)) {
    if (registry.inputRevisions?.[key] !== value || manifest.inputRevisions?.[key] !== value) {
      throw new Error(`Connector startup cannot change local ${key}`);
    }
  }
  verifyLocalOutputs(root, manifest);
  const fixtureSource = readText(root, 'src/data/fixtures.ts').match(/export const fixtures = ([\s\S]+);\s*$/);
  if (!fixtureSource || revision(JSON.parse(fixtureSource[1]).entities) !== revision(projectFixtures(domain, bindings, facts).entities)) {
    throw new Error('Connector startup cannot replace local fixture records or media');
  }
  const powerConfig = readJson(root, 'power.config.json');
  const selectedEnvironment = environmentId(powerConfig.environmentId);
  if (Object.keys(powerConfig.databaseReferences || {}).length) throw new Error('Connector-only startup cannot enable Dataverse database references');
  const auth = readJson(root, 'auth.config.json').msal;
  for (const field of ['clientId', 'tenantId']) {
    if (typeof auth?.[field] !== 'string' || auth[field].length !== 36 || environmentId(auth[field]).length !== 36) {
      throw new Error('Real auth client and tenant IDs must be configured before enabling connector startup');
    }
  }
  const pkg = readJson(root, 'package.json');
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../../template/package.json'), 'utf8'));
  if (profile.templateRevision !== revision(template)) throw new Error('The prototype belongs to another template revision');
  for (const dependency of ['expo', 'react', 'react-native', '@microsoft/power-apps-native-host', '@tanstack/react-query']) {
    if (pkg.dependencies?.[dependency] !== template.dependencies[dependency]) throw new Error(`Unsupported connector startup dependency: ${dependency}; no versions were changed`);
  }
  const requireFromApp = createRequire(path.join(path.resolve(root), 'package.json'));
  for (const name of ['expoConfig', 'metroConfig', 'babelConfig', 'tamaguiConfig', 'tsconfig']) requireFromApp.resolve(`@microsoft/power-apps-native-host/config/${name}`);
  const schemas = readText(root, 'src/generated/connectorSchemas.ts');
  if (!/\bexport\s+(?:const|let)\s+schemaMap\b/.test(schemas)) throw new Error('Official connector schemaMap generation must finish first');
  const generated = generatedSchemas(root, requireFromApp, schemas);
  return {
    domain, persistence, facts, registry, manifest, profile, powerConfig, selectedEnvironment, pkg,
    schemaNames: generated.names,
    inputRevisions: {
      ...manifest.inputRevisions, ...stable, persistence: persistence.persistenceRevision, scenario: facts.scenarioRevision,
      connectorSchemas: generated.revision, connectorConfig: sha256Hex(readText(root, 'power.config.json')),
    },
  };
}

function selectedBinding(current, catalog, selection, connectorName, localRefId) {
  const selected = validateConnectorSelection(catalog, selection);
  if (selected.environmentId !== current.selectedEnvironment) throw new Error('Connector startup cannot switch the initialized environment');
  if (['shared_commondataservice', 'shared_commondataserviceforapps', 'shared_logicflows', 'shared_excel'].includes(selected.apiId)) {
    throw new Error('This connector requires its separately approved specialized runtime workflow');
  }
  if (!current.persistence.connectors.some((entry) => entry.apiName === connectorName)) {
    throw new Error('Explicit connectorName must bind an approved connector decision');
  }
  const references = Object.entries(current.powerConfig.connectionReferences || {})
    .filter(([, entry]) => entry && normalizeApi(entry.id) === selected.apiId);
  const referenceId = localRefId || selected.connectionRef || (references.length === 1 ? references[0][0] : null);
  const reference = references.find(([id]) => id === referenceId)?.[1];
  if (typeof referenceId !== 'string' || referenceId.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(referenceId)
    || Object.hasOwn(Object.prototype, referenceId) || referenceId === 'prototype'
    || !reference || (selected.connectionRef && referenceId !== selected.connectionRef)
    || !Array.isArray(reference.dataSources) || !reference.dataSources.length
    || reference.dataSources.some((name) => typeof name !== 'string' || !name || !current.schemaNames.includes(name))) {
    throw new Error('Select the exact official localRefId/dataSources; ambiguous or replaced references are not allowed');
  }
  return {
    connectorName, localRefId: referenceId, apiId: selected.apiId, connectionId: selected.discoveryConnectionId,
    ...(selected.connectionRef ? { connectionRef: selected.connectionRef } : {}), catalogRevision: selected.catalogRevision,
  };
}

function providerSource() {
  return `import { useEffect, type ComponentProps, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PowerAppsProvider } from '@microsoft/power-apps-native-host';
import appConfig from '../../app.json';
import authConfig from '../../auth.config.json';
import powerConfig from '../../power.config.json';
import tamaguiConfig from '../../tamagui.config';
import { schemaMap } from '../generated/connectorSchemas';
import startup from './connector-startup.json';
import { getDataRuntime } from './runtime';

type HostConfig = ComponentProps<typeof PowerAppsProvider>['powerConfig'];
const officialConfig: HostConfig = powerConfig;
if (officialConfig.environmentId?.toLowerCase() !== startup.environmentId || Object.keys(officialConfig.databaseReferences ?? {}).length) {
  throw new Error('Connector-only startup cannot change environment or enable Dataverse.');
}
const references = { ...officialConfig.connectionReferences };
for (const binding of startup.bindings) {
  const source = references[binding.localRefId];
  if (!source || source.id.replace(/^\\/providers\\/Microsoft\\.PowerApps\\/apis\\//i, '') !== binding.apiId
    || !source.dataSources.length || !source.dataSources.every((name) => Object.hasOwn(schemaMap, name))) {
    throw new Error('The approved connector binding no longer matches official generated configuration.');
  }
  references[binding.localRefId] = { ...source, sharedConnectionId: binding.connectionId };
}
const runtimeConfig: HostConfig = { ...officialConfig, connectionReferences: references };
function LocalRepositorySubscriptions({ children }: PropsWithChildren) {
  const client = useQueryClient();
  useEffect(() => {
    const runtime = getDataRuntime();
    return runtime.subscribe((entityId) => {
      void client.invalidateQueries({ queryKey: ['domain', runtime.namespace, entityId] });
    });
  }, [client]);
  return children;
}
export function PrototypeConnectorProvider({ children }: PropsWithChildren) {
  const colorScheme = useColorScheme();
  if (!__DEV__) throw new Error('Retained local prototype data is development-only, not a production authentication mode.');
  return (
    <SafeAreaProvider>
      <PowerAppsProvider appConfig={appConfig} msalConfig={authConfig.msal} powerConfig={runtimeConfig}
        schemaMap={schemaMap} tamaguiConfig={tamaguiConfig} defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}>
        <LocalRepositorySubscriptions>{children}</LocalRepositorySubscriptions>
      </PowerAppsProvider>
    </SafeAreaProvider>
  );
}
`;
}

function boundarySource() {
  return `import type { PropsWithChildren } from 'react';
import type { DataPreview } from './contracts';
import { configureDataPreview } from './runtime';
import startup from './connector-startup.json';

let prepared = false;
// This outer fallback runs before the root. Player's AuthoringProvider may
// replace it with the verified publisher selection before mounting any data.
export function ConnectorPreviewBoundary({ children }: PropsWithChildren) {
  if (!prepared) {
    configureDataPreview(startup.preview as DataPreview);
    prepared = true;
  }
  return children;
}
`;
}

function wireRoot(root, source, alreadyConnected) {
  const ts = createRequire(path.join(path.resolve(root), 'package.json'))('typescript');
  const parsed = ts.createSourceFile(ROOT, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (parsed.parseDiagnostics.length) throw new Error('The current root must parse before connector startup is changed');
  const imports = parsed.statements.filter(ts.isImportDeclaration);
  const componentImport = (component, suffix) => imports.flatMap((node) => {
    const names = node.importClause?.namedBindings;
    return node.moduleSpecifier.text.endsWith(suffix) && names && ts.isNamedImports(names)
      ? names.elements.filter((entry) => (entry.propertyName?.text || entry.name.text) === component) : [];
  });
  const localImports = alreadyConnected
    ? componentImport('PrototypeConnectorProvider', '/data/PrototypeConnectorProvider')
    : componentImport('PrototypeProvider', '/data/PrototypeProvider');
  const authoringImports = componentImport('AuthoringProvider', '/authoring');
  if (process.env.MOBILE_AUTHORING_CONTEXT || authoringImports.length) {
    if (authoringImports.length !== 1 || localImports.length !== 1) throw new Error('Player connector startup requires the existing outer AuthoringProvider');
    const localName = localImports[0].name.text;
    const authoringName = authoringImports[0].name.text;
    const protectedComponent = require('./prototype-authoring').rootContent(ts, parsed);
    let found = false;
    let unsafe = false;
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === localName) {
        found = true;
        let ancestor = node.parent.parent;
        while (ancestor && !(ts.isJsxElement(ancestor) && ancestor.openingElement.tagName.getText(parsed) === authoringName)) ancestor = ancestor.parent;
        const configuration = ancestor?.openingElement.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === 'configureDataPreview');
        let owner = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        const protectedChild = protectedComponent && owner === protectedComponent;
        if (!protectedChild && (!configuration?.initializer || !ts.isJsxExpression(configuration.initializer)
          || configuration.initializer.expression?.getText(parsed) !== 'configureDataPreview')) unsafe = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (!found || unsafe) throw new Error('AuthoringProvider must configure the namespace before the local provider mounts');
  }
  if (alreadyConnected) {
    const boundaryImports = componentImport('ConnectorPreviewBoundary', '/data/ConnectorPreviewBoundary');
    const wrappers = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
    const statement = wrappers.length === 1 && wrappers[0].body?.statements.length === 1 ? wrappers[0].body.statements[0] : null;
    let expression = statement && ts.isReturnStatement(statement) ? statement.expression : null;
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!imports.some((node) => /\/data\/PrototypeConnectorProvider$/.test(node.moduleSpecifier.text))
      || boundaryImports.length !== 1 || !expression || !ts.isJsxElement(expression)
      || expression.openingElement.tagName.getText(parsed) !== boundaryImports[0].name.text) {
      throw new Error('The connected local root lost its provider or outer preview boundary');
    }
    return source;
  }
  const provider = imports.filter((node) => /\/data\/PrototypeProvider$/.test(node.moduleSpecifier.text));
  const defaults = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  const elements = provider[0]?.importClause?.namedBindings;
  const binding = elements && ts.isNamedImports(elements) && elements.elements.length === 1 ? elements.elements[0] : null;
  const original = defaults[0];
  if (provider.length !== 1 || !binding || (binding.propertyName?.text || binding.name.text) !== 'PrototypeProvider'
    || defaults.length !== 1 || !original.name || original.parameters.length || original.asteriskToken
    || original.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || /\b(?:ConnectorPreviewBoundary|ConnectorPrototypeRoot)\b/.test(source)) {
    throw new Error('Custom root needs a bounded foreground provider integration; no existing UI was overwritten');
  }
  const edits = [{
    start: provider[0].getStart(parsed), end: provider[0].end,
    text: `import { PrototypeConnectorProvider as ${binding.name.text} } from '../src/data/PrototypeConnectorProvider';`,
  }, ...original.modifiers.filter((node) => [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword].includes(node.kind))
    .map((node) => ({ start: node.getStart(parsed), end: node.end, text: '' }))];
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return `import { ConnectorPreviewBoundary } from '../src/data/ConnectorPreviewBoundary';\n${source}
export default function ConnectorPrototypeRoot() {
  return <ConnectorPreviewBoundary><${original.name.text} /></ConnectorPreviewBoundary>;
}
`;
}

function restoreAuthRoutes(root, profile) {
  const backup = readJson(root, '.tmp/prototype-connected-template.json');
  if (backup.schemaVersion !== 1 || backup.entryRoute !== profile.entryRoute
    || typeof profile.entryRoute !== 'string' || !/^\/[A-Za-z0-9_/()\-]+$/.test(profile.entryRoute)) {
    throw new Error('Connector authentication requires the existing approved entry route and saved template');
  }
  const routes = {};
  for (const file of AUTH_ROUTES) {
    if (fs.existsSync(inside(root, file))) {
      readText(root, file);
      continue;
    }
    const source = backup.files?.[file];
    const marker = file === 'app/login.tsx' ? 'useAuth' : 'completePowerAppsAuthSession';
    if (typeof source !== 'string' || !source.includes(marker)) throw new Error(`The saved supported auth route is missing: ${file}`);
    routes[file] = source.replace(/(["'])\/\(app\)\/home\1/g, JSON.stringify(profile.entryRoute));
  }
  return routes;
}

function pendingBinding(root, options) {
  const canonical = [
    '.tmp/prototype-domain.json', '.tmp/prototype-bindings.json', '.tmp/prototype-rules.json',
    '.tmp/persistence-contract.json', '.tmp/scenario-facts.json', '.tmp/prototype-connected-template.json', 'power.config.json',
    'auth.config.json', 'src/generated/connectorSchemas.ts',
  ];
  const requireFromApp = createRequire(path.join(path.resolve(root), 'package.json'));
  const schemas = generatedSchemas(root, requireFromApp, readText(root, 'src/generated/connectorSchemas.ts'));
  const pkg = readJson(root, 'package.json');
  if (pkg.scripts) delete pkg.scripts['dev:prototype'];
  return revision({ options, packageRevision: revision(pkg), connectorSchemas: schemas.revision, files: canonical.map((file) => ({ file, hash: sha256Hex(readText(root, file)) })) });
}

function applyPending(root, pending) {
  if (pending.schemaVersion !== 1 || !Array.isArray(pending.changes) || pending.changes.length > WRITABLE.size
    || new Set(pending.changes.map((entry) => entry.file)).size !== pending.changes.length) throw new Error('Invalid connector startup recovery');
  for (const entry of pending.changes) {
    if (!WRITABLE.has(entry.file) || typeof entry.after !== 'string' || !(entry.before === null || typeof entry.before === 'string')) {
      throw new Error('Connector startup recovery includes an unowned file');
    }
    const current = fs.existsSync(inside(root, entry.file)) ? readText(root, entry.file) : null;
    if (current !== entry.before && current !== entry.after) throw new Error(`Interrupted connector startup conflicts with an unrelated edit: ${entry.file}`);
  }
  for (const entry of pending.changes) atomicWrite(root, entry.file, entry.after);
  fs.rmSync(inside(root, PENDING));
  return { ok: true, profile: 'connector', persistenceMode: readJson(root, PROFILE).persistenceMode, repositoryMode: 'local-prototype', files: pending.changes.map((entry) => entry.file), published: false };
}

function stagePrototypeConnectorStartup(root, { catalog, selection, connectorName, preview, localRefId, check = false } = {}) {
  const selectedPreview = dataPreview(preview);
  if (selectedPreview.previewKind !== 'candidate') throw new Error('Stage an isolated connector candidate; activation requires the separate Apply transaction');
  const options = { selection, connectorName, preview: selectedPreview, ...(localRefId ? { localRefId } : {}) };
  validateConnectorSelection(catalog, selection);
  const bindingRevision = pendingBinding(root, options);
  if (fs.existsSync(inside(root, PENDING))) {
    if (check) throw new Error('Connector startup has an interrupted write to recover');
    const pending = readJson(root, PENDING);
    if (pending.bindingRevision !== bindingRevision) throw new Error('Interrupted connector startup inputs changed; do not replay it');
    return { ...applyPending(root, pending), resumed: true };
  }
  const current = inputs(root);
  const selected = selectedBinding(current, catalog, selection, connectorName, localRefId);
  const previous = fs.existsSync(inside(root, STATE)) ? assertRevision(readJson(root, STATE), 'startupRevision', 'Connector startup') : null;
  const bindings = [...(previous?.bindings || [])];
  const prior = bindings.find((entry) => entry.localRefId === selected.localRefId);
  if (prior && (prior.connectionId !== selected.connectionId || prior.apiId !== selected.apiId)) {
    throw new Error('Replacing an existing connector binding requires its separate explicit workflow');
  }
  if (prior) bindings.splice(bindings.indexOf(prior), 1);
  bindings.push(selected);
  bindings.sort((a, b) => a.localRefId.localeCompare(b.localRefId));
  for (const entry of bindings) {
    const official = current.powerConfig.connectionReferences?.[entry.localRefId];
    if (!official || normalizeApi(official.id) !== entry.apiId || !Array.isArray(official.dataSources) || !official.dataSources.length
      || official.dataSources.some((name) => !current.schemaNames.includes(name))
      || !current.persistence.connectors.some((connector) => connector.apiName === entry.connectorName)) {
      throw new Error('Connector startup cannot remove or silently replace an existing binding');
    }
  }
  const config = {
    schemaVersion: 1, mode: current.persistence.mode, appInstanceId: current.domain.appInstanceId,
    environmentId: current.selectedEnvironment, preview: selectedPreview, bindings,
  };
  const state = { ...config, contractType: 'prototype-connector-startup', inputRevisions: current.inputRevisions };
  state.startupRevision = revision(state);
  const sourceFiles = { [PROVIDER]: providerSource(), [BOUNDARY]: boundarySource(), [CONFIG]: `${JSON.stringify(config, null, 2)}\n` };
  for (const [file, bytes] of Object.entries(sourceFiles)) {
    if (fs.existsSync(inside(root, file)) && !current.manifest.files[file] && readText(root, file) !== bytes) {
      throw new Error(`Refusing to overwrite an unowned connector startup file: ${file}`);
    }
  }
  const manifest = {
    ...current.manifest, inputRevisions: current.inputRevisions,
    files: { ...current.manifest.files, ...Object.fromEntries(Object.entries(sourceFiles).map(([file, bytes]) => [file, sha256Hex(bytes)])) },
  };
  const registry = { ...current.registry, inputRevisions: { ...current.registry.inputRevisions, ...current.inputRevisions } };
  delete registry.registryRevision;
  registry.registryRevision = revision(registry);
  const profile = { ...current.profile, profile: 'connector', storageMode: 'local', persistenceMode: current.persistence.mode, environmentId: current.selectedEnvironment };
  const rootSource = wireRoot(root, readText(root, ROOT), current.profile.profile === 'connector');
  const authRoutes = restoreAuthRoutes(root, current.profile);
  const pkg = structuredClone(current.pkg);
  if (pkg.scripts) delete pkg.scripts['dev:prototype'];
  const files = {
    ...sourceFiles, ...authRoutes, [ROOT]: rootSource, [STATE]: state, [PROFILE]: profile,
    [REGISTRY]: registry, [MANIFEST]: manifest, 'package.json': pkg,
  };
  const changes = Object.entries(files).map(([file, value]) => ({
    file, before: fs.existsSync(inside(root, file)) ? readText(root, file) : null,
    after: typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  })).filter((entry) => entry.before !== entry.after);
  if (check) {
    if (changes.length) throw new Error('Connector startup generated files or input bindings are stale');
    return { ok: true, check: true, files: [], published: false };
  }
  atomicWrite(root, PENDING, { schemaVersion: 1, bindingRevision, changes });
  return applyPending(root, { schemaVersion: 1, bindingRevision, changes });
}

function verifyPrototypeConnectorStartup(root) {
  if (fs.existsSync(inside(root, PENDING))) throw new Error('Connector startup has an interrupted write to recover');
  const current = inputs(root);
  const state = assertRevision(readJson(root, STATE), 'startupRevision', 'Connector startup');
  const config = readJson(root, CONFIG);
  if (current.profile.profile !== 'connector' || current.profile.persistenceMode !== current.persistence.mode
    || state.mode !== current.persistence.mode || state.schemaVersion !== 1
    || config.schemaVersion !== 1 || config.mode !== current.persistence.mode || config.appInstanceId !== state.appInstanceId
    || state.environmentId !== current.selectedEnvironment || config.environmentId !== current.selectedEnvironment
    || state.appInstanceId !== current.domain.appInstanceId || revision(state.inputRevisions) !== revision(current.inputRevisions)
    || revision(config.bindings) !== revision(state.bindings) || revision(config.preview) !== revision(state.preview)) {
    throw new Error('Connector startup identity, environment, or canonical bindings are stale');
  }
  dataPreview(config.preview);
  for (const file of AUTH_ROUTES) readText(root, file);
  for (const binding of config.bindings) {
    const official = current.powerConfig.connectionReferences?.[binding.localRefId];
    if (!official || normalizeApi(official.id) !== binding.apiId || !Array.isArray(official.dataSources) || !official.dataSources.length
      || official.dataSources.some((name) => !current.schemaNames.includes(name))) throw new Error('Connector startup lost an official generated source binding');
  }
  wireRoot(root, readText(root, ROOT), true);
  return { ok: true, profile: 'connector', persistenceMode: current.persistence.mode, repositoryMode: 'local-prototype', environmentId: current.selectedEnvironment, published: false };
}

function typecheck(root) {
  const compiler = createRequire(path.join(path.resolve(root), 'package.json')).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--project', path.join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Connector activation TypeScript gate failed; staged files were restored');
}

// Source/data selection only, inside the caller's already-approved standalone
// Apply lease. Publishing, durable transaction recovery and reload remain caller-owned.
function activatePrototypeConnectorData(root, { expectedSourceRevision, confirmStandaloneApply = false } = {}, {
  env = process.env, captureSource, validateProject = typecheck,
} = {}) {
  if (env.MOBILE_AUTHORING_CONTEXT || env.MOBILE_AUTHORING_RUNNER_TOKEN) throw new Error('Player Apply is publisher-owned; use its authorized source stamp');
  if (!confirmStandaloneApply || typeof expectedSourceRevision !== 'string' || expectedSourceRevision.length !== 64
    || !/^[a-f0-9]{64}$/.test(expectedSourceRevision)) throw new Error('Connector activation requires explicit standalone Apply and its reviewed source revision');
  const capture = captureSource || require('./authoring-source').captureSource;
  const before = capture(root);
  if (before.revision !== expectedSourceRevision) throw new Error('The reviewed connector candidate changed before Apply');
  verifyPrototypeConnectorStartup(root);
  const config = readJson(root, CONFIG);
  if (config.preview.previewKind === 'active') return { ok: true, alreadyStaged: true, beforeRevision: before.revision, afterRevision: before.revision, published: false };
  const preview = { previewKind: 'active', dataNamespace: config.preview.baseDataNamespace || 'active' };
  const state = { ...readJson(root, STATE), preview };
  delete state.startupRevision;
  state.startupRevision = revision(state);
  const bytes = `${JSON.stringify({ ...config, preview }, null, 2)}\n`;
  const manifest = readJson(root, MANIFEST);
  const files = {
    [CONFIG]: bytes, [STATE]: state,
    [PROFILE]: { ...readJson(root, PROFILE), dataNamespace: preview.dataNamespace },
    [MANIFEST]: { ...manifest, files: { ...manifest.files, [CONFIG]: sha256Hex(bytes) } },
  };
  const backup = Object.fromEntries(Object.keys(files).map((file) => [file, readText(root, file)]));
  try {
    for (const [file, value] of Object.entries(files)) atomicWrite(root, file, value);
    validateProject(root);
    verifyPrototypeConnectorStartup(root);
    return { ok: true, beforeRevision: before.revision, afterRevision: capture(root).revision, files: Object.keys(files), requiresReload: true, published: false };
  } catch (error) {
    for (const [file, value] of Object.entries(backup)) atomicWrite(root, file, value);
    throw error;
  }
}

module.exports = { STATE, PENDING, CONFIG, PROVIDER, BOUNDARY, stagePrototypeConnectorStartup, verifyPrototypeConnectorStartup, activatePrototypeConnectorData, dataPreview, providerSource, boundarySource };

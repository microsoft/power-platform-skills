'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { inside, readJson, revision, assertRevision } = require('./prototype-files');
const { sha256Hex } = require('./product-experience-contracts');
const connector = require('./prototype-connector-startup');
const { environmentId } = require('./prototype-connections');

function readSource(root, file) {
  const target = inside(root, file);
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`Expected bounded startup source: ${file}`);
  return fs.readFileSync(target, 'utf8');
}

function namedImports(ts, parsed, name, suffix) {
  return parsed.statements.filter(ts.isImportDeclaration).flatMap((node) => {
    const bindings = node.importClause?.namedBindings;
    return node.moduleSpecifier.text.endsWith(suffix) && !node.importClause?.isTypeOnly && bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter((entry) => !entry.isTypeOnly && (entry.propertyName?.text || entry.name.text) === name) : [];
  });
}

function connectorSchemas(root, ts, referenceNames) {
  const parsed = ts.createSourceFile('connectorSchemas.ts', readSource(root, 'src/generated/connectorSchemas.ts'), ts.ScriptTarget.Latest, true);
  if (parsed.parseDiagnostics.length) throw new Error('Official schemaMap must parse before retaining connector pins');
  const declarations = parsed.statements.filter(ts.isVariableStatement)
    .flatMap((node) => node.declarationList.declarations).filter((node) => ts.isIdentifier(node.name) && node.name.text === 'schemaMap');
  let value = declarations.length === 1 ? declarations[0].initializer : null;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
  if (!value || !ts.isObjectLiteralExpression(value)) throw new Error('Official schemaMap must retain its static generated sources');
  const imports = new Map(parsed.statements.filter(ts.isImportDeclaration)
    .filter((node) => node.importClause?.name).map((node) => [node.importClause.name.text, node.moduleSpecifier.text]));
  const names = new Set();
  const revisions = [];
  for (const property of value.properties) {
    if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      || names.has(property.name.text)) throw new Error('Official schemaMap has an ambiguous source');
    const name = property.name.text;
    names.add(name);
    if (!referenceNames.has(name)) continue;
    const initializer = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    const imported = ts.isIdentifier(initializer) ? imports.get(initializer.text) : null;
    if (!imported?.startsWith('.')) throw new Error('Retained connector schemas must use official JSON imports');
    const file = path.posix.normalize(path.posix.join('src/generated', imported));
    if (!file.startsWith('.power/schemas/') || !file.endsWith('.json')) throw new Error('Official connector schema import escapes its directory');
    const schema = readJson(root, file);
    const runtime = new URL(schema.properties?.primaryRuntimeUrl);
    if (!schema.name || runtime.protocol !== 'https:' || runtime.username || runtime.password || runtime.search || runtime.hash) {
      throw new Error('Retained connector schema has an invalid runtime');
    }
    revisions.push({ file, hash: sha256Hex(readSource(root, file)) });
  }
  if ([...referenceNames].some((name) => !names.has(name))) throw new Error('Official schemaMap lost an approved connector source');
  return revision(revisions.sort((a, b) => a.file.localeCompare(b.file)));
}

function verifyConnectorConfigDelta(config, expectedHash) {
  // The old compiler bound the complete official config bytes. Project only
  // Dataverse additions out of the new config and compare with the supported
  // official JSON writer (or compact JSON), so a source cannot silently move
  // to another same-API reference while keeping the old reference IDs.
  const absent = { ...config };
  delete absent.databaseReferences;
  const candidates = [absent, { ...config, databaseReferences: {} }];
  if (config.version === '1.0') {
    for (const value of [...candidates]) {
      const prior = { ...value };
      delete prior.version;
      candidates.push(prior);
    }
  }
  for (const value of candidates) {
    for (const indent of [undefined, 2]) {
      const bytes = JSON.stringify(value, null, indent);
      if ([bytes, `${bytes}\n`, `${bytes}\r\n`].some((candidate) => sha256Hex(candidate) === expectedHash)) return;
    }
  }
  throw new Error('Official connector reference/connection configuration changed beyond the approved Dataverse addition');
}

function retainedConnectorStartup(root) {
  const manifest = readJson(root, '.tmp/prototype-generated.json');
  const profile = readJson(root, '.tmp/prototype-profile.json');
  const powerConfig = readJson(root, 'power.config.json');
  const has = (file) => fs.existsSync(inside(root, file));
  const retained = [connector.STATE, connector.CONFIG, connector.PROVIDER, connector.BOUNDARY]
    .some((file) => has(file) || manifest.files?.[file]);
  if (!retained) {
    if (profile.profile === 'connector' || Object.keys(powerConfig.connectionReferences || {}).length) {
      throw new Error('Existing connectors require their compiler-owned approved startup pins; no automatic connection selection is allowed');
    }
    return null;
  }
  if (has(connector.PENDING)) throw new Error('Recover the interrupted connector startup before converting to Dataverse');
  const state = assertRevision(readJson(root, connector.STATE), 'startupRevision', 'Connector startup');
  const config = readJson(root, connector.CONFIG);
  const { contractType, inputRevisions, startupRevision: _revision, ...projection } = state;
  if (contractType !== 'prototype-connector-startup' || state.schemaVersion !== 1
    || !['connector-only', 'local-prototype'].includes(state.mode)
    || !['connector', 'connected'].includes(profile.profile)
    || revision(projection) !== revision(config) || state.appInstanceId !== profile.appInstanceId
    || state.appInstanceId !== readJson(root, 'app.json').expo?.extra?.telemetry?.appInstanceId
    || environmentId(state.environmentId) !== state.environmentId
    || state.environmentId !== environmentId(powerConfig.environmentId)
    || state.environmentId !== environmentId(profile.environmentId)) {
    throw new Error('Retained connector identity, environment or canonical bindings changed');
  }
  connector.dataPreview(config.preview);
  for (const [file, canonical] of [[connector.PROVIDER, connector.providerSource()], [connector.BOUNDARY, connector.boundarySource()], [connector.CONFIG, null]]) {
    const bytes = readSource(root, file);
    if (manifest.schemaVersion !== 1 || manifest.files?.[file] !== sha256Hex(bytes) || (canonical !== null && bytes !== canonical)) {
      throw new Error(`Compiler-owned connector startup changed: ${file}`);
    }
  }
  for (const [key, file] of [['domain', '.tmp/prototype-domain.json'], ['bindings', '.tmp/prototype-bindings.json'], ['rules', '.tmp/prototype-rules.json']]) {
    if (inputRevisions?.[key] !== revision(readJson(root, file))) throw new Error(`Retained connector canonical ${key} binding changed`);
  }
  const persistence = assertRevision(readJson(root, '.tmp/persistence-contract.json'), 'persistenceRevision', 'Persistence contract');
  const refs = powerConfig.connectionReferences || {};
  const identifiers = new Set();
  if (!Array.isArray(config.bindings) || !config.bindings.length || config.bindings.length > 64) throw new Error('Exact existing connector pins are required');
  for (const binding of config.bindings) {
    const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(value)
      && !Object.hasOwn(Object.prototype, value) && value !== 'prototype';
    const official = refs[binding.localRefId];
    if (Object.keys(binding).some((key) => !['connectorName', 'localRefId', 'apiId', 'connectionId', 'connectionRef', 'catalogRevision'].includes(key))
      || !validId(binding.localRefId) || !validId(binding.connectionId) || !/^[a-f0-9]{64}$/.test(binding.catalogRevision || '')
      || (binding.connectionRef !== undefined && binding.connectionRef !== binding.localRefId)
      || identifiers.has(binding.localRefId) || !official || typeof official.id !== 'string'
      || official.id.replace(/^\/providers\/Microsoft\.PowerApps\/apis\//i, '') !== binding.apiId
      || !Array.isArray(official.dataSources) || !official.dataSources.length
      || !persistence.connectors?.some((entry) => entry.apiName === binding.connectorName)) {
      throw new Error('The exact approved connector reference/connection binding is no longer available');
    }
    identifiers.add(binding.localRefId);
  }
  verifyConnectorConfigDelta(powerConfig, inputRevisions.connectorConfig);
  const sourceNames = new Set(Object.values(refs).flatMap((ref) => {
    if (!Array.isArray(ref.dataSources) || ref.dataSources.some((name) => typeof name !== 'string' || !name)) {
      throw new Error('Official connector references require their generated source names');
    }
    return ref.dataSources;
  }));
  const ts = createRequire(path.join(root, 'package.json'))('typescript');
  if (connectorSchemas(root, ts, sourceNames) !== inputRevisions.connectorSchemas) {
    throw new Error('Existing connector schema bindings changed during Dataverse conversion');
  }
  return config;
}

function connectionPinSource(ts, names) {
  // Reuse the connector compiler's exact pin loop and local subscriptions, not
  // another connection resolver. Only its connector-only Dataverse prohibition
  // is removed; the saved template still supplies all real auth/offline setup.
  const parsed = ts.createSourceFile('PrototypeConnectorProvider.tsx', connector.providerSource(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variableName = (node) => ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
    ? node.declarationList.declarations[0].name.getText(parsed) : null;
  const selected = parsed.statements.filter((node) => (
    ts.isTypeAliasDeclaration(node) && node.name.text === 'HostConfig'
    || ['officialConfig', 'references', 'runtimeConfig'].includes(variableName(node))
    || ts.isIfStatement(node) || ts.isForOfStatement(node)
    || ts.isFunctionDeclaration(node) && node.name?.text === 'LocalRepositorySubscriptions'
  ));
  if (selected.length !== 7) throw new Error('Unsupported canonical connector pin compiler');
  const transformed = ts.transform(ts.factory.updateSourceFile(parsed, selected), [(context) => {
    const visit = (node) => {
      if (ts.isIdentifier(node) && Object.hasOwn(names, node.text)) return ts.factory.createIdentifier(names[node.text]);
      if (ts.isIfStatement(node) && node.parent === parsed) {
        if (!ts.isBinaryExpression(node.expression) || node.expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken
          || !node.expression.right.getText(parsed).includes('databaseReferences')) throw new Error('Unsupported canonical connector environment guard');
        return ts.factory.updateIfStatement(node, ts.visitNode(node.expression.left, visit),
          ts.factory.createBlock([ts.factory.createThrowStatement(ts.factory.createNewExpression(ts.factory.createIdentifier('Error'), undefined,
            [ts.factory.createStringLiteral('Connected startup cannot change the approved connector environment.')]))]), undefined);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit);
  }]);
  try { return ts.createPrinter().printFile(transformed.transformed[0]); }
  finally { transformed.dispose(); }
}

function removeUnusedOutletImports(ts, file, names) {
  const used = new Set();
  function visit(node) {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return ts.factory.updateSourceFile(file, file.statements.flatMap((node) => {
    const bindings = ts.isImportDeclaration(node) && node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [node];
    const remaining = bindings.elements.filter((binding) => !names.has(binding.name.text) || used.has(binding.name.text));
    if (remaining.length === bindings.elements.length) return [node];
    if (!remaining.length && !node.importClause.name) return [];
    return [ts.factory.updateImportDeclaration(node, node.modifiers,
      ts.factory.updateImportClause(node.importClause, node.importClause.isTypeOnly, node.importClause.name,
        remaining.length ? ts.factory.updateNamedImports(bindings, remaining) : undefined), node.moduleSpecifier, node.attributes)];
  }));
}

// Retain the installed template's real host/auth/offline configuration while
// turning only its route outlet into a provider slot. Current app UI is not a backup.
function connectedProviderSource(root, templateSource) {
  const ts = createRequire(path.join(root, 'package.json'))('typescript');
  const retained = retainedConnectorStartup(root);
  const parsed = ts.createSourceFile('app/_layout.tsx', templateSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (parsed.parseDiagnostics.length) throw new Error('Saved connected template root must parse before conversion');
  const imports = parsed.statements.filter(ts.isImportDeclaration);
  const imported = (module, name) => imports.flatMap((entry) => {
    const bindings = entry.importClause?.namedBindings;
    return entry.moduleSpecifier.text === module && bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter((binding) => (binding.propertyName?.text || binding.name.text) === name) : [];
  });
  const slots = imported('expo-router', 'Slot');
  const statusBars = imported('expo-status-bar', 'StatusBar');
  const host = imported('@microsoft/power-apps-native-host', 'PowerAppsProvider');
  const roots = parsed.statements.filter((node) => ts.isFunctionDeclaration(node)
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  if (slots.length !== 1 || host.length !== 1 || roots.length !== 1 || !roots[0].name
    || roots[0].parameters.length || /\bPropsWithChildren\b/.test(templateSource)) {
    throw new Error('Unsupported saved host root; integrate the connected provider explicitly without replacing current UI');
  }
  const hostElements = [];
  const visitHost = (node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === host[0].name.text) hostElements.push(node);
    ts.forEachChild(node, visitHost);
  };
  visitHost(parsed);
  const hostAttribute = (name) => hostElements[0]?.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.text === name)?.initializer;
  const power = hostAttribute('powerConfig');
  const schemas = hostAttribute('schemaMap');
  if (hostElements.length !== 1 || !power || !ts.isJsxExpression(power) || !ts.isIdentifier(power.expression)
    || !schemas || !ts.isJsxExpression(schemas) || !ts.isIdentifier(schemas.expression)) {
    throw new Error('Saved connected root must use the actual host configuration and schemaMap');
  }
  const fromApp = (node) => node.moduleSpecifier.text.startsWith('.')
    ? path.posix.normalize(path.posix.join('app', node.moduleSpecifier.text)).replace(/\.tsx?$/, '') : null;
  if (!imports.some((node) => fromApp(node) === 'power.config.json' && node.importClause?.name?.text === power.expression.text)
    || !imports.some((node) => fromApp(node) === 'src/generated/connectorSchemas'
      && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some((binding) => (binding.propertyName?.text || binding.name.text) === 'schemaMap' && binding.name.text === schemas.expression.text))) {
    throw new Error('Saved host configuration must use the official power.config and generated schemaMap imports');
  }
  let pinImports = '';
  let pins = '';
  if (retained) {
    if (/\b(?:startup|HostConfig|officialConfig|references|runtimeConfig|LocalRepositorySubscriptions|getDataRuntime|useQueryClient|useEffect|ComponentProps)\b/.test(templateSource)) {
      throw new Error('Saved host root conflicts with the canonical connector pin composition');
    }
    pinImports = `import { useEffect, type ComponentProps } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import startup from './connector-startup.json';
import { getDataRuntime } from './runtime';
`;
    pins = connectionPinSource(ts, { PowerAppsProvider: host[0].name.text, powerConfig: power.expression.text, schemaMap: schemas.expression.text });
  }
  const relocate = (value) => {
    const relative = path.posix.relative('src/data', path.posix.normalize(path.posix.join('app', value)));
    return relative.startsWith('.') ? relative : `./${relative}`;
  };
  let outlets = 0;
  const transformed = ts.transform(parsed, [(context) => {
    const visit = (node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === slots[0].name.text) {
        if (node.attributes.properties.length) throw new Error('Saved connected route outlet has unsupported parameters');
        let ancestor = node.parent;
        while (ancestor && !(ts.isJsxElement(ancestor) && ancestor.openingElement === hostElements[0])) ancestor = ancestor.parent;
        if (!ancestor) throw new Error('The saved route outlet must remain inside the real Power Apps host');
        outlets += 1;
        const child = ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier('children'));
        return retained ? ts.factory.createJsxElement(
          ts.factory.createJsxOpeningElement(ts.factory.createIdentifier('LocalRepositorySubscriptions'), undefined, ts.factory.createJsxAttributes([])),
          [child], ts.factory.createJsxClosingElement(ts.factory.createIdentifier('LocalRepositorySubscriptions'))) : child;
      }
      if (ts.isJsxSelfClosingElement(node) && statusBars.some((binding) => node.tagName.getText(parsed) === binding.name.text)) {
        return ts.factory.createJsxExpression(undefined, ts.factory.createNull());
      }
      if (ts.isStringLiteral(node)) {
        const specifier = ts.isImportDeclaration(node.parent) && node.parent.moduleSpecifier === node
          || ts.isCallExpression(node.parent) && node.parent.expression.getText(parsed) === 'require';
        if (specifier && node.text.startsWith('.')) return ts.factory.createStringLiteral(relocate(node.text));
        const missing = /^Cannot find module '(\.\.?\/[^']+)'$/.exec(node.text);
        if (missing) return ts.factory.createStringLiteral(`Cannot find module '${relocate(missing[1])}'`);
      }
      if (retained && node === power) return ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier('runtimeConfig'));
      if (node === roots[0]) {
        return ts.factory.updateFunctionDeclaration(node,
          node.modifiers.filter((modifier) => modifier.kind !== ts.SyntaxKind.DefaultKeyword), node.asteriskToken,
          ts.factory.createIdentifier('ConnectedProvider'), node.typeParameters,
          [ts.factory.createParameterDeclaration(undefined, undefined,
            ts.factory.createObjectBindingPattern([ts.factory.createBindingElement(undefined, undefined, 'children')]),
            undefined, ts.factory.createTypeReferenceNode('PropsWithChildren'), undefined)],
          node.type, ts.visitEachChild(node.body, visit, context));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit);
  }]);
  try {
    if (outlets !== 1) throw new Error('Saved connected root must have one actual route outlet');
    const file = removeUnusedOutletImports(ts, transformed.transformed[0], new Set([...slots, ...statusBars].map((binding) => binding.name.text)));
    return `import type { PropsWithChildren } from 'react';\n${pinImports}${ts.createPrinter().printFile(file)}${pins}`;
  } finally {
    transformed.dispose();
  }
}

function verifyAuthoringOrder(ts, parsed, localName) {
  const protectedContent = require('./prototype-authoring').rootContent(ts, parsed);
  const authors = namedImports(ts, parsed, 'AuthoringProvider', '/authoring');
  if (!authors.length && !protectedContent) return;
  const configure = namedImports(ts, parsed, 'configureDataPreview', '/data/runtime');
  if (authors.length !== 1 || configure.length !== 1) throw new Error('Preserve the existing authoring namespace configuration');
  let found = false;
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(parsed) === localName) {
      found = true;
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (protectedContent && owner === protectedContent) return;
      let ancestor = node.parent;
      while (ancestor && !(ts.isJsxElement(ancestor) && ancestor.openingElement.tagName.getText(parsed) === authors[0].name.text)) ancestor = ancestor.parent;
      const prop = ancestor?.openingElement.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === 'configureDataPreview');
      if (!prop?.initializer || !ts.isJsxExpression(prop.initializer) || prop.initializer.expression?.getText(parsed) !== configure[0].name.text) {
        throw new Error('AuthoringProvider must configure data before connected repository consumers');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!found) throw new Error('The current connected provider must remain inside the authoring root');
}

function wireConnectedRoot(root, source) {
  const ts = createRequire(path.join(root, 'package.json'))('typescript');
  const parsed = ts.createSourceFile('app/_layout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (parsed.parseDiagnostics.length) throw new Error('Current root must parse before conversion');
  const retained = retainedConnectorStartup(root);
  const providers = parsed.statements.filter((node) => ts.isImportDeclaration(node)
    && /\/data\/(?:PrototypeProvider|PrototypeConnectorProvider|ConnectedProvider)$/.test(node.moduleSpecifier.text));
  const binding = providers[0]?.importClause?.namedBindings;
  const exported = binding && ts.isNamedImports(binding) && binding.elements.length === 1
    ? binding.elements[0].propertyName?.text || binding.elements[0].name.text : null;
  if (providers.length !== 1 || providers[0].importClause?.name || providers[0].importClause?.isTypeOnly || binding?.elements?.[0]?.isTypeOnly
    || !exported || !providers[0].moduleSpecifier.text.endsWith(`/${exported}`)
    || (exported === 'PrototypeConnectorProvider' && !retained) || (retained && exported === 'PrototypeProvider')) {
    throw new Error('Current root needs an explicit connected-provider integration; no UI or selected connector was overwritten');
  }
  const localName = binding.elements[0].name.text;
  verifyAuthoringOrder(ts, parsed, localName);
  const boundaries = parsed.statements.filter((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text.endsWith('/data/ConnectorPreviewBoundary'));
  const edits = [];
  if (exported === 'PrototypeConnectorProvider' || boundaries.length) {
    // The old boundary selects a local namespace, potentially active. Remove
    // only its pure compiler wrapper so the new connected candidate keeps its
    // read-only default and the actual authoring/UI child is still the root.
    const named = boundaries[0]?.importClause?.namedBindings;
    const defaults = parsed.statements.filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      || ts.isExportAssignment(node) && !node.isExportEquals);
    const wrapper = defaults[0];
    let value = wrapper && ts.isFunctionDeclaration(wrapper) && wrapper.body?.statements.length === 1
      && ts.isReturnStatement(wrapper.body.statements[0]) ? wrapper.body.statements[0].expression : null;
    while (value && ts.isParenthesizedExpression(value)) value = value.expression;
    const children = value && ts.isJsxElement(value) ? value.children.filter((node) => !ts.isJsxText(node) || node.text.trim()) : [];
    const child = children[0];
    if (!retained || boundaries.length !== 1 || boundaries[0].moduleSpecifier.text !== '../src/data/ConnectorPreviewBoundary'
      || boundaries[0].importClause?.name || boundaries[0].importClause?.isTypeOnly || !named || !ts.isNamedImports(named) || named.elements.length !== 1
      || named.elements[0].isTypeOnly || named.elements[0].propertyName || named.elements[0].name.text !== 'ConnectorPreviewBoundary'
      || defaults.length !== 1 || !ts.isFunctionDeclaration(wrapper) || wrapper.name?.text !== 'ConnectorPrototypeRoot'
      || wrapper.parameters.length || wrapper.asteriskToken || wrapper.typeParameters?.length || wrapper.type
      || wrapper.modifiers?.length !== 2
      || wrapper.modifiers.some((modifier) => ![ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword].includes(modifier.kind))
      || !value || !ts.isJsxElement(value) || value.openingElement.tagName.getText(parsed) !== 'ConnectorPreviewBoundary'
      || value.openingElement.attributes.properties.length || children.length !== 1 || !ts.isJsxSelfClosingElement(child)
      || !ts.isIdentifier(child.tagName) || child.attributes.properties.length || child.typeArguments?.length) {
      throw new Error('Only the exact compiler-produced connector preview wrapper can be removed; current UI was preserved');
    }
    const content = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === child.tagName.text);
    if (content.length !== 1 || content[0] === wrapper || content[0].parameters.length || content[0].asteriskToken
      || content[0].modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      throw new Error('The connector wrapper must retain its actual current child component');
    }
    function checkReferences(node) {
      if (node === boundaries[0] || node === wrapper) return;
      if (ts.isIdentifier(node) && ['ConnectorPreviewBoundary', 'ConnectorPrototypeRoot'].includes(node.text)) {
        throw new Error('A customized connector preview wrapper must not be silently removed');
      }
      ts.forEachChild(node, checkReferences);
    }
    checkReferences(parsed);
    const exportedChild = content[0].modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    edits.push(
      { start: boundaries[0].getStart(parsed), end: boundaries[0].end, text: '' },
      { start: wrapper.getStart(parsed), end: wrapper.end, text: '' },
      { start: exportedChild ? exportedChild.end : content[0].getStart(parsed),
        end: exportedChild ? exportedChild.end : content[0].getStart(parsed), text: exportedChild ? ' default' : 'export default ' },
    );
  }
  if (exported === 'ConnectedProvider' && !edits.length) return source;
  const replacement = `import { ConnectedProvider as ${binding.elements[0].name.text} } from '../src/data/ConnectedProvider';`;
  edits.push({ start: providers[0].getStart(parsed), end: providers[0].end, text: replacement });
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  const result = ts.createSourceFile('app/_layout.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (result.parseDiagnostics.length) throw new Error('Connected root composition did not parse; no source was replaced');
  verifyAuthoringOrder(ts, result, localName);
  return source;
}

module.exports = { connectedProviderSource, wireConnectedRoot, retainedConnectorStartup };

'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { configureMobileAuthoring, validateAuthoringRegistry, REGISTRY_PATH, COMPILED_PATH } = require('./authoring-runtime');
const { instrumentPrototypeScreen } = require('./prototype-screen-authoring');
const { canonicalJson, digest, inside, readFile, readJson, exists, atomicWrite, plainDirectory } = require('./mobile-authoring-files');

const ROOT = 'app/_layout.tsx';
const ROOT_COMPONENT = 'MobileAuthoringRoot';

function expressionValue(ts, expression) {
  let value = expression;
  while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
  if (value && ts.isStringLiteral(value)) return value.text;
  if (value && ts.isArrayLiteralExpression(value)) return value.elements.map((entry) => expressionValue(ts, entry));
  if (value && ts.isObjectLiteralExpression(value)) {
    const result = {};
    for (const entry of value.properties) {
      if (!ts.isPropertyAssignment(entry) || !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name))) {
        throw new Error('authoringTargets must contain only explicit literal metadata, not computed properties or spreads');
      }
      const key = entry.name.text;
      if (Object.hasOwn(result, key) || Object.hasOwn(Object.prototype, key) || key === 'prototype') {
        throw new Error('authoringTargets contains a duplicate or unsafe metadata key');
      }
      result[key] = expressionValue(ts, entry.initializer);
    }
    return result;
  }
  throw new Error('authoringTargets must be an exported array of literal target metadata');
}

function sourceTargets(ts, source, file, required) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (parsed.parseDiagnostics.length) throw new Error(`Screen source must parse before compiling its authoring metadata: ${file}`);
  const declarations = parsed.statements.filter((statement) => ts.isVariableStatement(statement)
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap((statement) => statement.declarationList.declarations.map((declaration) => ({
      declaration, constant: Boolean(statement.declarationList.flags & ts.NodeFlags.Const),
    })))
    .filter(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'authoringTargets');
  if (!declarations.length && !required) return [];
  if (declarations.length !== 1 || !declarations[0].constant || !declarations[0].declaration.initializer) {
    throw new Error(`Screen must export its explicit const authoringTargets array: ${file}`);
  }
  const targets = expressionValue(ts, declarations[0].declaration.initializer);
  if (!Array.isArray(targets)) throw new Error(`authoringTargets must be an array: ${file}`);
  return targets;
}

function compileRegistry(root, ts, readyScreenIds, screenSources) {
  const compiled = readJson(root, COMPILED_PATH);
  if (compiled.contractType !== 'compiled-screen-build-pack' || !Array.isArray(compiled.screens)) {
    throw new Error('Prototype authoring requires the canonical compiled screen build pack');
  }
  if (!Array.isArray(readyScreenIds) || new Set(readyScreenIds).size !== readyScreenIds.length
    || readyScreenIds.some((id) => !compiled.screens.some((screen) => screen.screenId === id))) {
    throw new Error('Ready authoring screens must be unique members of the compiled screen plan');
  }
  const sources = screenSources === undefined ? (exists(root, REGISTRY_PATH)
    ? validateAuthoringRegistry(root, readJson(root, REGISTRY_PATH)).screens.map(({ screenId, sourceFile }) => ({ screenId, sourceFile }))
    : undefined) : screenSources;
  if (!Array.isArray(sources) || sources.length !== compiled.screens.length
    || sources.some((source) => !source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some((key) => !['screenId', 'sourceFile'].includes(key))
      || !compiled.screens.some((screen) => screen.screenId === source.screenId))
    || new Set(sources.map((source) => source.screenId)).size !== sources.length) {
    throw new Error('Provide explicit screen sources for every compiled screen; source files are never inferred from routes');
  }
  const assigned = validateAuthoringRegistry(root, {
    schemaVersion: 1, appInstanceId: readJson(root, 'app.json').expo?.extra?.telemetry?.appInstanceId,
    screens: compiled.screens.map((screen) => ({
      screenId: screen.screenId, route: screen.route,
      sourceFile: sources.find((source) => source.screenId === screen.screenId)?.sourceFile,
      targets: [],
    })),
  });
  const screens = assigned.screens.map((screen) => {
    const { sourceFile } = screen;
    return {
      screenId: screen.screenId, route: screen.route, sourceFile,
      targets: sourceTargets(ts, readFile(inside(root, sourceFile)).toString('utf8'), sourceFile, readyScreenIds.includes(screen.screenId)),
    };
  });
  return validateAuthoringRegistry(root, {
    schemaVersion: 1, appInstanceId: readJson(root, 'app.json').expo?.extra?.telemetry?.appInstanceId, screens,
  });
}

function rootContent(ts, parsed) {
  const namedImport = (name, module) => parsed.statements.filter(ts.isImportDeclaration).flatMap((entry) => {
    const bindings = entry.importClause?.namedBindings;
    return entry.moduleSpecifier.text === module && bindings && ts.isNamedImports(bindings)
      ? bindings.elements.filter((item) => (item.propertyName?.text || item.name.text) === name) : [];
  });
  const providers = namedImport('AuthoringProvider', '../src/authoring');
  const configure = namedImport('configureDataPreview', '../src/data/runtime');
  const wrapper = parsed.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === ROOT_COMPONENT);
  if (!wrapper) return null;
  const returnValue = (fn) => {
    const returned = fn.body?.statements.length === 1 ? fn.body.statements[0] : null;
    let value = returned && ts.isReturnStatement(returned) ? returned.expression : null;
    while (value && ts.isParenthesizedExpression(value)) value = value.expression;
    return value;
  };
  const onlyChild = (value) => {
    if (!value || !ts.isJsxElement(value)) return null;
    const children = value.children.filter((node) => !ts.isJsxText(node) || node.text.trim());
    return children.length === 1 && ts.isJsxSelfClosingElement(children[0])
      && children[0].attributes.properties.length === 0 ? children[0] : null;
  };
  const value = returnValue(wrapper);
  const child = onlyChild(value);
  const prop = value && ts.isJsxElement(value) && value.openingElement.attributes.properties.find((entry) => (
    ts.isJsxAttribute(entry) && entry.name.text === 'configureDataPreview'
  ));
  if (wrapper.parameters.length || wrapper.asteriskToken
    || wrapper.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || providers.length !== 1 || configure.length !== 1 || !value || !ts.isJsxElement(value) || !child
    || value.openingElement.attributes.properties.length !== 1
    || value.openingElement.tagName.getText(parsed) !== providers[0].name.text
    || !prop?.initializer || !ts.isJsxExpression(prop.initializer)
    || prop.initializer.expression?.getText(parsed) !== configure[0].name.text) {
    throw new Error('The existing authoring root no longer configures data before repository consumers');
  }
  const defaults = parsed.statements.filter((entry) => ts.isFunctionDeclaration(entry)
    && entry.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  if (defaults.length !== 1) throw new Error('The authoring root requires one actual default component');
  if (defaults[0] !== wrapper) {
    const boundary = namedImport('ConnectorPreviewBoundary', '../src/data/ConnectorPreviewBoundary');
    const outer = returnValue(defaults[0]);
    if (defaults[0].parameters.length || defaults[0].asteriskToken
      || defaults[0].modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      || boundary.length !== 1 || !outer || !ts.isJsxElement(outer) || outer.openingElement.attributes.properties.length
      || outer.openingElement.tagName.getText(parsed) !== boundary[0].name.text
      || onlyChild(outer)?.tagName.getText(parsed) !== ROOT_COMPONENT) {
      throw new Error('The actual application root must reach the authoring provider before data consumers');
    }
  }
  const name = child.tagName.getText(parsed);
  const component = parsed.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
  if (!component || component === wrapper) throw new Error('The authoring root must contain the original app component');
  return component;
}

function wrapRoot(ts, source) {
  const parsed = ts.createSourceFile(ROOT, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (parsed.parseDiagnostics.length) throw new Error('The application root must parse before adding authoring');
  if (rootContent(ts, parsed)) return source;
  if (/\b(?:AuthoringProvider|configureDataPreview|MobileAuthoringRoot)\b/.test(source)) {
    throw new Error('A custom authoring root requires explicit integration; existing imports will not be overwritten');
  }
  const defaults = parsed.statements.filter((entry) => ts.isFunctionDeclaration(entry)
    && entry.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  const content = defaults[0];
  if (defaults.length !== 1 || !content.name || content.parameters.length || content.asteriskToken
    || content.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    throw new Error('Prototype authoring requires a named synchronous default root component without parameters');
  }
  const edits = content.modifiers.filter((modifier) => (
    modifier.kind === ts.SyntaxKind.DefaultKeyword || modifier.kind === ts.SyntaxKind.ExportKeyword
  )).map((modifier) => ({ start: modifier.getStart(parsed), end: modifier.end }));
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + result.slice(edit.end);
  // The original component is a child, not a function call: none of its data hooks
  // execute until the source/native namespace handshake has initialized the provider.
  return `import { AuthoringProvider } from '../src/authoring';\nimport { configureDataPreview } from '../src/data/runtime';\n${result}
export default function ${ROOT_COMPONENT}() {
  return <AuthoringProvider configureDataPreview={configureDataPreview}><${content.name.text} /></AuthoringProvider>;
}
`;
}

function configurePrototypeAuthoring(projectRoot, { check = false, readyScreenIds = [], screenSources, wireScreenIds = [] } = {}) {
  const root = plainDirectory(projectRoot);
  const ts = createRequire(path.join(root, 'package.json'))('typescript');
  const registry = compileRegistry(root, ts, readyScreenIds, screenSources);
  if (!Array.isArray(wireScreenIds) || new Set(wireScreenIds).size !== wireScreenIds.length
    || wireScreenIds.some((id) => !registry.screens.some((screen) => screen.screenId === id))) {
    throw new Error('Explicit wiring targets must be unique screens in the authoring registry');
  }
  const screens = registry.screens.filter((screen) => wireScreenIds.includes(screen.screenId)).map((screen) => {
    const before = readFile(inside(root, screen.sourceFile)).toString('utf8');
    return {
      path: screen.sourceFile, before,
      next: instrumentPrototypeScreen(ts, before, {
        ...screen, ready: readyScreenIds.includes(screen.screenId),
        form: screen.targets.some((target) => target.role === 'form'),
      }),
    };
  });
  const before = readFile(inside(root, ROOT)).toString('utf8');
  const next = wrapRoot(ts, before);
  const previousRegistry = exists(root, REGISTRY_PATH) ? readJson(root, REGISTRY_PATH) : null;
  const registryChanged = canonicalJson(previousRegistry) !== canonicalJson(registry);
  const tsconfig = readJson(root, 'tsconfig.json');
  for (const value of [tsconfig, tsconfig?.compilerOptions, tsconfig?.compilerOptions?.paths]) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('TypeScript configuration and import paths must be objects');
    }
  }
  const nextConfig = structuredClone(tsconfig);
  nextConfig.compilerOptions ??= {};
  nextConfig.compilerOptions.paths ??= {};
  for (const [alias, target] of Object.entries({ '@/authoring': ['src/authoring'], '@/authoring/*': ['src/authoring/*'] })) {
    if (nextConfig.compilerOptions.paths[alias]
      && canonicalJson(nextConfig.compilerOptions.paths[alias]) !== canonicalJson(target)) {
      throw new Error('Existing authoring import aliases belong to another module; no alias was overwritten');
    }
    nextConfig.compilerOptions.paths[alias] = target;
  }
  const configChanged = canonicalJson(nextConfig) !== canonicalJson(tsconfig);
  if (check && (registryChanged || next !== before || configChanged || screens.some((screen) => screen.before !== screen.next))) {
    throw new Error('Prototype authoring registry, root, or real-screen wiring is missing/stale; run configure-prototype-authoring');
  }
  if (!check && registryChanged) atomicWrite(root, REGISTRY_PATH, registry);
  configureMobileAuthoring(root, { check });
  if (readFile(inside(root, ROOT)).toString('utf8') !== before
    || canonicalJson(readJson(root, 'tsconfig.json')) !== canonicalJson(tsconfig)
    || screens.some((screen) => readFile(inside(root, screen.path)).toString('utf8') !== screen.before)) {
    throw new Error('Application root, screen, or aliases changed during authoring configuration');
  }
  if (!check) for (const screen of screens.filter((entry) => entry.before !== entry.next)) atomicWrite(root, screen.path, screen.next, { bytes: true });
  if (!check && configChanged) atomicWrite(root, 'tsconfig.json', nextConfig);
  if (!check && next !== before) atomicWrite(root, ROOT, next, { bytes: true });
  if (canonicalJson(readJson(root, REGISTRY_PATH)) !== canonicalJson(registry)
    || canonicalJson(compileRegistry(root, ts, readyScreenIds, screenSources)) !== canonicalJson(registry)) {
    throw new Error('Assigned screen metadata changed during authoring configuration; recompile before publishing');
  }
  configureMobileAuthoring(root, { check: true });
  return {
    ok: true, appInstanceId: registry.appInstanceId, registryRevision: digest(canonicalJson(registry)),
    rootWired: true, screens: registry.screens.map((screen) => screen.screenId),
    wiredScreenIds: [...wireScreenIds],
    readyScreenIds: [...readyScreenIds], publicationReady: false,
  };
}

module.exports = { compileRegistry, configurePrototypeAuthoring, rootContent, sourceTargets, wrapRoot };

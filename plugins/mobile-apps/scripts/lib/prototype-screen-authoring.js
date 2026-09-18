'use strict';

// Opt-in source generation for explicit native bindings, not a mandatory JSX
// quality gate or a substitute for the runtime's mounted-screen acknowledgement.
const SCROLL_EVENTS = ['onScroll', 'onScrollBeginDrag', 'onScrollEndDrag', 'onMomentumScrollEnd'];
const LAYOUT_COMPONENTS = new Set(['View', 'SafeAreaView', 'ScrollView', 'FlatList', 'SectionList', 'YStack', 'XStack']);
const SCROLL_COMPONENTS = new Set(['ScrollView', 'FlatList', 'SectionList']);

function unwrap(ts, value) {
  while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
  return value;
}

function literal(ts, value) {
  const expression = unwrap(ts, value && ts.isJsxExpression(value) ? value.expression : value);
  return expression && ts.isStringLiteral(expression) ? expression.text : null;
}

function properties(ts, value) {
  value = unwrap(ts, value);
  if (!value || !ts.isObjectLiteralExpression(value)) return null;
  const result = new Map();
  for (const property of value.properties) {
    if (ts.isShorthandPropertyAssignment(property)) result.set(property.name.text, property.name);
    else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      result.set(property.name.text, property.initializer);
    } else return null;
  }
  return result;
}

function parseScreen(ts, source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (parsed.parseDiagnostics.length) throw new Error(`Screen must parse before authoring integration: ${file}`);
  const functions = new Map();
  const defaults = [];
  const imports = new Map();
  const names = new Set();
  const visitNames = (node) => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, visitNames); };
  visitNames(parsed);
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements.filter((entry) => !entry.isTypeOnly)) {
          imports.set(item.name.text, { module: statement.moduleSpecifier.text, name: item.propertyName?.text || item.name.text });
        }
      }
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) functions.set(statement.name.text, statement);
      if (statement.modifiers?.some((entry) => entry.kind === ts.SyntaxKind.DefaultKeyword)) defaults.push(statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = unwrap(ts, declaration.initializer);
        if (ts.isIdentifier(declaration.name) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) functions.set(declaration.name.text, fn);
      }
    }
  }
  for (const statement of parsed.statements.filter(ts.isExportAssignment)) {
    const expression = unwrap(ts, statement.expression);
    if (ts.isIdentifier(expression) && functions.has(expression.text)) defaults.push(functions.get(expression.text));
    else if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) defaults.push(expression);
  }
  if (defaults.length !== 1 || !defaults[0].body || !ts.isBlock(defaults[0].body)
    || defaults[0].asteriskToken || defaults[0].modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword)) {
    throw new Error(`Authoring requires one actual screen function with a block body: ${file}`);
  }
  const authoringName = (name) => {
    const item = imports.get(name);
    return item && (item.module === '@/authoring' || /^(?:\.\.\/)+src\/authoring(?:\/index)?$/.test(item.module)) ? item.name : null;
  };
  const nativeName = (name) => {
    const item = imports.get(name);
    return item && ['react-native', 'react-native-safe-area-context', 'tamagui'].includes(item.module) ? item.name : null;
  };
  return { parsed, root: defaults[0], functions, imports, names, authoringName, nativeName };
}

function functionFacts(ts, fn) {
  const calls = [];
  const returns = [];
  const variables = new Map();
  const boundNames = new Set();
  const bindName = (name) => {
    if (ts.isIdentifier(name)) boundNames.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const entry of name.elements) if (ts.isBindingElement(entry)) bindName(entry.name);
    }
  };
  for (const parameter of fn.parameters) bindName(parameter.name);
  const walk = (node) => {
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
      if (ts.isFunctionDeclaration(node) && node.name) bindName(node.name);
      return;
    }
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
    if (ts.isVariableDeclaration(node)) {
      bindName(node.name);
      if (ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, walk);
  };
  walk(fn);
  return { fn, calls, returns, variables, boundNames, elements: [], inheritedContext: false, mounts: 1 };
}

function analyze(ts, info) {
  const facts = new Map();
  const visitFunction = (fn, inheritedContext, ancestry = new Set()) => {
    if (ancestry.has(fn)) throw new Error('Recursive screen components cannot establish bounded authoring ownership');
    if (facts.has(fn)) {
      facts.get(fn).mounts += 1;
      facts.get(fn).inheritedContext &&= inheritedContext;
      return;
    }
    const fact = functionFacts(ts, fn);
    fact.inheritedContext = inheritedContext;
    facts.set(fn, fact);
    const visitExpression = (node, context, seen = new Set(), root = true) => {
      if (!node) return;
      node = unwrap(ts, node);
      if (ts.isIdentifier(node) && fact.variables.has(node.text) && !seen.has(node.text)) {
        visitExpression(fact.variables.get(node.text), context, new Set([...seen, node.text]), root);
        return;
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(info.parsed);
        fact.elements.push({ node: opening, context, root });
        if (info.functions.has(tag)) visitFunction(info.functions.get(tag), context, new Set([...ancestry, fn]));
        const childContext = context || info.authoringName(tag) === 'AuthoringScreen';
        if (ts.isJsxElement(node)) for (const child of node.children) visitExpression(child, childContext, seen, false);
        return;
      }
      ts.forEachChild(node, (child) => visitExpression(child, context, seen, root));
    };
    for (const returned of fact.returns) visitExpression(returned, inheritedContext);
  };
  visitFunction(info.root, false);
  return facts;
}

function attrs(ts, element) {
  const result = new Map();
  for (const entry of element.attributes.properties) {
    if (ts.isJsxAttribute(entry)) {
      if (result.has(entry.name.text)) throw new Error(`Repeated JSX attribute ${entry.name.text} cannot bind authoring`);
      result.set(entry.name.text, entry);
    }
  }
  return result;
}

function handlerUses(ts, attribute, owner, member) {
  const expression = unwrap(ts, attribute?.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : null);
  const matches = (node) => member
    ? ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === owner && node.name.text === member
    : ts.isIdentifier(node) && node.text === owner;
  if (!expression) return false;
  if (matches(expression)) return true;
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  let found = false;
  const walk = (node) => {
    if (node !== expression && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) return;
    if (ts.isCallExpression(node) && matches(unwrap(ts, node.expression))) found = true;
    ts.forEachChild(node, walk);
  };
  walk(expression);
  return found;
}

function uniqueName(names, wanted) {
  let name = wanted;
  let index = 1;
  while (names.has(name)) name = `${wanted}${index++}`;
  names.add(name);
  return name;
}

function instrumentPrototypeScreen(ts, source, { screenId, sourceFile, targets = [], ready = false, form = false }) {
  let info = parseScreen(ts, source, sourceFile);
  let facts = analyze(ts, info);
  const registrations = () => [...facts.values()].flatMap((fact) => [
    ...fact.calls.filter((call) => ts.isIdentifier(call.expression) && info.authoringName(call.expression.text) === 'useAuthoringScreen')
      .map((call) => ({ fact, call })),
    ...fact.elements.filter(({ node }) => info.authoringName(node.tagName.getText(info.parsed)) === 'AuthoringScreen')
      .map(({ node }) => ({ fact, node })),
  ]);
  if (!registrations().length) {
    if (ready) throw new Error(`Ready screen ${screenId} must register its actual readiness and dirty state through @/authoring`);
    const hook = uniqueName(info.names, 'useMobileScreenAuthoring');
    const handle = uniqueName(info.names, 'mobileAuthoringScreen');
    const offset = info.root.body.getStart(info.parsed) + 1;
    source = `import { useAuthoringScreen as ${hook} } from '@/authoring';\n${source.slice(0, offset)}
  const ${handle} = ${hook}(${JSON.stringify(screenId)}, { ready: false, hasUnsavedChanges: false });
${source.slice(offset)}`;
    info = parseScreen(ts, source, sourceFile);
    facts = analyze(ts, info);
  }
  const registered = registrations();
  if (registered.length !== 1) throw new Error(`Screen ${screenId} must have exactly one actual authoring registration`);
  const registration = registered[0];
  const unshadowed = (node, name) => {
    const existing = attrs(ts, node).get(name);
    if (existing && node.attributes.properties.some((entry) => ts.isJsxSpreadAttribute(entry) && entry.pos > existing.pos)) {
      throw new Error(`A JSX spread can override the actual authoring ${name} binding in ${sourceFile}`);
    }
    return existing;
  };
  for (const fact of facts.values()) {
    for (const call of fact.calls) {
      if (!ts.isIdentifier(call.expression) || !info.authoringName(call.expression.text)) continue;
      if (fact.boundNames.has(call.expression.text)) throw new Error('Authoring APIs must use their real imported binding, not a shadowed function');
      if (!ts.isVariableDeclaration(call.parent) || call.parent.parent?.parent?.parent !== fact.fn.body) {
        throw new Error('Authoring hooks must run unconditionally in the actual screen/component body');
      }
    }
    if (fact.mounts > 1 && (fact.calls.some((call) => ts.isIdentifier(call.expression) && info.authoringName(call.expression.text))
      || fact.elements.some(({ node }) => info.authoringName(node.tagName.getText(info.parsed))))) {
      throw new Error('Repeated component instances cannot share the same authoring screen/target IDs');
    }
    for (const { node } of fact.elements) {
      const tag = node.tagName.getText(info.parsed);
      if (fact.boundNames.has(tag) && (info.authoringName(tag) || info.nativeName(tag))) {
        throw new Error('Authoring and native views must use their real imported binding, not a shadowed component');
      }
    }
  }
  let screenHandle;
  let state;
  if (registration.call) {
    const call = registration.call;
    const declaration = call.parent;
    if (literal(ts, call.arguments[0]) !== screenId || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
      throw new Error(`Screen ${screenId} must keep its exact registered ID and named authoring handle`);
    }
    screenHandle = declaration.name.text;
    state = properties(ts, call.arguments[1]);
  } else {
    const attributes = attrs(ts, registration.node);
    for (const name of ['screenId', 'ready', 'hasUnsavedChanges']) unshadowed(registration.node, name);
    if (literal(ts, attributes.get('screenId')?.initializer) !== screenId) throw new Error(`Registered screen ID differs from ${screenId}`);
    state = new Map(['ready', 'hasUnsavedChanges'].map((name) => [name, attributes.get(name)?.initializer]));
  }
  if (!state?.get('ready') || !state.get('hasUnsavedChanges')) throw new Error(`Screen ${screenId} must explicitly bind ready and hasUnsavedChanges`);
  const valueOf = (expression) => unwrap(ts, expression && ts.isJsxExpression(expression) ? expression.expression : expression);
  if (ready && valueOf(state.get('ready'))?.kind === ts.SyntaxKind.FalseKeyword) throw new Error(`Screen ${screenId} is still an unready skeleton`);
  if (ready && form && valueOf(state.get('hasUnsavedChanges'))?.kind === ts.SyntaxKind.FalseKeyword) {
    throw new Error(`Form screen ${screenId} must register its actual dirty state`);
  }
  const edits = new Map();
  const insert = (position, text) => edits.set(position, (edits.get(position) || '') + text);
  const add = (node, name, expression) => insert(node.attributes.end, ` ${name}={${expression}}`);
  const plannedHandlers = new Map();
  const bind = (node, name, owner, member, eventArgument = false) => {
    const existing = unshadowed(node, name);
    if (!existing) {
      if (!plannedHandlers.has(node)) plannedHandlers.set(node, new Map());
      const handlers = plannedHandlers.get(node);
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push({ expression: member ? `${owner}.${member}` : owner, eventArgument });
    }
    else if (!handlerUses(ts, existing, owner, member)) throw new Error(`Compose the existing ${name} with the authoring handler in ${sourceFile}; it will not be overwritten`);
  };
  if (screenHandle) {
    const rootElements = registration.fact.elements.filter(({ root }) => root);
    if (!rootElements.length) throw new Error(`Screen ${screenId} needs a real native layout container, not a null/redirect skeleton`);
    for (const { node } of rootElements) {
      if (!LAYOUT_COMPONENTS.has(info.nativeName(node.tagName.getText(info.parsed)))) throw new Error(`Screen ${screenId} must attach authoring layout to its real native root container`);
      bind(node, 'onLayout', screenHandle, 'onLayout', true);
    }
  }
  const targetIds = new Set(targets.map((target) => target.id));
  const usedTargets = new Set();
  const addTarget = (id) => {
    if (!targetIds.has(id) || usedTargets.has(id)) throw new Error(`Screen ${screenId} has an unknown or repeated target ${id}`);
    usedTargets.add(id);
  };
  for (const fact of facts.values()) {
    const localScreen = registration.fact === fact ? screenHandle : null;
    let remeasure = localScreen;
    let member = localScreen ? 'onScroll' : null;
    for (const call of fact.calls) {
      if (!ts.isIdentifier(call.expression)) continue;
      const api = info.authoringName(call.expression.text);
      if (api === 'useAuthoringRemeasure' && fact.inheritedContext && ts.isVariableDeclaration(call.parent) && ts.isIdentifier(call.parent.name)) {
        remeasure = call.parent.name.text;
      }
      if (api !== 'useAuthoringTarget') continue;
      const id = literal(ts, call.arguments[0]);
      addTarget(id);
      const options = properties(ts, call.arguments[1]);
      if (!ts.isVariableDeclaration(call.parent) || !ts.isIdentifier(call.parent.name)
        || (!fact.inheritedContext && (!localScreen || options?.get('screen')?.getText(info.parsed) !== localScreen))) {
        throw new Error(`Target ${id} must use the actual screen handle or enclosing AuthoringScreen`);
      }
      const name = call.parent.name.text;
      const bound = fact.elements.filter(({ node }) => handlerUses(ts, attrs(ts, node).get('ref'), name, 'ref')
        || handlerUses(ts, attrs(ts, node).get('onLayout'), name, 'onLayout'));
      if (bound.length !== 1 || info.nativeName(bound[0].node.tagName.getText(info.parsed)) !== 'View') {
        throw new Error(`Target ${id} must bind one real native View through its ref/onLayout; no target location is inferred`);
      }
      bind(bound[0].node, 'ref', name, 'ref');
      bind(bound[0].node, 'onLayout', name, 'onLayout');
      const collapse = attrs(ts, bound[0].node).get('collapsable');
      if (!collapse) add(bound[0].node, 'collapsable', 'false');
      else if (valueOf(collapse.initializer)?.kind !== ts.SyntaxKind.FalseKeyword) throw new Error(`Target ${id} requires collapsable={false}`);
    }
    for (const { node, context } of fact.elements) {
      const api = info.authoringName(node.tagName.getText(info.parsed));
      const attributes = attrs(ts, node);
      if (api === 'AuthoringTarget') {
        for (const name of ['targetId', 'screen', 'recordRef']) unshadowed(node, name);
        const id = literal(ts, attributes.get('targetId')?.initializer);
        addTarget(id);
        if (!context && (!localScreen || attributes.get('screen')?.initializer?.expression?.getText(info.parsed) !== localScreen)) {
          throw new Error(`Target ${id} needs the actual AuthoringScreen or explicit screen handle`);
        }
      }
      if (!SCROLL_COMPONENTS.has(info.nativeName(node.tagName.getText(info.parsed)))) continue;
      if (!remeasure) throw new Error(`Scroll containers in ${sourceFile} need useAuthoringRemeasure inside their actual AuthoringScreen`);
      for (const event of SCROLL_EVENTS) bind(node, event, remeasure, member);
      const throttle = attributes.get('scrollEventThrottle');
      if (!throttle) add(node, 'scrollEventThrottle', '16');
      else if (valueOf(throttle.initializer)?.getText(info.parsed) !== '16') throw new Error(`Authoring scrollEventThrottle must equal 16 in ${sourceFile}`);
    }
  }
  if (ready && usedTargets.size !== targetIds.size) throw new Error(`Ready screen ${screenId} must instrument every declared semantic target`);
  for (const [node, attributes] of plannedHandlers) {
    for (const [name, handlers] of attributes) {
      const unique = [...new Map(handlers.map((handler) => [handler.expression, handler])).values()];
      add(node, name, unique.length === 1 ? unique[0].expression
        : `(event) => { ${unique.map((handler) => `${handler.expression}(${handler.eventArgument ? 'event' : ''});`).join(' ')} }`);
    }
  }
  let result = source;
  for (const [position, text] of [...edits].sort(([left], [right]) => right - left)) result = result.slice(0, position) + text + result.slice(position);
  return result;
}

module.exports = { instrumentPrototypeScreen };

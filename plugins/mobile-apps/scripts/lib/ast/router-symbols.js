'use strict';

const ROUTER_METHOD_NAMES = new Set(['navigate', 'push', 'replace']);

function expressionRouterStatus(context, expression, seen = new Set(), depth = 0) {
  const { ts, resolver } = context;
  if (!expression || depth > 5) return 'unknown';

  if (ts.isIdentifier(expression)) {
    if (resolver.isImportedFrom(expression, 'router', ['expo-router'])) return 'router';
    const target = resolver.resolveValueNode(expression);
    if (target && target !== expression) {
      return expressionRouterStatus(context, target, seen, depth + 1);
    }
  }

  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const callee = expression.expression;
    if (resolver.isImportedFrom(callee, 'useRouter', ['expo-router'])) return 'router';
    if (resolver.isImportedFrom(callee, 'useNavigation', ['@react-navigation/native'])) return 'router';

    const { local, externalModules } = resolver.declarationsFor(callee);
    for (const declaration of local) {
      if (seen.has(declaration)) continue;
      const nextSeen = new Set(seen);
      nextSeen.add(declaration);
      const fn = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
      if (!fn) continue;
      if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        const status = expressionRouterStatus(context, fn.body, nextSeen, depth + 1);
        if (status !== 'not-router') return status;
        continue;
      }
      const body = fn.body;
      if (!body || !ts.isBlock(body)) continue;
      for (const statement of body.statements) {
        if (!ts.isReturnStatement(statement) || !statement.expression) continue;
        const status = expressionRouterStatus(context, statement.expression, nextSeen, depth + 1);
        if (status !== 'not-router') return status;
      }
    }
    if (externalModules.length > 0 && /(?:Router|Navigation)$/.test(callee.text)) return 'unknown';
    return 'not-router';
  }

  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'router') {
    let root = expression.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (ts.isIdentifier(root)) {
      const binding = resolver.importBindingFor(root);
      return binding
        && binding.importedName === '*'
        && binding.moduleSpecifier === 'expo-router'
        ? 'router'
        : 'not-router';
    }
  }

  return 'not-router';
}

function routerReceiverStatus(context, receiver) {
  const { ts, resolver } = context;
  if (ts.isIdentifier(receiver)) {
    if (resolver.isImportedFrom(receiver, 'router', ['expo-router'])) return 'router';
    const { local } = resolver.declarationsFor(receiver);
    for (const declaration of local) {
      if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) continue;
      return expressionRouterStatus(context, declaration.initializer);
    }
    return 'not-router';
  }
  return expressionRouterStatus(context, receiver);
}

function isRouterMethodCall(context, node) {
  const { ts } = context;
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ROUTER_METHOD_NAMES.has(node.expression.name.text)
    && routerReceiverStatus(context, node.expression.expression) === 'router';
}

function routerMethodStatus(context, node) {
  const { ts } = context;
  if (!ts.isCallExpression(node)
    || !ts.isPropertyAccessExpression(node.expression)
    || !ROUTER_METHOD_NAMES.has(node.expression.name.text)) {
    return 'not-router';
  }
  return routerReceiverStatus(context, node.expression.expression);
}

module.exports = {
  expressionRouterStatus,
  isRouterMethodCall,
  routerMethodStatus,
  routerReceiverStatus,
  ROUTER_METHOD_NAMES,
};

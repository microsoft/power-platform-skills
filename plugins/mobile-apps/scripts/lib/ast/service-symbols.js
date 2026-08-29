'use strict';

function rootIdentifier(ts, node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : null;
}

function isExplicitGeneratedModule(moduleName) {
  const normalized = String(moduleName || '').replace(/\\/g, '/');
  return /^@\/generated(?:\/|$)/.test(normalized)
    || /^src\/generated(?:\/|$)/.test(normalized)
    || /^(?:\.\.?\/)+(?:src\/)?generated(?:\/|$)/.test(normalized);
}

function returnedExpressions(ts, declaration) {
  let fn = declaration;
  if (ts.isVariableDeclaration(declaration)) fn = declaration.initializer;
  if (ts.isPropertyAssignment(declaration)) fn = declaration.initializer;
  if (!fn || (!ts.isFunctionDeclaration(fn)
    && !ts.isFunctionExpression(fn)
    && !ts.isArrowFunction(fn)
    && !ts.isMethodDeclaration(fn))) {
    return [];
  }
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];

  const returns = [];
  const visit = (node) => {
    if (!node) return;
    if (node !== fn && (ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node))) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return returns;
}

function isGeneratedServiceReceiver(context, receiver, seen = new Set(), depth = 0) {
  const { ts, resolver } = context;
  if (!receiver || depth > 6 || seen.has(receiver)) return false;
  seen.add(receiver);

  if (ts.isCallExpression(receiver)) {
    const callee = ts.isIdentifier(receiver.expression)
      ? receiver.expression
      : (ts.isPropertyAccessExpression(receiver.expression) ? receiver.expression.name : null);
    if (!callee) return false;
    const resolvedCallee = resolver.declarationsFor(callee);
    for (const declaration of resolvedCallee.local) {
      for (const returned of returnedExpressions(ts, declaration)) {
        if (isGeneratedServiceReceiver(context, returned, seen, depth + 1)) return true;
      }
    }
    return false;
  }

  const identifier = rootIdentifier(ts, receiver);
  if (!identifier) return false;

  const { local, externalModules } = resolver.declarationsFor(identifier);
  if (externalModules.some(isExplicitGeneratedModule)) {
    return true;
  }
  if (local.some((declaration) => {
    const fileName = declaration.getSourceFile()?.fileName.replace(/\\/g, '/') || '';
    return /\/src\/generated(?:\/services)?\//.test(fileName);
  })) {
    return true;
  }

  const resolved = resolver.resolveValueNode(receiver);
  if (resolved && resolved !== receiver) {
    return isGeneratedServiceReceiver(context, resolved, seen, depth + 1);
  }
  if (receiver !== identifier) {
    const rootValue = resolver.resolveValueNode(identifier);
    if (rootValue && rootValue !== receiver) {
      return isGeneratedServiceReceiver(context, rootValue, seen, depth + 1);
    }
  }
  return false;
}

module.exports = { isExplicitGeneratedModule, isGeneratedServiceReceiver, rootIdentifier };

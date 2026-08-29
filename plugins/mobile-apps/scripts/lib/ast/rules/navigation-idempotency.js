'use strict';

const { routerMethodStatus } = require('../router-symbols');
const { isGeneratedServiceReceiver } = require('../service-symbols');

/**
 * Rule: navigation intent + submit idempotency.
 *
 *  - `router.push(...)` to a singleton route creates a duplicate screen instance
 *    on double-tap; those routes must use `router.navigate(...)`.
 *  - An async create/update must be behind a busy lock, or a double-tap writes
 *    two records.
 *  - A screen that navigates should have a duplicate-tap guard (advisory).
 *
 * The semantic version exists because the regex one demanded the lock be spelled
 * out *in the screen file* — `setIsSubmitting(true) … finally … (false)`. Apps
 * that centralise the guard in `useSubmitLock()` / `runLocked()` were blocked
 * even though they were strictly safer. Here the guard is looked up through the
 * checker: an app-local abstraction is inspected and accepted only when its own
 * body really implements lock semantics, and an abstraction that resolves into
 * an opaque package produces `unknown` instead of a block.
 */

const SINGLETON_ROUTE_RE = /\/(?:\(app\)\/)?(?:workout|recovery)\/form$|\/login$/;

// Flag names that plausibly denote a busy/idempotency guard. Used only after the
// structural shape (set true → set false, or early return) already matched.
const LOCK_NAME_RE = /submit|pending|saving|save|lock|busy|inflight|navigat|transition|tap|press|guard|mutat/i;

function normalizeFlagKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\.current$/, '')
    .replace(/^set/, '')
    .replace(/^is/, '')
    .replace(/ref$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function keysMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function booleanLiteralValue(ts, node) {
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function isFunctionLike(ts, node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node);
}

/** Collects the flag operations inside one function, excluding nested functions. */
function collectFlagOps(ts, root, value) {
  const operations = [];
  const visit = (node) => {
    if (!node) return;
    if (node !== root && isFunctionLike(ts, node)) return;
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const literal = booleanLiteralValue(ts, node.arguments[0]);
      if (literal === value) {
        operations.push({ key: normalizeFlagKey(node.expression.getText()), node });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const literal = booleanLiteralValue(ts, node.right);
      if (literal === value) {
        operations.push({ key: normalizeFlagKey(node.left.getText()), node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return operations.filter((operation) => operation.key);
}

function returnsEarly(ts, statement) {
  if (!statement) return false;
  if (ts.isReturnStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    return statement.statements.some((inner) => ts.isReturnStatement(inner));
  }
  return false;
}

function enclosingFunction(ts, node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(ts, current)) return current;
    current = current.parent;
  }
  return null;
}

function nodeContains(ancestor, descendant) {
  return ancestor.pos <= descendant.pos && ancestor.end >= descendant.end;
}

function collectGuards(ts, fn) {
  const guards = [];
  const visit = (node) => {
    if (!node) return;
    if (node !== fn && isFunctionLike(ts, node)) return;
    if (ts.isIfStatement(node) && returnsEarly(ts, node.thenStatement)) {
      const key = normalizeFlagKey(node.expression.getText());
      if (key && LOCK_NAME_RE.test(key)) guards.push({ key, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return guards;
}

function collectTryStatements(ts, fn) {
  const tries = [];
  const visit = (node) => {
    if (!node) return;
    if (node !== fn && isFunctionLike(ts, node)) return;
    if (ts.isTryStatement(node) && node.finallyBlock) tries.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return tries;
}

function functionProtectsOperation(ts, fn, operation) {
  if (!fn) return false;
  const guards = collectGuards(ts, fn);
  const setTrue = collectFlagOps(ts, fn, true);
  for (const tryStatement of collectTryStatements(ts, fn)) {
    if (!nodeContains(tryStatement.tryBlock, operation)) continue;
    const releases = collectFlagOps(ts, tryStatement.finallyBlock, false);
    for (const guard of guards) {
      if (guard.node.pos >= operation.pos) continue;
      const acquire = setTrue.find(
        (candidate) => candidate.node.pos > guard.node.pos
          && candidate.node.pos < operation.pos
          && keysMatch(guard.key, candidate.key),
      );
      if (!acquire) continue;
      if (releases.some((release) => keysMatch(guard.key, release.key))) return true;
    }
  }
  return false;
}

function functionProtectsCallback(ts, fn, parameterIndex) {
  if (!fn || !fn.parameters || parameterIndex < 0 || parameterIndex >= fn.parameters.length) return false;
  const parameter = fn.parameters[parameterIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) return false;
  const callbackName = parameter.name.text;
  const callbackAwaits = [];
  const visit = (node) => {
    if (!node) return;
    if (node !== fn && isFunctionLike(ts, node)) return;
    if (ts.isAwaitExpression(node)
      && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === callbackName) {
      callbackAwaits.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return callbackAwaits.some((operation) => functionProtectsOperation(ts, fn, operation));
}

function rootContainsProtectedCallback(ts, root, memberName, parameterIndex) {
  if (!memberName) {
    if (isFunctionLike(ts, root)) return functionProtectsCallback(ts, root, parameterIndex);
    if (ts.isVariableDeclaration(root) && root.initializer && isFunctionLike(ts, root.initializer)) {
      return functionProtectsCallback(ts, root.initializer, parameterIndex);
    }
    if (ts.isPropertyAssignment(root) && isFunctionLike(ts, root.initializer)) {
      return functionProtectsCallback(ts, root.initializer, parameterIndex);
    }
    return false;
  }

  let matched = false;
  const visit = (node) => {
    if (!node || matched) return;
    let candidate = null;
    if (!memberName && isFunctionLike(ts, node)) {
      candidate = node;
    } else if (memberName && ts.isMethodDeclaration(node)
      && node.name && node.name.getText().replace(/['"]/g, '') === memberName) {
      candidate = node;
    } else if (memberName && ts.isPropertyAssignment(node)
      && node.name && node.name.getText().replace(/['"]/g, '') === memberName
      && isFunctionLike(ts, node.initializer)) {
      candidate = node.initializer;
    } else if (memberName && ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name) && node.name.text === memberName
      && node.initializer && isFunctionLike(ts, node.initializer)) {
      candidate = node.initializer;
    } else if (memberName && ts.isFunctionDeclaration(node)
      && node.name && node.name.text === memberName) {
      candidate = node;
    }
    if (candidate && functionProtectsCallback(ts, candidate, parameterIndex)) {
      matched = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matched;
}

function enclosingWrapperCall(ts, operation) {
  let current = operation;
  while (current.parent) {
    if (isFunctionLike(ts, current) && ts.isCallExpression(current.parent)) {
      if (current.parent.arguments.includes(current)) return current.parent;
    }
    current = current.parent;
  }
  return null;
}

function variableDeclarationForBinding(ts, declaration) {
  let current = declaration;
  while (current && !ts.isVariableDeclaration(current)) current = current.parent;
  return current;
}

function wrapperLockRoots(context, wrapperCall, parameterIndex) {
  const { ts, resolver } = context;
  const candidates = [];
  const unknownBoundaries = [];
  let callee = wrapperCall.expression;
  let objectInitializer = null;
  let memberName = null;

  if (ts.isPropertyAccessExpression(callee)) {
    memberName = callee.name.text;
    const root = callee.expression;
    if (ts.isIdentifier(root)) objectInitializer = resolver.resolveValueNode(root);
    callee = callee.name;
  }
  if (!ts.isIdentifier(callee)) return { candidates, unknownBoundaries };
  if (!LOCK_NAME_RE.test(callee.text)) return { candidates, unknownBoundaries };

  const addHookRoots = (initializer) => {
    if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) return;
    const hook = resolver.declarationsFor(initializer.expression);
    for (const root of hook.local) {
      candidates.push({ root, memberName: memberName || callee.text, parameterIndex });
    }
    if (hook.local.length === 0) unknownBoundaries.push(...hook.externalModules);
  };

  if (objectInitializer) addHookRoots(objectInitializer);
  const resolved = resolver.declarationsFor(callee);
  for (const declaration of resolved.local) {
    if (ts.isBindingElement(declaration)) {
      addHookRoots(variableDeclarationForBinding(ts, declaration)?.initializer);
    } else {
      candidates.push({ root: declaration, memberName: null, parameterIndex });
    }
  }
  if (resolved.local.length === 0) unknownBoundaries.push(...resolved.externalModules);
  return { candidates, unknownBoundaries };
}

function wrapperLockStatus(context, operation) {
  const { ts } = context;
  const wrapper = enclosingWrapperCall(ts, operation);
  if (!wrapper) return { matched: false, unknownBoundaries: [] };
  const parameterIndex = wrapper.arguments.findIndex((argument) => nodeContains(argument, operation));
  if (parameterIndex < 0) return { matched: false, unknownBoundaries: [] };
  const resolved = wrapperLockRoots(context, wrapper, parameterIndex);
  for (const candidate of resolved.candidates) {
    if (rootContainsProtectedCallback(
      ts,
      candidate.root,
      candidate.memberName,
      candidate.parameterIndex,
    )) {
      return { matched: true, unknownBoundaries: [] };
    }
  }
  return { matched: false, unknownBoundaries: resolved.unknownBoundaries };
}

function functionIdentity(ts, fn) {
  if (!fn) return null;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
    && ts.isVariableDeclaration(fn.parent)) {
    return fn.parent;
  }
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
    && ts.isPropertyAssignment(fn.parent)) {
    return fn.parent;
  }
  return fn;
}

function callSitesForFunction(context, rootSource, fn) {
  const { ts, resolver } = context;
  const identity = functionIdentity(ts, fn);
  if (!identity) return [];
  const calls = [];
  const seen = new Set();
  resolver.walk([rootSource], (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isIdentifier(node.expression)
      ? node.expression
      : (ts.isPropertyAccessExpression(node.expression) ? node.expression.name : null);
    if (!callee) return;
    const declarations = resolver.declarationsFor(callee).local;
    if (!declarations.some((declaration) => declaration === identity || declaration === fn)) return;
    const key = `${node.getSourceFile().fileName}:${node.pos}:${node.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push(node);
    }
  });
  return calls;
}

function operationLockStatus(context, operation, rootSource, seenFunctions = new Set()) {
  const { ts } = context;
  const fn = enclosingFunction(ts, operation);
  if (functionProtectsOperation(ts, fn, operation)) {
    return { matched: true, unknownBoundaries: [] };
  }

  const wrapper = wrapperLockStatus(context, operation);
  if (wrapper.matched || wrapper.unknownBoundaries.length > 0) return wrapper;

  const identity = functionIdentity(ts, fn);
  if (!identity || seenFunctions.has(identity)) return { matched: false, unknownBoundaries: [] };
  seenFunctions.add(identity);
  const callSites = callSitesForFunction(context, rootSource, fn);
  if (callSites.length === 0) return { matched: false, unknownBoundaries: [] };

  const unknownBoundaries = [];
  for (const callSite of callSites) {
    const status = operationLockStatus(context, callSite, rootSource, new Set(seenFunctions));
    if (!status.matched && status.unknownBoundaries.length === 0) {
      return { matched: false, unknownBoundaries: [] };
    }
    if (!status.matched) unknownBoundaries.push(...status.unknownBoundaries);
  }
  return unknownBoundaries.length > 0
    ? { matched: false, unknownBoundaries: [...new Set(unknownBoundaries)] }
    : { matched: true, unknownBoundaries: [] };
}

function saveLockStatus(context, saveCall, rootSource) {
  return operationLockStatus(context, saveCall, rootSource);
}

module.exports = {
  id: 'navigation-idempotency',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!/\.(?:jsx|tsx)$/.test(normalized)) return false;
    if (normalized.includes('/shared/samples/')) return false;
    return normalized.includes('/app/');
  },

  run(context, sourceFile) {
    const { ts, resolver } = context;

    const saveCalls = [];
    resolver.walk([sourceFile], (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;

        const routerStatus = routerMethodStatus(context, node);
        if (routerStatus === 'router') {
          if (method === 'push') checkSingletonPush(context, node.getSourceFile(), node);
        } else if (routerStatus === 'unknown') {
          context.report(node.getSourceFile(), node, {
            status: 'unknown',
            rule: 'navigation-receiver-unresolved',
            message:
              'A push/navigate/replace receiver may be an app router abstraction, but its implementation could not be resolved. Singleton-route behavior was not verified.',
          });
        }

        if ((method === 'create' || method === 'update')
          && isGeneratedServiceReceiver(context, node.expression.expression)) {
          saveCalls.push(node);
        }
      }
    });

    for (const saveCall of saveCalls) {
      const evidence = saveLockStatus(context, saveCall, sourceFile);
      if (!evidence.matched) {
        const status = evidence.unknownBoundaries.length > 0 ? 'unknown' : 'fail';
        const suffix = evidence.unknownBoundaries.length > 0
          ? ` The analyzer could not inspect ${evidence.unknownBoundaries.join(', ')}, so this is reported as unknown rather than a failure.`
          : '';
        context.report(saveCall.getSourceFile(), saveCall, {
          status,
          rule: 'submit-lock',
          message:
            'Async save flow has no resolvable submit lock. Guard the save with an early return on a busy state/ref, set that same flag before work, reset it in `finally`, or use an app-local `useSubmitLock`/`runLocked` helper that implements equivalent exclusion.'
            + suffix,
        });
      }
    }

    // Missing a navigation tap guard is advisory rather than a provable defect,
    // so it is not emitted as a per-screen unknown. Singleton push misuse and
    // save idempotency remain enforceable findings above.
  },
};

function checkSingletonPush(context, sourceFile, call) {
  const { ts, resolver } = context;
  const argument = call.arguments[0];
  if (!argument) return;

  const routes = [];
  if (ts.isObjectLiteralExpression(argument)) {
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      if (resolver.propertyName(property) !== 'pathname') continue;
      routes.push(...resolver.evaluateStrings(property.initializer).values);
    }
  } else {
    routes.push(...resolver.evaluateStrings(argument).values);
  }

  for (const route of routes) {
    const withoutQuery = route.text.split('?')[0].trim();
    if (!SINGLETON_ROUTE_RE.test(withoutQuery)) continue;
    context.report(sourceFile, call, {
      status: 'fail',
      rule: 'navigation-singleton-push',
      message: `Use router.navigate(...) for singleton route "${withoutQuery}". router.push(...) can create duplicate instances on double-tap.`,
    });
  }
}

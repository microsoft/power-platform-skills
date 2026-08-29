'use strict';

/**
 * Rule: screens whose approved plan says `Pagination: cursor` must implement a
 * real server-paged read, not a bounded first page.
 *
 * The plan (`native-app-plan.md`) selects which screens this applies to; the
 * TypeScript program decides whether the screen satisfies the contract. Two
 * things the regex version got wrong:
 *   - an app-local wrapper hook (`useIncidentCursor` in `src/hooks/`) that calls
 *     `useInfiniteQuery` internally counted as "no cursor path" and blocked;
 *   - `getAll` options hoisted into a `const LIST_OPTIONS = {...}` were invisible,
 *     so `select` / `orderBy` / `maxPageSize` were reported missing.
 * Both are now resolved through the checker; anything that resolves into an
 * opaque package yields `unknown` instead of a block.
 */

const { isCursorSpec, readScreenSpec } = require('../../screen-plan-spec');
const { isGeneratedServiceReceiver } = require('../service-symbols');

const CURSOR_HOOKS = new Set(['useCursorListData', 'useInfiniteQuery']);
const BOUNDED_HOOKS = new Map([
  ['useListData', 'Cursor-paginated screens must not use `useListData`; it loads one bounded page. Use `useCursorListData`, `useInfiniteQuery`, or an app-specific cursor hook.'],
  ['useSearchFilter', 'Cursor-paginated screens must not use `useSearchFilter`; it filters only loaded rows. Push search into the service `filter` option.'],
]);

module.exports = {
  id: 'dataverse-heavy-lists',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.includes('/app/')) return false;
    if (normalized.includes('/shared/samples/')) return false;
    const { spec } = readScreenSpec(filePath);
    return isCursorSpec(spec);
  },

  run(context, sourceFile) {
    const { ts, resolver, jsx } = context;

    let usesCursorHook = false;
    let cursorHookUnknown = false;
    let usesBoundedHook = false;
    const getAllCalls = [];
    let flatListWithoutEndReached = null;
    let flatListSpread = false;
    const { unknownBoundaries } = resolver.walk([sourceFile], (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const cursorStatus = hookStatus(context, node, CURSOR_HOOKS, {
          external: new Map([['useInfiniteQuery', ['@tanstack/react-query']]]),
          localDirectory: '/src/hooks/',
        });
        if (cursorStatus === 'match') usesCursorHook = true;
        if (cursorStatus === 'unknown') cursorHookUnknown = true;

        const boundedName = [...BOUNDED_HOOKS.keys()].find((name) => (
          hookStatus(context, node, new Set([name]), { localDirectory: '/src/hooks/' }) === 'match'
        ));
        if (boundedName && node.getSourceFile() === sourceFile) {
          usesBoundedHook = true;
          context.report(sourceFile, node, {
            status: 'fail',
            rule: 'dataverse-heavy-lists',
            message: BOUNDED_HOOKS.get(boundedName),
          });
        }
      }

      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'getAll'
        && isGeneratedServiceReceiver(context, node.expression.expression)) {
        getAllCalls.push(node);
      }

      if (jsx.isOpeningLike(node)
        && /^(FlatList|FlashList|SectionList)$/.test(jsx.canonicalTagName(node, resolver))) {
        if (jsx.hasSpread(node)) flatListSpread = true;
        else if (!jsx.hasAttribute(node, 'onEndReached')) flatListWithoutEndReached = node;
      }
    });

    if (!usesCursorHook && !usesBoundedHook) {
      const unresolved = cursorHookUnknown || unknownBoundaries.length > 0;
      const status = unresolved ? 'unknown' : 'fail';
      const suffix = unresolved
        ? ` The analyzer could not inspect ${unknownBoundaries.join(', ') || 'the cursor hook implementation'}, so this is reported as unknown rather than a failure.`
        : '';
      context.report(sourceFile, sourceFile, {
        status,
        rule: 'dataverse-heavy-lists',
        message: `Cursor-paginated screens must use \`useCursorListData\`, React Query \`useInfiniteQuery\`, or an app-local hook that wraps one of them.${suffix}`,
      });
    }

    if (flatListWithoutEndReached) {
      context.report(flatListWithoutEndReached.getSourceFile(), flatListWithoutEndReached, {
        status: 'fail',
        rule: 'dataverse-heavy-lists',
        message: 'Cursor-paginated list must wire `onEndReached` to load the next page.',
      });
    } else if (flatListSpread) {
      context.report(sourceFile, sourceFile, {
        status: 'unknown',
        rule: 'dataverse-heavy-lists',
        message: 'List props are spread from a value the analyzer cannot resolve, so `onEndReached` wiring was not verified.',
      });
    }

    for (const call of getAllCalls) {
      checkGetAllOptions(context, call.getSourceFile(), call);
    }
  },
};

function declarationName(ts, declaration) {
  if (declaration.name && ts.isIdentifier(declaration.name)) return declaration.name.text;
  if ((ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration))
    && declaration.parent && declaration.parent.name && ts.isIdentifier(declaration.parent.name)) {
    return declaration.parent.name.text;
  }
  return null;
}

function directExternalHook(context, call, expected, modules) {
  const { ts, resolver } = context;
  if (!ts.isIdentifier(call.expression)) return false;
  return modules.some((moduleName) => resolver.isImportedFrom(call.expression, expected, [moduleName]));
}

function hookStatus(context, call, expectedNames, options = {}) {
  const { ts, resolver } = context;
  if (!ts.isIdentifier(call.expression)) return 'no-match';

  for (const expected of expectedNames) {
    const modules = options.external?.get(expected) || [];
    if (directExternalHook(context, call, expected, modules)) return 'match';
  }

  const resolved = resolver.declarationsFor(call.expression);
  let unknown = false;
  for (const declaration of resolved.local) {
    const fileName = declaration.getSourceFile()?.fileName.replace(/\\/g, '/') || '';
    const name = declarationName(ts, declaration);
    if (options.localDirectory
      && fileName.includes(options.localDirectory)
      && name
      && expectedNames.has(name)) {
      return 'match';
    }
    const evidence = resolver.search([declaration], (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
      for (const expected of expectedNames) {
        const modules = options.external?.get(expected) || [];
        if (directExternalHook(context, node, expected, modules)) return true;
        const innerName = node.expression.text;
        if (innerName === expected) {
          const innerResolved = resolver.declarationsFor(node.expression);
          if (innerResolved.local.some((inner) => {
            const innerFile = inner.getSourceFile()?.fileName.replace(/\\/g, '/') || '';
            return options.localDirectory
              && innerFile.includes(options.localDirectory)
              && declarationName(ts, inner) === expected;
          })) return true;
        }
      }
      return false;
    });
    if (evidence.matched) return 'match';
    if (evidence.unknownBoundaries.length > 0) unknown = true;
  }
  if (resolved.local.length === 0 && resolved.externalModules.length > 0
    && [...expectedNames].some((expected) => call.expression.text === expected)) {
    unknown = true;
  }
  return unknown ? 'unknown' : 'no-match';
}

function checkGetAllOptions(context, sourceFile, call) {
  const { ts, resolver } = context;
  const optionsArgument = call.arguments[0];
  if (!optionsArgument) {
    context.report(sourceFile, call, {
      status: 'fail',
      rule: 'dataverse-heavy-lists',
      message: 'Cursor-paginated Dataverse `getAll` must pass `select`, deterministic `orderBy`, and SDK `maxPageSize`.',
    });
    return;
  }

  let objectNode = optionsArgument;
  if (ts.isIdentifier(objectNode) || ts.isPropertyAccessExpression(objectNode)) {
    objectNode = resolver.resolveValueNode(objectNode) || objectNode;
  }
  if (ts.isAsExpression(objectNode) || ts.isParenthesizedExpression(objectNode)) {
    objectNode = objectNode.expression;
  }
  if (!objectNode || !ts.isObjectLiteralExpression(objectNode)) {
    context.report(sourceFile, call, {
      status: 'unknown',
      rule: 'dataverse-heavy-lists',
      message: '`getAll` options could not be resolved to an object literal, so cursor-list options were not verified.',
    });
    return;
  }

  const options = new Map();
  const collectOptions = (object, seen = new Set()) => {
    if (!object || seen.has(object)) return false;
    seen.add(object);
    let complete = true;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        let target = resolver.resolveValueNode(property.expression);
        if (target && (ts.isAsExpression(target) || ts.isParenthesizedExpression(target))) {
          target = target.expression;
        }
        if (!target || !ts.isObjectLiteralExpression(target)) {
          complete = false;
        } else if (!collectOptions(target, seen)) {
          complete = false;
        }
        continue;
      }
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : resolver.propertyName(property);
      if (name) {
        const value = ts.isShorthandPropertyAssignment(property)
          ? property.name
          : (ts.isPropertyAssignment(property) ? property.initializer : null);
        options.set(name, value);
      }
    }
    return complete;
  };

  if (!collectOptions(objectNode)) {
    context.report(sourceFile, call, {
      status: 'unknown',
      rule: 'dataverse-heavy-lists',
      message: '`getAll` options spread a value the analyzer cannot resolve, so cursor-list options were not verified.',
    });
    return;
  }

  const required = [
    ['select', 'Cursor-paginated Dataverse `getAll` calls must include `select` so heavy lists do not fetch every column.'],
    ['orderBy', 'Cursor-paginated Dataverse `getAll` calls must include deterministic `orderBy`, including a unique key.'],
    ['maxPageSize', 'Cursor-paginated Dataverse `getAll` calls must use SDK `maxPageSize` for page size. `top` alone is a capped first page, not server paging.'],
  ];
  for (const [key, message] of required) {
    if (!options.has(key)) {
      context.report(sourceFile, call, { status: 'fail', rule: 'dataverse-heavy-lists', message });
    }
  }

  if (options.has('skip') && !options.has('skipToken')) {
    context.report(sourceFile, call, {
      status: 'fail',
      rule: 'dataverse-heavy-lists',
      message: 'Cursor-paginated Dataverse reads must not use SDK `skip`; use the returned `skipToken` for the next page.',
    });
  }

  if (!options.has('skipToken')) {
    context.report(sourceFile, call, {
      status: 'fail',
      rule: 'dataverse-heavy-lists',
      message: 'Cursor-paginated Dataverse reads must pass the SDK cursor as `skipToken` on this `getAll` call. A `pageParam` or `fetchNextPage` elsewhere does not prove that later requests advance beyond the first page.',
    });
  } else {
    const cursorStatus = cursorValueStatus(context, options.get('skipToken'));
    if (cursorStatus === 'invalid' || cursorStatus === 'empty') {
      context.report(sourceFile, call, {
        status: 'fail',
        rule: 'dataverse-heavy-lists',
        message: '`skipToken` is present but has a static empty or constant value. Pass the current page cursor (`pageParam` or the previous response skip token) so later requests advance.',
      });
    } else if (cursorStatus === 'unknown') {
      context.report(sourceFile, call, {
        status: 'unknown',
        rule: 'dataverse-heavy-lists',
        message: '`skipToken` is present, but the analyzer could not prove that its value comes from the current page cursor.',
      });
    }
  }
}

function cursorValueStatus(context, value, seen = new Set(), depth = 0) {
  const { ts, resolver } = context;
  if (!value || depth > 5 || seen.has(value)) return 'unknown';
  seen.add(value);

  let node = value;
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) {
    node = node.expression;
  }
  if (!node) return 'unknown';
  if (node.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(node) && node.text === 'undefined')
    || ts.isVoidExpression(node)) {
    return 'empty';
  }
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return 'invalid';
  }

  const cursorName = /pageParam|skipToken|nextLink|cursor|continuation/i;
  if (ts.isIdentifier(node)) {
    if (cursorName.test(node.text)) return 'cursor';
    const declarations = resolver.declarationsFor(node).local;
    if (declarations.some((declaration) => (
      ts.isBindingElement(declaration)
      && declaration.propertyName
      && cursorName.test(declaration.propertyName.getText())
    ))) {
      return 'cursor';
    }
    const resolved = resolver.resolveValueNode(node);
    return resolved
      ? cursorValueStatus(context, resolved, seen, depth + 1)
      : 'unknown';
  }

  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const propertyName = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : (node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : '');
    if (cursorName.test(propertyName)) return 'cursor';
    const resolved = resolver.resolveValueNode(node);
    return resolved
      ? cursorValueStatus(context, resolved, seen, depth + 1)
      : 'unknown';
  }

  if (ts.isConditionalExpression(node)) {
    const branches = [
      cursorValueStatus(context, node.whenTrue, new Set(seen), depth + 1),
      cursorValueStatus(context, node.whenFalse, new Set(seen), depth + 1),
    ];
    if (branches.includes('invalid')) return 'invalid';
    if (branches.includes('cursor') && branches.every((status) => status === 'cursor' || status === 'empty')) {
      return 'cursor';
    }
    return branches.every((status) => status === 'cursor') ? 'cursor' : 'unknown';
  }

  return 'unknown';
}

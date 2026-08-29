'use strict';

const { isGeneratedServiceReceiver } = require('../service-symbols');

/**
 * Rule: Dataverse read/write payloads that return HTTP 400 at runtime.
 *
 * A1 — a `select: [...]` list containing a virtual `*name` shadow column
 *      (`cr123_projectidname`, `statename`, `statuscodename`, ...). The Web API
 *      rejects the whole request, so every list read on that screen fails.
 *      See https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api
 *
 * A2 — a create/update payload containing a server-managed column
 *      (`ownerid`, `statecode`, `createdon`, ...). The server owns these; sending
 *      them fails every save.
 *
 * The AST version fixes two regex gaps that mattered in practice:
 *   - `select: SELECT_COLUMNS` (a hoisted `const`) was never inspected.
 *   - quoted keys (`'statecode': 0`) and computed keys were invisible, while
 *     the literal `statecode` inside an unrelated nested object was flagged.
 * A spread of something the analyzer cannot resolve yields `unknown`, not a
 * block, because the payload's real shape is genuinely not knowable.
 */

const SELECT_FORBIDDEN_SUFFIX_RE = /^\w*(?:idname|statename|statusname|statecodename|statuscodename)$/;

const SERVER_MANAGED_COLUMNS = new Set([
  'createdby',
  'createdon',
  'importsequencenumber',
  'modifiedby',
  'modifiedon',
  'overriddencreatedon',
  'ownerid',
  'owneridtype',
  'statecode',
  'statuscode',
  'timezoneruleversionnumber',
  'utcconversiontimezonecode',
  'versionnumber',
]);

const A1_FIX =
  'Remove the virtual `*name` column from `select`, add `_<lookup>_value` instead, and read labels with `lookupName(record, ...)` / `formattedValue(record, ...)` from `@/utils`.';

const A2_FIX =
  'Remove the server-owned key from the payload. If the generated model marks it required, satisfy the type with `as any` at the call site; never emit `ownerid: \'\'` or `statecode: 0`. Use SetState/SetStatus and Assign actions instead.';

module.exports = {
  id: 'dataverse-payload',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.includes('/src/') || normalized.includes('/app/');
  },

  run(context, sourceFile) {
    const { ts, resolver } = context;
    resolver.walk([sourceFile], (node) => {
      if (ts.isCallExpression(node)) {
        checkReadCall(context, node.getSourceFile(), node);
        checkWriteCall(context, node.getSourceFile(), node);
      }
    });
  },

  SERVER_MANAGED_COLUMNS,
  SELECT_FORBIDDEN_SUFFIX_RE,
};

function checkReadCall(context, sourceFile, call) {
  const { ts } = context;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text !== 'getAll') return;
  if (!isGeneratedServiceReceiver(context, call.expression.expression)) return;

  const options = resolveObjectLiteral(context, call.arguments[0]);
  if (!options.node && !options.unknown) return;
  if (options.unknown) {
    context.report(sourceFile, call, {
      status: 'unknown',
      rule: 'dataverse-select-shadow-column',
      message:
        '`getAll()` options could not be resolved to an object literal, so the Dataverse select list was not verified.',
    });
    return;
  }

  const select = findObjectProperty(context, options.node, 'select');
  if (!select) return;
  checkSelect(context, sourceFile, select);
}

function checkSelect(context, sourceFile, property) {
  const evaluated = context.resolver.evaluateStringArray(property.initializer);
  for (const column of evaluated.values) {
    if (!SELECT_FORBIDDEN_SUFFIX_RE.test(column)) continue;
    context.report(sourceFile, property, {
      status: 'fail',
      rule: 'dataverse-select-shadow-column',
      message: `\`select\` contains virtual shadow column "${column}", which returns HTTP 400 from the Dataverse Web API. ${A1_FIX}`,
    });
  }
  if (evaluated.unknown && evaluated.values.length === 0) {
    context.report(sourceFile, property, {
      status: 'unknown',
      rule: 'dataverse-select-shadow-column',
      message:
        '`select` list could not be resolved to string literals, so shadow-column usage was not verified. Confirm no `*idname`/`statename`/`statuscodename` columns are requested.',
    });
  }
}

/**
 * Recognises `<x>Service.create(payload)` / `.update(id, payload)` — including
 * `await api.projects.update(...)` — by requiring a `.create`/`.update` member
 * call whose payload argument is an object-ish expression.
 */
function checkWriteCall(context, sourceFile, call) {
  const { ts } = context;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  if (method !== 'create' && method !== 'update') return;
  if (!isGeneratedServiceReceiver(context, call.expression.expression)) return;

  const payloadArgument = method === 'create' ? call.arguments[0] : call.arguments[1];
  if (!payloadArgument) return;

  const keys = collectPayloadKeys(context, payloadArgument, new Set());
  for (const { name, node } of keys.known) {
    if (!SERVER_MANAGED_COLUMNS.has(name.toLowerCase())) continue;
    context.report(sourceFile, node || call, {
      status: 'fail',
      rule: 'dataverse-server-managed-payload',
      message: `\`${method}()\` payload includes server-managed column "${name}", which returns HTTP 400 on every save. ${A2_FIX}`,
    });
  }

  if (keys.unknown) {
    context.report(sourceFile, call, {
      status: 'unknown',
      rule: 'dataverse-server-managed-payload',
      message: `\`${method}()\` payload is built from a value this analyzer cannot resolve (spread or dynamic object), so server-managed columns were not verified.`,
    });
  }
}

function resolveObjectLiteral(context, node, seen = new Set()) {
  const { ts, resolver } = context;
  if (!node) return { node: null, unknown: false };
  let current = node;
  while (ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) {
    const target = resolver.resolveValueNode(current, seen);
    if (!target) return { node: null, unknown: true };
    return resolveObjectLiteral(context, target, seen);
  }
  return ts.isObjectLiteralExpression(current)
    ? { node: current, unknown: false }
    : { node: null, unknown: true };
}

function findObjectProperty(context, object, expectedName) {
  const { ts, resolver } = context;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (resolver.propertyName(property) === expectedName) return property;
  }
  return null;
}

/**
 * @returns {{ known: Array<{ name: string, node: object }>, unknown: boolean }}
 */
function collectPayloadKeys(context, node, seen) {
  const { ts, resolver } = context;
  const result = { known: [], unknown: false };
  if (!node) return result;

  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression?.(node)) {
    return collectPayloadKeys(context, node.expression, seen);
  }

  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const target = resolver.resolveValueNode(node, seen);
    if (!target) {
      result.unknown = true;
      return result;
    }
    return collectPayloadKeys(context, target, seen);
  }

  if (ts.isCallExpression(node)) {
    // `buildPayload(form)` — inspect every return path in an app-local helper.
    // Nested functions are excluded so an unrelated callback cannot become a
    // payload branch.
    const returned = resolveReturns(context, node);
    if (returned.length > 0) {
      for (const expression of returned) {
        const branch = collectPayloadKeys(context, expression, new Set(seen));
        result.known.push(...branch.known);
        if (branch.unknown) result.unknown = true;
      }
      return result;
    }
    result.unknown = true;
    return result;
  }

  if (!ts.isObjectLiteralExpression(node)) {
    result.unknown = true;
    return result;
  }

  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = collectPayloadKeys(context, property.expression, seen);
      result.known.push(...spread.known);
      if (spread.unknown) result.unknown = true;
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : resolver.propertyName(property);
      if (name) result.known.push({ name, node: property });
      else result.unknown = true;
    }
  }

  return result;
}

function resolveReturns(context, call) {
  const { ts, resolver } = context;
  if (!ts.isIdentifier(call.expression)) return [];
  const { local } = resolver.declarationsFor(call.expression);
  const expressions = [];
  for (const declaration of local) {
    const fn = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    if (!fn) continue;
    if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) {
      expressions.push(fn.body);
      continue;
    }
    const body = fn.body;
    if (!body || !ts.isBlock(body)) continue;
    const visit = (node) => {
      if (node !== fn && (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node))) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression) {
        expressions.push(node.expression);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }
  return expressions;
}

'use strict';

/**
 * Route param contract analysis shared by `scripts/check-routes.js`.
 *
 * Catches the "screen A sends, screen B ignores" bug class: when several screens
 * navigate to one destination with different param sets, the destination's
 * `useLocalSearchParams<{...}>()` may declare only one sender's params and the
 * rest are silently dropped at runtime.
 *
 * TypeScript AST analysis sees aliased imports (`useLocalSearchParams as
 * useParams`), params built from constants, and navigation performed by an
 * app-local helper (`goToInspection(id)`) rather than an inline
 * `router.push`. If TypeScript is unavailable, structural path collisions are
 * still reported, but semantic route/parameter analysis is `unknown` and never
 * guessed from source text.
 *
 * Route derivation (file path → Expo route) and the diffing logic are shared by
 * both backends so the two can never disagree about what a route is.
 */

const fs = require('node:fs');
const path = require('node:path');

const { createProgram } = require('./program');
const { Resolver } = require('./resolve');
const { createJsxHelpers } = require('./jsx');
const { loadTypeScript } = require('./typescript-loader');
const { routerMethodStatus } = require('./router-symbols');

// ── Shared: file paths → routes ─────────────────────────────────────────────

function findTsxFiles(dir) {
  const out = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && /\.tsx$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

/**
 * app/(app)/inspections/[id]/defect.tsx → /inspections/[id]/defect
 * app/(app)/_layout.tsx                 → null (layout, not a screen)
 * app/(app)/inspections/index.tsx       → /inspections
 */
function fileToRoute(filePath, appRoot) {
  const rel = path.relative(appRoot, filePath).replace(/\\/g, '/');
  const noExt = rel.replace(/\.tsx$/, '');
  if (/(^|\/)_layout$/.test(noExt)) return null;
  if (/(^|\/)\+not-found$/.test(noExt)) return null;
  const segs = noExt.split('/').filter((segment) => !/^\(.+\)$/.test(segment));
  const cleaned = segs
    .map((segment) => (segment === 'index' ? '' : segment))
    .filter((segment, index, all) => !(segment === '' && index < all.length - 1));
  let route = `/${cleaned.join('/').replace(/\/$/, '')}`;
  if (route === '/' && cleaned[cleaned.length - 1] === '') route = '/';
  return route || '/';
}

function normalizeRoute(route) {
  const segs = String(route || '').split('/').filter((segment) => !/^\(.+\)$/.test(segment));
  return segs.join('/').replace(/\/+/g, '/');
}

/**
 * Sender routes carry positional `[X]` placeholders (the sender interpolates an
 * arbitrary variable); destinations carry named `[id]` segments. Match on
 * segment count with dynamic destination segments acting as wildcards.
 */
function matchSenderToDest(senderRoute, destRoutes) {
  const normalizedSender = normalizeRoute(senderRoute);
  if (destRoutes.includes(normalizedSender)) return normalizedSender;

  const senderSegments = normalizedSender.split('/').filter(Boolean);
  const candidates = [];
  for (const destination of destRoutes) {
    const destinationSegments = destination.split('/').filter(Boolean);
    if (senderSegments.length !== destinationSegments.length) continue;
    let allMatch = true;
    let literalMatches = 0;
    for (let index = 0; index < senderSegments.length; index += 1) {
      const destinationSegment = destinationSegments[index];
      if (/^\[.+\]$/.test(destinationSegment)) continue;
      if (senderSegments[index] === destinationSegment) {
        literalMatches += 1;
        continue;
      }
      allMatch = false;
      break;
    }
    if (allMatch) candidates.push({ destination, literalMatches });
  }
  candidates.sort((left, right) => right.literalMatches - left.literalMatches);
  return candidates.length > 0 ? candidates[0].destination : null;
}

function destPathParams(destRoute) {
  const out = [];
  for (const segment of destRoute.split('/').filter(Boolean)) {
    const match = segment.match(/^\[(.+)\]$/);
    if (match) out.push(match[1]);
  }
  return out;
}

function buildSuggestedType(allParams, alreadyDeclared = {}) {
  const parts = [];
  for (const [name, kind] of Object.entries(allParams)) {
    if (alreadyDeclared[name] === 'required') {
      parts.push(`${name}: string`);
    } else {
      parts.push(`${name}${kind === 'path' ? '' : '?'}: string`);
    }
  }
  return parts.join('; ');
}

/**
 * Turns a raw URL into a comparable route plus its query param names.
 * `/foo/${bar}/baz?zone=${z}&editId=1` → route `/foo/[X]/baz`, params {zone, editId}
 */
function parseUrlPattern(rawUrl) {
  const cleaned = String(rawUrl).replace(/\$\{[^}]*\}/g, '__INTERP__').replace(/\u0000/g, '__INTERP__');
  const [pathPart, queryPart] = cleaned.split('?');
  const params = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [key] = pair.split('=');
      if (key && key !== '__INTERP__') params[key] = 'query';
    }
  }
  return { route: pathPart.replace(/__INTERP__/g, '[X]'), params };
}

// ── Shared: collision + diff ────────────────────────────────────────────────

function collectStructuralFindings(appRoot, files) {
  const screenFiles = files.filter((file) => path.basename(file) !== '_layout.tsx');
  const findings = [];
  for (const file of screenFiles) {
    const relative = path.relative(appRoot, file).replace(/\\/g, '/');
    const base = relative.replace(/\.tsx$/, '');
    const children = screenFiles.filter((other) => path
      .relative(appRoot, other)
      .replace(/\\/g, '/')
      .startsWith(`${base}/`));
    const hasIndex = children.some(
      (child) => path.relative(appRoot, child).replace(/\\/g, '/') === `${base}/index.tsx`,
    );
    if (children.length > 0 && !hasIndex) {
      findings.push({
        route: fileToRoute(file, appRoot),
        file,
        childFiles: children,
        kind: 'file-folder-route-collision',
      });
    }
  }
  return findings;
}

function diffContracts({ cwd, dests, senders }) {
  const findings = [];
  const unknowns = [];
  const destRouteList = Object.keys(dests);
  const received = {};
  for (const route of destRouteList) received[route] = { params: {}, sources: [] };

  for (const sender of senders) {
    const destination = matchSenderToDest(sender.route, destRouteList);
    if (!destination) continue; // targets a route that does not exist — different bug class
    received[destination].sources.push(sender.fromFile);
    for (const name of destPathParams(destination)) received[destination].params[name] = 'path';
    for (const [name, kind] of Object.entries(sender.params)) {
      if (kind === 'query') received[destination].params[name] = 'query';
    }
    if (sender.paramsUnknown) {
      unknowns.push({
        route: destination,
        file: dests[destination].file,
        kind: 'sender-params-unresolved',
        message:
          `A navigation call targeting ${destination} builds params from a value the TypeChecker could not resolve. The destination parameter union may be incomplete.`,
        sources: [path.relative(cwd, sender.fromFile)],
      });
    }
  }

  for (const route of destRouteList) {
    const destination = dests[route];
    const inbound = received[route];
    if (inbound.sources.length === 0) continue;
    if (Object.keys(inbound.params).length === 0) continue;

    const sources = [...new Set(inbound.sources)].map((file) => path.relative(cwd, file));

    if (destination.declarationUnknown) {
      unknowns.push({
        route,
        file: destination.file,
        kind: 'params-type-unresolved',
        message:
          `Route ${route} calls useLocalSearchParams<${destination.declaredRaw}>(), but the TypeChecker could not resolve that type. Parameter compatibility was not verified.`,
        receivedParams: inbound.params,
        sources,
      });
      continue;
    }

    if (!destination.declaredKeys) {
      findings.push({
        route,
        file: destination.file,
        kind: 'no-declaration',
        receivedParams: inbound.params,
        sources,
        suggestion: buildSuggestedType(inbound.params),
      });
      continue;
    }

    const missing = {};
    for (const [name, kind] of Object.entries(inbound.params)) {
      if (!(name in destination.declaredKeys)) missing[name] = kind;
    }
    if (Object.keys(missing).length > 0) {
      findings.push({
        route,
        file: destination.file,
        kind: 'missing-params',
        declaredRaw: destination.declaredRaw,
        receivedParams: inbound.params,
        missingParams: missing,
        sources,
        suggestion: buildSuggestedType({ ...destination.declaredKeys, ...inbound.params }, destination.declaredKeys),
      });
    }
  }

  return { findings, unknowns };
}

// ── AST backend ─────────────────────────────────────────────────────────────

function directSearchParamsHook(context, call) {
  const { ts, resolver } = context;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return ['useLocalSearchParams', 'useGlobalSearchParams', 'useSearchParams'].some(
      (name) => resolver.isImportedFrom(callee, name, ['expo-router']),
    );
  }
  if (ts.isPropertyAccessExpression(callee)
    && /^use(Local|Global)?SearchParams$/.test(callee.name.text)
    && ts.isIdentifier(callee.expression)) {
    const binding = resolver.importBindingFor(callee.expression);
    return !!binding && binding.importedName === '*' && binding.moduleSpecifier === 'expo-router';
  }
  return false;
}

function searchParamsHookStatus(context, call) {
  const { ts, resolver } = context;
  if (directSearchParamsHook(context, call)) return 'router';
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return 'not-router';

  const resolved = resolver.declarationsFor(callee);
  let crossedUnknownBoundary = false;
  for (const declaration of resolved.local) {
    const evidence = resolver.search([declaration], (node) => (
      ts.isCallExpression(node) && directSearchParamsHook(context, node)
    ));
    if (evidence.matched) return 'router';
    if (evidence.unknownBoundaries.length > 0) crossedUnknownBoundary = true;
  }
  if (resolved.local.length > 0) return crossedUnknownBoundary ? 'unknown' : 'not-router';
  if (/(?:search|route|app).*params/i.test(callee.text) && resolved.externalModules.length > 0) {
    return 'unknown';
  }
  return 'not-router';
}

function parseDeclaredParamsAst(context, sourceFile) {
  const { ts, resolver } = context;
  let declared = null;

  const visit = (node) => {
    if (ts.isCallExpression(node) && node.typeArguments && node.typeArguments.length === 1) {
      const hookStatus = searchParamsHookStatus(context, node);
      if (hookStatus === 'unknown') {
        if (!declared || declared.unknown) {
          declared = {
            keys: null,
            raw: node.typeArguments[0].getText(sourceFile),
            unknown: true,
          };
        }
      }
      if (hookStatus === 'router') {
        const typeArgument = node.typeArguments[0];
        if (ts.isTypeLiteralNode(typeArgument)) {
          const keys = {};
          for (const member of typeArgument.members) {
            if (!ts.isPropertySignature(member) || !member.name) continue;
            const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
              ? member.name.text
              : null;
            if (!name) continue;
            keys[name] = member.questionToken ? 'optional' : 'required';
          }
          declared = { keys, raw: typeArgument.getText(sourceFile).replace(/^\{|\}$/g, '').trim() };
          return;
        }
        const type = context.checker.getTypeFromTypeNode(typeArgument);
        if (type) {
          const keys = {};
          for (const property of context.checker.getPropertiesOfType(type)) {
            keys[property.name] = property.flags & ts.SymbolFlags.Optional ? 'optional' : 'required';
          }
          const candidate = Object.keys(keys).length > 0
            ? { keys, raw: typeArgument.getText(sourceFile), unknown: false }
            : { keys: null, raw: typeArgument.getText(sourceFile), unknown: true };
          if (!declared || declared.unknown || !candidate.unknown) declared = candidate;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return declared;
}

function parseSendersAst(context, sourceFile) {
  const { ts, resolver, jsx } = context;
  const senders = [];
  const unknowns = [];
  const seen = new Set();

  const add = (route, params, paramsUnknown = false) => {
    const key = `${route}|${Object.keys(params).sort().join(',')}|${paramsUnknown}`;
    if (seen.has(key)) return;
    seen.add(key);
    senders.push({ route, params, paramsUnknown });
  };

  const collectObjectKeys = (node, depth = 0) => {
    const keys = {};
    if (!node || depth > 3) return { keys, unknown: true };
    let objectNode = node;
    if (ts.isIdentifier(objectNode) || ts.isPropertyAccessExpression(objectNode)) {
      const resolved = resolver.resolveValueNode(objectNode);
      if (!resolved) return { keys, unknown: true };
      objectNode = resolved;
    }
    if (!objectNode || !ts.isObjectLiteralExpression(objectNode)) return { keys, unknown: true };
    let unknown = false;
    for (const property of objectNode.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = collectObjectKeys(property.expression, depth + 1);
        Object.assign(keys, spread.keys);
        if (spread.unknown) unknown = true;
        continue;
      }
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : resolver.propertyName(property);
      if (name) keys[name] = 'query';
      else unknown = true;
    }
    return { keys, unknown };
  };

  const addUnknown = (node, kind, message) => {
    unknowns.push({
      kind,
      file: node && node.getSourceFile ? node.getSourceFile().fileName : sourceFile.fileName,
      message,
    });
  };

  const fromUrlExpression = (expression) => {
    const evaluated = resolver.evaluateStrings(expression);
    if (evaluated.unknown) {
      addUnknown(
        expression,
        'navigation-target-unresolved',
        'A navigation target could not be resolved to a route, so its parameter contract was not analyzed.',
      );
    }
    for (const value of evaluated.values) {
      const { route, params } = parseUrlPattern(value.text);
      if (route.startsWith('/')) add(route, params);
    }
  };

  const fromNavigationArgument = (argument) => {
    if (!argument) return;
    let navigationArgument = argument;
    if (ts.isIdentifier(navigationArgument) || ts.isPropertyAccessExpression(navigationArgument)) {
      const resolved = resolver.resolveValueNode(navigationArgument);
      if (resolved) navigationArgument = resolved;
    }
    if (ts.isObjectLiteralExpression(navigationArgument)) {
      const collectRouteObject = (objectNode, depth = 0, seen = new Set()) => {
        const state = {
          hasParams: false,
          hasPathname: false,
          params: { keys: {}, unknown: false },
          pathnames: [],
          pathnameUnknown: false,
        };
        if (depth > 4 || seen.has(objectNode)) {
          state.hasPathname = true;
          state.pathnameUnknown = true;
          state.hasParams = true;
          state.params = { keys: {}, unknown: true };
          return state;
        }
        seen.add(objectNode);
        for (const property of objectNode.properties) {
          if (ts.isSpreadAssignment(property)) {
            let target = resolver.resolveValueNode(property.expression);
            if (target && (ts.isAsExpression(target) || ts.isParenthesizedExpression(target))) {
              target = target.expression;
            }
            if (!target || !ts.isObjectLiteralExpression(target)) {
              // An unresolved spread can override both fields declared before
              // it. Later explicit properties restore certainty because object
              // property order makes them authoritative.
              state.hasPathname = true;
              state.pathnames = [];
              state.pathnameUnknown = true;
              state.hasParams = true;
              state.params = { keys: {}, unknown: true };
              continue;
            }
            const nested = collectRouteObject(target, depth + 1, seen);
            if (nested.hasPathname) {
              state.hasPathname = true;
              state.pathnames = nested.pathnames;
              state.pathnameUnknown = nested.pathnameUnknown;
            }
            if (nested.hasParams) {
              state.hasParams = true;
              state.params = nested.params;
            }
            continue;
          }
          if (!ts.isPropertyAssignment(property)) continue;
          const name = resolver.propertyName(property);
          if (name === 'pathname') {
            const evaluated = resolver.evaluateStrings(property.initializer);
            state.hasPathname = true;
            state.pathnames = [];
            for (const value of evaluated.values) {
              const pathname = normalizeRoute(value.text);
              if (pathname && !state.pathnames.includes(pathname)) state.pathnames.push(pathname);
            }
            state.pathnameUnknown = evaluated.unknown || state.pathnames.length === 0;
          }
          if (name === 'params') {
            state.hasParams = true;
            state.params = collectObjectKeys(property.initializer);
          }
        }
        return state;
      };

      const routeObject = collectRouteObject(navigationArgument);
      const { params, pathnames, pathnameUnknown } = routeObject;
      if (pathnames.length === 0) {
        addUnknown(
          navigationArgument,
          'navigation-target-unresolved',
          'A navigation object has a pathname the TypeChecker could not resolve, so its parameter contract was not analyzed.',
        );
        return;
      }
      if (pathnameUnknown) {
        addUnknown(
          navigationArgument,
          'navigation-target-unresolved',
          'A navigation object contains a partially unresolved pathname, so only its statically known route alternatives were analyzed.',
        );
      }
      for (const pathname of pathnames) {
        const combined = { ...params.keys };
        for (const name of destPathParams(pathname)) combined[name] = 'path';
        add(pathname, combined, params.unknown);
      }
      return;
    }
    fromUrlExpression(navigationArgument);
  };

  // `resolver.walk` follows calls into app-local helpers, so a screen that
  // navigates through `goToInspection(id)` is credited with that helper's route.
  resolver.walk([sourceFile], (node) => {
    const routerStatus = routerMethodStatus(context, node);
    if (routerStatus === 'router') {
      fromNavigationArgument(node.arguments[0]);
    } else if (routerStatus === 'unknown') {
      addUnknown(
        node,
        'navigation-receiver-unresolved',
        'A push/navigate/replace receiver may be an app router abstraction, but its implementation could not be resolved. The route contract was not analyzed.',
      );
    }

    if (jsx.isOpeningLike(node) && jsx.canonicalTagName(node, resolver) === 'Link') {
      const href = jsx.attributeNamed(node, 'href');
      if (href && href.initializer) {
        const expression = ts.isJsxExpression(href.initializer) ? href.initializer.expression : href.initializer;
        if (expression) fromNavigationArgument(expression);
      }
    }
  });

  return { senders, unknowns };
}

function analyzeWithAst({ projectRoot, appRoot, files, cwd, ts }) {
  const { program, checker } = createProgram({ ts, projectRoot, files });
  const resolver = new Resolver({ ts, checker, projectRoot });
  const jsx = createJsxHelpers(ts);
  const context = { ts, program, checker, resolver, jsx };

  const dests = {};
  const senders = [];
  const findings = [...collectStructuralFindings(appRoot, files)];
  const unknowns = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;

    const route = fileToRoute(file, appRoot);
    if (route) {
      if (dests[route]) {
        findings.push({ route, file, otherFile: dests[route].file, kind: 'duplicate-route' });
      } else {
        const declared = parseDeclaredParamsAst(context, sourceFile);
        dests[route] = {
          file,
          declaredKeys: declared ? declared.keys : null,
          declaredRaw: declared ? declared.raw : null,
          declarationUnknown: declared ? declared.unknown === true : false,
        };
      }
    }

    const parsedSenders = parseSendersAst(context, sourceFile);
    for (const sender of parsedSenders.senders) {
      senders.push({ fromFile: file, ...sender });
    }
    unknowns.push(...parsedSenders.unknowns);
  }

  const contracts = diffContracts({ cwd, dests, senders });
  findings.push(...contracts.findings);
  unknowns.push(...contracts.unknowns);
  return {
    backend: 'ast',
    findings,
    unknowns,
    stats: { files: files.length, routes: Object.keys(dests).length, senders: senders.length },
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{ projectRoot: string, cwd?: string }} options
 * @returns {{ backend: 'ast'|'unavailable', findings: object[], unknowns: object[], stats: object, appRoot: string }}
 */
function analyzeRoutes({ projectRoot, cwd = projectRoot }) {
  const appRoot = path.join(projectRoot, 'app');
  const files = findTsxFiles(appRoot);
  const loaded = loadTypeScript(projectRoot);

  const result = loaded
    ? analyzeWithAst({ projectRoot, appRoot, files, cwd, ts: loaded.ts })
    : {
      backend: 'unavailable',
      findings: collectStructuralFindings(appRoot, files),
      unknowns: [{
        kind: 'semantic-analysis-unavailable',
        message:
          'TypeScript is unavailable, so navigation targets and route-parameter contracts were not analyzed. Install project dependencies and rerun check-routes.',
      }],
      stats: { files: files.length, routes: 0, senders: 0 },
    };

  return { ...result, appRoot, typescript: loaded ? { version: loaded.version, source: loaded.source } : null };
}

module.exports = {
  analyzeRoutes,
  buildSuggestedType,
  destPathParams,
  fileToRoute,
  findTsxFiles,
  matchSenderToDest,
  normalizeRoute,
  parseUrlPattern,
};

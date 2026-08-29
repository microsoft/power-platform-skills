'use strict';

const { isKnownLibrary } = require('../resolve');

/**
 * Rule: screen structure — safe area, state-branch parity, list empty states,
 * scanner overlays, Tamagui shadow props, and button themes.
 *
 * These are the checks that produced the worst regex false positives, because a
 * well-factored app hides exactly this structure behind shared components:
 *
 *   export default function DetailScreen() {
 *     return <ScreenFrame>…</ScreenFrame>;   // ScreenFrame owns SafeAreaView
 *   }
 *
 *   if (isLoading) return <LoadingState />;  // LoadingState owns its own insets
 *
 * The analyzer resolves `ScreenFrame` / `LoadingState` / `ErrorState` — under any
 * alias — to their declarations in the app tree and inspects what they actually
 * render. Only a component that resolves locally and demonstrably lacks safe-area
 * handling fails; anything opaque is reported as `unknown`.
 */

const SAFE_AREA_MODULES = ['react-native-safe-area-context'];
const SCREEN_SIGNAL_TAGS = new Set(['FlatList', 'FlashList', 'SectionList', 'ScrollView', 'ScreenHeader', 'StatusBar']);
const TAMAGUI_SHADOW_HOSTS = new Set(['YStack', 'XStack', 'ZStack', 'Card', 'Button', 'Pressable', 'Stack']);
const SHADOW_PROPS = ['shadowOffset', 'shadowColor', 'shadowRadius', 'shadowOpacity'];
const UNSUPPORTED_BUTTON_THEMES = new Set(['active', 'primary']);
const INSET_HINT_RE = /insets|inset|tabBarHeight|safeArea|useHeaderHeight/i;
const STATUS_PILL_TAGS = new Set(['Badge', 'StatusPill']);
const RED_STATUS_TOKEN_RE = /^\$(?:red(?:8|9|10|11|12)|status(?:Fail|Error|Danger)(?:8|9|10|11|12)?)$/;

module.exports = {
  id: 'screen-structure',

  appliesTo(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!/\.(?:jsx|tsx)$/.test(normalized)) return false;
    if (normalized.includes('/shared/samples/')) return false;
    if (/\/_layout\.tsx$/.test(normalized)) return false;
    if (normalized.includes('/brand/')) return false;
    return normalized.includes('/app/') || normalized.includes('/src/components/');
  },

  run(context, sourceFile) {
    const { jsx } = context;

    const layoutRoots = applicableLayoutRoots(context, sourceFile);
    const inheritedSafeArea = layoutRoots.length > 0
      ? searchLayoutSafeArea(context, layoutRoots)
      : { matched: false, unknownBoundaries: [] };
    const localSafeArea = analyzeScreenSafeArea(context, sourceFile);
    const safeArea = {
      matched: inheritedSafeArea.matched || localSafeArea.matched,
      unknownBoundaries: [
        ...inheritedSafeArea.unknownBoundaries,
        ...localSafeArea.unknownBoundaries,
      ],
    };
    const looksLikeScreen = detectScreenShape(context, sourceFile);

    const isRouteScreen = isRouteSourceFile(sourceFile);
    if (isRouteScreen && looksLikeScreen && localSafeArea.visual !== false && !safeArea.matched) {
      const status = safeArea.unknownBoundaries.length > 0 ? 'unknown' : 'fail';
      const suffix = safeArea.unknownBoundaries.length > 0
        ? ` The analyzer could not inspect ${safeArea.unknownBoundaries.join(', ')}, so this is reported as unknown rather than a failure.`
        : '';
      context.report(sourceFile, sourceFile, {
        status,
        rule: 'missing-safe-area-chrome',
        message:
          'Screen content is not inside any resolvable safe-area handling. Wrap it in SafeAreaView from react-native-safe-area-context, apply insets from useSafeAreaInsets(), or render it through a shared screen frame component that does.'
          + suffix,
      });
    }

    checkBottomAnchoredElements(context, sourceFile);
    checkEmptyStateAboveList(context, sourceFile);
    checkScannerOverlay(context, sourceFile);
    checkStatusVisuals(context, sourceFile);

    jsx.forEachJsxElement(sourceFile, (element) => {
      checkShadowProps(context, sourceFile, element);
      checkButtonTheme(context, sourceFile, element);
    });
  },
};

function isRouteSourceFile(sourceFile) {
  return sourceFile.fileName.replace(/\\/g, '/').includes('/app/');
}

// ── Safe area ────────────────────────────────────────────────────────────────

function isSafeAreaEvidence(context, node) {
  const { ts, jsx, resolver } = context;

  if (ts.isPropertyAccessExpression(node) && /^(top|bottom)$/.test(node.name.text)) {
    if (/inset/i.test(node.expression.getText())) return true;
  }

  if (jsx.isOpeningLike(node)) {
    const identifier = jsx.tagIdentifier(node);
    if (identifier && resolver.isImportedFrom(identifier, 'SafeAreaView', SAFE_AREA_MODULES)) return true;
    const binding = identifier ? resolver.importBindingFor(identifier) : null;
    if (binding
      && binding.importedName === '*'
      && SAFE_AREA_MODULES.includes(binding.moduleSpecifier)
      && jsx.canonicalTagName(node, resolver) === 'SafeAreaView') {
      return true;
    }
  }

  return false;
}

function applicableLayoutRoots(context, sourceFile) {
  const { path, program, projectRoot } = context;
  const appRoot = path.join(projectRoot, 'app');
  const relative = path.relative(appRoot, sourceFile.fileName);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [];

  const roots = [];
  let current = appRoot;
  const segments = relative.split(path.sep).slice(0, -1);
  const candidates = [path.join(appRoot, '_layout.tsx')];
  for (const segment of segments) {
    current = path.join(current, segment);
    candidates.push(path.join(current, '_layout.tsx'));
  }
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(sourceFile.fileName)) continue;
    const layout = program.getSourceFile(candidate);
    if (layout) roots.push(layout);
  }
  return roots;
}

function searchLayoutSafeArea(context, layoutRoots) {
  const { ts, jsx, resolver } = context;
  const unknownBoundaries = new Set();
  for (const layout of layoutRoots) {
    let foundOutlet = false;
    let everyOutletSafe = true;
    jsx.forEachJsxElement(layout, (element) => {
      if (!/^(?:Slot|Stack|Tabs|Drawer)$/.test(jsx.canonicalTagName(element, resolver))) return;
      foundOutlet = true;
      let current = element.parent;
      let outletSafe = false;
      while (current) {
        if (ts.isJsxElement(current)) {
          const result = openingSafeAreaOwnership(context, current.openingElement, new Set());
          if (result.matched) {
            outletSafe = true;
            break;
          }
          for (const boundary of result.unknownBoundaries) unknownBoundaries.add(boundary);
        }
        current = current.parent;
      }
      if (!outletSafe) everyOutletSafe = false;
    });
    if (foundOutlet && everyOutletSafe) {
      return { matched: true, unknownBoundaries: [] };
    }
  }
  return {
    matched: false,
    unknownBoundaries: [...unknownBoundaries],
  };
}

function analyzeScreenSafeArea(context, sourceFile) {
  const component = defaultExportedComponent(context, sourceFile);
  if (!component) return { matched: false, unknownBoundaries: [], visual: false };

  const returns = componentReturnExpressions(context, component);
  let visual = false;
  let unsafe = false;
  const unknownBoundaries = new Set();
  for (const expression of returns) {
    const result = expressionSafeAreaOwnership(context, expression, new Set());
    if (!result.visual) continue;
    visual = true;
    if (!result.matched && result.unknownBoundaries.length === 0) unsafe = true;
    for (const boundary of result.unknownBoundaries) unknownBoundaries.add(boundary);
  }
  return {
    matched: visual && !unsafe && unknownBoundaries.size === 0,
    unknownBoundaries: [...unknownBoundaries],
    visual,
  };
}

function defaultExportedComponent(context, sourceFile) {
  const { ts, resolver } = context;
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers && ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement) || []
      : statement.modifiers || [];
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) {
      return statement;
    }
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    if (ts.isIdentifier(statement.expression)) {
      const { local } = resolver.declarationsFor(statement.expression);
      for (const declaration of local) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) return declaration.initializer;
        if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) return declaration;
      }
    }
    return statement.expression;
  }
  return null;
}

function componentReturnExpressions(context, component) {
  const { ts } = context;
  if (ts.isArrowFunction(component) && !ts.isBlock(component.body)) return [component.body];
  const body = component.body;
  if (!body || !ts.isBlock(body)) return [];

  const returns = [];
  const visit = (node) => {
    if (node !== body && (ts.isFunctionDeclaration(node)
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
  visit(body);
  return returns;
}

function expressionSafeAreaOwnership(context, expression, seenDeclarations) {
  const { ts, jsx, resolver } = context;
  if (!expression) return { matched: false, unknownBoundaries: [], visual: false };
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isNonNullExpression(expression)) {
    return expressionSafeAreaOwnership(context, expression.expression, seenDeclarations);
  }
  if (ts.isConditionalExpression(expression)) {
    return combineOwnershipResults([
      expressionSafeAreaOwnership(context, expression.whenTrue, new Set(seenDeclarations)),
      expressionSafeAreaOwnership(context, expression.whenFalse, new Set(seenDeclarations)),
    ]);
  }
  if (ts.isIdentifier(expression)) {
    const target = resolver.resolveValueNode(expression);
    return target
      ? expressionSafeAreaOwnership(context, target, seenDeclarations)
      : { matched: false, unknownBoundaries: [expression.text], visual: true };
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword
    || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.UndefinedKeyword) {
    return { matched: true, unknownBoundaries: [], visual: false };
  }
  if (ts.isJsxFragment(expression)) {
    const children = expression.children
      .map((child) => childOwnership(context, child, seenDeclarations))
      .filter((result) => result.visual);
    return children.length === 0
      ? { matched: true, unknownBoundaries: [], visual: false }
      : combineOwnershipResults(children);
  }

  const opening = ts.isJsxElement(expression)
    ? expression.openingElement
    : (ts.isJsxSelfClosingElement(expression) ? expression : null);
  if (!opening) return { matched: false, unknownBoundaries: [], visual: true };
  const tag = jsx.canonicalTagName(opening, resolver);
  if (tag === 'Redirect') return { matched: true, unknownBoundaries: [], visual: false };

  const direct = openingSafeAreaOwnership(context, opening, seenDeclarations);
  if (direct.matched || direct.unknownBoundaries.length > 0) {
    return { ...direct, visual: true };
  }

  if (!ts.isJsxElement(expression)) return { matched: false, unknownBoundaries: [], visual: true };
  const children = expression.children
    .map((child) => childOwnership(context, child, seenDeclarations))
    .filter((result) => result.visual);
  if (children.length === 0) return { matched: false, unknownBoundaries: [], visual: true };
  return { ...combineOwnershipResults(children), visual: true };
}

function childOwnership(context, child, seenDeclarations) {
  const { ts } = context;
  if (ts.isJsxText(child)) {
    return child.text.trim()
      ? { matched: false, unknownBoundaries: [], visual: true }
      : { matched: true, unknownBoundaries: [], visual: false };
  }
  if (ts.isJsxExpression(child)) {
    return child.expression
      ? expressionSafeAreaOwnership(context, child.expression, new Set(seenDeclarations))
      : { matched: true, unknownBoundaries: [], visual: false };
  }
  return expressionSafeAreaOwnership(context, child, new Set(seenDeclarations));
}

function openingSafeAreaOwnership(context, opening, seenDeclarations) {
  const { ts, jsx, resolver } = context;
  if (isSafeAreaEvidence(context, opening)) {
    return { matched: true, unknownBoundaries: [] };
  }
  const insetUse = resolver.search([opening.attributes], (node) => (
    ts.isPropertyAccessExpression(node)
      && /^(?:top|bottom)$/.test(node.name.text)
      && /inset/i.test(node.expression.getText())
  ), { followReferences: false });
  if (insetUse.matched) return { matched: true, unknownBoundaries: [] };

  const identifier = jsx.tagIdentifier(opening);
  if (!identifier) return { matched: false, unknownBoundaries: [] };
  const { local, externalModules } = resolver.declarationsFor(identifier);
  if (local.length === 0) {
    const opaque = externalModules.filter((moduleName) => !isKnownLibrary(moduleName));
    return {
      matched: false,
      unknownBoundaries: opaque.length > 0 ? [`${identifier.text} (from "${opaque[0]}")`] : [],
    };
  }

  const results = [];
  for (const declaration of local) {
    if (seenDeclarations.has(declaration)) continue;
    const nextSeen = new Set(seenDeclarations);
    nextSeen.add(declaration);
    const component = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    if (!component) continue;
    for (const expression of componentReturnExpressions(context, component)) {
      results.push(expressionSafeAreaOwnership(context, expression, nextSeen));
    }
  }
  return results.length > 0
    ? combineOwnershipResults(results)
    : { matched: false, unknownBoundaries: [] };
}

function combineOwnershipResults(results) {
  const visualResults = results.filter((result) => result.visual !== false);
  if (visualResults.length === 0) return { matched: true, unknownBoundaries: [], visual: false };
  const unknownBoundaries = [...new Set(visualResults.flatMap((result) => result.unknownBoundaries))];
  return {
    matched: unknownBoundaries.length === 0 && visualResults.every((result) => result.matched),
    unknownBoundaries,
    visual: true,
  };
}

/**
 * A "screen" is a default-exported component (Expo Router route) or any file
 * that renders scrollable/list/header chrome, matching the previous heuristic
 * but read from the AST instead of a name regex.
 */
function detectScreenShape(context, sourceFile) {
  const { ts, jsx } = context;
  let isDefaultExportedComponent = false;
  let rendersChrome = false;

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers && ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement) || []
      : statement.modifiers || [];
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) {
      isDefaultExportedComponent = true;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) isDefaultExportedComponent = true;
  }

  jsx.forEachJsxElement(sourceFile, (element) => {
    if (SCREEN_SIGNAL_TAGS.has(jsx.canonicalTagName(element, context.resolver))) rendersChrome = true;
  });

  const normalized = sourceFile.fileName.replace(/\\/g, '/');
  const isRouteFile = normalized.includes('/app/');
  return rendersChrome || (isRouteFile && isDefaultExportedComponent);
}

function returnedJsx(ts, statement) {
  if (!statement) return null;
  const candidates = ts.isBlock(statement) ? statement.statements : [statement];
  for (const candidate of candidates) {
    if (!ts.isReturnStatement(candidate) || !candidate.expression) continue;
    const expression = candidate.expression;
    if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression)) {
      return expression;
    }
    if (ts.isParenthesizedExpression(expression)) return expression.expression;
  }
  return null;
}

// ── Bottom-anchored controls ────────────────────────────────────────────────

function checkBottomAnchoredElements(context, sourceFile) {
  const { jsx } = context;
  let hasUnhandledBottomChrome = false;
  let topOnlySafeArea = null;

  jsx.forEachJsxElement(sourceFile, (element) => {
    const positionAttribute = jsx.attributeNamed(element, 'position') || jsx.attributeNamed(element, 'pos');
    const bottomAttribute = jsx.attributeNamed(element, 'bottom') || jsx.attributeNamed(element, 'b');
    if (positionAttribute && bottomAttribute && attributeIsString(context, positionAttribute, 'absolute')) {
      if (!expressionMentions(context, bottomAttribute.initializer, INSET_HINT_RE)) {
        hasUnhandledBottomChrome = true;
        const unknown = expressionHasUnknownReference(context, bottomAttribute.initializer);
        context.report(sourceFile, element, {
          status: unknown ? 'unknown' : 'fail',
          rule: 'absolute-bottom-without-inset',
          message:
            unknown
              ? 'Absolutely positioned bottom chrome uses an offset the analyzer could not resolve, so safe-area inset handling was not verified.'
              : 'Absolutely positioned bottom chrome does not account for safe-area insets. Offset it with insets.bottom (plus tab bar height when present) so it clears the home indicator.',
        });
      }
    }

    if (jsx.canonicalTagName(element, context.resolver) === 'SafeAreaView') {
      const edges = jsx.attributeNamed(element, 'edges');
      if (edges && isTopOnlyEdges(context, edges)) topOnlySafeArea = element;
    }
  });

  if (hasUnhandledBottomChrome && topOnlySafeArea) {
    context.report(sourceFile, topOnlySafeArea, {
      status: 'fail',
      rule: 'bottom-ui-safe-area-top-only',
      message:
        "Screen has bottom-anchored UI but the SafeAreaView only claims the top edge. Use edges={['top','bottom']} so bottom controls clear the home indicator.",
    });
  }
}

function isTopOnlyEdges(context, attribute) {
  const { resolver } = context;
  const initializer = attribute.initializer;
  if (!initializer) return false;
  const expression = context.ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  const evaluated = resolver.evaluateStringArray(expression);
  if (evaluated.unknown) return false;
  return evaluated.values.length === 1 && evaluated.values[0] === 'top';
}

function attributeIsString(context, attribute, expected) {
  const { resolver } = context;
  if (!attribute.initializer) return false;
  const evaluated = resolver.evaluateStrings(attribute.initializer);
  return evaluated.values.some((value) => value.exact && value.text === expected);
}

/**
 * Walks an expression looking for `pattern`, following identifiers one hop into
 * their local declaration so `b={bottomOffset}` where
 * `const bottomOffset = insets.bottom + 16` is recognised.
 */
function expressionMentions(context, node, pattern, depth = 0) {
  const { ts, resolver } = context;
  if (!node || depth > 2) return false;
  let found = false;
  const visit = (current) => {
    if (found || !current) return;
    if (ts.isIdentifier(current)) {
      if (pattern.test(current.text)) {
        found = true;
        return;
      }
      const target = resolver.resolveValueNode(current);
      if (target && target !== current) {
        if (expressionMentions(context, target, pattern, depth + 1)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function expressionHasUnknownReference(context, node) {
  const { ts, resolver } = context;
  let unknown = false;
  const seen = new Set();
  const visit = (current) => {
    if (unknown || !current) return;
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === current) return;
      const target = resolver.resolveValueNode(current);
      if (target) {
        if (!seen.has(target)) {
          seen.add(target);
          visit(target);
        }
      } else {
        const declarations = resolver.declarationsFor(current);
        if (declarations.local.length === 0) unknown = true;
      }
    }
    if (ts.isCallExpression(current)) {
      const callee = ts.isIdentifier(current.expression) ? current.expression : null;
      if (callee) {
        const declarations = resolver.declarationsFor(callee);
        if (declarations.local.length === 0 && declarations.externalModules.length > 0) {
          unknown = true;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return unknown;
}

// ── Empty state above a list ────────────────────────────────────────────────

function checkEmptyStateAboveList(context, sourceFile) {
  const { ts, jsx } = context;

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const body = node.body;
      if (body && ts.isBlock(body)) inspectFunctionBody(context, sourceFile, body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  function inspectFunctionBody(ctx, file, body) {
    let listStatementIndex = -1;
    const emptyGuards = [];

    body.statements.forEach((statement, index) => {
      let rendersList = false;
      jsx.forEachJsxElement(statement, (element) => {
        if (/^(FlatList|FlashList|SectionList)$/.test(jsx.canonicalTagName(element, ctx.resolver))) rendersList = true;
      });
      if (rendersList && listStatementIndex === -1) listStatementIndex = index;

      if (ts.isIfStatement(statement) && isEmptyLengthCondition(ctx, statement.expression)) {
        const returned = returnedJsx(ts, statement.thenStatement);
        if (returned) emptyGuards.push({ index, statement });
      }
    });

    if (listStatementIndex === -1) return;
    for (const guard of emptyGuards) {
      if (guard.index >= listStatementIndex) continue;
      ctx.report(file, guard.statement, {
        status: 'fail',
        rule: 'empty-state-branched-above-list',
        message:
          'Empty state is returned before the list renders, which removes pull-to-refresh when the list is empty. Render it through the list\'s ListEmptyComponent instead.',
      });
    }
  }
}

function isEmptyLengthCondition(context, expression) {
  const { ts } = context;
  if (!expression) return false;
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    const isComparison = operator === ts.SyntaxKind.EqualsEqualsEqualsToken
      || operator === ts.SyntaxKind.EqualsEqualsToken
      || operator === ts.SyntaxKind.LessThanToken;
    if (isComparison) {
      const left = expression.left.getText();
      const right = expression.right.getText();
      if (/\.length$/.test(left.trim()) && /^[01]$/.test(right.trim())) return true;
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return isEmptyLengthCondition(context, expression.left) || isEmptyLengthCondition(context, expression.right);
    }
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return /\.length$/.test(expression.operand.getText().trim());
  }
  return false;
}

// ── Scanner overlay ─────────────────────────────────────────────────────────

function checkScannerOverlay(context, sourceFile) {
  const { ts, jsx } = context;
  let scanner = null;
  const spinners = [];

  jsx.forEachJsxElement(sourceFile, (element) => {
    const tag = jsx.canonicalTagName(element, context.resolver);
    if (tag === 'BarcodeScannerView') scanner = element;
    if (tag === 'Spinner') spinners.push(element);
  });

  if (!scanner || spinners.length === 0) return;

  const overlay = jsx.attributeNamed(scanner, 'overlay');
  const overlayHasSpinner = overlay
    ? spinners.some((spinner) => isDescendantOf(ts, spinner, overlay))
    : false;

  if (overlay && !overlayHasSpinner) {
    context.report(sourceFile, scanner, {
      status: 'unknown',
      rule: 'scanner-loader-outside-overlay',
      message:
        'BarcodeScannerView has an overlay and a Spinner elsewhere on the screen, but static analysis cannot prove whether that spinner is scanner processing feedback. Verify processing feedback renders inside the overlay.',
    });
  }
}

function isDescendantOf(ts, node, ancestor) {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

// ── Tamagui shadow props + button themes ────────────────────────────────────

function checkShadowProps(context, sourceFile, element) {
  const { jsx } = context;
  const tag = jsx.canonicalTagName(element, context.resolver);
  if (!TAMAGUI_SHADOW_HOSTS.has(tag)) return;
  for (const property of SHADOW_PROPS) {
    if (!jsx.hasAttribute(element, property)) continue;
    context.report(sourceFile, element, {
      status: 'fail',
      rule: 'inline-shadow',
      message:
        `React Native shadow prop \`${property}\` on Tamagui <${tag}>. Use Tamagui 2 \`boxShadow\` (for example boxShadow="0 2px 8px $shadow3") instead.`,
    });
    return;
  }
}

function checkButtonTheme(context, sourceFile, element) {
  const { jsx } = context;
  if (jsx.canonicalTagName(element, context.resolver) !== 'Button') return;
  const theme = jsx.attributeNamed(element, 'theme');
  if (!theme || !theme.initializer) return;
  const evaluated = context.resolver.evaluateStrings(theme.initializer);
  for (const value of evaluated.values) {
    if (!value.exact || !UNSUPPORTED_BUTTON_THEMES.has(value.text)) continue;
    context.report(sourceFile, element, {
      status: 'fail',
      rule: 'unsupported-button-theme',
      message:
        `theme="${value.text}" is not guaranteed by the generated Tamagui config, so the primary CTA can render as a pale disabled-looking control. Use a confirmed theme (for example theme="blue") or compose explicit frame and label styles.`,
    });
  }
}

// ── Status visual structure ──────────────────────────────────────────────────

function checkStatusVisuals(context, sourceFile) {
  const { ts, jsx, resolver } = context;

  jsx.forEachJsxElement(sourceFile, (element) => {
    const hasStatusStripe = jsx.hasAttribute(element, 'borderLeftWidth')
      || jsx.hasAttribute(element, 'borderLeftColor');
    if (hasStatusStripe) {
      const owner = jsx.elementOf(element);
      let statusPill = null;
      const visit = (node) => {
        if (statusPill || !node) return;
        if (jsx.isOpeningLike(node)
          && node !== element
          && STATUS_PILL_TAGS.has(jsx.canonicalTagName(node, resolver))) {
          statusPill = node;
          return;
        }
        ts.forEachChild(node, visit);
      };
      if (ts.isJsxElement(owner)) {
        for (const child of owner.children) visit(child);
      }
      if (statusPill) {
        context.report(sourceFile, statusPill, {
          status: 'fail',
          rule: 'redundant-status-cues',
          message:
            'This row/card combines a left status stripe with a filled StatusPill/Badge. Use one strong status cue plus text unless the approved experience explicitly requires redundant emergency/outdoor signaling.',
        });
      }
    }

    const tag = jsx.canonicalTagName(element, resolver);
    if (!/^(?:YStack|XStack|View|Stack)$/.test(tag)) return;
    const background = jsx.attributeNamed(element, 'bg')
      || jsx.attributeNamed(element, 'background')
      || jsx.attributeNamed(element, 'backgroundColor');
    if (!background || !background.initializer) return;
    const colors = resolver.evaluateStrings(background.initializer);
    if (!colors.values.some((value) => value.exact && RED_STATUS_TOKEN_RE.test(value.text))) return;

    const flex = numericAttributeValue(context, element, 'flex');
    const height = numericAttributeValue(context, element, 'height');
    const minHeight = numericAttributeValue(context, element, 'minH')
      ?? numericAttributeValue(context, element, 'minHeight');
    if (flex !== 1 && (height === null || height < 180) && (minHeight === null || minHeight < 180)) return;

    context.report(sourceFile, element, {
      status: 'fail',
      rule: 'dominant-red-detail-header',
      message:
        'Large red failure/error surfaces read like an app crash rather than an operational record. Use a compact status band, tinted surface, or strong label with structured details below.',
    });
  });
}

function numericAttributeValue(context, element, name) {
  const { ts, jsx } = context;
  const attribute = jsx.attributeNamed(element, name);
  if (!attribute || !attribute.initializer) return null;
  const expression = ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : attribute.initializer;
  if (!expression) return null;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isStringLiteral(expression) && /^\d+(?:\.\d+)?$/.test(expression.text)) {
    return Number(expression.text);
  }
  return null;
}

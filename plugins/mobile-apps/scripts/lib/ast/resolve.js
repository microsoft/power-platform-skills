'use strict';

/**
 * Symbol/value resolution helpers shared by every semantic mobile rule.
 *
 * Two capabilities matter for false-positive removal:
 *
 *   1. *Alias resolution* — `import { ScreenFrame as Frame } from '@/components'`
 *      must resolve to the real declaration so a rule can inspect what the
 *      component actually does instead of pattern-matching the local name.
 *   2. *Bounded, local-only following* — a wrapper that lives in the app's own
 *      `app/` or `src/` tree is inspected recursively (with a cycle guard);
 *      anything that resolves into `node_modules` (or does not resolve at all)
 *      stops the walk and is reported as `unknown` rather than `fail`. Trusting
 *      an arbitrary third-party implementation would be unsound, and blocking on
 *      it would recreate the very false positives this analyzer removes.
 */

const path = require('node:path');

// Packages whose behaviour the rules already model directly. Hitting one of
// these is NOT an unknown boundary: the rule knows what `SafeAreaView` from
// react-native-safe-area-context or `YStack` from tamagui does, so following
// into their .d.ts files would add nothing.
const KNOWN_LIBRARY_PREFIXES = [
  '@expo/vector-icons',
  '@expo/vector-icons/',
  '@microsoft/power-apps-native-host',
  '@react-native/',
  '@react-navigation/',
  '@shopify/flash-list',
  '@tamagui/',
  '@tanstack/',
  'expo',
  'expo-router',
  'expo-router/',
  'expo-status-bar',
  'react',
  'react-dom',
  'react-dom/',
  'react-hook-form',
  'react-native',
  'react-native/',
  'react-native-safe-area-context',
  'tamagui',
];

const MAX_FOLLOW_DEPTH = 5;
const MAX_VISITED_DECLARATIONS = 400;

function isKnownLibrary(moduleSpecifier) {
  if (typeof moduleSpecifier !== 'string') return false;
  return KNOWN_LIBRARY_PREFIXES.some((prefix) => (
    prefix.endsWith('/')
      ? moduleSpecifier.startsWith(prefix)
      : moduleSpecifier === prefix
  ));
}

class Resolver {
  constructor({ ts, checker, projectRoot }) {
    this.ts = ts;
    this.checker = checker;
    this.projectRoot = path.resolve(projectRoot);
  }

  isLocalFileName(fileName) {
    if (typeof fileName !== 'string') return false;
    const normalized = path.resolve(fileName);
    if (normalized.split(path.sep).includes('node_modules')) return false;
    const relative = path.relative(this.projectRoot, normalized);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  isDeclarationFile(node) {
    const sourceFile = node.getSourceFile();
    return !!sourceFile && sourceFile.isDeclarationFile;
  }

  /** Resolves a node to its symbol, following import aliases when present. */
  symbolFor(node) {
    const { ts, checker } = this;
    let symbol;
    try {
      symbol = checker.getSymbolAtLocation(node);
    } catch {
      return null;
    }
    if (!symbol) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        const aliased = checker.getAliasedSymbol(symbol);
        if (aliased && aliased.declarations && aliased.declarations.length > 0) return aliased;
      } catch {
        // A broken/unresolvable alias keeps the original symbol; the caller then
        // sees only the import specifier and reports `unknown`.
      }
    }
    return symbol;
  }

  /**
   * @returns {{ local: object[], externalModules: string[], resolved: boolean }}
   *   `local` holds declarations inside the app tree. `externalModules` lists the
   *   module specifiers the identifier came from when it resolved outside the
   *   app (used to decide known-library vs unknown boundary).
   */
  declarationsFor(node) {
    const { ts } = this;
    const originalImportSpecifier = this.importSpecifierTextFor(node);
    const symbol = this.symbolFor(node);
    const result = { local: [], externalModules: [], resolved: false };
    if (!symbol || !symbol.declarations) {
      if (originalImportSpecifier) result.externalModules.push(originalImportSpecifier);
      return result;
    }

    for (const declaration of symbol.declarations) {
      // An import node surviving alias resolution means the module never
      // resolved to a real file (the app's node_modules is not installed, or the
      // path alias is wrong). Treat it as external — descending into the import
      // statement itself would "find nothing" and wrongly look like proof of a
      // missing implementation.
      if (ts.isImportSpecifier(declaration)
        || ts.isImportClause(declaration)
        || ts.isNamespaceImport(declaration)
        || ts.isImportEqualsDeclaration(declaration)) {
        const specifier = this.moduleSpecifierOfDeclaration(declaration);
        if (specifier) result.externalModules.push(specifier);
        continue;
      }

      const sourceFile = declaration.getSourceFile();
      if (sourceFile && this.isLocalFileName(sourceFile.fileName) && !sourceFile.isDeclarationFile) {
        result.local.push(declaration);
        result.resolved = true;
        continue;
      }
      // The declaration lives outside the app tree. Record where it came from so
      // callers can distinguish "a library we model" from "an opaque package".
      const moduleSpecifier = this.moduleSpecifierOfDeclaration(declaration)
        || originalImportSpecifier
        || (sourceFile ? sourceFile.fileName : null);
      if (moduleSpecifier) result.externalModules.push(moduleSpecifier);
      result.resolved = true;
    }

    if (result.local.length === 0 && result.externalModules.length === 0) {
      if (originalImportSpecifier) result.externalModules.push(originalImportSpecifier);
    }
    return result;
  }

  moduleSpecifierOfDeclaration(declaration) {
    const { ts } = this;
    let node = declaration;
    while (node) {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        return node.moduleSpecifier.text;
      }
      node = node.parent;
    }
    return null;
  }

  /** Finds the `from '...'` text for an identifier that was imported into this file. */
  importSpecifierTextFor(node) {
    const { ts } = this;
    if (!node || !ts.isIdentifier(node)) return null;
    const sourceFile = node.getSourceFile();
    if (!sourceFile) return null;
    const name = node.text;
    let found = null;
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (clause.name && clause.name.text === name) found = statement.moduleSpecifier.text;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
        found = statement.moduleSpecifier.text;
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.name.text === name) found = statement.moduleSpecifier.text;
        }
      }
    }
    return found;
  }

  /** True when the identifier resolves to a named import from `moduleNames`. */
  isImportedFrom(node, exportName, moduleNames) {
    const { ts } = this;
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol || !symbol.declarations) return false;
    for (const declaration of symbol.declarations) {
      if (!ts.isImportSpecifier(declaration)) continue;
      const importedName = (declaration.propertyName || declaration.name).text;
      if (exportName && importedName !== exportName) continue;
      const moduleSpecifier = this.moduleSpecifierOfDeclaration(declaration);
      if (moduleSpecifier && moduleNames.includes(moduleSpecifier)) return true;
    }
    return false;
  }

  /**
   * Returns the imported name and module for a local import binding.
   * `import { Button as IconButton } from 'tamagui'` resolves to
   * `{ importedName: 'Button', moduleSpecifier: 'tamagui' }`.
   */
  importBindingFor(node) {
    const { ts } = this;
    if (!node || !ts.isIdentifier(node)) return null;
    let symbol;
    try {
      symbol = this.checker.getSymbolAtLocation(node);
    } catch {
      return null;
    }
    if (!symbol || !symbol.declarations) return null;
    for (const declaration of symbol.declarations) {
      const moduleSpecifier = this.moduleSpecifierOfDeclaration(declaration);
      if (!moduleSpecifier) continue;
      if (ts.isImportSpecifier(declaration)) {
        return {
          importedName: (declaration.propertyName || declaration.name).text,
          moduleSpecifier,
        };
      }
      if (ts.isNamespaceImport(declaration)) {
        return { importedName: '*', moduleSpecifier };
      }
      if (ts.isImportClause(declaration) && declaration.name) {
        return { importedName: 'default', moduleSpecifier };
      }
    }
    return null;
  }

  // ── Literal evaluation ────────────────────────────────────────────────────

  /**
   * Evaluates the possible string values of an expression.
   *
   * Handles the forms that appear in generated screens: literals, template
   * literals (returned as a `exact: false` prefix-bearing value with `\u0000`
   * standing in for each interpolation), identifiers bound to a local `const`,
   * property access into a local const object (design tokens), and both arms of
   * a ternary / `||` / `??`.
   *
   * @returns {{ values: Array<{ text: string, exact: boolean }>, unknown: boolean }}
   */
  evaluateStrings(node, seen = new Set()) {
    const { ts } = this;
    const empty = { values: [], unknown: true };
    if (!node) return empty;

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { values: [{ text: node.text, exact: true }], unknown: false };
    }

    if (ts.isJsxExpression(node)) {
      return node.expression ? this.evaluateStrings(node.expression, seen) : empty;
    }

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return this.evaluateStrings(node.expression, seen);
    }

    if (ts.isTemplateExpression(node)) {
      // `https://graph.microsoft.com/${path}` → 'https://graph.microsoft.com/\u0000'
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const inner = this.evaluateStrings(span.expression, new Set(seen));
        if (!inner.unknown && inner.values.length === 1 && inner.values[0].exact) {
          text += inner.values[0].text;
        } else {
          text += '\u0000';
        }
        text += span.literal.text;
      }
      const exact = !text.includes('\u0000');
      return { values: [{ text, exact }], unknown: false };
    }

    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.evaluateStrings(node.whenTrue, new Set(seen));
      const whenFalse = this.evaluateStrings(node.whenFalse, new Set(seen));
      return {
        values: [...whenTrue.values, ...whenFalse.values],
        unknown: whenTrue.unknown || whenFalse.unknown,
      };
    }

    if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      const left = this.evaluateStrings(node.left, new Set(seen));
      const right = this.evaluateStrings(node.right, new Set(seen));
      return { values: [...left.values, ...right.values], unknown: left.unknown || right.unknown };
    }

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = this.resolveValueNode(node, seen);
      if (target === undefined) return empty;
      if (target === null) return empty;
      return this.evaluateStrings(target, seen);
    }

    return empty;
  }

  /**
   * Resolves an identifier / property access to the initializer expression it is
   * bound to, following only local declarations. Returns `null` when the target
   * is not statically knowable.
   */
  resolveValueNode(node, seen = new Set()) {
    const { ts } = this;

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const propertyName = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : (node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : null);
      if (!propertyName) return null;
      const objectNode = this.resolveValueNode(node.expression, seen);
      if (!objectNode || !ts.isObjectLiteralExpression(objectNode)) return null;
      for (const property of objectNode.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = this.propertyName(property);
        if (name === propertyName) return property.initializer;
      }
      return null;
    }

    if (!ts.isIdentifier(node)) return node;

    const { local } = this.declarationsFor(node);
    for (const declaration of local) {
      if (seen.has(declaration)) return null;
      seen.add(declaration);
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return declaration.initializer;
      }
      if (ts.isPropertyAssignment(declaration)) return declaration.initializer;
      if (ts.isExportAssignment(declaration)) return declaration.expression;
    }
    return null;
  }

  /** Static text of a property name, including quoted (`'ownerid': ...`) keys. */
  propertyName(property) {
    const { ts } = this;
    const name = property.name;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name)) {
      const evaluated = this.evaluateStrings(name.expression);
      if (!evaluated.unknown && evaluated.values.length === 1 && evaluated.values[0].exact) {
        return evaluated.values[0].text;
      }
      return null;
    }
    return null;
  }

  /**
   * Evaluates an array expression to its string entries.
   * @returns {{ values: string[], unknown: boolean }}
   */
  evaluateStringArray(node, seen = new Set()) {
    const { ts } = this;
    if (!node) return { values: [], unknown: true };
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
      return this.evaluateStringArray(node.expression, seen);
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const target = this.resolveValueNode(node, seen);
      if (!target) return { values: [], unknown: true };
      return this.evaluateStringArray(target, seen);
    }
    if (!ts.isArrayLiteralExpression(node)) return { values: [], unknown: true };

    const values = [];
    let unknown = false;
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = this.evaluateStringArray(element.expression, new Set(seen));
        values.push(...spread.values);
        if (spread.unknown) unknown = true;
        continue;
      }
      const evaluated = this.evaluateStrings(element, new Set(seen));
      if (evaluated.unknown) {
        unknown = true;
        continue;
      }
      for (const value of evaluated.values) {
        if (value.exact) values.push(value.text);
        else unknown = true;
      }
    }
    return { values, unknown };
  }

  // ── Bounded declaration following ─────────────────────────────────────────

  /**
   * Walks `roots` looking for a node that satisfies `predicate`, descending into
   * locally-declared components and helpers that the code references.
   *
   * @param {object[]} roots Nodes to search (usually a function body).
   * @param {(node: object, context: {resolver: Resolver, depth: number}) => boolean} predicate
   * @returns {{ matched: boolean, unknownBoundaries: string[] }}
   *   `unknownBoundaries` names every referenced abstraction the walk could not
   *   inspect (an opaque package or an unresolved import). A caller that did not
   *   match must downgrade `fail` to `unknown` when this list is non-empty.
   */
  search(roots, predicate, options = {}) {
    const { ts } = this;
    const maxDepth = options.maxDepth || MAX_FOLLOW_DEPTH;
    const followReferences = options.followReferences !== false;
    const seenDeclarations = new Set();
    const unknownBoundaries = new Set();
    let matched = false;
    let visitedDeclarations = 0;

    const visit = (node, depth) => {
      if (matched || !node) return;

      if (predicate(node, { resolver: this, depth })) {
        matched = true;
        return;
      }

      if (followReferences && depth < maxDepth) {
        const candidate = this.followCandidate(node);
        if (candidate) {
          const { local, externalModules } = this.declarationsFor(candidate.identifier);
          if (local.length > 0) {
            for (const declaration of local) {
              if (seenDeclarations.has(declaration)) continue;
              if (visitedDeclarations >= MAX_VISITED_DECLARATIONS) break;
              seenDeclarations.add(declaration);
              visitedDeclarations += 1;
              visit(declaration, depth + 1);
              if (matched) return;
            }
          } else if (candidate.reportsUnknown) {
            // Only an *opaque* dependency is an unknown boundary. Libraries the
            // rules already model (react-native, tamagui, expo, …) are known
            // quantities, and a symbol that resolved nowhere at all is unknown
            // by definition.
            const opaque = externalModules.filter((moduleName) => !isKnownLibrary(moduleName));
            if (opaque.length > 0 || externalModules.length === 0) {
              unknownBoundaries.add(
                `${candidate.identifier.text}${opaque.length > 0 ? ` (from "${opaque[0]}")` : ''}`,
              );
            }
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, depth));
    };

    for (const root of roots) visit(root, 0);
    return { matched, unknownBoundaries: [...unknownBoundaries] };
  }

  /**
   * Like {@link Resolver#search} but visits every node instead of stopping at
   * the first match. Used by rules that must collect all occurrences (for
   * example every `getAll(...)` call reachable from a screen, including the ones
   * inside an app-local cursor hook).
   */
  walk(roots, visitor, options = {}) {
    const { ts } = this;
    const maxDepth = options.maxDepth || MAX_FOLLOW_DEPTH;
    const seenDeclarations = new Set();
    const unknownBoundaries = new Set();
    let visitedDeclarations = 0;

    const visit = (node, depth) => {
      if (!node) return;
      visitor(node, { resolver: this, depth });

      if (depth < maxDepth) {
        const candidate = this.followCandidate(node);
        if (candidate) {
          const { local, externalModules } = this.declarationsFor(candidate.identifier);
          if (local.length > 0) {
            for (const declaration of local) {
              if (seenDeclarations.has(declaration)) continue;
              if (visitedDeclarations >= MAX_VISITED_DECLARATIONS) break;
              seenDeclarations.add(declaration);
              visitedDeclarations += 1;
              visit(declaration, depth + 1);
            }
          } else if (candidate.reportsUnknown) {
            // Only an *opaque* dependency is an unknown boundary. Libraries the
            // rules already model (react-native, tamagui, expo, …) are known
            // quantities, and a symbol that resolved nowhere at all is unknown
            // by definition.
            const opaque = externalModules.filter((moduleName) => !isKnownLibrary(moduleName));
            if (opaque.length > 0 || externalModules.length === 0) {
              unknownBoundaries.add(
                `${candidate.identifier.text}${opaque.length > 0 ? ` (from "${opaque[0]}")` : ''}`,
              );
            }
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, depth));
    };

    for (const root of roots) visit(root, 0);
    return { unknownBoundaries: [...unknownBoundaries] };
  }

  /**
   * Decides whether a node references another declaration worth following.
   *
   * Only two shapes are followed, because they are the shapes app-level
   * abstractions actually take: rendering a component (`<ScreenFrame>`) and
   * calling a helper or hook (`useSubmitLock()`, `runLocked()`).
   */
  followCandidate(node) {
    const { ts } = this;
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = node.tagName;
      if (ts.isIdentifier(tagName) && /^[A-Z]/.test(tagName.text)) {
        return { identifier: tagName, reportsUnknown: true };
      }
      return null;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      // Ignore obvious framework noise (`require`, `String`, ...) so unknown
      // boundaries stay meaningful.
      if (/^[a-z]/.test(name) === false && !/^use[A-Z]/.test(name)) {
        return { identifier: node.expression, reportsUnknown: false };
      }
      return {
        identifier: node.expression,
        reportsUnknown:
          /^use[A-Z]/.test(name)
          || /^(?:run|with|goTo|navigate|submit|save|load|fetch|mutate|lock)[A-Z_]/.test(name),
      };
    }
    return null;
  }
}

function lineOf(node) {
  const sourceFile = node.getSourceFile();
  if (!sourceFile) return 1;
  const start = node.getStart(sourceFile, /* includeJsDocComment */ false);
  return sourceFile.getLineAndCharacterOfPosition(start).line + 1;
}

module.exports = { Resolver, isKnownLibrary, lineOf, KNOWN_LIBRARY_PREFIXES };

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const registry = require('../registry');

const PLUGIN_ROOT = registry.PLUGIN_ROOT;
const TEMPLATE_ROOT = path.join(PLUGIN_ROOT, 'template');
const COLOR_PROPS = new Set(['color', 'col', 'bg', 'background', 'backgroundColor', 'borderColor', 'tintColor', 'placeholderTextColor']);
const PHYSICAL_PROPS = new Set(['left', 'right', 'marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']);
const INTERACTIVE_TAGS = new Set(['Button', 'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback']);
const DEFAULT_TOKENS = new Set(['$background', '$borderColor', '$accentBase', '$accentDeep', '$accentSoft', '$accentOnAccent', '$surface0', '$surface1', '$surface2', '$surface3', '$statusComplete', '$statusPending', '$statusOverdue', '$statusInProgress', '$statusDraft', '$statusCancelled']);

function loadTypescript(projectRoot) {
  return require(require.resolve('typescript', { paths: [projectRoot, TEMPLATE_ROOT] }));
}

function findProjectRoot(filePath) {
  let directory = path.dirname(path.resolve(filePath));
  while (directory !== path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, 'package.json'))
      && fs.existsSync(path.join(directory, 'app.config.js'))
      && fs.existsSync(path.join(directory, 'auth.config.json'))) return directory;
    directory = path.dirname(directory);
  }
  return null;
}

function isWatchedFile(filePath, projectRoot) {
  if (!filePath || !projectRoot || !filePath.endsWith('.tsx')) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/plugins/mobile-apps/') || normalized.includes('/node_modules/') || normalized.includes('/src/generated/')) return false;
  const relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  return (relative.startsWith('app/') || relative.startsWith('src/components/')) && !relative.endsWith('/_layout.tsx');
}

function nameText(ts, name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

function jsxTag(ts, node) {
  const name = node.tagName;
  return ts.isIdentifier(name) ? name.text : name.getText();
}

function attributes(ts, node) {
  const output = new Map();
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    const name = nameText(ts, property.name);
    let value = true;
    if (property.initializer && ts.isStringLiteral(property.initializer)) value = property.initializer.text;
    else if (property.initializer && ts.isJsxExpression(property.initializer)) value = property.initializer.expression;
    output.set(name, value);
  }
  return output;
}

function literalValue(ts, value) {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return value.text;
  if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
  return null;
}

function numericValue(ts, value) {
  const expression = value && ts.isJsxExpression(value) ? value.expression : value;
  if (expression && ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression && ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) return -Number(expression.operand.text);
  return null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function tokenNames(ts, projectRoot) {
  const names = new Set(DEFAULT_TOKENS);
  const tokenPath = path.join(projectRoot, 'brand', 'tokens.ts');
  if (!fs.existsSync(tokenPath)) return names;
  const file = ts.createSourceFile(tokenPath, fs.readFileSync(tokenPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) names.add(`$${nameText(ts, node.name)}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function componentExports(ts, projectRoot) {
  const filePath = path.join(projectRoot, 'src', 'components', 'index.tsx');
  if (!fs.existsSync(filePath)) return new Set();
  const file = ts.createSourceFile(filePath, fs.readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set();
  for (const statement of file.statements) {
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && statement.name) names.add(statement.name.text);
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  return names;
}

function localModuleExists(specifier, filePath, projectRoot) {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return true;
  const base = specifier.startsWith('@/')
    ? path.join(projectRoot, 'src', specifier.slice(2))
    : path.resolve(path.dirname(filePath), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .some((candidate) => fs.existsSync(candidate));
}

function lintSource(source, filePath, projectRoot) {
  const ts = loadTypescript(projectRoot);
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const allowedTokens = tokenNames(ts, projectRoot);
  const components = componentExports(ts, projectRoot);
  let hasRecordState = false;
  let hasConditionalField = false;

  const add = (id, node, actual, expected) => findings.push({ id, file: filePath, line: lineOf(sourceFile, node), actual, expected });
  const validToken = (value) => allowedTokens.has(value)
    || /^\$(?:color|gray|blue|red|green|yellow|orange)\d{1,2}$/.test(value)
    || /^\$\d+(?:\.\d+)?$/.test(value);

  const visit = (node, interactiveAncestors = []) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!localModuleExists(specifier, filePath, projectRoot)) add('static.import-resolution', node, specifier, 'a resolvable local module');
      if (specifier === '@/components' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if (!components.has(element.name.text)) add('static.component-inventory', element, element.name.text, 'an exported @/components symbol');
        }
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = jsxTag(ts, node);
      const attrs = attributes(ts, node);
      const interactive = INTERACTIVE_TAGS.has(tag) || attrs.has('onPress');
      if (interactive) {
        let parent = node.parent;
        if (ts.isJsxElement(parent) && parent.openingElement === node) parent = parent.parent;
        while (parent) {
          if (ts.isJsxElement(parent)) {
            const parentTag = jsxTag(ts, parent.openingElement);
            const parentAttrs = attributes(ts, parent.openingElement);
            if (INTERACTIVE_TAGS.has(parentTag) || parentAttrs.has('onPress')) {
              add('static.nested-tappable', node, tag, `no interactive descendant inside ${parentTag}`);
              break;
            }
          }
          parent = parent.parent;
        }
      }
      for (const [name, raw] of attrs) {
        const value = literalValue(ts, raw);
        if (COLOR_PROPS.has(name) && typeof value === 'string') {
          if (/^#[0-9a-f]{3,8}$/i.test(value)) add('static.raw-hex', node, `${name}=${value}`, 'a semantic color token');
          if (value.startsWith('$') && !validToken(value)) add('static.token-membership', node, value, 'a token declared by Config v5 or brand/tokens.ts');
        }
        if (name === 'allowFontScaling' && value === false) add('static.font-scaling', node, 'allowFontScaling={false}', 'font scaling enabled');
        if (name === 'letterSpacing' && numericValue(ts, raw) !== null && numericValue(ts, raw) !== 0) add('typography.script-aware', node, `letterSpacing=${numericValue(ts, raw)}`, 'a locale/script branch that resolves non-Latin scripts to 0');
        if (name === 'textTransform' && value === 'uppercase') add('typography.script-aware', node, 'textTransform=uppercase', 'a locale/script branch that resolves scripts without case to none');
        if (name === 'testID' && typeof value === 'string') {
          if (value.startsWith('conditional-field:')) hasConditionalField = true;
          if (value.startsWith('input-role:') && !value.endsWith(':numeric-stepper')) add('static.control-role', node, value, 'input-role:<field>:numeric-stepper');
        }
        if (name === 'data-record-state' || name === 'dataSet' && raw?.getText?.().includes('recordState')) hasRecordState = true;
      }
      if (/(?:Ionicons|MaterialIcons|FontAwesome|Icon)$/.test(tag)) {
        const iconName = literalValue(ts, attrs.get('name'));
        if (typeof iconName === 'string' && /(?:arrow|chevron|caret).*(?:left|right|back|forward)|(?:left|right|back|forward).*(?:arrow|chevron|caret)|^(?:arrow-back|arrow-forward|chevron-back|chevron-forward)/i.test(iconName)) {
          add('static.directional-icon', node, `name=${iconName}`, 'an I18nManager.isRTL conditional icon name');
        }
      }
      if (tag === 'Gradient') {
        const testId = literalValue(ts, attrs.get('testID'));
        const name = literalValue(ts, attrs.get('name'));
        const sourceValue = literalValue(ts, attrs.get('source'));
        const wrapperContract = typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(name) && /^(content|state|magnitude|legibility)$/.test(String(sourceValue || ''));
        const directContract = /^(content|state|magnitude|legibility)$/.test(String(sourceValue || '')) && /^gradient:[A-Za-z][A-Za-z0-9]*:(content|state|magnitude|legibility)$/.test(String(testId || ''));
        if (!wrapperContract && !directContract) {
          add('static.gradient-source', node, node.getText(sourceFile).slice(0, 120), 'source plus gradient:<token>:<source> testID');
        }
      }
      const position = attrs.get('position')?.getText?.() || '';
      const bottom = attrs.has('bottom') || attrs.get('style')?.getText?.().includes('bottom');
      const testId = literalValue(ts, attrs.get('testID'));
      if ((position.includes('absolute') || position.includes('fixed') || attrs.get('style')?.getText?.().match(/position\s*:\s*['"](?:absolute|fixed)/)) && bottom && !String(testId || '').startsWith('pinned:')) {
        add('static.testid', node, testId || '<missing>', 'pinned:<layer>');
      }
      const next = interactive ? [...interactiveAncestors, tag] : interactiveAncestors;
      ts.forEachChild(node, (child) => visit(child, next));
      return;
    }

    if (ts.isJsxText(node) && /\b(?:Item|Record|Entity)\s+\d+\b/.test(node.text)) add('static.binding-literal', node, node.text.trim(), 'a data binding');
    if (ts.isJsxText(node) && /\b[A-Za-z]+\(s\)/.test(node.text)) add('content.pluralisation', node, node.text.trim(), 'Intl.PluralRules, i18n plural forms, or an explicit singular/plural branch');
    if (ts.isTemplateExpression(node)) {
      const quantity = node.templateSpans.some((span) => /\b(?:count|length)\b/i.test(span.expression.getText(sourceFile)));
      const literalCopy = `${node.head.text}${node.templateSpans.map((span) => span.literal.text).join('')}`;
      if (quantity && /\s+[A-Za-z]+s\b/.test(literalCopy)) add('content.pluralisation', node, node.getText(sourceFile), 'Intl.PluralRules, i18n plural forms, or an explicit singular/plural branch');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = node.left.getText(sourceFile);
      const right = node.right.getText(sourceFile);
      const unsafe = /\b(?:count|length)\b/i.test(left) && /^['"]\s+[A-Za-z]+s\b/.test(right)
        || /\b(?:count|length)\b/i.test(right) && /^['"]\s+[A-Za-z]+s\b/.test(left);
      if (unsafe) add('content.pluralisation', node, node.getText(sourceFile), 'Intl.PluralRules, i18n plural forms, or an explicit singular/plural branch');
    }
    if (ts.isJsxExpression(node) && node.expression) {
      const text = node.expression.getText(sourceFile);
      if (/\.toUpperCase\s*\(/.test(text)) add('typography.script-aware', node, text, 'locale-authored casing or a script-aware branch');
      if (/\.(?:cr_)?(?:status|state|phase|outcome)\b/i.test(text) && !/choiceLabel|statusToken|formattedValue/.test(text)) {
        add('static.choice-label', node, text, 'choiceLabel/statusToken/formattedValue');
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = nameText(ts, node.name);
      if (PHYSICAL_PROPS.has(name)) add('static.logical-properties', node, name, name.replace(/Left/g, 'Start').replace(/Right/g, 'End').replace(/^left$/, 'start').replace(/^right$/, 'end'));
      if (COLOR_PROPS.has(name) && ts.isStringLiteral(node.initializer) && /^#[0-9a-f]{3,8}$/i.test(node.initializer.text)) add('static.raw-hex', node, `${name}: ${node.initializer.text}`, 'a semantic color token');
      const spacing = numericValue(ts, node.initializer);
      if (name === 'letterSpacing' && spacing !== null && spacing !== 0) add('typography.script-aware', node, `letterSpacing=${spacing}`, 'a locale/script branch that resolves non-Latin scripts to 0');
      if (name === 'textTransform' && ts.isStringLiteral(node.initializer) && node.initializer.text === 'uppercase') add('typography.script-aware', node, 'textTransform=uppercase', 'a locale/script branch that resolves scripts without case to none');
    }
    ts.forEachChild(node, (child) => visit(child, interactiveAncestors));
  };
  visit(sourceFile);
  if (hasConditionalField && !hasRecordState) add('static.conditional', sourceFile, 'conditional-field without data-record-state', 'state evidence on its record row');
  return findings;
}

function lintFile(filePath, projectRoot = findProjectRoot(filePath)) {
  if (!isWatchedFile(filePath, projectRoot)) return [];
  return lintSource(fs.readFileSync(filePath, 'utf8'), filePath, projectRoot);
}

function staticEntries() {
  return registry.load().filter((entry) => entry.tier === 1);
}

function blockingFindings(findings) {
  const metadata = new Map(staticEntries().map((entry) => [entry.id, entry]));
  return findings.filter((finding) => metadata.get(finding.id)?.blocking);
}

function formatFindings(findings, startedAt) {
  const elapsed = performance.now() - startedAt;
  return [`[mobile-app] static AST gate found ${findings.length} blocking issue(s) in ${elapsed.toFixed(1)}ms:`, ...findings.map((finding) => `- ${finding.id} ${path.basename(finding.file)}:${finding.line}: ${finding.actual}; expected ${finding.expected}`)].join('\n');
}

function parseCli(argv) {
  const projectIndex = argv.indexOf('--project');
  const fileIndexes = argv.flatMap((value, index) => value === '--file' ? [index + 1] : []);
  return { all: argv.includes('--all'), projectRoot: projectIndex >= 0 ? path.resolve(argv[projectIndex + 1]) : null, files: fileIndexes.map((index) => argv[index]) };
}

function collect(projectRoot) {
  const output = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && target.endsWith('.tsx')) output.push(target);
    }
  };
  walk(path.join(projectRoot, 'app'));
  walk(path.join(projectRoot, 'src', 'components'));
  return output;
}

function runFiles(files, projectRoot) {
  const startedAt = performance.now();
  const findings = files.flatMap((file) => lintFile(path.resolve(projectRoot, file), projectRoot));
  const blocking = blockingFindings(findings);
  if (blocking.length > 0) {
    process.stderr.write(`${formatFindings(blocking, startedAt)}\n`);
    return 2;
  }
  process.stdout.write(JSON.stringify({ files: files.length, findings, elapsedMs: Number((performance.now() - startedAt).toFixed(2)) }) + '\n');
  return 0;
}

function runHook(payload) {
  const toolName = payload.tool_name || payload.toolName;
  if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) return 0;
  const input = payload.tool_input || payload.toolInput || {};
  const filePath = input.file_path || input.filePath;
  const projectRoot = findProjectRoot(filePath);
  if (!isWatchedFile(filePath, projectRoot)) return 0;
  return runFiles([filePath], projectRoot);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--project')) {
    const cli = parseCli(args);
    const files = cli.all ? collect(cli.projectRoot) : cli.files;
    process.exit(runFiles(files, cli.projectRoot));
  }
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try { process.exit(runHook(JSON.parse(input || '{}'))); } catch (error) { process.stderr.write(`static AST gate error: ${error.message}\n`); process.exit(2); }
  });
}

if (require.main === module) main();

module.exports = { blockingFindings, collect, findProjectRoot, isWatchedFile, lintFile, lintSource, runFiles, runHook };
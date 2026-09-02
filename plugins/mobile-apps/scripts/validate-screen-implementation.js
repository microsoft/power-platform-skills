#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const { validateSealedWorkOrder } = require('./lib/screen-builder-work-order');

const MEDIA_COMPONENTS = new Set([
  'Image',
  'ExpoImage',
  'Video',
  'VideoView',
  'CameraView',
  'BarcodeScannerView',
  'DocumentView',
  'Pdf',
]);
const OPERATION_METHODS = {
  read: new Set(['get', 'getAll', 'find', 'list', 'query', 'retrieve', 'retrieveMultipleRecordsAsync']),
  create: new Set(['add', 'create', 'insert']),
  update: new Set(['save', 'update', 'upsert']),
  delete: new Set(['delete', 'remove']),
  'external-call': new Set(['call', 'execute', 'get', 'getAll', 'invoke', 'request', 'send']),
};

function finding(code, message) {
  return { code, message };
}

function loadTypeScript(projectRoot) {
  try {
    const projectRequire = createRequire(path.join(path.resolve(projectRoot), 'package.json'));
    return projectRequire('typescript');
  } catch (error) {
    throw new Error(
      `TypeScript compiler API is unavailable under ${projectRoot}; run npm install before the screen gate (${error.code || error.message})`,
    );
  }
}

function propertyName(node, sourceFile) {
  if (!node) return '';
  if (node.escapedText !== undefined) return String(node.escapedText);
  return node.getText(sourceFile).replace(/^['"]|['"]$/g, '');
}

function jsxTag(node, sourceFile) {
  return node.tagName.getText(sourceFile).split('.').at(-1);
}

function jsxAttributes(node, sourceFile, ts) {
  const result = {};
  for (const attribute of node.attributes?.properties || []) {
    if (!ts.isJsxAttribute(attribute)) continue;
    const name = propertyName(attribute.name, sourceFile);
    if (!attribute.initializer) {
      result[name] = 'true';
    } else if (ts.isStringLiteral(attribute.initializer)) {
      result[name] = attribute.initializer.text;
    } else if (ts.isJsxExpression(attribute.initializer)) {
      const expression = attribute.initializer.expression;
      result[name] = expression && ts.isStringLiteralLike(expression)
        ? expression.text
        : expression?.getText(sourceFile) || '';
    }
  }
  return result;
}

function collectAst(sourceFile, ts) {
  const state = {
    calls: [],
    jsx: [],
    routeParams: new Set(),
    strings: new Set(),
  };
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      state.strings.add(node.text);
    } else if (ts.isJsxText(node)) {
      const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
      if (text) state.strings.add(text);
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(sourceFile);
      const method = ts.isPropertyAccessExpression(node.expression)
        ? propertyName(node.expression.name, sourceFile)
        : expression;
      state.calls.push({ expression, method });
      if (expression.endsWith('useLocalSearchParams')) {
        const type = node.typeArguments?.[0];
        if (type && ts.isTypeLiteralNode(type)) {
          for (const member of type.members) {
            const name = propertyName(member.name, sourceFile);
            if (name) state.routeParams.add(name);
          }
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      state.jsx.push({
        attributes: jsxAttributes(node, sourceFile, ts),
        node,
        tag: jsxTag(node, sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return state;
}

function ancestorTags(entry, sourceFile, ts) {
  const tags = [];
  let current = entry.node.parent;
  while (current) {
    if (ts.isJsxElement(current)) tags.push(jsxTag(current.openingElement, sourceFile));
    else if (ts.isJsxSelfClosingElement(current)) tags.push(jsxTag(current, sourceFile));
    current = current.parent;
  }
  return tags;
}

function elementText(entry, sourceFile) {
  const node = entry.node.parent?.kind === undefined ? entry.node : entry.node.parent;
  return node.getText(sourceFile);
}

function validateScreenImplementation({ sourceText, workOrder, typescript }) {
  const ts = typescript;
  if (!ts?.createSourceFile) throw new Error('typescript.createSourceFile is required');
  const sourceFile = ts.createSourceFile(
    `${workOrder.screenId}.tsx`,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const errors = (sourceFile.parseDiagnostics || []).map((diagnostic) => finding(
    'tsx-parse-error',
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  ));
  const implementation = workOrder.pack?.implementationContract;
  if (!implementation) {
    return { ok: false, errors: [finding('implementation-contract-missing', 'compiled screen implementation contract is required')] };
  }
  const expectedTestIds = Object.values(implementation.testIds || {});
  const missingSealedIds = expectedTestIds.filter((id) => !workOrder.testIds.includes(id));
  if (missingSealedIds.length > 0) {
    errors.push(finding(
      'work-order-test-id-drift',
      `sealed work order omits implementation test IDs: ${missingSealedIds.join(', ')}`,
    ));
  }

  const ast = collectAst(sourceFile, ts);
  const byTestId = new Map(ast.jsx
    .filter((entry) => entry.attributes.testID)
    .map((entry) => [entry.attributes.testID, entry]));
  for (const id of expectedTestIds) {
    if (!byTestId.has(id)) {
      errors.push(finding('required-test-id-missing', `screen is missing AST testID ${id}`));
    }
  }

  const focal = byTestId.get(implementation.testIds?.focal);
  const canonicalHeadline = String(workOrder.scenarioFacts?.headline || '');
  if (focal && canonicalHeadline && !elementText(focal, sourceFile).includes(canonicalHeadline)) {
    errors.push(finding(
      'canonical-identity-missing',
      `focal region does not render canonical scenario identity ${canonicalHeadline}`,
    ));
  }

  const primary = byTestId.get(implementation.testIds?.primaryAction);
  if (primary && !elementText(primary, sourceFile).includes(implementation.primaryActionLabel)) {
    errors.push(finding(
      'primary-action-label-mismatch',
      `primary action does not render ${implementation.primaryActionLabel}`,
    ));
  }

  for (const routeParam of implementation.routeParams || []) {
    if (!ast.routeParams.has(routeParam)) {
      errors.push(finding(
        'route-param-missing',
        `useLocalSearchParams type does not declare ${routeParam}`,
      ));
    }
  }

  for (const operation of implementation.requiredOperations || []) {
    const methods = OPERATION_METHODS[operation.kind] || new Set();
    const present = ast.calls.some((call) => methods.has(call.method));
    if (!present) {
      errors.push(finding(
        'domain-operation-missing',
        `screen has no AST call for ${operation.kind}:${operation.entity || 'none'}`,
      ));
    }
  }

  const forbiddenNavigators = ast.jsx.filter((entry) => ['Tabs', 'Drawer'].includes(entry.tag));
  if (forbiddenNavigators.length > 0) {
    errors.push(finding(
      'screen-owns-navigation-shell',
      'individual screen files cannot render Tabs or Drawer; the navigation manifest owns shared shells',
    ));
  }

  if (implementation.mediaBinding) {
    const media = byTestId.get(implementation.testIds?.media);
    if (media && !MEDIA_COMPONENTS.has(media.tag)) {
      errors.push(finding(
        'media-component-missing',
        `${implementation.testIds.media} must be a real image/media component`,
      ));
    }
    if (media && !media.attributes.source && !media.attributes.uri) {
      errors.push(finding('media-source-missing', 'required media component has no source binding'));
    }
    const bindingValue = implementation.mediaBinding.replace(/^(asset|field):/, '');
    if (!ast.strings.has(bindingValue)) {
      errors.push(finding(
        'media-binding-missing',
        `screen does not reference canonical media binding ${bindingValue}`,
      ));
    }
    if (implementation.mediaFallback && !ast.strings.has(implementation.mediaFallback)) {
      errors.push(finding(
        'media-fallback-missing',
        'screen does not include the approved media fallback',
      ));
    }
  }

  if (implementation.primaryActionPlacement === 'sticky-bottom' && primary) {
    const sticky = byTestId.get(implementation.testIds?.stickyAction);
    if (!sticky || !['BottomActionBar', 'StickyActionBar'].includes(sticky.tag)) {
      errors.push(finding(
        'sticky-action-container-missing',
        'sticky primary action requires BottomActionBar or StickyActionBar',
      ));
    } else {
      const role = sticky.attributes.bottomInsetRole || sticky.attributes.safeAreaBottomRole;
      if (role !== implementation.safeAreaBottomRole) {
        errors.push(finding(
          'sticky-safe-area-mismatch',
          `sticky action must use bottom inset role ${implementation.safeAreaBottomRole}`,
        ));
      }
      if (!ancestorTags(primary, sourceFile, ts).includes(sticky.tag)) {
        errors.push(finding(
          'primary-action-outside-sticky-container',
          'primary action is not inside its sticky safe-area container',
        ));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      callCount: ast.calls.length,
      jsxElementCount: ast.jsx.length,
      testIdCount: byTestId.size,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--work-order') args.workOrder = argv[++index];
    else if (argv[index] === '--file') args.file = argv[++index];
    else if (argv[index] === '--json') args.json = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.projectRoot || !args.workOrder || !args.file) {
    throw new Error('--project-root, --work-order, and --file are required');
  }
  return args;
}

function main(argv = process.argv) {
  try {
    const args = parseArgs(argv);
    const projectRoot = path.resolve(args.projectRoot);
    const workOrder = validateSealedWorkOrder(
      JSON.parse(fs.readFileSync(path.resolve(projectRoot, args.workOrder), 'utf8')),
      { projectRoot },
    );
    const result = validateScreenImplementation({
      sourceText: fs.readFileSync(path.resolve(projectRoot, args.file), 'utf8'),
      workOrder,
      typescript: loadTypeScript(projectRoot),
    });
    if (args.json || result.ok) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else result.errors.forEach((item) => process.stderr.write(`${item.code}: ${item.message}\n`));
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`validate-screen-implementation: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  collectAst,
  loadTypeScript,
  main,
  validateScreenImplementation,
};

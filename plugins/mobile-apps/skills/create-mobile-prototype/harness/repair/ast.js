'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../registry');

const PHYSICAL_TO_LOGICAL = {
  left: 'start', right: 'end', marginLeft: 'marginStart', marginRight: 'marginEnd',
  paddingLeft: 'paddingStart', paddingRight: 'paddingEnd', borderLeftWidth: 'borderStartWidth',
  borderRightWidth: 'borderEndWidth',
};

function loadTypescript(projectDir) {
  return require(require.resolve('typescript', { paths: [projectDir, path.join(registry.PLUGIN_ROOT, 'template')] }));
}

function atomicWrite(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filePath);
}

function safeToken(property) {
  if (/background|\bbg\b/i.test(property)) return '$surface0';
  if (/border/i.test(property)) return '$borderColor';
  return '$accentDeep';
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function jsxName(ts, attribute) {
  return ts.isIdentifier(attribute.name) ? attribute.name.text : attribute.name.getText();
}

function literalText(ts, initializer) {
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression && (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))) return initializer.expression.text;
  return null;
}

function replacementForInitializer(ts, initializer, value) {
  return ts.isJsxExpression(initializer) ? `{${JSON.stringify(value)}}` : JSON.stringify(value);
}

function transformSource(source, filePath, findings, projectDir) {
  const ts = loadTypescript(projectDir);
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const byLine = new Map();
  for (const finding of findings) {
    const items = byLine.get(finding.line) || [];
    items.push(finding);
    byLine.set(finding.line, items);
  }
  const edits = [];
  const repaired = new Set();
  const addEdit = (finding, start, end, text) => {
    edits.push({ start, end, text });
    repaired.add(`${finding.id}:${finding.line}`);
  };
  const visit = (node) => {
    const lineFindings = byLine.get(lineOf(sourceFile, node)) || [];
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter((property) => ts.isJsxAttribute(property));
      for (const finding of lineFindings) {
        if (finding.id === 'static.font-scaling') {
          const attribute = attributes.find((candidate) => jsxName(ts, candidate) === 'allowFontScaling');
          if (attribute) addEdit(finding, attribute.getFullStart(), attribute.end, '');
        }
        if (finding.id === 'static.raw-hex' || finding.id === 'static.token-membership') {
          const property = String(finding.actual).split(/[=:]/, 1)[0];
          const attribute = attributes.find((candidate) => {
            const name = jsxName(ts, candidate);
            const value = literalText(ts, candidate.initializer);
            return name === property || value === finding.actual;
          });
          if (attribute?.initializer) addEdit(finding, attribute.initializer.getStart(sourceFile), attribute.initializer.end, replacementForInitializer(ts, attribute.initializer, safeToken(jsxName(ts, attribute))));
        }
        if (finding.id === 'static.testid') {
          const attribute = attributes.find((candidate) => jsxName(ts, candidate) === 'testID');
          const value = `pinned:auto-${finding.line}`;
          if (attribute?.initializer) addEdit(finding, attribute.initializer.getStart(sourceFile), attribute.initializer.end, replacementForInitializer(ts, attribute.initializer, value));
          else if (!attribute) addEdit(finding, node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1), node.end - (ts.isJsxSelfClosingElement(node) ? 2 : 1), ` testID=${JSON.stringify(value)}`);
        }
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(sourceFile).replace(/^['"]|['"]$/g, '');
      for (const finding of lineFindings) {
        const property = String(finding.actual).split(/[=:]/, 1)[0].trim();
        if (finding.id === 'static.logical-properties' && property === name && PHYSICAL_TO_LOGICAL[name]) {
          addEdit(finding, node.name.getStart(sourceFile), node.name.end, PHYSICAL_TO_LOGICAL[name]);
        }
        if (finding.id === 'static.raw-hex' && property === name && ts.isStringLiteral(node.initializer) && /^#[0-9a-f]{3,8}$/i.test(node.initializer.text)) {
          addEdit(finding, node.initializer.getStart(sourceFile), node.initializer.end, JSON.stringify(safeToken(name)));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const unique = [...new Map(edits.map((edit) => [`${edit.start}:${edit.end}`, edit])).values()].sort((left, right) => right.start - left.start);
  let output = source;
  for (const edit of unique) output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  return { changed: output !== source, output, repaired: [...repaired] };
}

function defaultTypecheck(projectDir) {
  const result = spawnSync('npm', ['--prefix', projectDir, 'run', 'type-check'], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

function insideProject(projectDir, filePath) {
  const absolute = path.resolve(projectDir, filePath);
  return absolute === projectDir || absolute.startsWith(`${projectDir}${path.sep}`) ? absolute : null;
}

function applyClassA(projectDir, findings, options = {}) {
  const root = path.resolve(projectDir);
  const grouped = new Map();
  for (const finding of findings.filter((candidate) => candidate.class === 'A')) {
    const filePath = insideProject(root, finding.file);
    if (!filePath || !fs.existsSync(filePath)) continue;
    const list = grouped.get(filePath) || [];
    list.push(finding);
    grouped.set(filePath, list);
  }
  const originals = new Map();
  const changedFiles = [];
  const repaired = [];
  for (const [filePath, fileFindings] of grouped) {
    const source = fs.readFileSync(filePath, 'utf8');
    const transformed = transformSource(source, filePath, fileFindings, root);
    if (!transformed.changed) continue;
    originals.set(filePath, source);
    atomicWrite(filePath, transformed.output);
    changedFiles.push(filePath);
    repaired.push(...transformed.repaired);
  }
  if (changedFiles.length === 0) return { ok: true, changedFiles, repaired, reverted: false, typecheckRuns: 0, modelCalls: 0 };
  const result = (options.typecheck || defaultTypecheck)(root);
  const normalized = typeof result === 'boolean' ? { ok: result, output: '' } : result;
  if (!normalized.ok) {
    for (const [filePath, source] of originals) atomicWrite(filePath, source);
    return { ok: false, changedFiles: [], repaired: [], reverted: true, typecheckRuns: 1, modelCalls: 0, diagnostics: normalized.output || '' };
  }
  return { ok: true, changedFiles, repaired, reverted: false, typecheckRuns: 1, modelCalls: 0 };
}

module.exports = { PHYSICAL_TO_LOGICAL, applyClassA, safeToken, transformSource };
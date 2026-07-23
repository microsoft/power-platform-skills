#!/usr/bin/env node
'use strict';

/**
 * Verify that every deterministic critical source obligation has either an
 * exact implementation marker in an allowed target file or an exact semantic
 * delta marker backed by explicit user approval in source-deltas.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict') || process.env.STRICT === '1';
const CONTRACT_PATH = path.join(ROOT, 'critical-obligations.json');
const DELTAS_PATH = path.join(ROOT, 'source-deltas.json');
const DEFAULT_SCAN_DIRS = ['app', 'src', 'brand'];
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const IGNORED_DIRS = new Set(['node_modules', '.expo', '.git', 'dist', 'build', 'coverage']);

function fail(message, code = 1) {
  console.error(`[obligations] ${message}`);
  process.exit(code);
}

function readJson(file, label) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file`, 2);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`, 2);
  }
}

function containedFile(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) return null;
  if (/[\0\\\u0000-\u001f\u007f]/.test(relativePath) || path.posix.normalize(relativePath) !== relativePath) return null;
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}

function parseMarkersFromText(text, file = '<memory>') {
  const markers = [];
  const sourceText = String(text || '');
  const lines = sourceText.split(/\r?\n/);
  const pattern = /^\s*\/\/\s*(source-obligation|source-delta):\s*(obl-[0-9a-f]{16})(?![a-z0-9-])/i;
  let offset = 0;
  lines.forEach((line, index) => {
    const match = pattern.exec(line);
    if (match) {
      markers.push({
        type: match[1].toLowerCase() === 'source-obligation' ? 'implementation' : 'delta',
        id: match[2].toLowerCase(),
        file,
        line: index + 1,
        offset,
        end: offset + line.length,
      });
    }
    offset += line.length + 1;
  });
  return markers;
}

function walkSourceFiles(root, relativeDirs = DEFAULT_SCAN_DIRS) {
  const files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
    }
  }
  for (const relativeDir of relativeDirs) walk(path.join(root, relativeDir));
  return files.sort();
}

function collectMarkers(root, relativeDirs = DEFAULT_SCAN_DIRS) {
  const markers = [];
  for (const file of walkSourceFiles(root, relativeDirs)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    markers.push(...parseMarkersFromText(fs.readFileSync(file, 'utf8'), relative));
  }
  return markers;
}

function verifyEvidenceFacts(marker, obligation, facts) {
  if (!facts || !facts.attached) return 'marker is not the leading comment of a TypeScript implementation node';
  if (facts.placeholder) return 'marker is attached to TODO/placeholder/not-implemented code';
  const requirement = obligation.requirement || {};
  const category = obligation.category;
  const structuralDelta = marker.type === 'delta';

  if (category === 'component-command') {
    if (!facts.exportedNames.includes(requirement.targetExport)) return `shared command must export ${requirement.targetExport || '(missing export contract)'}`;
    if (!facts.hasExecutableBody) return 'shared command export has no executable body';
    return null;
  }
  if (category === 'component-command-availability') {
    if (!facts.imports.some((row) => row.module === requirement.commandImportPath && row.names.includes(requirement.commandExportName))) {
      return `screen must import ${requirement.commandExportName || '(missing export)'} from ${requirement.commandImportPath || '(missing import path)'}`;
    }
    if (!facts.callNames.includes(requirement.commandExportName)) return `screen must invoke ${requirement.commandExportName}`;
    return null;
  }
  if (category === 'screen-presence') {
    const missing = [];
    if (!facts.hasDefaultExport) missing.push('default export');
    if (!facts.hasJsx) missing.push('JSX');
    if (!facts.hasNonNullReturn) missing.push('non-null return');
    if (missing.length) return `screen presence requires a default-exported component with a non-null JSX return (missing: ${missing.join(', ')}; node: ${facts.nodeKind || 'unknown'})`;
    return null;
  }
  if (category === 'navigation' || category === 'start-screen') {
    if (!facts.hasNavigation) return `${category} requires an Expo Router navigation/Redirect operation`;
    if (!structuralDelta && requirement.targetRoute && !facts.stringLiterals.includes(requirement.targetRoute)) {
      return `navigation must target ${requirement.targetRoute}`;
    }
    if (!structuralDelta) {
      for (const key of requirement.contextKeys || []) {
        if (!facts.propertyNames.includes(key) && !facts.identifiers.includes(key)) return `navigation context key is missing: ${key}`;
      }
    }
    return null;
  }
  if (category === 'saved-view-semantics') {
    if (!facts.hasQueryOperation) return 'saved-view implementation requires a real query/hook operation';
    const targetViewId = requirement.targetViewId || obligation.source?.viewId;
    if (!structuralDelta && targetViewId && !facts.stringLiterals.includes(targetViewId)) {
      return `saved-view query must use resolved target view ID ${targetViewId}`;
    }
    if (!structuralDelta && requirement.executionParameter
      && !facts.stringLiterals.includes(requirement.executionParameter)
      && !facts.propertyNames.includes(requirement.executionParameter)
      && !facts.identifiers.includes(requirement.executionParameter)) {
      return `saved-view query must use ${requirement.executionParameter}`;
    }
    if (!structuralDelta) {
      for (const column of requirement.columns || []) {
        if (!facts.stringLiterals.includes(column) && !facts.identifiers.includes(column)) return `saved-view column is missing: ${column}`;
      }
      for (const order of requirement.orderBy || []) {
        const field = typeof order === 'string' ? order.split(/\s+/)[0] : order?.field;
        if (field && !facts.stringLiterals.includes(field) && !facts.identifiers.includes(field)) return `saved-view ordering is missing: ${field}`;
      }
    }
    return null;
  }
  if (category === 'design-baseline') {
    if (!facts.exportedNames.includes('tokens')) return 'design evidence must be attached to the exported tokens object';
    if (structuralDelta) return null;
    const requiredColors = requirement.requiredColors || [];
    const literalColors = facts.stringLiterals.map((value) => value.toLowerCase());
    for (const color of requiredColors) {
      if (!literalColors.includes(String(color).toLowerCase())) return `source design color is missing: ${color}`;
    }
    for (const token of requirement.requiredDimensionTokens || []) {
      if (!facts.propertyNames.includes(token) && !facts.identifiers.includes(token) && !facts.stringLiterals.includes(token)) {
        return `source design dimension token is missing: ${token}`;
      }
    }
    const font = requirement.requiredFont || obligation.source?.typography?.dominantFont;
    if (font && !facts.stringLiterals.some((value) => value.toLowerCase() === String(font).toLowerCase())) return `source dominant font is missing: ${font}`;
    return null;
  }
  return `unsupported critical obligation category: ${category}`;
}

function createTypeScriptEvidenceVerifier(root, ts) {
  const cache = new Map();

  function parse(relativeFile) {
    if (cache.has(relativeFile)) return cache.get(relativeFile);
    const absolute = containedFile(root, relativeFile);
    if (!absolute || !fs.existsSync(absolute)) return null;
    const text = fs.readFileSync(absolute, 'utf8');
    const kind = relativeFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(relativeFile, text, ts.ScriptTarget.Latest, true, kind);
    const imports = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const names = [];
      const clause = statement.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.push(element.name.text);
      }
      imports.push({ module: statement.moduleSpecifier.text, names });
    }
    const parsed = { text, sourceFile, imports };
    cache.set(relativeFile, parsed);
    return parsed;
  }

  function hasModifier(node, kind) {
    return !!node.modifiers?.some((modifier) => modifier.kind === kind);
  }

  function candidateNode(parsed, marker) {
    const { text, sourceFile } = parsed;
    let best = null;
    function visit(node) {
      if (node !== sourceFile && ts.isStatement(node)) {
        for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) || []) {
          const between = text.slice(marker.end, node.getStart(sourceFile));
          if (marker.offset <= range.pos && marker.end <= range.end && between.trim() === '') {
            const span = node.getEnd() - node.getStart(sourceFile);
            if (!best || span < best.span) best = { node, span };
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return best?.node || null;
  }

  function factsFor(marker) {
    const parsed = parse(marker.file);
    if (!parsed) return null;
    const node = candidateNode(parsed, marker);
    if (!node) return { attached: false };
    const nodeText = node.getText(parsed.sourceFile);
    const callNames = [];
    const stringLiterals = [];
    const propertyNames = [];
    const identifiers = [];
    const exportedNames = [];
    let hasJsx = false;
    let hasNonNullReturn = false;
    let hasDefaultExport = false;
    let hasExecutableBody = false;
    let hasNavigation = false;
    let hasQueryOperation = false;

    if (ts.isFunctionDeclaration(node) && node.name && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      exportedNames.push(node.name.text);
      hasDefaultExport = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
      hasExecutableBody = !!node.body && node.body.statements.length > 0;
    }
    if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedNames.push(declaration.name.text);
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          hasExecutableBody = !ts.isBlock(declaration.initializer.body) || declaration.initializer.body.statements.length > 0;
        } else if (declaration.initializer) hasExecutableBody = true;
      }
    }
    if (ts.isExportAssignment(node)) hasDefaultExport = !node.isExportEquals;

    function visit(current) {
      if (ts.isIdentifier(current)) identifiers.push(current.text);
      if (ts.isStringLiteralLike(current)) stringLiterals.push(current.text);
      if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
        const name = current.name;
        if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) propertyNames.push(name.text);
      }
      if (ts.isReturnStatement(current) && current.expression && current.expression.kind !== ts.SyntaxKind.NullKeyword) hasNonNullReturn = true;
      if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) hasJsx = true;
      if (ts.isCallExpression(current)) {
        let callName = '';
        if (ts.isIdentifier(current.expression)) callName = current.expression.text;
        else if (ts.isPropertyAccessExpression(current.expression)) callName = `${current.expression.expression.getText(parsed.sourceFile)}.${current.expression.name.text}`;
        if (callName) callNames.push(callName);
        if (/^(?:router\.)?(?:push|replace|navigate|back)$/.test(callName) || /^router\.(?:push|replace|navigate|back)$/.test(callName)) hasNavigation = true;
        if (/(?:useQuery|useInfiniteQuery|useViewQuery|\.getAll|\.get)$/.test(callName)) hasQueryOperation = true;
      }
      if (ts.isJsxSelfClosingElement(current) || ts.isJsxOpeningElement(current)) {
        const tag = current.tagName.getText(parsed.sourceFile);
        if (tag === 'Redirect' || tag === 'Link') {
          hasNavigation = true;
          for (const attribute of current.attributes.properties) {
            if (!ts.isJsxAttribute(attribute) || attribute.name.text !== 'href' || !attribute.initializer) continue;
            if (ts.isStringLiteral(attribute.initializer)) stringLiterals.push(attribute.initializer.text);
          }
        }
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
    if (hasJsx && hasNonNullReturn) hasExecutableBody = true;
    return {
      attached: true,
      nodeKind: ts.SyntaxKind[node.kind],
      nodeText,
      placeholder: /\b(?:TODO|placeholder|not[ -]implemented)\b/i.test(nodeText),
      imports: parsed.imports,
      callNames: [...new Set(callNames)],
      stringLiterals: [...new Set(stringLiterals)],
      propertyNames: [...new Set(propertyNames)],
      identifiers: [...new Set(identifiers)],
      exportedNames: [...new Set(exportedNames)],
      hasJsx,
      hasNonNullReturn,
      hasDefaultExport,
      hasExecutableBody,
      hasNavigation,
      hasQueryOperation,
    };
  }

  return (marker, obligation) => verifyEvidenceFacts(marker, obligation, factsFor(marker));
}

function normalizeDeltaApprovals(document) {
  const errors = [];
  if (document != null && (!document || document.$schema !== 'source-deltas-v1')) {
    errors.push('source-deltas.json $schema must be "source-deltas-v1"');
  }
  const rows = Array.isArray(document)
    ? document
    : (document && Array.isArray(document.deltas) ? document.deltas : []);
  const approvals = new Map();
  for (const row of rows) {
    const id = row && (row.obligationId || row.id);
    if (!id) continue;
    if (approvals.has(String(id))) errors.push(`duplicate semantic delta approval: ${id}`);
    else approvals.set(String(id), row);
  }
  return { approvals, errors };
}

function validateApproval(approval, sourceTreeSha256, sourceInputSha256) {
  if (!approval) return 'missing source-deltas.json entry';
  if (approval.status !== 'approved') return 'status must be "approved"';
  if (approval.approvedBy !== 'user') return 'approvedBy must be "user"';
  for (const field of ['approvedAt', 'approvalReceipt', 'rationale', 'targetBehavior']) {
    if (typeof approval[field] !== 'string' || approval[field].trim() === '') return `${field} is required`;
  }
  if (!Number.isFinite(Date.parse(approval.approvedAt))) return 'approvedAt must be an ISO timestamp';
  if (approval.sourceTreeSha256 !== sourceTreeSha256) return 'sourceTreeSha256 must match the critical obligation contract';
  if (approval.sourceInputSha256 !== sourceInputSha256) return 'sourceInputSha256 must match the critical obligation contract';
  return null;
}

function allowedEvidenceFiles(root, obligation, allSourceFiles) {
  const targets = Array.isArray(obligation?.requirement?.targetFiles)
    ? obligation.requirement.targetFiles
    : [];
  const targetRoots = Array.isArray(obligation?.requirement?.targetRoots)
    ? obligation.requirement.targetRoots
    : [];
  if (targets.length === 0 && targetRoots.length === 0) return { files: [], issues: ['obligation has no constrained evidence target'] };
  const files = [];
  const issues = [];
  for (const target of targets) {
    const resolved = containedFile(root, target);
    if (!resolved) {
      issues.push(`unsafe target file ${target}`);
      continue;
    }
    if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isFile()) {
      issues.push(`target file missing: ${target}`);
      continue;
    }
    files.push(target);
  }
  for (const targetRoot of targetRoots) {
    const resolved = containedFile(root, targetRoot);
    if (!resolved) {
      issues.push(`unsafe target root ${targetRoot}`);
      continue;
    }
    files.push(...allSourceFiles.filter((file) => file === targetRoot || file.startsWith(`${targetRoot}/`)));
  }
  return { files: [...new Set(files)], issues };
}

function auditCriticalObligations(contract, markers, deltaDocument = null, options = {}) {
  const root = options.root || ROOT;
  const obligations = Array.isArray(contract?.obligations) ? contract.obligations : [];
  const allSourceFiles = options.allSourceFiles
    || [...new Set((markers || []).map((marker) => marker.file))];
  const obligationById = new Map();
  const duplicateIds = [];
  for (const obligation of obligations) {
    if (!obligation || typeof obligation.id !== 'string') continue;
    if (obligationById.has(obligation.id)) duplicateIds.push(obligation.id);
    obligationById.set(obligation.id, obligation);
  }

  const markersById = new Map();
  const unknownMarkers = [];
  for (const marker of markers || []) {
    if (!obligationById.has(marker.id)) {
      unknownMarkers.push(marker);
      continue;
    }
    if (!markersById.has(marker.id)) markersById.set(marker.id, []);
    markersById.get(marker.id).push(marker);
  }

  const normalizedApprovals = normalizeDeltaApprovals(deltaDocument);
  const approvals = normalizedApprovals.approvals;
  const implemented = [];
  const approvedDeltas = [];
  const unresolved = [];
  const invalidDeltas = [];
  const misplacedEvidence = [];
  const duplicateEvidence = [];
  const invalidEvidence = [];
  const evidenceVerifier = typeof options.evidenceVerifier === 'function'
    ? options.evidenceVerifier
    : () => null;

  for (const obligation of obligations.filter((row) => row?.criticality === 'critical')) {
    if (obligation.requirement?.requiresLiveResolution === true) {
      unresolved.push({ obligation, issues: ['target saved-view predicate/order/columns/security metadata is unresolved'] });
      continue;
    }
    const allowed = allowedEvidenceFiles(root, obligation, allSourceFiles);
    const evidence = markersById.get(obligation.id) || [];
    if (evidence.length > 1) duplicateEvidence.push({ obligation, evidence });
    const allowedSet = new Set(allowed.files);
    const inPlace = [];
    for (const marker of evidence.filter((candidate) => allowedSet.has(candidate.file))) {
      const error = evidenceVerifier(marker, obligation);
      if (error) invalidEvidence.push({ obligation, evidence: [marker], reason: error });
      else inPlace.push(marker);
    }
    const misplaced = evidence.filter((marker) => !allowedSet.has(marker.file));
    if (misplaced.length > 0) misplacedEvidence.push({ obligation, evidence: misplaced });

    const implementations = inPlace.filter((marker) => marker.type === 'implementation');
    if (implementations.length > 0 && allowed.issues.length === 0) {
      implemented.push({ obligation, evidence: implementations });
      continue;
    }

    const deltas = inPlace.filter((marker) => marker.type === 'delta');
    if (deltas.length > 0 && allowed.issues.length === 0) {
      const approval = approvals.get(obligation.id);
      const error = validateApproval(approval, contract.sourceTreeSha256, contract.sourceInputSha256);
      if (error) invalidDeltas.push({ obligation, evidence: deltas, error });
      else approvedDeltas.push({ obligation, evidence: deltas, approval });
      continue;
    }

    unresolved.push({ obligation, issues: allowed.issues });
  }

  const deltaMarkerIds = new Set((markers || []).filter((marker) => marker.type === 'delta').map((marker) => marker.id));
  const staleApprovals = [...approvals.keys()].filter((id) => !obligationById.has(id) || !deltaMarkerIds.has(id));
  const total = implemented.length + approvedDeltas.length + unresolved.length + invalidDeltas.length;
  return {
    ok: duplicateIds.length === 0
      && normalizedApprovals.errors.length === 0
      && unknownMarkers.length === 0
      && staleApprovals.length === 0
      && invalidDeltas.length === 0
      && misplacedEvidence.length === 0
      && invalidEvidence.length === 0
      && duplicateEvidence.length === 0
      && unresolved.length === 0,
    total,
    disposed: implemented.length + approvedDeltas.length,
    implemented,
    approvedDeltas,
    unresolved,
    invalidDeltas,
    misplacedEvidence,
    duplicateEvidence,
    invalidEvidence,
    duplicateIds,
    unknownMarkers,
    staleApprovals,
    approvalErrors: normalizedApprovals.errors,
  };
}

function printReport(report) {
  console.log('\n=== critical source obligations ===');
  console.log(`implemented: ${report.implemented.length}`);
  console.log(`approved deltas: ${report.approvedDeltas.length}`);
  const percent = report.total === 0 ? 100 : Math.round((report.disposed / report.total) * 100);
  console.log(`disposed: ${report.disposed}/${report.total} (${percent}%)`);
  for (const row of report.unresolved) {
    const details = row.issues.length ? `: ${row.issues.join('; ')}` : '';
    console.log(`x unresolved ${row.obligation.id} [${row.obligation.category}]${details}`);
  }
  for (const row of report.invalidDeltas) console.log(`x invalid delta ${row.obligation.id}: ${row.error}`);
  for (const row of report.misplacedEvidence) {
    const locations = row.evidence.map((marker) => `${marker.file}:${marker.line}`).join(', ');
    console.log(`x misplaced evidence ${row.obligation.id}: ${locations}${row.reason ? ` (${row.reason})` : ''}`);
  }
  for (const row of report.duplicateEvidence) {
    const locations = row.evidence.map((marker) => `${marker.file}:${marker.line}`).join(', ');
    console.log(`x duplicate evidence ${row.obligation.id}: ${locations}`);
  }
  for (const row of report.invalidEvidence) {
    const locations = row.evidence.map((marker) => `${marker.file}:${marker.line}`).join(', ');
    console.log(`x invalid implementation evidence ${row.obligation.id}: ${locations} (${row.reason})`);
  }
  for (const marker of report.unknownMarkers) console.log(`x unknown marker ${marker.id} at ${marker.file}:${marker.line}`);
  for (const id of report.duplicateIds) console.log(`x duplicate obligation id ${id}`);
  for (const id of report.staleApprovals) console.log(`x stale delta approval ${id}`);
  for (const error of report.approvalErrors) console.log(`x invalid delta ledger: ${error}`);
}

function main() {
  if (!fs.existsSync(CONTRACT_PATH)) {
    if (STRICT) fail('critical-obligations.json not found in strict mode');
    console.log('[obligations] critical-obligations.json not found - skipping non-adapted project');
    return 0;
  }
  const contract = readJson(CONTRACT_PATH, 'critical-obligations.json');
  if (contract.$schema !== 'critical-obligations-v1' || !Array.isArray(contract.obligations)) {
    fail('unsupported or invalid critical-obligations.json schema', 2);
  }
  const deltaDocument = fs.existsSync(DELTAS_PATH) ? readJson(DELTAS_PATH, 'source-deltas.json') : null;
  const sourceFiles = walkSourceFiles(ROOT).map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  let ts;
  try {
    ts = require('typescript');
  } catch {
    fail('typescript compiler API is required; run npm install in the generated app before checking obligations', 2);
  }
  const evidenceVerifier = createTypeScriptEvidenceVerifier(ROOT, ts);
  const report = auditCriticalObligations(contract, collectMarkers(ROOT), deltaDocument, {
    root: ROOT,
    allSourceFiles: sourceFiles,
    evidenceVerifier,
  });
  printReport(report);
  if (STRICT && !report.ok) fail('critical source obligations are unresolved or invalid');
  if (report.ok) console.log('\n[obligations] all critical source obligations are implemented or user-approved deltas');
  else console.log('\n[obligations] baseline only; strict mode will block unresolved obligations');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  parseMarkersFromText,
  walkSourceFiles,
  collectMarkers,
  normalizeDeltaApprovals,
  validateApproval,
  auditCriticalObligations,
  createTypeScriptEvidenceVerifier,
  verifyEvidenceFacts,
};
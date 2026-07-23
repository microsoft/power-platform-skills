'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  Ajv,
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
} = require('./vendor/power-apps-yaml-runtime.cjs');

const SCHEMA_VERSION = '3.0';
const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas', 'power-apps-yaml', `v${SCHEMA_VERSION}`);
const SCHEMA_PATH = path.join(SCHEMA_DIR, 'pa.schema.yaml');
const PROVENANCE_PATH = path.join(SCHEMA_DIR, 'provenance.json');
const TOP_LEVEL_SECTIONS = [
  'App',
  'Screens',
  'ComponentDefinitions',
  'DataSources',
  'EditorState',
];
const SINGLETON_SECTIONS = new Set(['App', 'EditorState']);
const MAPPING_SECTIONS = new Set(['Screens', 'ComponentDefinitions', 'DataSources']);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILES = 10000;
const MAX_TOTAL_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_YAML_LINES = 250000;
const MAX_YAML_LINE_BYTES = 1024 * 1024;
const MAX_YAML_NODES = 1000000;
const MAX_TOTAL_YAML_NODES = 2000000;
const MAX_YAML_DEPTH = 256;
const PUBLISHED_CODE_COMPONENT_PATTERN = '^([a-zA-Z][a-zA-Z0-9]{1,7})_)?(\\w+\\.)+(\\w+)(\\([0-9a-f-]{36}\\))?$';
const CORRECTED_CODE_COMPONENT_PATTERN = '^([a-zA-Z][a-zA-Z0-9]{1,7}_)?(\\w+\\.)+(\\w+)(\\([0-9a-f-]{36}\\))?$';

let cachedSchemaRuntime;

class PowerAppsYamlValidationError extends Error {
  constructor(report) {
    const first = report.errors[0];
    const summary = first
      ? `${first.file}${first.line ? `:${first.line}:${first.column}` : ''}: ${first.message}`
      : 'Power Apps YAML validation failed';
    super(summary);
    this.name = 'PowerAppsYamlValidationError';
    this.code = 'POWER_APPS_YAML_SCHEMA_INVALID';
    this.report = report;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readPinnedSchemaRuntime(options = {}) {
  if (cachedSchemaRuntime && !options.reload) return cachedSchemaRuntime;

  const provenance = JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf8'));
  const schemaBytes = fs.readFileSync(SCHEMA_PATH);
  const actualDigest = sha256(schemaBytes);
  if (actualDigest !== provenance.sha256) {
    throw new Error(
      `Pinned Power Apps YAML schema digest mismatch: expected ${provenance.sha256}, got ${actualDigest}`
    );
  }
  if (schemaBytes.length !== provenance.bytes) {
    throw new Error(
      `Pinned Power Apps YAML schema size mismatch: expected ${provenance.bytes}, got ${schemaBytes.length}`
    );
  }

  const parsed = parseYamlDocument(schemaBytes.toString('utf8'), 'pa.schema.yaml', {
    allowAliases: false,
    maxNodes: 50000,
    semanticSubset: false,
  });
  if (parsed.errors.length > 0) {
    throw new Error(`Pinned Power Apps YAML schema cannot be parsed: ${parsed.errors[0].message}`);
  }
  const schema = parsed.value;
  if (schema?.$id !== provenance.schemaId || schema?.$schema !== 'http://json-schema.org/draft-07/schema#') {
    throw new Error('Pinned Power Apps YAML schema metadata does not match provenance');
  }

  // The official a03a42b snapshot closes the optional publisher-prefix group
  // before its underscore, leaving one unmatched `)` and making the Draft-07
  // schema impossible to compile. Preserve the official file byte-for-byte and
  // correct only that exact value in memory. A changed upstream value blocks
  // here so this compatibility correction cannot silently outlive its pin.
  // Source: https://github.com/microsoft/PowerApps-Tooling/commit/a03a42b966f7308cd3f888304e56330edea155ec
  const publishedPattern = schema?.definitions?.['CodeComponent-ComponentName']?.pattern;
  if (publishedPattern !== PUBLISHED_CODE_COMPONENT_PATTERN) {
    throw new Error('Pinned Power Apps YAML CodeComponent pattern differs from the reviewed compatibility correction');
  }
  schema.definitions['CodeComponent-ComponentName'].pattern = CORRECTED_CODE_COMPONENT_PATTERN;

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false,
    messages: true,
  });
  cachedSchemaRuntime = {
    provenance,
    schema,
    validate: ajv.compile(schema),
  };
  return cachedSchemaRuntime;
}

function parseYamlDocument(text, displayPath, options = {}) {
  const preflightErrors = preflightYamlText(text, displayPath, options);
  if (preflightErrors.length > 0) {
    return { document: null, errors: preflightErrors, lineCounter: null, nodeCount: 0, value: null };
  }
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    lineCounter,
    logLevel: 'silent',
    maxAliasCount: 0,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const errors = [];
  if (documents.length !== 1) {
    errors.push(diagnostic(displayPath, null, `expected exactly one YAML document, found ${documents.length}`, 'YAML_DOCUMENT_COUNT'));
  }

  for (const document of documents) {
    for (const issue of [...document.errors, ...document.warnings]) {
      const pos = Array.isArray(issue.pos) && issue.pos.length > 0
        ? lineCounter.linePos(issue.pos[0])
        : null;
      errors.push(diagnostic(
        displayPath,
        pos,
        String(issue.message || issue).replace(/\s+at line \d+, column \d+:[\s\S]*$/, ''),
        issue.code || 'YAML_PARSE_ERROR'
      ));
    }
  }

  const document = documents[0];
  if (!document || document.contents == null) {
    if (errors.length === 0) errors.push(diagnostic(displayPath, null, 'YAML document is empty', 'YAML_EMPTY'));
    return { document, errors, lineCounter, value: null };
  }

  if (document.directives?.yaml?.explicit) {
    errors.push(diagnostic(displayPath, { line: 1, col: 1 }, 'explicit YAML version directives are not allowed in Canvas source', 'YAML_DIRECTIVE_FORBIDDEN'));
  }
  const tagHandles = Object.keys(document.directives?.tags || {}).filter((handle) => handle !== '!!');
  if (tagHandles.length > 0) {
    errors.push(diagnostic(displayPath, { line: 1, col: 1 }, 'custom YAML tag directives are not allowed in Canvas source', 'YAML_DIRECTIVE_FORBIDDEN'));
  }

  const graph = inspectYamlGraph(document.contents, displayPath, lineCounter, errors, {
    allowAliases: options.allowAliases === true,
    maxDepth: options.maxDepth || MAX_YAML_DEPTH,
    maxNodes: options.maxNodes || MAX_YAML_NODES,
    semanticSubset: options.semanticSubset !== false,
  });

  let value = null;
  if (errors.length === 0) {
    try {
      value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    } catch (error) {
      errors.push(diagnostic(displayPath, null, error.message, 'YAML_CONVERSION_ERROR'));
    }
  }
  return { document, errors, lineCounter, nodeCount: graph.nodeCount, value };
}

function preflightYamlText(text, displayPath, options = {}) {
  const errors = [];
  const maxLines = options.maxLines || MAX_YAML_LINES;
  const maxLineBytes = options.maxLineBytes || MAX_YAML_LINE_BYTES;
  let line = 1;
  let lineBytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.charCodeAt(index);
    if (codePoint === 10) {
      if (lineBytes > maxLineBytes) {
        errors.push(diagnostic(displayPath, { line, col: 1 }, `YAML line exceeds ${maxLineBytes} characters`, 'YAML_LINE_SIZE'));
        return errors;
      }
      line += 1;
      lineBytes = 0;
      if (line > maxLines) {
        errors.push(diagnostic(displayPath, { line, col: 1 }, `YAML document exceeds ${maxLines} lines`, 'YAML_LINE_LIMIT'));
        return errors;
      }
    } else {
      lineBytes += 1;
    }
  }
  if (lineBytes > maxLineBytes) {
    errors.push(diagnostic(displayPath, { line, col: 1 }, `YAML line exceeds ${maxLineBytes} characters`, 'YAML_LINE_SIZE'));
  }
  return errors;
}

function inspectYamlGraph(root, displayPath, lineCounter, errors, limits) {
  const stack = [{ node: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    nodes += 1;
    if (nodes > limits.maxNodes) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), `YAML document exceeds ${limits.maxNodes} nodes`, 'YAML_NODE_LIMIT'));
      return { nodeCount: nodes };
    }
    if (depth > limits.maxDepth) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), `YAML document exceeds depth ${limits.maxDepth}`, 'YAML_DEPTH_LIMIT'));
      return { nodeCount: nodes };
    }
    if (isAlias(node) && !limits.allowAliases) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), 'YAML aliases are not allowed in Canvas source', 'YAML_ALIAS_FORBIDDEN'));
      continue;
    }
    if (node?.tag) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), 'explicit YAML tags are not allowed in Canvas source', 'YAML_TAG_FORBIDDEN'));
    }
    if (node?.anchor) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), 'YAML anchors are not allowed in Canvas source', 'YAML_ANCHOR_FORBIDDEN'));
    }
    if (limits.semanticSubset && isMap(node) && node.flow === true) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), 'flow-style YAML mappings are not supported by Canvas semantic extraction', 'YAML_FLOW_MAP_FORBIDDEN'));
    }
    if (limits.semanticSubset && isSeq(node) && node.flow === true && node.items.length > 0) {
      errors.push(diagnostic(displayPath, positionForNode(node, lineCounter), 'nonempty flow-style YAML sequences are not supported by Canvas semantic extraction', 'YAML_FLOW_SEQUENCE_FORBIDDEN'));
    }
    if (isMap(node)) {
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        const pair = node.items[index];
        if (!isScalar(pair.key)) {
          errors.push(diagnostic(displayPath, positionForNode(pair.key, lineCounter), 'YAML mapping keys must be plain scalar values', 'YAML_COMPLEX_KEY_FORBIDDEN'));
        } else if (limits.semanticSubset && pair.key.type && pair.key.type !== 'PLAIN') {
          errors.push(diagnostic(displayPath, positionForNode(pair.key, lineCounter), 'quoted YAML mapping keys are not supported by Canvas semantic extraction', 'YAML_QUOTED_KEY_FORBIDDEN'));
        } else if (pair.key.value === '<<') {
          errors.push(diagnostic(displayPath, positionForNode(pair.key, lineCounter), 'YAML merge keys are not allowed in Canvas source', 'YAML_MERGE_KEY_FORBIDDEN'));
        }
        if (pair.value) stack.push({ node: pair.value, depth: depth + 1 });
        if (pair.key) stack.push({ node: pair.key, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (let index = node.items.length - 1; index >= 0; index -= 1) {
        if (node.items[index]) stack.push({ node: node.items[index], depth: depth + 1 });
      }
    }
  }
  return { nodeCount: nodes };
}

function diagnostic(file, position, message, code, instancePath = '') {
  return {
    file,
    line: position?.line || null,
    column: position?.col || null,
    instancePath,
    code,
    message,
  };
}

function positionForNode(node, lineCounter) {
  const offset = Array.isArray(node?.range) ? node.range[0] : null;
  return Number.isInteger(offset) ? lineCounter.linePos(offset) : null;
}

function pointerSegments(pointer) {
  if (!pointer) return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((segment) => (/^(?:0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment));
}

function positionForInstancePath(parsed, instancePath) {
  if (!parsed?.document) return null;
  let node = parsed.document.getIn(pointerSegments(instancePath), true);
  if (!node && instancePath) {
    const segments = pointerSegments(instancePath);
    node = parsed.document.getIn(segments.slice(0, -1), true);
  }
  return positionForNode(node || parsed.document.contents, parsed.lineCounter);
}

function formatAjvError(error, file, parsed) {
  let message = error.message || 'does not match the official Power Apps YAML schema';
  if (error.keyword === 'additionalProperties') {
    message = `unknown field ${JSON.stringify(error.params.additionalProperty)} is not supported by Power Apps YAML v${SCHEMA_VERSION}`;
  } else if (error.keyword === 'required') {
    message = `missing required field ${JSON.stringify(error.params.missingProperty)}`;
  } else if (error.keyword === 'oneOf') {
    message = 'value does not match exactly one allowed Power Apps YAML shape';
  }
  return diagnostic(
    file,
    positionForInstancePath(parsed, error.instancePath),
    message,
    `SCHEMA_${String(error.keyword || 'VALIDATION').toUpperCase()}`,
    error.instancePath || ''
  );
}

function validateParsedDocument(parsed, file, validate) {
  if (parsed.errors.length > 0) return parsed.errors.slice();
  if (parsed.value == null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return [diagnostic(file, positionForNode(parsed.document?.contents, parsed.lineCounter), 'top-level YAML value must be an object', 'SCHEMA_TYPE')];
  }
  const valid = validate(parsed.value);
  return valid ? [] : (validate.errors || []).map((error) => formatAjvError(error, file, parsed));
}

function mergeLogicalDocuments(parsedFiles, rootDisplayPath) {
  const combined = Object.create(null);
  const owners = new Map();
  const errors = [];

  for (const entry of parsedFiles) {
    if (entry.parsed.errors.length > 0 || !entry.parsed.value || typeof entry.parsed.value !== 'object') continue;
    for (const section of TOP_LEVEL_SECTIONS) {
      if (!Object.hasOwn(entry.parsed.value, section)) continue;
      const value = entry.parsed.value[section];
      if (SINGLETON_SECTIONS.has(section)) {
        if (Object.hasOwn(combined, section)) {
          errors.push(diagnostic(
            entry.file,
            positionForInstancePath(entry.parsed, `/${section}`),
            `${section} is defined more than once; first definition is in ${owners.get(section)}`,
            'LOGICAL_DUPLICATE_SECTION',
            `/${section}`
          ));
        } else {
          combined[section] = value;
          owners.set(section, entry.file);
        }
        continue;
      }
      if (!MAPPING_SECTIONS.has(section) || value == null || typeof value !== 'object' || Array.isArray(value)) continue;
      if (!Object.hasOwn(combined, section)) combined[section] = Object.create(null);
      for (const [name, item] of Object.entries(value)) {
        const ownerKey = `${section}/${name}`;
        if (Object.hasOwn(combined[section], name)) {
          errors.push(diagnostic(
            entry.file,
            positionForInstancePath(entry.parsed, `/${escapePointer(section)}/${escapePointer(name)}`),
            `${section} entry ${JSON.stringify(name)} is defined more than once; first definition is in ${owners.get(ownerKey)}`,
            'LOGICAL_DUPLICATE_ENTITY',
            `/${escapePointer(section)}/${escapePointer(name)}`
          ));
        } else {
          combined[section][name] = item;
          owners.set(ownerKey, entry.file);
        }
      }
    }
  }

  return { combined, errors, file: rootDisplayPath };
}

function escapePointer(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function listPowerAppsYamlSourceFiles(sourceRoot) {
  const srcRoot = ['Src', 'src']
    .map((name) => path.join(sourceRoot, name))
    .find((candidate) => fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory());
  if (!srcRoot) throw new Error('Canvas source root does not contain a Src directory with current *.pa.yaml files');

  const files = [];
  const stack = [srcRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(sourceRoot, fullPath).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in Canvas source: ${relativePath}`);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.pa.yaml')) {
        files.push(fullPath);
        if (files.length > MAX_SOURCE_FILES) throw new Error(`Canvas source exceeds ${MAX_SOURCE_FILES} YAML files`);
      }
    }
  }
  if (files.length === 0) throw new Error('Canvas source Src directory contains no current *.pa.yaml files');
  return files.sort();
}

function validatePowerAppsYamlSource(sourceRoot, options = {}) {
  const requestedRoot = path.resolve(sourceRoot);
  if (!fs.existsSync(requestedRoot) || !fs.lstatSync(requestedRoot).isDirectory()) {
    throw new Error('Canvas source root does not exist or is not a directory');
  }
  const absoluteRoot = fs.realpathSync(requestedRoot);
  const runtime = readPinnedSchemaRuntime();
  const sourceFiles = listPowerAppsYamlSourceFiles(absoluteRoot);
  const sourceTreeHasher = crypto.createHash('sha256');
  const parsedFiles = [];
  const errors = [];
  let totalBytes = 0;
  let totalNodes = 0;

  for (const filePath of sourceFiles) {
    const stat = fs.lstatSync(filePath);
    const relativeFile = path.relative(absoluteRoot, filePath).replace(/\\/g, '/');
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(diagnostic(relativeFile, null, 'source artifact must be a regular file', 'SOURCE_FILE_TYPE'));
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      errors.push(diagnostic(relativeFile, null, `source artifact exceeds ${MAX_FILE_BYTES} bytes`, 'SOURCE_FILE_SIZE'));
      continue;
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
      errors.push(diagnostic(relativeFile, null, `Canvas YAML source exceeds ${MAX_TOTAL_SOURCE_BYTES} aggregate bytes`, 'SOURCE_TOTAL_SIZE'));
      break;
    }
    const parsed = parseYamlDocument(fs.readFileSync(filePath, 'utf8'), relativeFile);
    const sourceBytes = fs.readFileSync(filePath);
    sourceTreeHasher.update(Buffer.from(`${relativeFile}\0${sourceBytes.length}\0`, 'utf8'));
    sourceTreeHasher.update(sourceBytes);
    totalNodes += parsed.nodeCount || 0;
    if (totalNodes > MAX_TOTAL_YAML_NODES) {
      errors.push(diagnostic(relativeFile, null, `Canvas YAML source exceeds ${MAX_TOTAL_YAML_NODES} aggregate nodes`, 'YAML_TOTAL_NODE_LIMIT'));
      break;
    }
    parsedFiles.push({ file: relativeFile, parsed });
    errors.push(...validateParsedDocument(parsed, relativeFile, runtime.validate));
  }

  const logical = mergeLogicalDocuments(parsedFiles, '.');
  errors.push(...logical.errors);
  if (errors.length === 0 && Object.keys(logical.combined).length > 0) {
    const valid = runtime.validate(logical.combined);
    if (!valid) {
      for (const error of runtime.validate.errors || []) {
        errors.push(diagnostic(
          '.',
          null,
          `logical app ${formatAjvError(error, '.', null).message}`,
          `LOGICAL_SCHEMA_${String(error.keyword || 'VALIDATION').toUpperCase()}`,
          error.instancePath || ''
        ));
      }
    }
  }

  const sectionCounts = {};
  for (const section of TOP_LEVEL_SECTIONS) {
    if (!Object.hasOwn(logical.combined, section)) continue;
    sectionCounts[section] = MAPPING_SECTIONS.has(section)
      ? Object.keys(logical.combined[section] || {}).length
      : 1;
  }

  const report = {
    $schema: 'power-apps-yaml-validation-report-v1',
    valid: errors.length === 0,
    schema: {
      version: runtime.provenance.schemaVersion,
      id: runtime.provenance.schemaId,
      sourceCommit: runtime.provenance.sourceCommit,
      sha256: runtime.provenance.sha256,
    },
    sourceFileCount: sourceFiles.length,
    sourceTreeSha256: sourceTreeHasher.digest('hex'),
    sectionCounts,
    errors: errors.sort(compareDiagnostics),
  };
  if (!report.valid && options.throwOnError !== false) throw new PowerAppsYamlValidationError(report);
  return report;
}

function validatePowerAppsYamlAttestation(attestation, options = {}) {
  const errors = [];
  const label = options.label || 'Power Apps YAML schema attestation';
  const runtime = readPinnedSchemaRuntime();
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    return [`${label} is missing`];
  }
  const expected = {
    schema: 'power-apps-yaml-validation-report-v1',
    version: runtime.provenance.schemaVersion,
    id: runtime.provenance.schemaId,
    sourceCommit: runtime.provenance.sourceCommit,
    sha256: runtime.provenance.sha256,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (attestation[field] !== value) errors.push(`${label}.${field} must equal ${JSON.stringify(value)}`);
  }
  if (!Number.isInteger(attestation.sourceFileCount) || attestation.sourceFileCount < 1) {
    errors.push(`${label}.sourceFileCount must be a positive integer`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(attestation.sourceTreeSha256 || ''))) {
    errors.push(`${label}.sourceTreeSha256 must be a lowercase SHA-256 digest`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(attestation.sourceInputSha256 || ''))) {
    errors.push(`${label}.sourceInputSha256 must be a lowercase SHA-256 digest`);
  }
  if (!Number.isInteger(attestation.sourceInputFileCount) || attestation.sourceInputFileCount < 1) {
    errors.push(`${label}.sourceInputFileCount must be a positive integer`);
  }
  if (!attestation.sectionCounts || typeof attestation.sectionCounts !== 'object' || Array.isArray(attestation.sectionCounts)
      || Object.keys(attestation.sectionCounts).length === 0) {
    errors.push(`${label}.sectionCounts must contain at least one validated logical section`);
  }
  return errors;
}

function compareDiagnostics(left, right) {
  return left.file.localeCompare(right.file)
    || (left.line || 0) - (right.line || 0)
    || (left.column || 0) - (right.column || 0)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message);
}

function formatValidationReport(report) {
  if (report.valid) {
    return `Power Apps YAML v${report.schema.version} validation passed for ${report.sourceFileCount} source files`;
  }
  return report.errors
    .map((error) => `${error.file}${error.line ? `:${error.line}:${error.column}` : ''} [${error.code}] ${error.message}`)
    .join('\n');
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_SOURCE_FILES,
  MAX_TOTAL_SOURCE_BYTES,
  MAX_TOTAL_YAML_NODES,
  MAX_YAML_LINES,
  MAX_YAML_LINE_BYTES,
  PROVENANCE_PATH,
  PowerAppsYamlValidationError,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  formatValidationReport,
  listPowerAppsYamlSourceFiles,
  mergeLogicalDocuments,
  parseYamlDocument,
  preflightYamlText,
  readPinnedSchemaRuntime,
  validatePowerAppsYamlSource,
  validatePowerAppsYamlAttestation,
};

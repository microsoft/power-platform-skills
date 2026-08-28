'use strict';

// Core primitives for the deterministic product-experience compiler.
//
// The planner (an LLM) authors four JSON sidecars; these scripts only validate, normalize,
// hash, and compile them. Nothing here inspects raw prompt text, and nothing here maps a
// domain or industry word to a design decision — every design-relevant value must already be
// declared as a semantic dimension in the product-experience contract.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { stableValue, validateJsonSchema } = require('./json-schema-lite');

const SCHEMA_DIR = path.join(__dirname, '..');

const CONTRACT_SCHEMA_FILES = {
  'product-experience': 'schema-product-experience-contract.json',
  'product-scope': 'schema-product-scope-contract.json',
  'workflow-journey': 'schema-workflow-journey-contract.json',
  'screen-build-pack': 'schema-screen-build-pack.json',
};

// The integration surface the planner writes to and the CLIs read from, relative to the
// project working directory. These are the only paths a planner needs to know; every CLI
// resolves its defaults from this one table so the four contracts cannot drift apart, and a
// caller that prefers explicit paths can still override each one with a flag.
const CONTRACT_ARTIFACTS = {
  'product-experience': '.tmp/product-experience-contract.json',
  'product-scope': '.tmp/product-scope-contract.json',
  'workflow-journey': '.tmp/workflow-journey-contract.json',
  'screen-build-pack': '.tmp/screen-build-pack.json',
  // Output of compile-screen-build-pack.js; the planner never authors this one.
  'compiled-screen-build-pack': '.tmp/compiled-screen-build-pack.json',
};

// The CLI that owns each artifact, kept beside the paths so the planner integration contract
// is readable from a single place.
const CONTRACT_TOOLS = {
  'product-experience': 'validate-product-experience.js',
  'product-scope': 'validate-product-scope.js',
  'workflow-journey': 'validate-workflow-journey.js',
  'screen-build-pack': 'compile-screen-build-pack.js',
};

// Every datum the planner introduces carries one of these classifications. Production behavior
// may never depend on `sample` or `proposed-requires-approval` until the user approves it and
// the data model or connector contract supports it.
const DATA_CLASSIFICATIONS = ['safe-presentation', 'sample', 'schema-backed', 'proposed-requires-approval'];
const UNSUPPORTED_PRODUCTION_CLASSIFICATIONS = ['sample', 'proposed-requires-approval'];

// The semantic dimensions of the UX DNA contract. Kept as data (not spread through the rule
// code) so validators, evidence checks, and the signature stay in agreement.
const EXPERIENCE_DIMENSIONS = [
  'primaryUser',
  'primaryGoal',
  'primaryIntent',
  'workflowShape',
  'operatingContext',
  'sessionPattern',
  'informationDensity',
  'interactionTempo',
  'decisionRisk',
  'contentEmphasis',
  'collaborationMode',
  'visualPersonality',
  'mediaStrategy',
  'accessibilityPriorities',
  'firstViewport',
  'signatureExperience',
];

// Dimensions that must be traceable to something the user said (or to a recorded assumption)
// because getting them wrong changes what the product is, not merely how it looks.
const EVIDENCE_REQUIRED_DIMENSIONS = [
  'primaryUser',
  'primaryGoal',
  'primaryIntent',
  'workflowShape',
  'operatingContext',
  'contentEmphasis',
  'mediaStrategy',
  'visualPersonality',
];

// Adaptive review budgets for user-facing screens, keyed by declared product complexity.
// These are budgets to argue against, not universal low caps: a genuinely multi-role product
// is expected to land near 20 screens, and a single-journey product near 6.
const SCREEN_BUDGETS = {
  focused: { min: 4, max: 7 },
  standard: { min: 7, max: 12 },
  complex: { min: 12, max: 16 },
  'multi-role': { min: 16, max: 20 },
  // `exceptional` has no upper bound in the table; it is unlocked only by an explicit
  // justification naming the independent roles and journeys that cannot be composed.
  exceptional: { min: 20, max: null },
};

// Adaptive budgets for NEW Dataverse tables. A noun in the brief is not table justification;
// every new table must additionally carry at least one lifecycle reason.
const TABLE_BUDGETS = {
  focused: { target: 2, max: 4 },
  standard: { target: 4, max: 7 },
  complex: { target: 7, max: 12 },
  'multi-role': { target: 10, max: 16 },
  exceptional: { target: 12, max: null },
};

// Above this count of user-facing screens the contract must declare complexity `exceptional`
// AND supply an exceptional justification, regardless of how it was classified.
const ABSOLUTE_SCREEN_CEILING = 20;

// The generic record patterns. Repeating these per entity is the specific failure mode scope
// validation guards against — they are legitimate individually, suspicious in bulk.
const GENERIC_RECORD_PATTERNS = ['list', 'detail', 'create', 'edit', 'form'];

const schemaCache = new Map();

function loadSchema(contractType) {
  const fileName = CONTRACT_SCHEMA_FILES[contractType];
  if (!fileName) throw new Error(`Unknown contract type: ${contractType}`);
  if (!schemaCache.has(contractType)) {
    schemaCache.set(contractType, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, fileName), 'utf8')));
  }
  return schemaCache.get(contractType);
}

/**
 * Key-sorted JSON with no insignificant whitespace. Contract revisions are hashes of this
 * string, so a re-serialized contract that differs only in key order or formatting must keep
 * the same revision — otherwise every downstream binding would spuriously go stale.
 */
function canonicalJson(value) {
  return stableValue(value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Stable revision id for any contract. Downstream contracts embed the revisions they were
 * built from; the compiler recomputes and compares, so a build pack cannot silently be
 * consumed against an edited scope or journey.
 */
function contractRevision(contract) {
  return sha256Hex(canonicalJson(contract));
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
  }
  return result;
}

/**
 * Hash of ONLY the design-relevant semantic dimensions of the UX DNA — no product name, no
 * domain vocabulary, no free-text goal, no evidence.
 *
 * This is the mechanical statement of the rule that industry supplies vocabulary only: two
 * products from completely different domains that describe the same user, context, tempo,
 * density, risk, emphasis, and personality have the SAME experience signature and therefore
 * must receive the same experience treatment. Changing a semantic dimension changes it;
 * changing the domain words does not.
 */
function experienceSignature(contract) {
  const semantic = {
    primaryUserProficiency: contract?.primaryUser?.proficiency,
    primaryIntent: contract?.primaryIntent,
    workflowShape: contract?.workflowShape,
    operatingContext: pick(contract?.operatingContext, ['environment', 'connectivity', 'interruptionLevel', 'handsAvailable']),
    sessionPattern: pick(contract?.sessionPattern, ['frequency', 'duration', 'resumability']),
    informationDensity: contract?.informationDensity,
    interactionTempo: contract?.interactionTempo,
    decisionRisk: contract?.decisionRisk?.level,
    contentEmphasis: {
      primary: contract?.contentEmphasis?.primary,
      secondary: [...(contract?.contentEmphasis?.secondary || [])].sort(),
    },
    collaborationMode: contract?.collaborationMode,
    visualPersonality: pick(contract?.visualPersonality, ['tone', 'expressiveness']),
    mediaStrategy: {
      necessity: contract?.mediaStrategy?.necessity,
      types: [...(contract?.mediaStrategy?.types || [])].sort(),
      capture: contract?.mediaStrategy?.capture,
    },
    accessibilityPriorities: [...(contract?.accessibilityPriorities || [])].sort(),
    firstViewportRegionOrder: contract?.firstViewport?.regionOrder,
  };
  return sha256Hex(canonicalJson(semantic));
}

/**
 * Restatement of the already-declared dimensions in the shape downstream generators consume.
 * It is deliberately a projection, not a decision: there is no default direction, no preset,
 * and no lookup keyed on domain. An app with no brand input gets whatever personality the
 * approved contract declares.
 */
function experienceDirective(contract) {
  return {
    tone: contract.visualPersonality.tone,
    expressiveness: contract.visualPersonality.expressiveness,
    density: contract.informationDensity,
    tempo: contract.interactionTempo,
    emphasis: contract.contentEmphasis.primary,
    mediaNecessity: contract.mediaStrategy.necessity,
    riskLevel: contract.decisionRisk.level,
    regionOrder: contract.firstViewport.regionOrder,
    accessibilityPriorities: contract.accessibilityPriorities,
    forbiddenDefaults: contract.forbiddenDefaults,
  };
}

function finding(code, message, pointer) {
  return pointer ? { code, message, pointer } : { code, message };
}

/**
 * Schema-shape validation. Returns findings rather than throwing so a caller can report shape
 * and semantic problems in the same run when the shape is close enough to keep going.
 */
function validateContractShape(contract, contractType) {
  const schema = loadSchema(contractType);
  return validateJsonSchema(contract, schema).map((message) => finding('schema', message));
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
}

/**
 * Minimal `--flag value` parser. `spec` maps a CLI flag to the result key; unknown flags are
 * reported rather than ignored so a typo cannot silently fall back to a default path.
 */
function parseArgs(argv, spec) {
  const args = {};
  const unknown = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(spec, token)) {
      args[spec[token]] = argv[++index];
      continue;
    }
    unknown.push(token);
  }
  if (unknown.length) args.unknown = unknown;
  return args;
}

function resolveContractPath(projectRoot, explicitPath, defaultRelativePath) {
  const root = projectRoot ? path.resolve(projectRoot) : process.cwd();
  return path.resolve(root, explicitPath || defaultRelativePath);
}

/**
 * Single JSON document on stdout for every outcome, so callers can parse the result without
 * branching on exit code first.
 *
 * Exit codes: 0 = contract valid, 1 = contract rejected, 2 = usage or fatal I/O error.
 */
function emitResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.fatal) return 2;
  return result.ok ? 0 : 1;
}

function fatal(tool, message) {
  return emitResult({ ok: false, fatal: true, tool, errors: [finding('fatal', message)], warnings: [] });
}

module.exports = {
  ABSOLUTE_SCREEN_CEILING,
  CONTRACT_ARTIFACTS,
  CONTRACT_SCHEMA_FILES,
  CONTRACT_TOOLS,
  DATA_CLASSIFICATIONS,
  EVIDENCE_REQUIRED_DIMENSIONS,
  EXPERIENCE_DIMENSIONS,
  GENERIC_RECORD_PATTERNS,
  SCREEN_BUDGETS,
  TABLE_BUDGETS,
  UNSUPPORTED_PRODUCTION_CLASSIFICATIONS,
  canonicalJson,
  contractRevision,
  emitResult,
  experienceDirective,
  experienceSignature,
  fatal,
  finding,
  loadSchema,
  parseArgs,
  readJsonFile,
  resolveContractPath,
  sha256Hex,
  validateContractShape,
};

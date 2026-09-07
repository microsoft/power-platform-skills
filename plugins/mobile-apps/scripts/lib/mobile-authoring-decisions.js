'use strict';

const crypto = require('node:crypto');
const protocol = require('./authoring-protocol');
const { ARTIFACT_PATHS, GATE_SECTIONS, planSection } = require('./mobile-plan-approval');
const {
  digest, canonicalJson, relativePath, inside, readFile, readJson, exists,
} = require('./mobile-authoring-files');
const { publicKey, assertNoCredential } = require('./mobile-authoring-context');

const RECEIPT_KEYS = [
  'protocolVersion', 'issuer', 'appInstanceId', 'jobId', 'attemptId',
  'approvalId', 'approvalRevision', 'gateId', 'sourceRevision', 'questionDigest',
  'action', 'answer', 'issuedAt', 'signature',
];
const GATE_ARTIFACTS = {
  1: ['experience', 'scope', 'navigation', 'architecture', 'persistence'],
  2: ['experience', 'scope', 'navigation', 'architecture', 'persistence', 'journey', 'buildPack', 'scenarioFacts', 'dataModelUsage'],
  3: ['experience', 'scope', 'navigation', 'architecture', 'persistence', 'journey', 'buildPack', 'scenarioFacts', 'dataModelUsage', 'preview'],
  4: Object.keys(ARTIFACT_PATHS),
};
const PROTOTYPE_CANONICAL = [
  '.tmp/prototype-domain.json', '.tmp/prototype-bindings.json', '.tmp/prototype-rules.json',
];

function artifactBinding(root, bindings) {
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 64
    || new Set(bindings).size !== bindings.length) {
    throw new Error('A question binding requires 1-64 unique canonical artifacts');
  }
  const files = bindings.map((relative) => {
    relativePath(relative);
    const immutableProposal = /^\.devplayer-builder\/logs\/authoring\/[a-f0-9]{64}\/[a-f0-9]{64}\/proposals\/[A-Za-z0-9-]+\.json$/.test(relative);
    if ((!immutableProposal && relative.startsWith('.devplayer-builder/'))
      || /(?:receipt|journal|pipeline-state|mobile-plan-status|build-plan-state)/i.test(relative)) {
      throw new Error('Questions must bind canonical artifacts, not mutable status or receipt journals');
    }
    return { path: relative, sha256: digest(readFile(inside(root, relative), 32 * 1024 * 1024)) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { type: 'artifacts', files, sourceRevision: digest(canonicalJson(files)) };
}

function gateBinding(root, gate) {
  if (![1, 2, 3, 4].includes(gate)) throw new Error('The owning plan gate must be 1, 2, 3, or 4');
  const files = GATE_ARTIFACTS[gate].filter((key) => exists(root, ARTIFACT_PATHS[key]))
    .map((key) => ARTIFACT_PATHS[key]);
  for (const key of GATE_ARTIFACTS[gate].filter((name) => name !== 'preview' && exists(root, ARTIFACT_PATHS[name]))) {
    readJson(root, ARTIFACT_PATHS[key]);
  }
  const required = GATE_ARTIFACTS[gate].filter((key) => key !== 'dataModel');
  for (const key of required) {
    if (!exists(root, ARTIFACT_PATHS[key])) throw new Error('The owning gate is missing a canonical artifact');
  }
  if (gate > 1 && ['dataverse', 'mixed'].includes(readJson(root, ARTIFACT_PATHS.persistence).mode)) {
    if (!exists(root, ARTIFACT_PATHS.dataModel)) throw new Error('The data gate requires its canonical Dataverse schema');
    if (!files.includes(ARTIFACT_PATHS.dataModel)) files.push(ARTIFACT_PATHS.dataModel);
  }
  if (gate > 1 && PROTOTYPE_CANONICAL.some((file) => exists(root, file))) {
    for (const file of PROTOTYPE_CANONICAL) {
      if (!exists(root, file)) throw new Error('The logical domain review requires its complete domain, bindings, and rules');
      readJson(root, file);
      files.push(file);
    }
  }
  const binding = artifactBinding(root, files);
  const sections = {};
  if (exists(root, 'native-app-plan.md')) {
    const plan = readFile(inside(root, 'native-app-plan.md')).toString('utf8');
    const headings = gate === 4
      ? [...new Set(Object.values(GATE_SECTIONS).flat())]
      : [...new Set(Object.entries(GATE_SECTIONS).filter(([index]) => Number(index) <= gate).flatMap(([, value]) => value))];
    for (const heading of headings) sections[heading] = digest(planSection(plan, heading));
    if (gate === 4) sections.$plan = digest(plan);
  } else if (gate > 1) throw new Error('The owning gate requires the human plan projection');
  return { type: 'gate', gate, files: binding.files, sections, sourceRevision: digest(canonicalJson({ files: binding.files, sections })) };
}

function questionBinding(root, { bind, recordGate } = {}) {
  if (recordGate !== undefined) {
    if (bind?.length) throw new Error('An owning gate uses its canonical binding set, not custom artifacts');
    return gateBinding(root, Number(recordGate));
  }
  if (bind?.length) return artifactBinding(root, bind);
  const source = require('./authoring-source').captureSource(root);
  return { type: 'source', sourceRevision: source.revision };
}

function currentBinding(root, binding) {
  if (binding.type === 'gate') return gateBinding(root, binding.gate);
  if (binding.type === 'artifacts') return artifactBinding(root, binding.files.map((file) => file.path));
  if (binding.type === 'source') return questionBinding(root);
  throw new Error('Unsupported question artifact binding');
}

function prepareQuestion(input, binding, descriptor) {
  protocol.object(input, 'question input');
  const allowed = new Set(['id', 'gateId', 'sourceRevision', 'kind', 'title', 'summary', 'items', 'fields']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Question input contains unsupported fields');
  const gateId = binding.type === 'gate' ? `gate${binding.gate}` : input.gateId;
  if (input.gateId !== undefined && input.gateId !== gateId) throw new Error('Question does not belong to the requested gate');
  if (input.sourceRevision !== undefined && input.sourceRevision !== binding.sourceRevision) {
    throw new Error('Question source revision is stale');
  }
  if (binding.type === 'gate' && input.kind !== 'plan') throw new Error('Plan gates require a plan question');
  const shape = protocol.assertQuestion({ ...input, id: input.id || 'pending-question', gateId, sourceRevision: binding.sourceRevision });
  for (const field of shape.fields) {
    if (new Set(field.choices).size !== field.choices.length
      || (field.type !== 'select' && field.choices.length)) {
      throw new Error('Question choices must be unambiguous and belong to a select field');
    }
  }
  if (binding.type === 'gate' && shape.fields.length) {
    throw new Error('Resolve typed clarifications before asking approval for an exact plan gate');
  }
  delete shape.id;
  const stableId = `question-${digest(canonicalJson({
    appInstanceId: descriptor.appInstanceId, jobId: descriptor.jobId, attemptId: descriptor.attemptId, question: shape,
  })).slice(0, 40)}`;
  return protocol.assertQuestion({ ...shape, id: input.id || stableId });
}

function questionDigest(question) {
  return digest(canonicalJson(protocol.assertQuestion(question)));
}

function validateAnswer(question, action, answer) {
  const permitted = question.kind === 'apply' ? ['apply', 'discard'] : ['approve', 'reject', 'revise'];
  if (!permitted.includes(action)) throw new Error('Decision action does not match the question kind');
  const fields = new Map(question.fields.map((field) => [field.id, field]));
  if (question.fields.some((field) => new Set(field.choices).size !== field.choices.length)) {
    throw new Error('Decision question contains ambiguous choices');
  }
  for (const [fieldId, value] of Object.entries(answer)) {
    const field = fields.get(fieldId);
    if (!field) throw new Error('Decision contains an unknown answer field');
    if (field.type === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') {
      throw new Error('Decision answer has the wrong field type');
    }
    if (field.type === 'select' && !field.choices.includes(value)) throw new Error('Decision answer is not a declared choice');
  }
  if (['approve', 'apply'].includes(action) && question.fields.some((field) => (
    !Object.prototype.hasOwnProperty.call(answer, field.id)
  ))) throw new Error('Decision is missing a required answer field');
  return answer;
}

function verifyDecision(receipt, { descriptor, question, approvalId, approvalRevision, now = Date.now(), token } = {}) {
  protocol.object(receipt, 'decision receipt');
  if (Object.keys(receipt).length !== RECEIPT_KEYS.length
    || RECEIPT_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(receipt, key))) {
    throw new Error('Decision receipt has an unsupported signed shape');
  }
  if (receipt.protocolVersion !== protocol.PROTOCOL_VERSION || receipt.issuer !== protocol.PROTOCOL_ID
    || receipt.appInstanceId !== descriptor.appInstanceId || receipt.jobId !== descriptor.jobId
    || receipt.attemptId !== descriptor.attemptId || receipt.gateId !== question.gateId
    || receipt.sourceRevision !== question.sourceRevision || receipt.questionDigest !== questionDigest(question)) {
    throw new Error('Decision receipt does not match the exact app, attempt, question, and artifact revision');
  }
  const decision = protocol.assertDecision(receipt);
  if (decision.approvalId !== approvalId || decision.approvalRevision !== approvalRevision) {
    throw new Error('Decision receipt approval identity is stale or replayed');
  }
  const issued = Date.parse(receipt.issuedAt);
  if (typeof receipt.issuedAt !== 'string' || !Number.isFinite(issued) || issued > now + 60_000) {
    throw new Error('Decision receipt timestamp is invalid');
  }
  if (typeof receipt.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature)) {
    throw new Error('Decision receipt requires a canonical Ed25519 signature');
  }
  const unsigned = { ...receipt };
  delete unsigned.signature;
  if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned)), publicKey(descriptor.decisionPublicKey),
    Buffer.from(receipt.signature, 'base64'))) {
    throw new Error('Decision receipt signature is invalid');
  }
  validateAnswer(question, decision.action, decision.answer);
  if (token) assertNoCredential(receipt, token);
  return structuredClone(receipt);
}

module.exports = {
  artifactBinding, gateBinding, questionBinding, currentBinding, prepareQuestion,
  questionDigest, validateAnswer, verifyDecision,
};

#!/usr/bin/env node
'use strict';

/**
 * Finalize or verify the canonical design decision for a mobile app.
 *
 * Usage:
 *   node finalize-design-decision.js <project-dir> finalize
 *   node finalize-design-decision.js <project-dir> check
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DESIGN_FILES = {
  designSystem: 'brand/design-system.md',
  tokens: 'brand/tokens.ts',
  gallery: 'brand/design-system.html',
};

function fail(message) {
  console.error(`design-decision: ${message}`);
  process.exit(1);
}

function readText(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readText(filePath, label));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableClone(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableClone(value), null, 2)}\n`;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function safeLabel(value) {
  const label = requiredString(value, 'selectionSource.label')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return path.isAbsolute(label) ? path.basename(label) : label.slice(0, 200);
}

function fileRecord(projectDir, relativePath, required = true) {
  const filePath = path.join(projectDir, relativePath);
  if (!fs.existsSync(filePath)) {
    if (required) fail(`required design artifact is missing: ${relativePath}`);
    return null;
  }
  const contents = fs.readFileSync(filePath);
  return { path: relativePath, sha256: sha256(contents) };
}

function validateRecommendation(recommendation, briefRecord) {
  if (!recommendation || recommendation.schemaVersion !== 1) {
    fail('design recommendation schemaVersion must be 1');
  }
  if (recommendation.status !== 'recommendation-only') {
    fail('design recommendation status must be recommendation-only');
  }
  const normalized = {
    direction: requiredString(recommendation.direction, 'recommendation.direction'),
    rationale: requiredString(recommendation.rationale, 'recommendation.rationale'),
    confidence: requiredString(recommendation.confidence, 'recommendation.confidence'),
    source: requiredString(recommendation.source, 'recommendation.source'),
    theme: recommendation.theme && typeof recommendation.theme === 'object'
      ? stableClone(recommendation.theme)
      : {},
  };
  if (recommendation.briefSha256) {
    if (!briefRecord || recommendation.briefSha256 !== briefRecord.sha256) {
      fail('design recommendation briefSha256 does not match brief.md');
    }
    normalized.briefSha256 = recommendation.briefSha256;
  }
  return normalized;
}

function readRecommendation(projectDir, input, briefRecord) {
  const relativePath = '.tmp/design-recommendation.json';
  const filePath = path.join(projectDir, relativePath);
  if (fs.existsSync(filePath)) {
    const contents = fs.readFileSync(filePath);
    return {
      recommendation: validateRecommendation(JSON.parse(contents.toString('utf8')), briefRecord),
      artifact: { path: relativePath, sha256: sha256(contents) },
    };
  }
  if (!input.standaloneRecommendation) {
    fail('planner recommendation is missing and no standaloneRecommendation was supplied');
  }
  return {
    recommendation: validateRecommendation({
      schemaVersion: 1,
      status: 'recommendation-only',
      ...input.standaloneRecommendation,
    }, briefRecord),
    artifact: null,
  };
}

function verifyFileRecord(projectDir, record, label) {
  if (!record || typeof record.path !== 'string' || typeof record.sha256 !== 'string') {
    fail(`design decision ${label} file record is invalid`);
  }
  const current = fileRecord(projectDir, record.path, true);
  if (current.sha256 !== record.sha256) fail(`design decision ${label} hash is stale`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, stableJson(value), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function finalize(projectDir) {
  const inputPath = path.join(projectDir, '.tmp', 'design-decision-input.json');
  const input = readJson(inputPath, '.tmp/design-decision-input.json');
  if (input.schemaVersion !== 1) fail('design decision input schemaVersion must be 1');

  const confirmationStatus = requiredString(input.confirmationStatus, 'confirmationStatus');
  if (!['confirmed', 'draft'].includes(confirmationStatus)) {
    fail('confirmationStatus must be confirmed or draft');
  }
  const selectedDirection = requiredString(input.selectedDirection, 'selectedDirection');
  const source = input.selectionSource;
  if (!source || typeof source !== 'object') fail('selectionSource is required');
  const sourceKind = requiredString(source.kind, 'selectionSource.kind');
  const sourceLabel = safeLabel(source.label);

  const brief = fileRecord(projectDir, 'brief.md', false);
  const plan = fileRecord(projectDir, 'native-app-plan.md', false);
  const { recommendation, artifact: recommendationArtifact } = readRecommendation(
    projectDir,
    input,
    brief,
  );
  if (sourceKind === 'planner-recommendation' && selectedDirection !== recommendation.direction) {
    fail('planner-recommendation selection must reuse the recommended direction exactly');
  }

  const files = Object.fromEntries(
    Object.entries(DESIGN_FILES).map(([key, relativePath]) => [key, fileRecord(projectDir, relativePath)]),
  );
  if (brief) files.brief = brief;
  if (plan) files.plan = plan;

  const decisionPath = path.join(projectDir, 'brand', 'design-decision.json');
  const previousDecisionSha256 = fs.existsSync(decisionPath)
    ? sha256(fs.readFileSync(decisionPath))
    : null;
  const now = new Date().toISOString();
  const decision = {
    schemaVersion: 1,
    recommendation,
    recommendationArtifact,
    finalSelection: {
      direction: selectedDirection,
      sourceKind,
      sourceLabel,
    },
    userConfirmation: {
      status: confirmationStatus,
      recordedAt: now,
    },
    files,
    previousDecisionSha256,
    generatedAt: now,
  };
  decision.integritySha256 = sha256(stableJson(decision));
  writeJsonAtomic(decisionPath, decision);
  console.log(`design-decision: finalized ${path.relative(projectDir, decisionPath)}`);
}

function check(projectDir) {
  const relativePath = 'brand/design-decision.json';
  const decision = readJson(path.join(projectDir, relativePath), relativePath);
  if (decision.schemaVersion !== 1) fail('design decision schemaVersion must be 1');
  const integrity = decision.integritySha256;
  const withoutIntegrity = { ...decision };
  delete withoutIntegrity.integritySha256;
  if (integrity !== sha256(stableJson(withoutIntegrity))) {
    fail('design decision integritySha256 is invalid');
  }
  requiredString(decision.recommendation?.direction, 'recommendation.direction');
  requiredString(decision.recommendation?.rationale, 'recommendation.rationale');
  requiredString(decision.finalSelection?.direction, 'finalSelection.direction');
  if (!['confirmed', 'draft'].includes(decision.userConfirmation?.status)) {
    fail('design decision userConfirmation.status is invalid');
  }
  for (const key of Object.keys(DESIGN_FILES)) verifyFileRecord(projectDir, decision.files?.[key], key);
  if (decision.files?.brief) verifyFileRecord(projectDir, decision.files.brief, 'brief');
  if (decision.files?.plan) verifyFileRecord(projectDir, decision.files.plan, 'plan');
  if (decision.recommendationArtifact) {
    verifyFileRecord(projectDir, decision.recommendationArtifact, 'recommendation');
  }
  console.log(`design-decision: valid (${decision.finalSelection.direction}, ${decision.userConfirmation.status})`);
}

function main() {
  const projectArg = process.argv[2];
  const action = process.argv[3];
  if (!projectArg || !['finalize', 'check'].includes(action)) {
    fail('usage: node finalize-design-decision.js <project-dir> <finalize|check>');
  }
  const projectDir = path.resolve(projectArg);
  if (action === 'finalize') finalize(projectDir);
  else check(projectDir);
}

main();

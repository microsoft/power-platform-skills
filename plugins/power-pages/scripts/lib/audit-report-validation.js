"use strict";

const fs = require("node:fs");

const PREFIXES = Object.freeze({
  "intent-coverage": "IC",
  "privilege-calibration": "PC",
  "scope-correctness": "SC",
  "role-completeness": "RC",
  "table-coverage": "TC",
  "anonymous-access-hygiene": "AH",
  "data-model-alignment": "DM",
  "internal-consistency": "IS",
  "security-posture": "SP",
});

const DIMENSIONS = Object.freeze({
  "intent-coverage": Object.freeze({ key: "intentCoverage", category: "underExposure" }),
  "privilege-calibration": Object.freeze({ key: "privilegeCalibration", category: "overExposure" }),
  "scope-correctness": Object.freeze({ key: "scopeCorrectness", category: "correctness" }),
  "role-completeness": Object.freeze({ key: "roleCompleteness", category: "underExposure" }),
  "table-coverage": Object.freeze({ key: "tableCoverage", category: "underExposure" }),
  "anonymous-access-hygiene": Object.freeze({ key: "anonymousAccessHygiene", category: "overExposure" }),
  "data-model-alignment": Object.freeze({ key: "dataModelAlignment", category: "correctness" }),
  "internal-consistency": Object.freeze({ key: "internalConsistency", category: "correctness" }),
  "security-posture": Object.freeze({ key: "securityPosture", category: "overExposure" }),
});

const CATEGORIES = Object.freeze([
  Object.freeze({
    id: "over-exposure",
    key: "overExposure",
    name: /^Over-Exposure/i,
    dimensions: ["privilege-calibration", "anonymous-access-hygiene", "security-posture"],
  }),
  Object.freeze({
    id: "under-exposure",
    key: "underExposure",
    name: /^Under-Exposure/i,
    dimensions: ["intent-coverage", "table-coverage", "role-completeness"],
  }),
  Object.freeze({
    id: "correctness",
    key: "correctness",
    name: /^Correctness/i,
    dimensions: ["scope-correctness", "data-model-alignment", "internal-consistency"],
  }),
]);

const ROOT_CAUSES = Object.freeze([
  "permissions",
  "mixed",
  "data-model",
  "webapi-code",
  "webapi-settings",
]);

const SCORING_STATUSES = Object.freeze(["complete", "partial"]);
const VERDICTS = Object.freeze(["safe_to_go", "needs_revision", "not_scored"]);

const ROOT_CAUSE_KEYS = Object.freeze({
  permissions: "permissions",
  mixed: "mixed",
  "data-model": "dataModel",
  "webapi-code": "webApiCode",
  "webapi-settings": "webApiSettings",
});

function round(value) {
  return Math.round(value * 100) / 100;
}

function scoreFromIssues(major, minor) {
  return round(5 - 4 * Math.tanh(0.2 * (major + 0.25 * minor)));
}

function countIssues(issues) {
  const major = issues.filter((issue) => issue.severity === "major").length;
  const minor = issues.filter((issue) => issue.severity === "minor").length;
  return { major, minor, total: major + minor };
}

function requireText(record, fields, label) {
  for (const field of fields) {
    if (typeof record[field] !== "string" || !record[field].trim()) {
      throw new Error(`${label} needs a non-empty ${field}.`);
    }
  }
}

function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new Error("FINDINGS must be an array.");
  const ids = new Set();
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("Each FINDINGS entry must be an object.");
    }
    const prefix = PREFIXES[finding.dimension];
    if (!prefix) throw new Error(`Finding ${finding.id} has invalid dimension ${finding.dimension}.`);
    if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(finding.id)) {
      throw new Error(`Finding ${finding.id} must use the ${prefix} prefix for ${finding.dimension}.`);
    }
    if (ids.has(finding.id)) throw new Error(`Finding ${finding.id} is listed more than once.`);
    ids.add(finding.id);
    if (!["major", "minor"].includes(finding.severity)) {
      throw new Error(`Finding ${finding.id} has invalid severity ${finding.severity}.`);
    }
    requireText(finding, ["title", "reasoning", "fix"], `Finding ${finding.id}`);
    if (finding.severity === "major") {
      if (!ROOT_CAUSES.includes(finding.rootCause)) {
        throw new Error(`Major finding ${finding.id} has invalid rootCause ${finding.rootCause}.`);
      }
      requireText(finding, ["rootCauseReason"], `Major finding ${finding.id}`);
    } else if (finding.rootCause !== undefined || finding.rootCauseReason !== undefined) {
      throw new Error(`Minor finding ${finding.id} must not carry a root cause.`);
    }
  }
}

function validateScorecard(scorecard, findings) {
  if (scorecard === null) return;
  const categories = scorecard?.categories;
  if (!Array.isArray(categories) || categories.length !== CATEGORIES.length) {
    throw new Error(`SCORECARD.categories must contain exactly ${CATEGORIES.length} entries.`);
  }
  CATEGORIES.forEach((category, index) => {
    const entry = categories[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`SCORECARD.categories[${index}] must be an object.`);
    }
    if (!category.name.test(String(entry.name || ""))) {
      throw new Error(`SCORECARD.categories[${index}] must be ${category.id}, found ${entry.name}.`);
    }
    if (typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 1 || entry.score > 5) {
      throw new Error(`${entry.name} score must be a finite number from 1 through 5.`);
    }
    const counts = countIssues(findings.filter((finding) => category.dimensions.includes(finding.dimension)));
    const expected = scoreFromIssues(counts.major, counts.minor);
    if (entry.score !== expected) {
      throw new Error(`${entry.name} score is ${entry.score}; expected ${expected}.`);
    }
  });
}

function validateAuditData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Audit data must be an object.");
  }
  if (!Object.prototype.hasOwnProperty.call(data, "FINDINGS_DATA")) {
    throw new Error("Audit data has no FINDINGS_DATA.");
  }
  if (!Object.prototype.hasOwnProperty.call(data, "SCORECARD_DATA")) {
    throw new Error("Audit data has no SCORECARD_DATA.");
  }
  validateFindings(data.FINDINGS_DATA);
  validateScorecard(data.SCORECARD_DATA, data.FINDINGS_DATA);
}

function scriptText(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join("\n");
}

function readConst(script, name) {
  const matches = [...script.matchAll(new RegExp(`^const ${name} = (.*)$`, "gm"))];
  if (matches.length === 0) throw new Error(`Audit report has no ${name} data.`);
  if (matches.length > 1) throw new Error(`Audit report declares ${name} more than once.`);
  const json = matches[0][1].trim().replace(/;$/, "");
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`Audit report ${name} data is not valid JSON.`);
  }
}

function validateSummary(html, scorecard, majorCount) {
  const match = html.match(/id="summaryBox"[^>]*>([\s\S]*?)<\/div>/);
  if (!match) throw new Error("Audit report has no SUMMARY.");
  const states = (phrase) => match[1].toLowerCase().includes(phrase.toLowerCase());
  if (scorecard === null) {
    if (states("Safe to go") || states("Needs revision")) {
      throw new Error("SUMMARY must not state a verdict when scoring was skipped.");
    }
    return null;
  }
  const [expected, opposite] = majorCount === 0 ? ["Safe to go", "Needs revision"] : ["Needs revision", "Safe to go"];
  if (!states(expected) || states(opposite)) {
    throw new Error(`SUMMARY must state the verdict "${expected}" and not "${opposite}".`);
  }
  return expected;
}

function validateReport(reportPath) {
  const html = fs.readFileSync(reportPath, "utf8");
  if (/__(?:(?:HTML|ATTR|JSON|RAW)_)?(?:SITE_NAME|AUDIT_DESC|SUMMARY|FINDINGS_DATA|INVENTORY_DATA|SCORECARD_DATA)__/.test(html)) {
    throw new Error("Audit report has unreplaced data placeholders.");
  }
  const script = scriptText(html);
  const findings = readConst(script, "FINDINGS");
  validateFindings(findings);
  const inventory = readConst(script, "INVENTORY");
  if (!Array.isArray(inventory)) throw new Error("INVENTORY must be an array.");
  const scorecard = readConst(script, "SCORECARD");
  validateScorecard(scorecard, findings);
  const issueCounts = countIssues(findings);
  return {
    findings,
    scorecard,
    issueCounts,
    verdict: validateSummary(html, scorecard, issueCounts.major),
  };
}

function zeroCounts() {
  return { major: 0, minor: 0 };
}

function deriveAuditMetrics(data) {
  validateAuditData(data);

  const categories = Object.fromEntries(CATEGORIES.map((category) => [category.key, zeroCounts()]));
  const dimensions = Object.fromEntries(
    Object.values(DIMENSIONS).map((dimension) => [dimension.key, zeroCounts()])
  );
  const majorRootCauses = Object.fromEntries(Object.values(ROOT_CAUSE_KEYS).map((key) => [key, 0]));

  for (const finding of data.FINDINGS_DATA) {
    const dimension = DIMENSIONS[finding.dimension];
    dimensions[dimension.key][finding.severity] += 1;
    categories[dimension.category][finding.severity] += 1;
    if (finding.severity === "major") {
      majorRootCauses[ROOT_CAUSE_KEYS[finding.rootCause]] += 1;
    }
  }

  const issueCounts = countIssues(data.FINDINGS_DATA);
  const complete = data.SCORECARD_DATA !== null;
  const metrics = {
    schemaVersion: 1,
    scoringStatus: complete ? "complete" : "partial",
    verdict: complete ? (issueCounts.major === 0 ? "safe_to_go" : "needs_revision") : "not_scored",
    majorIssueCount: issueCounts.major,
    minorIssueCount: issueCounts.minor,
    totalIssueCount: issueCounts.total,
    categories,
    dimensions,
    majorRootCauses,
  };
  if (complete) {
    metrics.scores = Object.fromEntries(
      CATEGORIES.map((category, index) => [category.key, data.SCORECARD_DATA.categories[index].score])
    );
  }
  validateAuditMetrics(metrics);
  return metrics;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has invalid properties.`);
  }
}

function assertCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function validateCountMap(map, expectedKeys, label) {
  assertExactKeys(map, expectedKeys, label);
  for (const key of expectedKeys) {
    assertExactKeys(map[key], ["major", "minor"], `${label}.${key}`);
    assertCount(map[key].major, `${label}.${key}.major`);
    assertCount(map[key].minor, `${label}.${key}.minor`);
  }
}

function validateAuditMetrics(metrics) {
  assertPlainObject(metrics, "Audit metrics");
  const complete = metrics.scoringStatus === "complete";
  const expectedKeys = [
    "schemaVersion",
    "scoringStatus",
    "verdict",
    "majorIssueCount",
    "minorIssueCount",
    "totalIssueCount",
    "categories",
    "dimensions",
    "majorRootCauses",
    ...(complete ? ["scores"] : []),
  ];
  assertExactKeys(metrics, expectedKeys, "Audit metrics");
  if (metrics.schemaVersion !== 1) throw new Error("Audit metrics schemaVersion must be 1.");
  if (!SCORING_STATUSES.includes(metrics.scoringStatus)) {
    throw new Error("Audit metrics scoringStatus is invalid.");
  }
  if (!VERDICTS.includes(metrics.verdict)) {
    throw new Error("Audit metrics verdict is invalid.");
  }
  for (const key of ["majorIssueCount", "minorIssueCount", "totalIssueCount"]) {
    assertCount(metrics[key], `Audit metrics.${key}`);
  }
  if (metrics.totalIssueCount !== metrics.majorIssueCount + metrics.minorIssueCount) {
    throw new Error("Audit metrics totalIssueCount is inconsistent.");
  }

  const categoryKeys = CATEGORIES.map((category) => category.key);
  const dimensionKeys = Object.values(DIMENSIONS).map((dimension) => dimension.key);
  validateCountMap(metrics.categories, categoryKeys, "Audit metrics.categories");
  validateCountMap(metrics.dimensions, dimensionKeys, "Audit metrics.dimensions");

  assertExactKeys(metrics.majorRootCauses, Object.values(ROOT_CAUSE_KEYS), "Audit metrics.majorRootCauses");
  for (const [key, value] of Object.entries(metrics.majorRootCauses)) {
    assertCount(value, `Audit metrics.majorRootCauses.${key}`);
  }

  const dimensionMajor = Object.values(metrics.dimensions).reduce((sum, value) => sum + value.major, 0);
  const dimensionMinor = Object.values(metrics.dimensions).reduce((sum, value) => sum + value.minor, 0);
  if (dimensionMajor !== metrics.majorIssueCount || dimensionMinor !== metrics.minorIssueCount) {
    throw new Error("Audit metrics dimension totals are inconsistent.");
  }
  const rootCauseTotal = Object.values(metrics.majorRootCauses).reduce((sum, value) => sum + value, 0);
  if (rootCauseTotal !== metrics.majorIssueCount) {
    throw new Error("Audit metrics root-cause total is inconsistent.");
  }
  for (const category of CATEGORIES) {
    const expected = category.dimensions.reduce(
      (counts, name) => {
        const values = metrics.dimensions[DIMENSIONS[name].key];
        counts.major += values.major;
        counts.minor += values.minor;
        return counts;
      },
      zeroCounts()
    );
    const actual = metrics.categories[category.key];
    if (actual.major !== expected.major || actual.minor !== expected.minor) {
      throw new Error(`Audit metrics ${category.key} category total is inconsistent.`);
    }
  }

  if (complete) {
    if (metrics.verdict !== (metrics.majorIssueCount === 0 ? "safe_to_go" : "needs_revision")) {
      throw new Error("Audit metrics verdict is inconsistent.");
    }
    assertExactKeys(metrics.scores, categoryKeys, "Audit metrics.scores");
    for (const [key, score] of Object.entries(metrics.scores)) {
      if (typeof score !== "number" || !Number.isFinite(score) || score < 1 || score > 5) {
        throw new Error(`Audit metrics.scores.${key} must be a finite number from 1 through 5.`);
      }
    }
  } else if (metrics.verdict !== "not_scored") {
    throw new Error("Partial audit metrics must use the not_scored verdict.");
  }

  return metrics;
}

module.exports = {
  CATEGORIES,
  DIMENSIONS,
  PREFIXES,
  ROOT_CAUSES,
  ROOT_CAUSE_KEYS,
  SCORING_STATUSES,
  VERDICTS,
  countIssues,
  deriveAuditMetrics,
  scoreFromIssues,
  validateAuditData,
  validateAuditMetrics,
  validateFindings,
  validateReport,
  validateScorecard,
};

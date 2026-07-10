#!/usr/bin/env node
// Transforms raw opengrep and trivy JSON output into unified section findings.
// Strict to the documented response shapes — no fallbacks for unseen variants.
// Run with --help for flags.

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--help')) {
  process.stdout.write(`transform-scan-code.js — Transform raw opengrep + trivy JSON into section findings.

Usage:
  node transform-scan-code.js [--opengrepFile <path>] [--trivyFile <path>] [--projectRoot <path>]

Flags:
  --opengrepFile  Path to raw opengrep JSON output (optional — omit if opengrep was not run)
  --trivyFile     Path to raw trivy JSON output (optional — omit if trivy was not run)
  --projectRoot   Project root used to relativize file paths in locations (optional)
  --help          Show this help message

At least one of --opengrepFile or --trivyFile must be provided.

Exit codes:
  0  Success (unified JSON on stdout)
  1  Invocation error

Examples:
  node transform-scan-code.js --opengrepFile <opengrep-file> --trivyFile <trivy-file> --projectRoot <project-root>
  node transform-scan-code.js --opengrepFile <opengrep-file> --projectRoot <project-root>
  node transform-scan-code.js --trivyFile <trivy-file>
`);
  process.exit(0);
}

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`${label} not found: ${filePath}\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Failed to parse ${label} (${filePath}): ${err.message}\n`);
    process.exit(1);
  }
}

const OPENGREP_SEVERITY_TO_BUCKET = {
  ERROR: 'critical',
  CRITICAL: 'critical',
  HIGH: 'high',
  WARNING: 'warning',
  MEDIUM: 'medium',
  INFO: 'info',
  LOW: 'low',
};

const TRIVY_SEVERITY_TO_BUCKET = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'info',
};

// Fallback so an unknown severity is still counted, never dropped from report totals.
const SEVERITY_FALLBACK = 'warning';

function normalizeSeverity(map, raw) {
  if (typeof raw === 'string') {
    const bucket = map[raw.trim().toUpperCase()];
    if (bucket) return bucket;
  }
  return SEVERITY_FALLBACK;
}

function relativize(filePath, projectRoot) {
  const normalized = filePath.replace(/\\/g, '/');
  if (!projectRoot) return normalized;
  const root = projectRoot.replace(/\\/g, '/');
  // Path boundary so "/repo/app2" isn't treated as under root "/repo/app".
  const rootWithSep = root.endsWith('/') ? root : root + '/';
  return normalized === root || normalized.startsWith(rootWithSep)
    ? path.posix.relative(root, normalized)
    : normalized;
}

// Opengrep result shape (per opengrep1-4.json samples):
//   { check_id, path, start: { line }, extra: { severity, message, metadata: { category, confidence, references, cwe, vulnerability_class } } }
//
// Multiple results with the same check_id are grouped into a single finding (one finding per rule).
// Locations are aggregated; the rule's shared message is shown once.
function transformOpengrep(raw, projectRoot) {
  const byCheckId = new Map();
  // Tolerate missing `results` (run-opengrep.js "{}" fallback) — treat as no findings.
  const results = Array.isArray(raw?.results) ? raw.results : [];
  for (const r of results) {
    if (!byCheckId.has(r.check_id)) byCheckId.set(r.check_id, []);
    byCheckId.get(r.check_id).push(r);
  }

  const findings = [];
  let counter = 1;
  for (const [checkId, occurrences] of byCheckId) {
    const first = occurrences[0];
    // Some rules omit metadata/references; read defensively to avoid throwing.
    const metadata = first.extra.metadata || {};
    const vulnClass = metadata.vulnerability_class;
    const title = Array.isArray(vulnClass) && vulnClass.length > 0 ? vulnClass[0] : checkId;
    const locations = occurrences.map(r => `${relativize(r.path, projectRoot)}:${r.start.line}`);
    const references = Array.isArray(metadata.references) ? metadata.references : [];

    const detailLines = [first.extra.message];
    detailLines.push('', `${occurrences.length} occurrence${occurrences.length === 1 ? '' : 's'}:`);
    for (const loc of locations) detailLines.push(`- ${loc}`);
    if (references.length > 0) {
      detailLines.push('', 'References:');
      for (const ref of references.slice(0, 3)) detailLines.push(`- ${ref}`);
    }

    findings.push({
      id: `opengrep-${counter++}`,
      severity: normalizeSeverity(OPENGREP_SEVERITY_TO_BUCKET, first.extra.severity),
      category: metadata.category,
      confidence: metadata.confidence,
      title,
      tag: checkId,
      location: locations[0],
      details: detailLines.join('\n'),
    });
  }
  return findings;
}

// Trivy result shape (per trivy1-8.json samples):
//   Results[]: { Target, Class, Vulnerabilities?, Secrets?, Licenses? }
//   Vulnerability: { VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity, Title }
//   Secret:        { RuleID, Category, Severity, Title, StartLine, Match, Code }
//   License:       { Severity, Category, PkgName, FilePath, Name }
//
// Read only safe metadata — never Match/Code — so secret values can't leak. Don't add them.
function transformTrivy(raw, projectRoot) {
  const findings = [];
  let counter = 1;
  // Tolerate missing `Results` (run-trivy.js "{}" fallback) — treat as no findings.
  const results = Array.isArray(raw?.Results) ? raw.Results : [];
  for (const target of results) {
    const targetPath = relativize(target.Target, projectRoot);

    if (target.Vulnerabilities) {
      for (const v of target.Vulnerabilities) {
        findings.push({
          id: `trivy-${counter++}`,
          severity: normalizeSeverity(TRIVY_SEVERITY_TO_BUCKET, v.Severity),
          category: 'vulnerability',
          title: `${v.PkgName}@${v.InstalledVersion}`,
          tag: v.VulnerabilityID,
          location: targetPath,
          details: v.Title,
          fix: v.FixedVersion ? `Upgrade ${v.PkgName} to ${v.FixedVersion}` : null,
        });
      }
    }

    if (target.Secrets) {
      for (const s of target.Secrets) {
        findings.push({
          id: `trivy-${counter++}`,
          severity: normalizeSeverity(TRIVY_SEVERITY_TO_BUCKET, s.Severity),
          category: 'secret',
          title: s.Title,
          tag: s.RuleID,
          location: `${targetPath}:${s.StartLine}`,
          details: s.Category,
          fix: 'Remove the secret from source code and rotate it immediately',
        });
      }
    }

    if (target.Licenses) {
      for (const l of target.Licenses) {
        findings.push({
          id: `trivy-${counter++}`,
          severity: normalizeSeverity(TRIVY_SEVERITY_TO_BUCKET, l.Severity),
          category: 'license',
          title: `${l.PkgName}: ${l.Name}`,
          tag: l.Name,
          location: relativize(l.FilePath, projectRoot),
          details: `Category: ${l.Category}`,
        });
      }
    }
  }
  return findings;
}

function main() {
  const opengrepFile = getArg('opengrepFile');
  const trivyFile = getArg('trivyFile');
  const projectRoot = getArg('projectRoot');

  if (!opengrepFile && !trivyFile) {
    process.stderr.write('Provide at least one of --opengrepFile or --trivyFile.\n');
    return 1;
  }

  const findings = [];

  if (opengrepFile) {
    findings.push(...transformOpengrep(readJson(opengrepFile, 'opengrep file'), projectRoot));
  }
  if (trivyFile) {
    findings.push(...transformTrivy(readJson(trivyFile, 'trivy file'), projectRoot));
  }

  process.stdout.write(JSON.stringify({ status: 'ok', findings }) + '\n');
  return 0;
}

module.exports = { transformOpengrep, transformTrivy };

if (require.main === module) {
  process.exit(main());
}

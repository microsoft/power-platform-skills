#!/usr/bin/env node
// Transforms get-status.js + get-rules.js stdout into unified section findings.
// Strict to the documented response shapes. Plain-language explanations are NOT hardcoded —
// they must be provided by the agent via --annotations.
// Run with --help for flags.

const fs = require('fs');

if (process.argv.includes('--help')) {
  process.stdout.write(`transform-firewall.js — Transform get-status.js + get-rules.js output into section findings.

Usage:
  node transform-firewall.js --statusFile <path> --rulesFile <path> [--annotations <path>]

Flags:
  --statusFile    Path to a get-status.js stdout JSON file (required)
  --rulesFile     Path to a get-rules.js stdout JSON file (required)
  --annotations   Path to agent-provided annotations JSON (optional) — see "Annotations shape" below
  --help          Show this help message

Annotations shape (all keys optional):
  {
    "state": {
      "description": "Plain-language meaning of the current firewall state",
      "fix": "Suggested action if the state indicates a genuine issue"
    },
    "rules": {
      "<RuleName>": { "description": "Plain-language summary", "fix": "Optional fix" }
    }
  }

Exit codes:
  0  Success (unified JSON on stdout)
  1  Invocation error (missing flags or unreadable file)

Examples:
  node transform-firewall.js --statusFile <status-file> --rulesFile <rules-file>
  node transform-firewall.js --statusFile <status-file> --rulesFile <rules-file> --annotations <annotations-file>
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

function bulletList(pairs) {
  return pairs.map(([k, v]) => `- ${k}: ${v}`).join('\n');
}

function transform(statusResponse, rulesResponse, annotations) {
  const findings = [];
  let counter = 1;

  // Status: { status: "ok", value: "<string>" } or { status: "unsupported", message: "<string>" }
  if (statusResponse.status === 'unsupported') {
    findings.push({
      id: `firewall-${counter++}`,
      title: 'Firewall unsupported',
      details: statusResponse.message,
    });

    return { status: 'unsupported', findings };
  }

  const stateAnnotation = annotations.state || {};
  findings.push({
    id: `firewall-${counter++}`,
    title: `Firewall state: ${statusResponse.value}`,
    ...(stateAnnotation.description ? { details: stateAnnotation.description } : {}),
    ...(stateAnnotation.fix ? { fix: stateAnnotation.fix } : {}),
  });

  // Rules: { status: "ok", body: { CustomRules: [...], ManagedRules: [...] } }
  // Defensive defaults — when the WAF policy is absent the orchestrator may pass an empty
  // body (per SKILL.md § 2.1). Treat missing arrays as no rules rather than throwing.
  const body = rulesResponse.body || {};
  const customRules = Array.isArray(body.CustomRules) ? body.CustomRules : [];
  const managedRules = Array.isArray(body.ManagedRules) ? body.ManagedRules : [];
  const ruleAnnotations = annotations.rules || {};

  const sortedCustom = [...customRules].sort((a, b) => a.priority - b.priority);
  for (const r of sortedCustom) {
    const pairs = [];
    pairs.push(['Type', r.ruleType === 'RateLimitRule' ? 'Custom rate-limit rule' : `Custom ${r.ruleType}`]);
    if (r.ruleType === 'RateLimitRule') {
      pairs.push(['Threshold', `${r.rateLimitThreshold} requests / ${r.rateLimitDurationInMinutes} min`]);
    }
    pairs.push(['Action', r.action]);
    pairs.push(['Priority', String(r.priority)]);
    pairs.push(['State', r.enabledState]);

    const annotation = ruleAnnotations[r.name] || {};
    const detailParts = [];
    if (annotation.description) detailParts.push(annotation.description);
    detailParts.push(bulletList(pairs));

    findings.push({
      id: `firewall-${counter++}`,
      title: r.name,
      details: detailParts.join('\n\n'),
      ...(annotation.fix ? { fix: annotation.fix } : {}),
    });
  }

  const sortedManaged = [...managedRules].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const m of sortedManaged) {
    const version = m['properties.ruleSetVersion'];
    const groups = Array.isArray(m['properties.ruleGroups']) ? m['properties.ruleGroups'] : [];
    const provisioningState = m['properties.provisioningState'];
    let ruleCount = 0;
    for (const g of groups) ruleCount += Array.isArray(g.rules) ? g.rules.length : 0;

    const pairs = [
      ['Type', 'Managed rule set'],
      ['Version', version],
      ['Rules', `${ruleCount} across ${groups.length} group${groups.length === 1 ? '' : 's'}`],
      ['Provisioning state', provisioningState],
    ];
    const annotation = ruleAnnotations[m.name] || {};
    const detailParts = [];
    if (annotation.description) detailParts.push(annotation.description);
    detailParts.push(bulletList(pairs));

    findings.push({
      id: `firewall-${counter++}`,
      title: m.name,
      details: detailParts.join('\n\n'),
      ...(annotation.fix ? { fix: annotation.fix } : {}),
    });
  }

  return { status: 'ok', findings };
}

function main() {
  const statusFile = getArg('statusFile');
  const rulesFile = getArg('rulesFile');
  const annotationsFile = getArg('annotations');
  if (!statusFile || !rulesFile) {
    process.stderr.write('Usage: node transform-firewall.js --statusFile <status-file> --rulesFile <rules-file> [--annotations <annotations-file>]\n');
    return 1;
  }
  const statusResponse = readJson(statusFile, 'status file');
  const rulesResponse = readJson(rulesFile, 'rules file');
  const annotations = annotationsFile ? readJson(annotationsFile, 'annotations file') : {};
  process.stdout.write(JSON.stringify(transform(statusResponse, rulesResponse, annotations)) + '\n');
  return 0;
}

module.exports = { transform };

if (require.main === module) {
  process.exit(main());
}

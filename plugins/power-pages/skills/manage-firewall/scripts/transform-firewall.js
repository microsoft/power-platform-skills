#!/usr/bin/env node

const fs = require('fs');

const RULE_TYPE_RATE_LIMIT = 'RateLimitRule';

const HELP = `transform-firewall.js — Transform get-status.js + get-rules.js output into section findings.

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
`;

function getArg(name) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
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

function buildFinding(id, title, pairs, annotation) {
  const detailParts = [];
  if (annotation.description) detailParts.push(annotation.description);
  detailParts.push(bulletList(pairs));
  return {
    id,
    title,
    details: detailParts.join('\n\n'),
    ...(annotation.fix ? { fix: annotation.fix } : {}),
  };
}

function customRulePairs(rule) {
  const typeLabel =
    rule.ruleType === RULE_TYPE_RATE_LIMIT
      ? 'Custom rate-limit rule'
      : `Custom ${rule.ruleType || 'rule'}`;
  const pairs = [['Type', typeLabel]];
  if (rule.ruleType === RULE_TYPE_RATE_LIMIT) {
    pairs.push([
      'Threshold',
      `${rule.rateLimitThreshold ?? '?'} requests / ${rule.rateLimitDurationInMinutes ?? '?'} min`,
    ]);
  }
  pairs.push(['Action', rule.action || 'unknown']);
  pairs.push(['Priority', rule.priority != null ? String(rule.priority) : 'unknown']);
  pairs.push(['State', rule.enabledState || 'unknown']);
  return pairs;
}

// Managed-rule responses arrive with dotted, flattened keys (e.g. `properties.ruleSetVersion`)
// from the WAF endpoint, but fall back to nested `properties.*` if the service shape changes.
function managedField(rule, key) {
  return rule[`properties.${key}`] ?? rule.properties?.[key];
}

function managedRulePairs(rule) {
  const groups = (() => {
    const value = managedField(rule, 'ruleGroups');
    return Array.isArray(value) ? value : [];
  })();
  const ruleCount = groups.reduce(
    (sum, g) => sum + (Array.isArray(g.rules) ? g.rules.length : 0),
    0
  );
  const groupCount = groups.length;
  return [
    ['Type', 'Managed rule set'],
    ['Version', managedField(rule, 'ruleSetVersion') || 'unknown'],
    ['Rules', `${ruleCount} across ${groupCount} group${groupCount === 1 ? '' : 's'}`],
    ['Provisioning state', managedField(rule, 'provisioningState') || 'unknown'],
  ];
}

function transform(statusResponse, rulesResponse, annotations) {
  const findings = [];
  let counter = 1;

  const unsupportedResponse =
    statusResponse.status === 'unsupported'
      ? statusResponse
      : rulesResponse.status === 'unsupported'
        ? rulesResponse
        : null;
  if (unsupportedResponse) {
    findings.push({
      id: `firewall-${counter++}`,
      title: 'Firewall unsupported',
      details: unsupportedResponse.message || 'Feature not available.',
    });
    return { status: 'unsupported', findings };
  }

  const stateAnnotation = annotations.state || {};
  findings.push({
    id: `firewall-${counter++}`,
    title: `Firewall state: ${statusResponse.value ?? 'unknown'}`,
    ...(stateAnnotation.description ? { details: stateAnnotation.description } : {}),
    ...(stateAnnotation.fix ? { fix: stateAnnotation.fix } : {}),
  });

  const body = rulesResponse.body || {};
  const customRules = Array.isArray(body.CustomRules) ? body.CustomRules : [];
  const managedRules = Array.isArray(body.ManagedRules) ? body.ManagedRules : [];
  const ruleAnnotations = annotations.rules || {};

  // Missing priorities sort last so the comparator never returns NaN.
  const priorityOf = (r) => (r.priority != null ? r.priority : Number.MAX_SAFE_INTEGER);
  const sortedCustom = [...customRules].sort((a, b) => priorityOf(a) - priorityOf(b));
  for (const rule of sortedCustom) {
    findings.push(
      buildFinding(
        `firewall-${counter++}`,
        rule.name,
        customRulePairs(rule),
        ruleAnnotations[rule.name] || {}
      )
    );
  }

  const sortedManaged = [...managedRules].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  );
  for (const rule of sortedManaged) {
    findings.push(
      buildFinding(
        `firewall-${counter++}`,
        rule.name,
        managedRulePairs(rule),
        ruleAnnotations[rule.name] || {}
      )
    );
  }

  return { status: 'ok', findings };
}

function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const statusFile = getArg('statusFile');
  const rulesFile = getArg('rulesFile');
  const annotationsFile = getArg('annotations');
  if (!statusFile || !rulesFile) {
    process.stderr.write(
      'Usage: node transform-firewall.js --statusFile <status-file> ' +
        '--rulesFile <rules-file> [--annotations <annotations-file>]\n'
    );
    return 1;
  }

  const statusResponse = readJson(statusFile, 'status file');
  const rulesResponse = readJson(rulesFile, 'rules file');
  const annotations = annotationsFile ? readJson(annotationsFile, 'annotations file') : {};

  process.stdout.write(
    JSON.stringify(transform(statusResponse, rulesResponse, annotations)) + '\n'
  );
  return 0;
}

module.exports = { transform };

if (require.main === module) {
  process.exit(main());
}

#!/usr/bin/env node

// Fails the build when model-apps source, docs, or eval fixtures reference a REAL
// Dataverse environment, tenant, or user account instead of a placeholder.
//
// WHY THIS EXISTS
// This repository is public (see the "This Repo Is PUBLIC" section in the root
// AGENTS.md). The genpage eval fixtures are *captured* agent transcripts, so they
// faithfully record whatever live environment the eval was run against — including
// `pac auth list` output with the operator's UPN, tenant, and environment URL. That
// is internal infrastructure detail with no value to an external reader, and it
// accumulated to 53 occurrences across 28 files before it was scrubbed. This guard
// exists so the scrub sticks: re-pasting a fresh live transcript is the realistic
// regression path, and it is not something review reliably catches by eye.
//
// WHAT IT CHECKS
// Two independent rules, both scoped to the model-apps plugin and its evals:
//   1. Shape rule — every Dataverse host (`<sub>.crm*.dynamics.com`) and every
//      `<tenant>.onmicrosoft.com` must look like a placeholder.
//   2. Token rule — specific identifiers that were previously committed and removed
//      are permanently banned, so the exact same environments cannot come back.
//
// KNOWN GAP (deliberate, not an oversight)
// The scan is limited to `plugins/model-apps/**` and `evals/model-apps/**`. Other
// plugins have their own pre-existing references of this class (for example real
// `org<8hex>` orgs cited in power-pages provenance comments). Widening the scan
// today would fail the build on those pre-existing hits, which would either block
// unrelated PRs or force a rushed cross-plugin edit. Widening is a separate change
// that must scrub those plugins first. A guard that silently skipped them while
// claiming repo-wide coverage would be worse than one that states its limits.
//
// `scripts/**` is outside the scan too, and cannot simply be added: this guard's own
// tests must contain non-placeholder hosts and tenants BY CONSTRUCTION — they are the
// negative cases proving rejection works — so scanning them would report the guard
// against itself. Those fixtures are invented values, deliberately NOT the identifiers
// this repo actually scrubbed; committing the real ones as test data (or as a denylist)
// would make this file the durable public copy of exactly what the scrub removed.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const SCAN_PATHS = ['plugins/model-apps', 'evals/model-apps'];

// Subdomain roots that are unambiguously fictional. Microsoft documentation uses
// Contoso/Fabrikam as its standard sample organizations, so they read as obviously
// fake to any external reader.
// https://learn.microsoft.com/en-us/style-guide/a-z-word-list-term-collections/term-collections/fictitious-names
//
// Kept deliberately SHORT. These are matched as PREFIXES, so every entry here waves through an
// unbounded family of names — and a generic English word is exactly the kind of prefix a real
// environment carries. `test`, `demo`, `sample` and `my-` were removed for that reason:
// environments genuinely named `TestEnv01`, `demo-prod-01` or `sampleorg99` are common, and a prefix
// rule would have declared each of them a placeholder and let a live URL through. That is the
// failure direction that matters here — a false negative is a leak, while a false positive is a
// one-line fix by whoever hits it. Bare `test`/`demo` still pass via the length rule below, which is
// what the in-tree fixtures actually use.
const PLACEHOLDER_ROOTS = [
  'contoso',
  'fabrikam',
  'example',
  'your-',
];

// Short generic stand-ins used throughout the unit tests (`org`, `x`, `a`, `b`,
// `stg`, `other`, ...). Real Dataverse environment names are never this short: the
// service auto-generates `org<8 hex>` and human-named envs carry a team or product
// word. A length ceiling is therefore a reliable discriminator, and it is
// intentionally paired with the hex check below so `org1a2b3c4d` cannot slip
// through merely because it starts with the allowed word "org".
const MAX_GENERIC_LENGTH = 6;

// Dataverse auto-generates organization hostnames as `org` + 8 hex characters, e.g.
// `https://org1a2b3c4d.crm.dynamics.com` (that example is invented — this file must not become a
// durable copy of a real org id). That shape is always a real environment.
// https://learn.microsoft.com/en-us/power-platform/admin/determine-org-id-name
const REAL_ORG_SHAPE = /^org[0-9a-f]{8}$/i;

// Previously-committed identifiers are deliberately NOT listed here as plaintext. A denylist of
// private values republishes exactly what this guard exists to suppress — the file would become the
// durable copy of every environment and tenant we scrubbed, in the same public repo. It is also
// unnecessary: the shape rules below already reject every one of them, because a real environment
// name is neither a documented fictitious brand nor short enough to be a generic stand-in.

// Email domains that are obviously illustrative. Anything else in a scanned file is treated as a
// real person's address. A work UPN in a captured transcript is the leak most likely to survive a
// hostname-only scrub, precisely because it does not look like infrastructure — this guard missed
// one until review caught it.
const PLACEHOLDER_EMAIL_DOMAIN_ROOTS = ['contoso', 'fabrikam', 'example', 'company', 'your'];

// OData annotations parse as e-mail addresses but are not: `_ownerid_value@OData.Community.Display.
// V1.FormattedValue`, `publisherid@odata.bind`. Both begin their "domain" with `odata.`, which is
// not a registrable domain, so skipping them costs no real coverage.
const ODATA_ANNOTATION = /^odata\./i;

const HOST_RE = /\b([a-z0-9][a-z0-9-]*)\.crm[a-z0-9]*\.dynamics\.com\b/gi;
const TENANT_RE = /\b([a-z0-9][a-z0-9-]*)\.onmicrosoft\.com\b/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

// `contosotest1.onmicrosoft.com` -> `contosotest1`; `contoso.com` -> `contoso`.
function isPlaceholderEmailDomain(domain) {
  const value = String(domain).toLowerCase();
  if (ODATA_ANNOTATION.test(value)) return true;
  // `*.onmicrosoft.com` is already judged by TENANT_RE with the same placeholder logic. Returning
  // true here means "not the e-mail rule's business", not "safe" — reporting one identifier twice
  // would make the operator's output noisier without adding coverage.
  if (value.endsWith('.onmicrosoft.com')) return true;
  const firstLabel = value.split('.')[0] || '';
  return PLACEHOLDER_EMAIL_DOMAIN_ROOTS.some((root) => firstLabel.startsWith(root));
}

function isPlaceholder(subdomain) {
  const value = subdomain.toLowerCase();
  // Checked before the placeholder roots so a real `org<8hex>` is never rescued by
  // some future root that happens to prefix-match it.
  if (REAL_ORG_SHAPE.test(value)) return false;
  if (PLACEHOLDER_ROOTS.some((root) => value.startsWith(root))) return true;
  return value.length <= MAX_GENERIC_LENGTH;
}

function listTrackedFiles() {
  // `git ls-files` rather than a directory walk so the guard sees exactly what is
  // committed — untracked scratch files are the author's business, not the public
  // repository's.
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_PATHS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

function scanText(content) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;

    for (const [, subdomain] of line.matchAll(HOST_RE)) {
      if (!isPlaceholder(subdomain)) {
        violations.push({
          line: lineNo,
          detail: `non-placeholder Dataverse host "${subdomain}"`,
        });
      }
    }

    for (const [, tenant] of line.matchAll(TENANT_RE)) {
      if (!isPlaceholder(tenant)) {
        violations.push({ line: lineNo, detail: `non-placeholder tenant "${tenant}"` });
      }
    }

    for (const [, domain] of line.matchAll(EMAIL_RE)) {
      if (!isPlaceholderEmailDomain(domain)) {
        violations.push({ line: lineNo, detail: `real-looking e-mail domain "${domain}"` });
      }
    }
  });
  return violations;
}

function main() {
  const violations = [];

  for (const relPath of listTrackedFiles()) {
    const absPath = path.join(REPO_ROOT, relPath);
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      // Unreadable or binary content cannot carry a readable identifier.
      continue;
    }
    // A cheap pre-filter: most files contain none of these markers, and skipping them avoids running
    // the regexes over the whole plugin tree. `@` covers the e-mail rule — broad, but the files that
    // contain no `@` at all are exactly the ones with nothing to find.
    const lower = content.toLowerCase();
    if (
      !lower.includes('dynamics.com') &&
      !lower.includes('onmicrosoft.com') &&
      !lower.includes('@')
    ) {
      continue;
    }

    for (const v of scanText(content)) {
      violations.push({ file: relPath, ...v });
    }
  }

  if (violations.length > 0) {
    console.error('Real environment / tenant identifiers found in a PUBLIC repository:\n');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.detail}`);
    }
    console.error(
      [
        '',
        `${violations.length} violation(s).`,
        '',
        'This repository is public. Replace live environment URLs, tenants, and user',
        'accounts with placeholders such as https://contoso.crm.dynamics.com or',
        'maker@contoso.onmicrosoft.com. For eval fixtures captured from a live run,',
        'prefer an EQUAL-LENGTH placeholder so fixed-width `pac auth list` tables stay',
        'aligned. For provenance comments ("verified live on X"), generalise the claim',
        'to "a Dataverse test environment" rather than substituting a fake name, which',
        'would make the claim misleading.',
        '',
        'See the "This Repo Is PUBLIC" section in the root AGENTS.md.',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log(
    `OK: no real environment identifiers in ${SCAN_PATHS.join(', ')} (scanned tracked files).`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { isPlaceholder, isPlaceholderEmailDomain, scanText, PLACEHOLDER_ROOTS };

#!/usr/bin/env node

// V-2/V-14/V-16/V-18/V-19 orchestrator: runs every pre-flight validator in
// parallel against the pending-changes snapshot, aggregates findings into
// the standard `{ ok, blocking[], warnings[], info[] }` shape, captures
// per-validator timings, computes delta vs the previous run, and emits the
// combined report in --format json|junit|sarif|text.
//
// Why this exists:
// - SKILL.md Phase 3 used to enumerate ~13 individual validator calls; this
//   collapses it to one orchestrator invocation. Easier to read, harder to
//   forget a validator, and the orchestrator centralises non-trivial
//   plumbing (timing, delta, format emission) that would otherwise need to
//   live in agent prose.
// - It is the single place that knows the catalog of validators. Adding a
//   new validator means appending one entry to VALIDATORS.
//
// Discovery:
//   Each entry: { name, script, kind: 'pure'|'http', ILRef, build(ctx) -> argv[] }
//   `kind` is documentation only — `build()` decides what flags to add.
//   `ILRef` is the inner-loop-error-catalog.md anchor for V-17 (LOW tier).
//
// Backward compatibility:
//   Even with this orchestrator in place, every individual validator script
//   remains directly invokable. The orchestrator does not replace them; it
//   just stops the agent from having to enumerate them.
//
// Usage:
//   node run-prevalidators.js
//     --pending-file <path>                 # required: snapshot from list-pending-changes.js
//     [--manifest <path>]                   # default: <projectRoot>/docs/inner-loop/.git-integration-manifest.json
//     [--envUrl <url>] [--token <bearer>]
//     [--solutionUniqueName <name>]         # taken from manifest if absent
//     [--format json|junit|sarif|text]      # default: json (and always writes last-validation.json + pre-commit-report.html)
//     [--out-dir <dir>]                     # default: <projectRoot>/docs/inner-loop/
//     [--project-root <path>]               # default: findProjectRoot(cwd)
//     [--env-friendly-name <name>]          # default: extracted from envUrl host
//     [--no-timings]                        # opt out of validator timing capture
//     [--no-delta]                          # opt out of delta computation
//     [--validator-timeout <ms>]            # per-validator hard timeout. default 60000
//     [--quiet]
//     [--docs-base-url <url>]               # V-17 IL hyperlink base; overrides POWER_PAGES_DOCS_BASE_URL env var

'use strict';

const fs  = require('node:fs');
const os  = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  findProjectRoot,
} = require('./validation-helpers');
const {
  innerLoopDir,
  innerLoopPath,
  ensureInnerLoopDir,
  gitIntegrationManifestPath,
  requireProjectRoot,
} = require('./inner-loop-paths');

// ===== Validator catalog =====
//
// Adding a validator: append a single entry below. The orchestrator picks
// it up automatically. Each entry's build(ctx) returns the argv array
// passed to `node <script>`; the orchestrator captures stdout JSON and
// merges per the standard envelope shape.

const LIB_DIR = __dirname;
const SCRIPT = (name) => path.join(LIB_DIR, name);

const VALIDATORS = [
  // ---- 5 pure validators (consume snapshot via --pending-file) ----
  {
    name: 'validate-file-sizes',
    script: SCRIPT('validate-file-sizes.js'),
    kind: 'pure',
    ILRef: 'IL-006',
    build: (c) => ['--pending-file', c.pendingFile],
  },
  {
    name: 'validate-supported-object-types',
    script: SCRIPT('validate-supported-object-types.js'),
    kind: 'pure',
    ILRef: 'IL-007',
    build: (c) => ['--pending-file', c.pendingFile],
  },
  {
    name: 'check-large-canvas-warning',
    script: SCRIPT('check-large-canvas-warning.js'),
    kind: 'pure',
    ILRef: 'IL-006',
    build: (c) => ['--pending-file', c.pendingFile],
  },
  {
    name: 'check-code-first-binary-duplication',
    script: SCRIPT('check-code-first-binary-duplication.js'),
    kind: 'pure',
    ILRef: null,
    build: (c) => ['--pending-file', c.pendingFile],
  },
  {
    name: 'validate-dependencies',
    script: SCRIPT('validate-dependencies.js'),
    kind: 'pure',
    ILRef: null,
    build: (c) => ['--pending-file', c.pendingFile],
  },

  // ---- HTTP-touching validators ----
  {
    name: 'validate-no-orphan-source-control-rows',
    script: SCRIPT('validate-no-orphan-source-control-rows.js'),
    kind: 'http',
    ILRef: 'IL-019',
    build: (c) => ['--envUrl', c.envUrl, ...optTok(c), ...optSolName(c)],
  },
  {
    name: 'validate-no-action-3-conflicts',
    script: SCRIPT('validate-no-action-3-conflicts.js'),
    kind: 'http',
    ILRef: 'IL-010',
    build: (c) => ['--envUrl', c.envUrl, ...optTok(c), ...optSolName(c)],
  },
  {
    name: 'validate-no-shared-components',
    script: SCRIPT('validate-no-shared-components.js'),
    kind: 'http',
    ILRef: 'IL-009',
    needsSolutionUniqueName: true,
    build: (c) => ['--envUrl', c.envUrl, ...optTok(c), '--solutionUniqueName', c.solutionUniqueName],
  },
  {
    name: 'validate-not-default-solution',
    script: SCRIPT('validate-not-default-solution.js'),
    kind: 'pure',
    ILRef: 'IL-008',
    build: (c) => ['--manifest', c.manifestFile],
  },
  {
    name: 'validate-solution-version-bumped',
    script: SCRIPT('validate-solution-version-bumped.js'),
    kind: 'http',
    ILRef: 'IL-008',
    needsSolutionUniqueName: true,
    build: (c) => ['--envUrl', c.envUrl, ...optTok(c), '--solutionUniqueName', c.solutionUniqueName,
                   '--pending-file', c.pendingFile, '--project-root', c.projectRoot],
  },
  {
    name: 'validate-no-iscustomizable-false-rows',
    script: SCRIPT('validate-no-iscustomizable-false-rows.js'),
    kind: 'http',
    ILRef: 'IL-007',
    build: (c) => ['--envUrl', c.envUrl, ...optTok(c), '--pending-file', c.pendingFile],
  },
  {
    name: 'validate-blocked-attachments',
    script: SCRIPT('validate-blocked-attachments.js'),
    kind: 'http',
    ILRef: 'IL-012',
    build: (c) => ['--envUrl', c.envUrl],
  },
  // ---- Tier 3 (LOW) additions ----
  {
    name: 'validate-publisher-prefix-consistency',
    script: SCRIPT('validate-publisher-prefix-consistency.js'),
    kind: 'http',
    ILRef: null,
    needsSolutionUniqueName: true,
    build: (c) => ['--envUrl', c.envUrl, ...optTok(c),
                   '--solutionUniqueName', c.solutionUniqueName,
                   '--pending-file', c.pendingFile],
  },
  {
    name: 'validate-total-payload-size',
    script: SCRIPT('validate-total-payload-size.js'),
    kind: 'pure',
    ILRef: null,
    build: (c) => ['--pending-file', c.pendingFile],
  },
];

function optTok(c)     { return c.token              ? ['--token', c.token]                          : []; }
function optSolName(c) { return c.solutionUniqueName ? ['--solutionUniqueName', c.solutionUniqueName] : []; }

// ===== CLI =====

function parseArgs(argv) {
  const a = argv.slice(2);
  const o = {
    pendingFile: null, manifestFile: null,
    envUrl: null, token: null, solutionUniqueName: null,
    format: 'json', outDir: null, projectRoot: null,
    envFriendlyName: null,
    captureTimings: true, computeDelta: true,
    validatorTimeoutMs: 60000,
    quiet: false, verbose: false,
    docsBaseUrl: process.env.POWER_PAGES_DOCS_BASE_URL || null,
  };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--pending-file':         o.pendingFile = a[++i]; break;
      case '--manifest':             o.manifestFile = a[++i]; break;
      case '--envUrl':               o.envUrl = a[++i]; break;
      case '--token':                o.token = a[++i]; break;
      case '--solutionUniqueName':   o.solutionUniqueName = a[++i]; break;
      case '--format':               o.format = a[++i]; break;
      case '--out-dir':              o.outDir = a[++i]; break;
      case '--project-root':         o.projectRoot = a[++i]; break;
      case '--env-friendly-name':    o.envFriendlyName = a[++i]; break;
      case '--no-timings':           o.captureTimings = false; break;
      case '--no-delta':             o.computeDelta = false; break;
      case '--validator-timeout':    o.validatorTimeoutMs = parseInt(a[++i], 10); break;
      case '--quiet':                o.quiet = true; break;
      case '--verbose':              o.verbose = true; break;
      case '--docs-base-url':        o.docsBaseUrl = a[++i]; break;
      default: /* ignore unknown */
    }
  }
  if (!['json','junit','sarif','text'].includes(o.format)) {
    throw new Error(`Unsupported --format '${o.format}'`);
  }
  return o;
}

// ===== Child-process runner =====

function runOne(script, argv, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [script, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error',  (e)   => { clearTimeout(timer); resolve({ ok: false, error: e.message, elapsedMs: Date.now() - start }); });
    child.on('close',  (code) => {
      clearTimeout(timer);
      resolve({ ok: true, exitCode: code, stdout, stderr, elapsedMs: Date.now() - start });
    });
  });
}

// ===== Envelope normaliser =====
// Accepts the standard envelope shape OR the older shape from
// validate-file-sizes / check-large-canvas-warning. Returns the
// canonical { ok, totalChecked, blocking[], warnings[], info[] }.

function normaliseEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.error) return { error: parsed.error, statusCode: parsed.statusCode };
  const blocking = Array.isArray(parsed.blocking) ? parsed.blocking : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const info     = Array.isArray(parsed.info)     ? parsed.info     : [];
  const ok = typeof parsed.ok === 'boolean' ? parsed.ok : blocking.length === 0;
  const totalChecked = typeof parsed.totalChecked === 'number'
    ? parsed.totalChecked
    : (typeof parsed.totalFiles === 'number' ? parsed.totalFiles : (blocking.length + warnings.length + info.length));
  return { ok, totalChecked, blocking, warnings, info };
}

// Promote bare entries to standard finding shape so emitters can rely on it.
function normaliseFinding(f, defaultSeverity, fallbackILRef) {
  if (!f || typeof f !== 'object') return null;
  return {
    severity:    f.severity    || defaultSeverity,
    key:         f.key         || (typeof f.detail === 'string' ? f.detail.slice(0, 40) : 'finding'),
    message:     f.message     || (typeof f.detail === 'string' ? f.detail : JSON.stringify(f)),
    ref:         f.ref         || fallbackILRef || null,
    details:     f.details     || f,
    remediation: f.remediation || null,
  };
}

// ===== Aggregation =====

function aggregateResults(perValidator) {
  const blockers = [];
  const warnings = [];
  const infos    = [];
  for (const v of perValidator) {
    for (const b of v.blocking || []) {
      const f = normaliseFinding(b, 'blocker', v.ILRef);
      if (f) blockers.push({ ...f, validator: v.name });
    }
    for (const w of v.warnings || []) {
      const f = normaliseFinding(w, 'warn', v.ILRef);
      if (f) warnings.push({ ...f, validator: v.name });
    }
    for (const i of v.info || []) {
      const f = normaliseFinding(i, 'info', v.ILRef);
      if (f) infos.push({ ...f, validator: v.name });
    }
  }
  const status = blockers.length > 0 ? 'blocked' : (warnings.length > 0 ? 'warnings' : 'passed');
  return { status, blockers, warnings, infos };
}

// O1 — collapse a noisy run of same-(validator, ref/code) findings into a single
// summary row so one root cause (e.g. 61 publisher-prefix warnings) doesn't flood
// the report. Blockers are NEVER collapsed — every blocker must stay visible.
// Returns a NEW array; the caller's raw arrays (used for counts/delta) are
// untouched. `verbose` disables collapsing entirely.
function collapseFindings(findings, { threshold = 5, verbose = false } = {}) {
  if (verbose || !Array.isArray(findings)) return findings || [];
  const groups = new Map();
  const order = [];
  for (const f of findings) {
    const code = f.ref || 'no-ref';
    const k = `${f.validator || '?'}||${code}`;
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(f);
  }
  const out = [];
  for (const k of order) {
    const grp = groups.get(k);
    if (grp.length > threshold) {
      const first = grp[0];
      out.push({
        ...first,
        collapsedCount: grp.length,
        message: `${grp.length}× ${first.message} — collapsed; run with --verbose to expand all ${grp.length}.`,
      });
    } else {
      out.push(...grp);
    }
  }
  return out;
}

function computeDelta(current, priorPath) {
  if (!priorPath || !fs.existsSync(priorPath)) {
    return { prior: null, deltas: null };
  }
  let prior;
  try { prior = JSON.parse(fs.readFileSync(priorPath, 'utf8')); }
  catch { return { prior: null, deltas: null }; }
  const priorBlockers = (prior.blockers || []).length;
  const priorWarnings = (prior.warnings || []).length;
  const priorInfos    = (prior.infos    || []).length;
  return {
    prior: {
      generatedAt: prior.generatedAt || null,
      status: prior.status || null,
      blockers: priorBlockers, warnings: priorWarnings, infos: priorInfos,
    },
    deltas: {
      blockers: current.blockers.length - priorBlockers,
      warnings: current.warnings.length - priorWarnings,
      infos:    current.infos.length    - priorInfos,
    },
  };
}

// ===== Emitters =====

function emitText(report) {
  const badge = report.status === 'blocked' ? '✗ BLOCKED' : (report.status === 'warnings' ? '⚠ WARNINGS' : '✓ PASSED');
  const lines = [
    `[git-sync --dry-run] ${badge}`,
    `  Validators:    ${report.validatorTimings ? Object.keys(report.validatorTimings).length : '?'} run`,
    `  Blockers:      ${report.blockers.length}`,
    `  Warnings:      ${report.warnings.length}`,
    `  Info:          ${report.infos.length}`,
    `  Elapsed:       ${report.elapsedMs}ms`,
  ];
  if (report.delta && report.delta.deltas) {
    const d = report.delta.deltas;
    lines.push(`  vs prior:      blockers ${signed(d.blockers)}, warnings ${signed(d.warnings)}, info ${signed(d.infos)}`);
  }
  return lines.join('\n') + '\n';
}
function signed(n) { return n > 0 ? `+${n}` : `${n}`; }

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

function emitJUnit(report) {
  const ts = report.generatedAt;
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<testsuites name="git-sync-dry-run" tests="${report.blockers.length + report.warnings.length + report.infos.length}" failures="${report.blockers.length}" time="${(report.elapsedMs / 1000).toFixed(3)}" timestamp="${ts}">\n`;
  for (const v of report.perValidator) {
    const findings = [
      ...(v.blocking || []).map((f) => ({ ...f, severity: 'blocker' })),
      ...(v.warnings || []).map((f) => ({ ...f, severity: 'warn' })),
      ...(v.info     || []).map((f) => ({ ...f, severity: 'info' })),
    ];
    const elapsedSec = ((report.validatorTimings?.[v.name] || 0) / 1000).toFixed(3);
    const failuresInSuite = (v.blocking || []).length;
    xml += `  <testsuite name="${xmlEscape(v.name)}" tests="${findings.length || 1}" failures="${failuresInSuite}" time="${elapsedSec}">\n`;
    if (findings.length === 0) {
      xml += `    <testcase name="${xmlEscape(v.name + '.ok')}" classname="${xmlEscape(v.name)}" time="${elapsedSec}"/>\n`;
    }
    for (const f of findings) {
      const tc = `    <testcase name="${xmlEscape(f.key || 'finding')}" classname="${xmlEscape(v.name)}" time="0">\n`;
      let body = '';
      if (f.severity === 'blocker') {
        body = `      <failure type="${xmlEscape(f.ref || 'blocker')}" message="${xmlEscape(f.message || '')}">${xmlEscape(JSON.stringify(f.details || {}, null, 2))}</failure>\n`;
      } else if (f.severity === 'warn') {
        body = `      <system-out>WARNING: ${xmlEscape(f.message || '')}</system-out>\n`;
      } else {
        body = `      <system-out>INFO: ${xmlEscape(f.message || '')}</system-out>\n`;
      }
      xml += tc + body + '    </testcase>\n';
    }
    xml += '  </testsuite>\n';
  }
  xml += '</testsuites>\n';
  return xml;
}

function emitSarif(report) {
  const allFindings = [
    ...report.blockers.map((f) => ({ ...f, level: 'error' })),
    ...report.warnings.map((f) => ({ ...f, level: 'warning' })),
    ...report.infos.map((f) => ({ ...f, level: 'note' })),
  ];
  const rules = new Map();
  for (const f of allFindings) {
    const id = ruleId(f);
    if (!rules.has(id)) {
      rules.set(id, {
        id,
        shortDescription: { text: f.key || id },
        fullDescription: { text: f.message || id },
        helpUri: f.ref ? buildHelpUri(f.ref, report.docsBaseUrl) : undefined,
        properties: f.ref ? { ilRef: f.ref } : undefined,
      });
    }
  }
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'git-sync-dry-run',
          informationUri: 'https://github.com/microsoft/power-platform-skills',
          rules: [...rules.values()],
        },
      },
      results: allFindings.map((f) => ({
        ruleId: ruleId(f),
        level: f.level,
        message: { text: f.message || '' },
        properties: {
          validator: f.validator,
          ilRef: f.ref || null,
          details: f.details || {},
          remediation: f.remediation || null,
        },
      })),
    }],
  }, null, 2);
}

function ruleId(f) {
  if (f.ref) return `PP-VALIDATE-${f.ref}`;
  return `PP-VALIDATE-${(f.validator || 'unknown')}-${(f.key || 'finding')}`;
}

function buildHelpUri(ilRef, base) {
  const anchor = ilRefToAnchor(ilRef);
  if (base) return `${base.replace(/\/+$/, '')}/inner-loop-error-catalog.md#${anchor}`;
  return `../references/inner-loop-error-catalog.md#${anchor}`;
}

// ## Pattern IL-008: Default Solution cannot be Git-bound
//   → #pattern-il-008-default-solution-cannot-be-git-bound
// We only know the IL number, not the short name; produce a stable anchor
// that github+gitiles+gitlab-style renderers will recognise as a *prefix*
// of the actual heading anchor. For full anchor, the report renderer below
// resolves the name from a small in-memory map.
function ilRefToAnchor(ilRef) {
  const num = (ilRef || '').replace(/^IL-/, '').toLowerCase();
  return `pattern-il-${num}`;
}

// ===== HTML report =====

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderHtmlReport(report) {
  const statusClass = report.status === 'blocked' ? 'blocker' : (report.status === 'warnings' ? 'warning' : 'passed');
  const statusLabel = report.status.charAt(0).toUpperCase() + report.status.slice(1);
  const findings = [
    ...report.blockers.map((f) => ({ ...f, sev: 'blocker' })),
    ...collapseFindings(report.warnings, { verbose: report.verbose }).map((f) => ({ ...f, sev: 'warning' })),
    ...collapseFindings(report.infos, { verbose: report.verbose }).map((f) => ({ ...f, sev: 'info' })),
  ];
  const findingsRows = findings.length ? findings.map((f) => `
    <tr>
      <td><span class="badge badge-${f.sev}">${htmlEscape(f.sev)}</span></td>
      <td>${htmlEscape(f.validator)}</td>
      <td>${htmlEscape(f.message)}</td>
      <td>${f.ref ? `<a href="${buildHelpUri(f.ref, report.docsBaseUrl)}">${htmlEscape(f.ref)}</a>` : ''}</td>
      <td>${htmlEscape(f.remediation || '')}</td>
    </tr>`).join('') : '<tr><td colspan="5"><em>All checks passed.</em></td></tr>';

  // V-15: components-by-type breakdown
  const breakdown = report.componentsByType || {};
  const breakdownRows = Object.entries(breakdown).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<tr><td>${htmlEscape(t)}</td><td style="text-align:right">${n}</td></tr>`).join('');

  // V-18 timings
  const timingsRows = Object.entries(report.validatorTimings || {}).sort((a, b) => b[1] - a[1])
    .map(([n, ms]) => `<tr><td>${htmlEscape(n)}</td><td style="text-align:right">${ms} ms</td></tr>`).join('');

  // V-14 delta
  const delta = report.delta && report.delta.deltas ? `
    <p>Since previous run: blockers <strong>${signed(report.delta.deltas.blockers)}</strong>,
    warnings <strong>${signed(report.delta.deltas.warnings)}</strong>,
    info <strong>${signed(report.delta.deltas.infos)}</strong></p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Pre-commit validation report</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; padding: 24px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 1.6rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: #f3f3f3; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .8rem; font-weight: 600; color: #fff; }
  .badge-blocker, .badge-blocked { background: #c50f1f; }
  .badge-warning, .badge-warnings { background: #f7630c; }
  .badge-info     { background: #6c757d; }
  .badge-passed   { background: #107c10; }
  a { color: #0067c0; }
</style></head>
<body>
  <h1>Pre-commit validation report</h1>
  <p>Generated: <strong>${htmlEscape(report.generatedAt)}</strong> &nbsp;|&nbsp;
     Env: <strong>${htmlEscape(report.envUrl || 'unknown')}</strong> &nbsp;|&nbsp;
     Solution: <strong>${htmlEscape(report.solutionUniqueName || '(env-bound)')}</strong></p>
  <p>Pending changes: <strong>${report.pendingChangesCount ?? '?'}</strong> &nbsp;|&nbsp;
     Status: <span class="badge badge-${statusClass}">${htmlEscape(statusLabel)}</span></p>
  ${delta}

  <h2>Findings</h2>
  <table>
    <thead><tr><th>Severity</th><th>Validator</th><th>Message</th><th>Catalog ref</th><th>Remediation</th></tr></thead>
    <tbody>${findingsRows}</tbody>
  </table>

  ${breakdownRows ? `
  <h2>Components by type</h2>
  <table>
    <thead><tr><th>Component type</th><th>Count</th></tr></thead>
    <tbody>${breakdownRows}</tbody>
  </table>` : ''}

  ${timingsRows ? `
  <h2>Validator timings</h2>
  <table>
    <thead><tr><th>Validator</th><th>Elapsed</th></tr></thead>
    <tbody>${timingsRows}</tbody>
  </table>` : ''}
</body></html>
`;
}

// ===== Main =====

async function runPrevalidators(rawArgs = {}) {
  const opts = typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? { ...defaultOpts(), ...rawArgs }
    : rawArgs;

  if (!opts.pendingFile)              return { error: '--pending-file is required.' };
  if (!fs.existsSync(opts.pendingFile)) return { error: `Snapshot not found: ${opts.pendingFile}` };

  // Resolve project root + paths. requireProjectRoot centralises the
  // deprecation policy: WARN now, hard error after the runway date.
  const projectRoot = requireProjectRoot(opts.projectRoot, {
    caller: 'run-prevalidators',
    fallbackResolver: () => findProjectRoot(process.cwd()),
  });
  // Always ensure the canonical docs/inner-loop/ exists under projectRoot —
  // every artifact path we write resolves there via innerLoopPath().
  ensureInnerLoopDir(projectRoot);
  const outDir = opts.outDir || innerLoopDir(projectRoot);
  fs.mkdirSync(outDir, { recursive: true });

  const manifestFile = opts.manifestFile || gitIntegrationManifestPath(projectRoot);
  let manifest = {};
  if (fs.existsSync(manifestFile)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* tolerate */ }
  }
  const solutionUniqueName = opts.solutionUniqueName || manifest.solutionUniqueName || null;

  // Snapshot pre-read: needed for componentsByType (V-15) + count.
  let snapshot = { items: [] };
  try { snapshot = JSON.parse(fs.readFileSync(opts.pendingFile, 'utf8')); } catch { /* tolerate */ }
  const items = Array.isArray(snapshot.items) ? snapshot.items : (Array.isArray(snapshot) ? snapshot : []);

  // B1 guard: refuse to validate a truncated snapshot. A partial items[] makes
  // every downstream validator under-report (false-negatives on the missing
  // rows). list-pending-changes.js sets truncated:true and/or a count that
  // exceeds items.length when it could not materialise every row.
  const declaredCount = typeof snapshot.count === 'number' ? snapshot.count : null;
  if (snapshot.truncated === true || (declaredCount !== null && items.length < declaredCount)) {
    return {
      error: `Pending-changes snapshot is truncated (items=${items.length}` +
             (declaredCount !== null ? `, count=${declaredCount}` : '') +
             '). Re-run list-pending-changes.js with a higher --max-items so validators see ' +
             'every row — validating a partial snapshot would yield false-negatives.',
      truncated: true,
    };
  }

  const componentsByType = {};
  for (const it of items) {
    const t = it?.componentType || 'Unknown';
    componentsByType[t] = (componentsByType[t] || 0) + 1;
  }

  // Build per-validator argv via catalog.
  const ctx = {
    pendingFile: opts.pendingFile,
    manifestFile,
    envUrl: opts.envUrl,
    token: opts.token,
    solutionUniqueName,
    projectRoot,
  };

  // Filter out validators that can't run (e.g. missing solutionUniqueName).
  const runnable = VALIDATORS.filter((v) => {
    if (v.needsSolutionUniqueName && !solutionUniqueName) return false;
    if (v.kind === 'http' && !opts.envUrl) return false;
    return true;
  });
  const skipped = VALIDATORS.filter((v) => !runnable.includes(v));

  // Run in parallel.
  const tStart = Date.now();
  const runs = await Promise.all(runnable.map(async (v) => {
    const argv = v.build(ctx);
    const res  = await runOne(v.script, argv, opts.validatorTimeoutMs);
    const elapsedMs = res.elapsedMs;
    let envelope = null;
    if (res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        envelope = normaliseEnvelope(parsed);
      } catch (e) { envelope = { error: `JSON parse failed: ${e.message}` }; }
    } else if (!res.ok) {
      envelope = { error: res.error || 'spawn failure' };
    } else {
      envelope = { error: `Empty stdout (exit ${res.exitCode}); stderr: ${res.stderr?.slice(0,200)}` };
    }
    return {
      name: v.name, ILRef: v.ILRef, kind: v.kind,
      elapsedMs,
      envelope,
      stderr: res.stderr || '',
      exitCode: res.exitCode,
    };
  }));
  const elapsedMs = Date.now() - tStart;

  // Convert validator runs into the aggregator's input shape.
  const perValidator = runs.map((r) => {
    if (r.envelope && r.envelope.error) {
      return {
        name: r.name, ILRef: r.ILRef, kind: r.kind,
        blocking: [{
          severity: 'blocker',
          key: 'validator-failed',
          message: `Validator '${r.name}' failed: ${r.envelope.error}`,
          ref: r.ILRef,
          details: { exitCode: r.exitCode, stderr: r.stderr },
          remediation: 'Re-run the validator standalone with the same inputs to inspect the error.',
        }],
        warnings: [], info: [],
      };
    }
    return {
      name: r.name, ILRef: r.ILRef, kind: r.kind,
      blocking: r.envelope?.blocking || [],
      warnings: r.envelope?.warnings || [],
      info:     r.envelope?.info     || [],
    };
  });

  // Surface info findings for skipped validators (so the user knows nothing
  // silently dropped). 'config-incomplete' is the catch-all key.
  for (const sk of skipped) {
    perValidator.push({
      name: sk.name, ILRef: sk.ILRef, kind: sk.kind,
      blocking: [], warnings: [],
      info: [{
        severity: 'info',
        key: 'validator-skipped',
        message: `Skipped '${sk.name}' (missing ${sk.kind === 'http' ? 'envUrl' : (sk.needsSolutionUniqueName ? 'solutionUniqueName' : 'config')}).`,
        ref: sk.ILRef,
        details: { reason: sk.kind === 'http' && !opts.envUrl ? 'no envUrl' : 'no solutionUniqueName' },
        remediation: 'Pass --envUrl / --solutionUniqueName to re-enable this validator.',
      }],
    });
  }

  const agg = aggregateResults(perValidator);

  const lastValidationPath = innerLoopPath(projectRoot, 'lastValidation');
  const delta = opts.computeDelta ? computeDelta(agg, lastValidationPath) : { prior: null, deltas: null };

  const validatorTimings = opts.captureTimings
    ? Object.fromEntries(runs.map((r) => [r.name, r.elapsedMs]))
    : null;

  const report = {
    skill: 'git-sync',
    mode: 'dry-run',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    envUrl: opts.envUrl,
    envFriendlyName: opts.envFriendlyName,
    solutionUniqueName,
    pendingChangesCount: items.length,
    status: agg.status,
    blockers: agg.blockers,
    warnings: agg.warnings,
    infos: agg.infos,
    perValidator,
    validatorTimings,
    delta,
    componentsByType,
    elapsedMs,
    docsBaseUrl: opts.docsBaseUrl,
    verbose: opts.verbose === true,
    // Carry forward last-committed solution version across runs.
    lastCommittedSolutionVersion: null,
  };

  // Preserve lastCommittedSolutionVersion if the prior file had one (the
  // git-sync commit flow updates it post-commit).
  if (fs.existsSync(lastValidationPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(lastValidationPath, 'utf8'));
      if (prior.lastCommittedSolutionVersion) report.lastCommittedSolutionVersion = prior.lastCommittedSolutionVersion;
    } catch { /* tolerate */ }
  }

  // Always write JSON marker + HTML report.
  fs.writeFileSync(lastValidationPath, JSON.stringify(report, null, 2), 'utf8');
  const htmlPath = innerLoopPath(projectRoot, 'preCommitReportHtml');
  fs.writeFileSync(htmlPath, renderHtmlReport(report), 'utf8');

  // Format-specific extras.
  if (opts.format === 'junit') {
    const xml = emitJUnit(report);
    fs.writeFileSync(innerLoopPath(projectRoot, 'lastValidationJunit'), xml, 'utf8');
  } else if (opts.format === 'sarif') {
    fs.writeFileSync(innerLoopPath(projectRoot, 'lastValidationSarif'), emitSarif(report), 'utf8');
  }

  return {
    report,
    artifacts: {
      lastValidationJson: lastValidationPath,
      preCommitReportHtml: htmlPath,
      lastValidationJunit: opts.format === 'junit' ? innerLoopPath(projectRoot, 'lastValidationJunit') : null,
      lastValidationSarif: opts.format === 'sarif' ? innerLoopPath(projectRoot, 'lastValidationSarif') : null,
    },
  };
}

function defaultOpts() {
  return {
    pendingFile: null, manifestFile: null,
    envUrl: null, token: null, solutionUniqueName: null,
    format: 'json', outDir: null, projectRoot: null,
    envFriendlyName: null,
    captureTimings: true, computeDelta: true,
    validatorTimeoutMs: 60000,
    quiet: false, verbose: false,
    docsBaseUrl: process.env.POWER_PAGES_DOCS_BASE_URL || null,
  };
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  runPrevalidators(opts)
    .then((r) => {
      if (r && r.error) {
        process.stderr.write('run-prevalidators: ' + r.error + '\n');
        process.exit(1);
      }
      if (opts.format === 'text') {
        process.stdout.write(emitText(r.report));
      } else if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(r.report, null, 2) + '\n');
      } else if (opts.format === 'junit') {
        process.stdout.write(emitJUnit(r.report));
      } else if (opts.format === 'sarif') {
        process.stdout.write(emitSarif(r.report));
      }
      process.exit(r.report.status === 'blocked' ? 2 : 0);
    })
    .catch((e) => {
      process.stderr.write('run-prevalidators: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = {
  runPrevalidators,
  VALIDATORS,
  normaliseEnvelope,
  normaliseFinding,
  aggregateResults,
  collapseFindings,
  computeDelta,
  emitText,
  emitJUnit,
  emitSarif,
  renderHtmlReport,
  buildHelpUri,
  ilRefToAnchor,
  ruleId,
  xmlEscape,
  htmlEscape,
};

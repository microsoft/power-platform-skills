'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');

const orch = require('../lib/run-prevalidators');
const {
  normaliseEnvelope, normaliseFinding, aggregateResults, computeDelta,
  emitText, emitJUnit, emitSarif, renderHtmlReport, buildHelpUri,
  ilRefToAnchor, ruleId, xmlEscape, htmlEscape,
  VALIDATORS, runPrevalidators,
} = orch;

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-prevalidators-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('VALIDATORS catalog: every entry has the required shape', () => {
  assert.ok(Array.isArray(VALIDATORS) && VALIDATORS.length > 0);
  for (const v of VALIDATORS) {
    assert.equal(typeof v.name, 'string', `name on ${JSON.stringify(v)}`);
    assert.ok(/^validate-|^check-/.test(v.name), `name '${v.name}' should start with validate-/check-`);
    assert.equal(typeof v.script, 'string');
    assert.ok(fs.existsSync(v.script), `script for '${v.name}' must exist on disk`);
    assert.ok(['pure', 'http'].includes(v.kind));
    assert.equal(typeof v.build, 'function');
    // build() requires at least pendingFile to be a string
    const argv = v.build({ pendingFile: 'p.json', manifestFile: 'm.json', envUrl: 'https://x.crm.dynamics.com', token: 't', solutionUniqueName: 's', projectRoot: '/tmp' });
    assert.ok(Array.isArray(argv));
  }
});

test('normaliseEnvelope passes through standard shape', () => {
  const e = normaliseEnvelope({ ok: true, totalChecked: 3, blocking: [], warnings: [{ key: 'w1' }], info: [] });
  assert.equal(e.ok, true);
  assert.equal(e.totalChecked, 3);
  assert.equal(e.warnings.length, 1);
});

test('normaliseEnvelope: missing arrays default to empty', () => {
  const e = normaliseEnvelope({ ok: true });
  assert.deepEqual(e.blocking, []);
  assert.deepEqual(e.warnings, []);
  assert.deepEqual(e.info, []);
});

test('normaliseEnvelope: ok derives from blocking count when omitted', () => {
  const e = normaliseEnvelope({ blocking: [{ key: 'x' }] });
  assert.equal(e.ok, false);
});

test('normaliseEnvelope: surfaces error from validator', () => {
  const e = normaliseEnvelope({ error: 'auth failed', statusCode: 401 });
  assert.equal(e.error, 'auth failed');
  assert.equal(e.statusCode, 401);
});

test('normaliseFinding fills severity + fallback IL ref', () => {
  const f = normaliseFinding({ key: 'k', message: 'm' }, 'warn', 'IL-007');
  assert.equal(f.severity, 'warn');
  assert.equal(f.ref, 'IL-007');
  assert.equal(f.key, 'k');
});

test('normaliseFinding: keeps explicit severity & ref over defaults', () => {
  const f = normaliseFinding({ severity: 'blocker', ref: 'IL-009', message: 'm' }, 'warn', 'IL-XXX');
  assert.equal(f.severity, 'blocker');
  assert.equal(f.ref, 'IL-009');
});

test('aggregateResults: status passed/warnings/blocked transitions', () => {
  assert.equal(aggregateResults([{ name: 'v', blocking: [], warnings: [], info: [] }]).status, 'passed');
  assert.equal(aggregateResults([{ name: 'v', blocking: [], warnings: [{ key: 'w' }], info: [] }]).status, 'warnings');
  assert.equal(aggregateResults([{ name: 'v', blocking: [{ key: 'b' }], warnings: [], info: [] }]).status, 'blocked');
});

test('aggregateResults: attaches validator name to each finding', () => {
  const out = aggregateResults([{ name: 'v-1', ILRef: 'IL-006', blocking: [{ key: 'k' }], warnings: [], info: [] }]);
  assert.equal(out.blockers[0].validator, 'v-1');
  assert.equal(out.blockers[0].ref, 'IL-006');
});

test('computeDelta: returns null when no prior file exists', () => {
  const d = computeDelta({ blockers: [{}, {}], warnings: [], infos: [] }, '/nope/last.json');
  assert.deepEqual(d, { prior: null, deltas: null });
});

test('computeDelta: returns signed deltas vs prior counts', (t) => {
  const dir = tmp(t);
  const priorPath = path.join(dir, 'prior.json');
  fs.writeFileSync(priorPath, JSON.stringify({ blockers: [{}], warnings: [{}, {}], infos: [] }), 'utf8');
  const d = computeDelta({ blockers: [{}, {}, {}], warnings: [{}], infos: [{}, {}] }, priorPath);
  assert.deepEqual(d.deltas, { blockers: 2, warnings: -1, infos: 2 });
});

test('emitText: produces the 5-line summary', () => {
  const txt = emitText({
    status: 'blocked',
    blockers: [{}], warnings: [], infos: [],
    validatorTimings: { 'v-1': 10, 'v-2': 20 },
    elapsedMs: 42,
  });
  assert.match(txt, /BLOCKED/);
  assert.match(txt, /Blockers:\s+1/);
  assert.match(txt, /Warnings:\s+0/);
  assert.match(txt, /Elapsed:\s+42ms/);
});

test('emitJUnit: well-formed XML with testsuite per validator', () => {
  const xml = emitJUnit({
    generatedAt: '2026-06-12T00:00:00Z',
    elapsedMs: 100,
    blockers: [{ key: 'b1', message: 'msg', ref: 'IL-009', validator: 'v-A', details: {} }],
    warnings: [], infos: [],
    perValidator: [
      { name: 'v-A', blocking: [{ key: 'b1', message: 'msg', ref: 'IL-009' }], warnings: [], info: [] },
      { name: 'v-B', blocking: [], warnings: [{ key: 'w1', message: 'm' }], info: [] },
    ],
    validatorTimings: { 'v-A': 30, 'v-B': 40 },
  });
  assert.match(xml, /<\?xml version="1\.0"/);
  assert.match(xml, /<testsuite name="v-A"/);
  assert.match(xml, /<testsuite name="v-B"/);
  assert.match(xml, /<failure type="IL-009"/);
});

test('emitJUnit: escapes special XML characters in messages', () => {
  const xml = emitJUnit({
    generatedAt: '2026-06-12T00:00:00Z',
    elapsedMs: 1,
    blockers: [], warnings: [], infos: [],
    perValidator: [{ name: 'v', blocking: [{ key: '<x>', message: '"&" <bad>' }], warnings: [], info: [] }],
    validatorTimings: { v: 1 },
  });
  assert.match(xml, /&quot;&amp;&quot; &lt;bad&gt;/);
});

test('emitSarif: returns valid JSON with required SARIF skeleton', () => {
  const out = emitSarif({
    blockers: [{ key: 'b', message: 'M', ref: 'IL-019', validator: 'v', details: { x: 1 } }],
    warnings: [], infos: [],
    docsBaseUrl: null,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.version, '2.1.0');
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].results[0].ruleId, 'PP-VALIDATE-IL-019');
  assert.equal(parsed.runs[0].results[0].level, 'error');
});

test('emitSarif: maps blocker→error, warn→warning, info→note', () => {
  const out = JSON.parse(emitSarif({
    blockers: [{ key: 'b', message: 'B', ref: 'IL-006', validator: 'v' }],
    warnings: [{ key: 'w', message: 'W', ref: 'IL-007', validator: 'v' }],
    infos:    [{ key: 'i', message: 'I', ref: null,     validator: 'v' }],
  }));
  const levels = out.runs[0].results.map((r) => r.level);
  assert.deepEqual(levels, ['error', 'warning', 'note']);
});

test('ruleId: prefers IL ref, falls back to validator+key', () => {
  assert.equal(ruleId({ ref: 'IL-009' }), 'PP-VALIDATE-IL-009');
  assert.equal(ruleId({ validator: 'v-x', key: 'k1' }), 'PP-VALIDATE-v-x-k1');
});

test('ilRefToAnchor: lowercases and prefixes pattern-il-', () => {
  assert.equal(ilRefToAnchor('IL-008'), 'pattern-il-008');
  assert.equal(ilRefToAnchor('IL-019'), 'pattern-il-019');
});

test('buildHelpUri: uses configured base URL when provided', () => {
  assert.match(buildHelpUri('IL-008', 'https://docs.example.com'),
    /^https:\/\/docs\.example\.com\/inner-loop-error-catalog\.md#pattern-il-008$/);
});

test('buildHelpUri: falls back to relative path when base URL omitted', () => {
  assert.match(buildHelpUri('IL-008', null),
    /^\.\.\/references\/inner-loop-error-catalog\.md#pattern-il-008$/);
});

test('xmlEscape / htmlEscape: handles undefined and reserved chars', () => {
  assert.equal(xmlEscape(undefined), '');
  assert.equal(xmlEscape('<a&b>'), '&lt;a&amp;b&gt;');
  assert.equal(htmlEscape('<a&b>'), '&lt;a&amp;b&gt;');
});

test('renderHtmlReport: contains badges, IL hyperlinks, breakdown, timings, delta', () => {
  const html = renderHtmlReport({
    skill: 'commit-to-git',
    mode: 'dry-run',
    generatedAt: '2026-06-12T00:00:00Z',
    envUrl: 'https://o.crm.dynamics.com',
    solutionUniqueName: 'InternLearning',
    status: 'blocked',
    pendingChangesCount: 44,
    blockers: [{ key: 'orphan', message: 'orphan row', ref: 'IL-019', validator: 'v-orphan' }],
    warnings: [], infos: [],
    componentsByType: { Attribute: 19, Entity: 6 },
    validatorTimings: { 'v-orphan': 12, 'v-conflict': 9 },
    delta: { prior: { blockers: 0, warnings: 0, infos: 0 }, deltas: { blockers: 1, warnings: 0, infos: 0 } },
    docsBaseUrl: null,
  });
  assert.match(html, /badge-blocker/);
  assert.match(html, /pattern-il-019/);
  assert.match(html, /Components by type/);
  assert.match(html, /Validator timings/);
  assert.match(html, /Since previous run/);
});

test('runPrevalidators: returns error when --pending-file is missing', async () => {
  const r = await runPrevalidators({});
  assert.match(r.error, /--pending-file is required/);
});

test('runPrevalidators: returns error when snapshot file does not exist', async (t) => {
  const dir = tmp(t);
  const r = await runPrevalidators({ pendingFile: path.join(dir, 'nope.json') });
  assert.match(r.error, /Snapshot not found/);
});

test('runPrevalidators: runs end-to-end with mock snapshot, emits json + html + skipped infos', async (t) => {
  const dir = tmp(t);
  const snap = { items: [
    { componentType: 'Entity',    componentpath: '/x/y/Account.xml' },
    { componentType: 'Attribute', componentpath: '/x/y/name.xml' },
  ], pendingChangesCount: 2 };
  const snapPath = path.join(dir, 'snap.json');
  fs.writeFileSync(snapPath, JSON.stringify(snap), 'utf8');

  // Run without envUrl so HTTP validators are skipped (info findings).
  const r = await runPrevalidators({
    pendingFile: snapPath,
    projectRoot: dir,
    outDir:      dir,
    format:      'json',
    captureTimings: true,
    computeDelta: false,
  });

  assert.ok(r.report);
  assert.ok(r.report.perValidator.length > 0);
  // componentsByType derived from snapshot.
  assert.equal(r.report.componentsByType.Entity, 1);
  assert.equal(r.report.componentsByType.Attribute, 1);
  // Pure validators ran; HTTP-skipped ones became info findings.
  const skippedInfos = r.report.infos.filter((i) => i.key === 'validator-skipped');
  assert.ok(skippedInfos.length >= 1, 'expected at least one HTTP validator to be marked skipped');
  // Artifacts written.
  assert.ok(fs.existsSync(r.artifacts.lastValidationJson));
  assert.ok(fs.existsSync(r.artifacts.preCommitReportHtml));
});

test('runPrevalidators: preserves lastCommittedSolutionVersion across runs', async (t) => {
  const dir = tmp(t);
  const snapPath = path.join(dir, 'snap.json');
  fs.writeFileSync(snapPath, JSON.stringify({ items: [] }), 'utf8');

  // Seed prior last-validation.json with a baseline version.
  const innerLoop = path.join(dir, 'docs', 'inner-loop');
  fs.mkdirSync(innerLoop, { recursive: true });
  fs.writeFileSync(path.join(innerLoop, 'last-validation.json'),
    JSON.stringify({ lastCommittedSolutionVersion: '1.2.3.4' }), 'utf8');

  const r = await runPrevalidators({
    pendingFile: snapPath,
    projectRoot: dir,
    outDir:      dir,
    format:      'json',
    computeDelta: true,
  });
  assert.equal(r.report.lastCommittedSolutionVersion, '1.2.3.4');
});

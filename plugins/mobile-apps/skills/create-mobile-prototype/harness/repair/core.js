'use strict';

const fs = require('node:fs');
const path = require('node:path');
const registry = require('../registry');
const staticGate = require('../static/run');
const events = require('../../runtime/events');

function metadata() {
  return new Map(registry.load().map((entry) => [entry.id, entry]));
}

function normalize(finding, entries = metadata()) {
  const entry = entries.get(finding.id) || {};
  return {
    ...finding,
    class: finding.class || entry.class,
    file: finding.file || 'app',
    line: Number.isInteger(finding.line) ? finding.line : 1,
    actual: String(finding.actual || 'requirement not met'),
    expected: String(finding.expected || entry.rule || 'registered requirement'),
    screenshot: finding.screenshot || null,
    state: finding.state || 'OPEN',
  };
}

function collectStatic(projectDir) {
  const entries = metadata();
  return staticGate.collect(projectDir).flatMap((filePath) => staticGate.lintFile(filePath, projectDir)).map((finding) => normalize(finding, entries));
}

function collectBrowser(projectDir, report = '.tmp/prototype-harness-findings.json') {
  const filePath = path.resolve(projectDir, report);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return (parsed.findings || []).map((finding) => normalize(finding));
}

function collectAll(projectDir, report) {
  return [...collectStatic(projectDir), ...collectBrowser(projectDir, report)];
}

function evidence(finding) {
  const normalized = normalize(finding);
  return {
    file: normalized.file,
    line: normalized.line,
    actual: normalized.actual,
    expected: normalized.expected,
    screenshot: normalized.screenshot,
  };
}

function shape(finding) {
  const normalized = normalize(finding);
  return `${normalized.id}\u0000${normalized.file}\u0000${normalized.expected}`;
}

function assessRound(previous, next, completedRounds) {
  const before = previous.map((finding) => normalize(finding));
  const after = next.map((finding) => normalize(finding));
  const rounds = completedRounds + 1;
  if (after.length === 0) return { status: 'complete', rounds, findings: [] };
  const priorShapes = new Set(before.map(shape));
  const reshaped = after.some((finding) => !priorShapes.has(shape(finding)));
  if (reshaped) return { status: 'stopped', reason: 'findings-reshaped', rounds, findings: after };
  if (after.length >= before.length) return { status: 'stopped', reason: 'findings-did-not-reduce', rounds, findings: after };
  if (rounds >= 2) return { status: 'stopped', reason: 'round-limit', rounds, findings: after };
  return { status: 'continue', rounds, findings: after, request: after.map(evidence) };
}

async function runClassBRounds(initial, repair, collect) {
  let findings = initial.map((finding) => normalize(finding)).filter((finding) => finding.class === 'B');
  let rounds = 0;
  while (findings.length > 0 && rounds < 2) {
    await repair(findings.map(evidence), rounds + 1);
    const next = (await collect()).map((finding) => normalize(finding)).filter((finding) => finding.class === 'B');
    const assessed = assessRound(findings, next, rounds);
    rounds = assessed.rounds;
    findings = assessed.findings;
    if (assessed.status !== 'continue') return assessed;
  }
  return { status: findings.length === 0 ? 'complete' : 'stopped', reason: findings.length ? 'round-limit' : undefined, rounds, findings };
}

function emitOpen(projectDir, findings) {
  const prior = new Set(events.readEvents(projectDir).filter((event) => event.kind === 'finding' && event.state === 'OPEN').map((event) => `${event.id}\u0000${event.file}\u0000${event.actual}\u0000${event.expected}`));
  const emitted = [];
  for (const finding of findings.map((item) => normalize(item))) {
    const key = `${finding.id}\u0000${finding.file}\u0000${finding.actual}\u0000${finding.expected}`;
    if (prior.has(key)) continue;
    emitted.push(events.append(projectDir, { kind: 'finding', ...finding, state: 'OPEN' }));
    prior.add(key);
  }
  return emitted;
}

module.exports = { assessRound, collectAll, collectBrowser, collectStatic, emitOpen, evidence, normalize, runClassBRounds, shape };
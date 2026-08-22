#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyClassA } = require('./ast');
const core = require('./core');

function args(argv) {
  const command = argv[0];
  const projectIndex = argv.indexOf('--project');
  const reportIndex = argv.indexOf('--report');
  if (!command || projectIndex < 0 || !argv[projectIndex + 1]) throw new Error('usage: run.js <class-a|prepare-b|assess-b> --project <dir> [--report <json>]');
  return { command, projectDir: path.resolve(argv[projectIndex + 1]), report: reportIndex >= 0 ? argv[reportIndex + 1] : undefined };
}

function files(projectDir) {
  const directory = path.join(projectDir, '.mobile-build');
  return { directory, state: path.join(directory, 'repair-state.json'), request: path.join(directory, 'repair-request.json') };
}

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function classA(options) {
  const before = core.collectStatic(options.projectDir).filter((finding) => finding.class === 'A');
  const repair = applyClassA(options.projectDir, before);
  const unresolved = core.collectStatic(options.projectDir).filter((finding) => finding.class === 'A');
  core.emitOpen(options.projectDir, unresolved);
  return { repair, unresolved: unresolved.length };
}

function prepareB(options) {
  const target = files(options.projectDir);
  const all = core.collectAll(options.projectDir, options.report);
  core.emitOpen(options.projectDir, all.filter((finding) => finding.class === 'A'));
  const findings = all.filter((finding) => finding.class === 'B');
  const state = { rounds: 0, findings };
  write(target.state, state);
  write(target.request, { round: 1, findings: findings.map(core.evidence) });
  return { status: findings.length ? 'repair' : 'complete', request: target.request, findings: findings.length };
}

function assessB(options) {
  const target = files(options.projectDir);
  if (!fs.existsSync(target.state)) throw new Error('repair state is missing; run prepare-b first');
  const prior = JSON.parse(fs.readFileSync(target.state, 'utf8'));
  const next = core.collectAll(options.projectDir, options.report).filter((finding) => finding.class === 'B');
  const assessed = core.assessRound(prior.findings, next, prior.rounds);
  write(target.state, { rounds: assessed.rounds, findings: assessed.findings, status: assessed.status, reason: assessed.reason });
  if (assessed.status === 'continue') write(target.request, { round: assessed.rounds + 1, findings: assessed.request });
  else core.emitOpen(options.projectDir, assessed.findings);
  return { ...assessed, request: assessed.status === 'continue' ? target.request : null };
}

function main() {
  try {
    const options = args(process.argv.slice(2));
    const result = options.command === 'class-a' ? classA(options) : options.command === 'prepare-b' ? prepareB(options) : options.command === 'assess-b' ? assessB(options) : (() => { throw new Error(`unknown command ${options.command}`); })();
    console.log(JSON.stringify(result, null, 2));
    if (result.repair?.ok === false) process.exitCode = 2;
  } catch (error) {
    console.error(`prototype-repair: ${error.message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { args, assessB, classA, files, prepareB };
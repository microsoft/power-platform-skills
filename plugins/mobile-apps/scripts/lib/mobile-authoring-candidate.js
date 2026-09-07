'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const protocol = require('./authoring-protocol');
const { fileToRoute } = require('../validate-navigation-layout');
const { digest, canonicalJson, inside, readJson, atomicWrite, journalPath } = require('./mobile-authoring-files');
const { requiresAuthoringCheck, registeredReadyScreenIds } = require('./mobile-authoring-registration');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function candidateMode(root) {
  const persistence = readJson(root, '.tmp/persistence-contract.json');
  if (persistence.mode === 'local-prototype' && fs.existsSync(path.join(root, '.tmp/prototype-profile.json'))
    && readJson(root, '.tmp/prototype-profile.json').profile === 'connector') {
    require('./prototype-connector-startup').verifyPrototypeConnectorStartup(root);
    return 'connector-only';
  }
  return protocol.enumeration({
    'local-prototype': 'prototype', dataverse: 'dataverse', mixed: 'mixed', 'connector-only': 'connector-only',
  }[persistence.mode], ['prototype', 'dataverse', 'mixed', 'connector-only'], 'candidate data mode');
}

function readyFiles(root, source, readyScreenIds) {
  if (!Array.isArray(readyScreenIds) || !readyScreenIds.length
    || new Set(readyScreenIds).size !== readyScreenIds.length) {
    throw new Error('A candidate requires unique ready screen IDs');
  }
  const compiled = readJson(root, '.tmp/compiled-screen-build-pack.json');
  if (compiled.contractType !== 'compiled-screen-build-pack' || !Array.isArray(compiled.screens)) {
    throw new Error('A candidate requires compiled screen packs');
  }
  return readyScreenIds.map((screenId) => {
    protocol.id(screenId, 'ready screen ID');
    const pack = compiled.screens.find((entry) => entry.screenId === screenId);
    if (!pack || !pack.route) throw new Error('A ready screen must name a compiled screen and route');
    const files = source.files.filter((file) => file.path.startsWith('app/') && file.path.endsWith('.tsx')
      && fileToRoute(path.join(root, file.path), path.join(root, 'app')) === pack.route);
    if (files.length !== 1) throw new Error('A ready screen requires one unambiguous existing route file');
    return files[0].path;
  });
}

function runCandidateChecks(root, screenFiles, { run = spawnSync } = {}) {
  const compiler = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(compiler)) throw new Error('The app TypeScript compiler is missing; restore the existing app dependencies before validation');
  const policyFiles = require('./authoring-source').captureSource(root).files.map((entry) => entry.path)
    .filter((file) => /\.(?:ts|tsx)$/.test(file) && !file.startsWith('src/generated/')
      && (file.startsWith('src/') || !file.includes('/')
        || (file.startsWith('app/') && (file.endsWith('/_layout.tsx') || screenFiles.includes(file)))));
  const checks = [
    ['typescript', [compiler, '--noEmit', '--incremental', 'false']],
    ['compiled-contracts', [path.join(PLUGIN_ROOT, 'scripts/compile-screen-build-pack.js'), '--project-root', root, '--check']],
    ...(requiresAuthoringCheck(root) ? [['authoring-registration', [
      path.join(PLUGIN_ROOT, 'scripts/configure-prototype-authoring.js'), '--project-root', root, '--check',
      ...registeredReadyScreenIds(root, screenFiles).flatMap((id) => ['--ready-screen', id]),
    ]]] : []),
    ['route-contracts', [path.join(PLUGIN_ROOT, 'scripts/check-routes.js'), '--quiet']],
    ['navigation-layout', [path.join(PLUGIN_ROOT, 'scripts/validate-navigation-layout.js'), '--project-root', root]],
    ['changed-file-policy', [path.join(PLUGIN_ROOT, 'scripts/validate-mobile-files.js'), '--project-root', root,
      ...policyFiles.flatMap((file) => ['--file', file])]],
    ['screen-quality', [path.join(PLUGIN_ROOT, 'hooks/validate-screen-quality.js'), '--report', ...screenFiles.map((file) => inside(root, file))]],
    ['color-contrast', [path.join(PLUGIN_ROOT, 'hooks/validate-color-contrast.js'), '--report', ...screenFiles.map((file) => inside(root, file))]],
  ];
  const env = { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: '1' };
  delete env.MOBILE_AUTHORING_RUNNER_TOKEN;
  delete env.MOBILE_AUTHORING_CONTEXT;
  const completed = [];
  for (const [name, args] of checks) {
    const result = run(process.execPath, args, {
      cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (result.status !== 0 || result.error || result.signal) {
      // Tool output can include user paths and source. Do not copy it into a
      // maker event or a decision receipt; the foreground reruns this fixed
      // named gate locally to diagnose its failure.
      throw new Error(`Candidate readiness failed at ${name}; diagnose and rerun that existing gate`);
    }
    if (['screen-quality', 'color-contrast'].includes(name)) {
      let report;
      try { report = JSON.parse(result.stdout); } catch { throw new Error(`Candidate readiness returned an invalid ${name} report`); }
      if (!Array.isArray(report.issues) || report.issues.length) {
        throw new Error(`Candidate readiness found ${name} issues; resolve the report before publication`);
      }
    }
    completed.push(name);
  }
  return completed;
}

async function prepareCandidate(client, { readyScreenIds, final = false, validate = runCandidateChecks } = {}) {
  await client.verify({ refresh: true });
  const { descriptor } = client;
  const root = descriptor.workspaceDir;
  const { captureSource } = require('./authoring-source');
  const before = captureSource(root);
  const screenFiles = readyFiles(root, before, readyScreenIds);
  const checks = validate(root, screenFiles);
  const after = captureSource(root);
  if (before.revision !== after.revision) throw new Error('Candidate source changed during readiness validation');
  const candidate = protocol.assertCandidate({
    id: `candidate-${digest(canonicalJson({
      jobId: descriptor.jobId, attemptId: descriptor.attemptId,
      sourceRevision: after.revision, readyScreenIds, final,
    })).slice(0, 40)}`,
    baseRevision: descriptor.baseRevision,
    sourceRevision: after.revision,
    dataMode: candidateMode(root), readyScreenIds, checks, final,
  });
  const localPath = journalPath(descriptor, `candidates/${candidate.id}.json`);
  atomicWrite(root, localPath, { schemaVersion: 1, candidate, screenFiles });
  await client.submitCandidate(candidate);
  return { status: 'submitted', candidate, receiptPath: localPath, applied: false };
}

module.exports = { candidateMode, readyFiles, runCandidateChecks, prepareCandidate };

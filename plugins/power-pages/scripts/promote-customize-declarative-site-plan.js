#!/usr/bin/env node
/**
 * Publish one approved customization-plan JSON document.
 *
 * The canonical HTML is always rendered from the validated JSON in this process. This
 * prevents an unrelated or stale browser document from being paired with approved data.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./lib/render-template');
const {
  canonicalPlanJson,
  createExecutionReceipt,
  createRunId,
  customizationPaths,
  hashText,
  planHash,
  validateCustomizationPlan,
  writeFileAtomic,
  writeJsonAtomic,
} = require('./lib/customize-declarative-site-plan');
const {
  renderCustomizationPlan,
} = require('./render-customize-declarative-site-plan');

function main() {
  const args = parseArgs(process.argv);
  if (!args.projectRoot || !args.data) {
    console.error(
      'Usage: node promote-customize-declarative-site-plan.js ' +
        '--projectRoot <path> --data <approved-json>'
    );
    process.exit(1);
  }

  try {
    const result = publishApprovedPlan({
      projectRoot: path.resolve(args.projectRoot),
      dataPath: path.resolve(args.data),
    });
    console.log(JSON.stringify({ status: 'ok', ...result }));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function publishApprovedPlan({ projectRoot, dataPath, now = new Date() }) {
  if (!fs.existsSync(dataPath) || !fs.statSync(dataPath).isFile()) {
    throw new Error(`Approved JSON file not found: ${dataPath}`);
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    throw new Error(`Approved JSON file is not valid JSON: ${dataPath}`);
  }
  validateCustomizationPlan(plan);

  const paths = customizationPaths(projectRoot);
  const existing = inspectCurrentArtifacts(paths);
  fs.mkdirSync(paths.root, { recursive: true });

  const runId = createRunId(now);
  const planText = canonicalPlanJson(plan);
  const hash = planHash(plan);
  const tempHtml = path.join(paths.root, `.current-plan.${runId}.html`);

  try {
    renderCustomizationPlan(plan, tempHtml, {
      copyIcon: false,
      emitStatus: false,
    });
    const htmlText = fs.readFileSync(tempHtml, 'utf8');
    const execution = createExecutionReceipt(plan, runId, hash, now);
    execution.artifactHashes = {
      planSha256: hash,
      htmlSha256: hashText(htmlText),
    };

    let archivePath = null;
    if (existing.present) {
      archivePath = archiveCurrentArtifacts(paths, existing, now);
    }

    // JSON and execution state are atomic individually, and the HTML is derived from the
    // JSON immediately beforehand. A crash between renames can be repaired by publishing
    // the same approved JSON again; no unvalidated source can become canonical.
    writeFileAtomic(paths.currentHtml, htmlText);
    writeFileAtomic(paths.currentJson, planText);
    writeJsonAtomic(paths.currentExecution, execution);
    copySharedIcon(paths.currentIcon);

    return {
      runId,
      planHash: hash,
      currentJson: paths.currentJson,
      currentHtml: paths.currentHtml,
      currentExecution: paths.currentExecution,
      archivedPreviousPlan: archivePath,
    };
  } finally {
    try {
      fs.unlinkSync(tempHtml);
    } catch {}
  }
}

function inspectCurrentArtifacts(paths) {
  const hasJson = fs.existsSync(paths.currentJson);
  const hasHtml = fs.existsSync(paths.currentHtml);
  const hasExecution = fs.existsSync(paths.currentExecution);
  if (hasJson !== hasHtml) {
    throw new Error(
      'Canonical plan is incomplete: current-plan.json and current-plan.html must both exist'
    );
  }
  if (!hasJson && hasExecution) {
    throw new Error('Canonical execution receipt exists without a current plan');
  }
  if (!hasJson) return { present: false, hasExecution: false };

  let currentPlan;
  try {
    currentPlan = JSON.parse(fs.readFileSync(paths.currentJson, 'utf8'));
  } catch {
    throw new Error('Canonical current-plan.json is not valid JSON');
  }
  validateCustomizationPlan(currentPlan);
  if (fs.statSync(paths.currentHtml).size === 0) {
    throw new Error('Canonical current-plan.html is empty');
  }

  return { present: true, hasExecution };
}

function archiveCurrentArtifacts(paths, existing, now) {
  fs.mkdirSync(paths.historyRoot, { recursive: true });
  const archivePath = reserveArchiveDirectory(paths.historyRoot, now);
  fs.copyFileSync(paths.currentJson, path.join(archivePath, 'plan.json'));
  fs.copyFileSync(paths.currentHtml, path.join(archivePath, 'plan.html'));
  if (existing.hasExecution) {
    fs.copyFileSync(paths.currentExecution, path.join(archivePath, 'execution.json'));
  }
  if (fs.existsSync(paths.currentIcon)) {
    fs.copyFileSync(paths.currentIcon, path.join(archivePath, 'power-pages-icon.png'));
  }
  return archivePath;
}

function reserveArchiveDirectory(historyRoot, now) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? timestamp : `${timestamp}-${suffix}`;
    const candidate = path.join(historyRoot, name);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function copySharedIcon(destination) {
  const source = path.join(
    __dirname,
    '..',
    'skills',
    'create-site',
    'assets',
    'shared',
    'power-pages-icon.png'
  );
  if (!fs.existsSync(source)) {
    throw new Error(`Shared Power Pages icon not found: ${source}`);
  }
  fs.copyFileSync(source, destination);
}

if (require.main === module) main();

module.exports = {
  archiveCurrentArtifacts,
  inspectCurrentArtifacts,
  publishApprovedPlan,
  reserveArchiveDirectory,
};

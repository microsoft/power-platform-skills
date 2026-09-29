'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePackageBin, runNodeScript } = require('./node-tool.js');
const { findManifests, parseManifest } = require('./pcf-manifest.js');
const { loadMatrix } = require('./pcf-matrix.js');

const DEFAULT_OUT_DIR = path.join('out', 'controls');
const DEFAULT_LIMIT_BYTES = 5 * 1024 * 1024;

function findControlProject(dir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  let current = pathDep.resolve(String(dir || process.cwd()));
  try {
    if (fsDep.existsSync(current) && fsDep.statSync(current).isFile()) current = pathDep.dirname(current);
  } catch {
    return { error: `Cannot inspect PCF project path '${dir}'.` };
  }

  while (true) {
    const entries = safeReaddir(fsDep, current);
    const projects = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.pcfproj'))
      .map((entry) => pathDep.join(current, entry.name))
      .sort();
    if (projects.length > 0) {
      const packageJson = pathDep.join(current, 'package.json');
      if (!fileExists(fsDep, packageJson)) {
        return { error: `Found ${pathDep.basename(projects[0])} in ${current}, but package.json is missing. Run this from a PCF control project or restore package.json.` };
      }
      const manifests = (deps.findManifests || findManifests)(current, { fs: fsDep, path: pathDep });
      if (!manifests.length) {
        return { error: `Found ${pathDep.basename(projects[0])} in ${current}, but no ControlManifest.Input.xml files were found. Add a PCF manifest before building.` };
      }
      return { projectDir: current, pcfproj: projects[0], manifests, packageJson };
    }

    const parent = pathDep.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { error: `No *.pcfproj file was found at or above '${dir}'. Run from inside a PCF control project or pass --project <dir>.` };
}

function buildControl({ projectDir, mode = 'production', clean = true } = {}, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const run = deps.runNodeScript || runNodeScript;
  const resolveBin = deps.resolvePackageBin || resolvePackageBin;
  const resolvedProjectDir = pathDep.resolve(String(projectDir || process.cwd()));
  let outRoot;
  try {
    outRoot = resolveOutRoot(resolvedProjectDir, { fs: fsDep, path: pathDep });
  } catch (err) {
    return {
      ok: false,
      mode,
      controls: [],
      stdout: '',
      stderr: '',
      error: String(err && err.message ? err.message : err),
    };
  }
  const scriptPath = resolveBin(resolvedProjectDir, 'pcf-scripts', 'pcf-scripts');

  if (!scriptPath) {
    return {
      ok: false,
      mode,
      controls: [],
      stdout: '',
      stderr: '',
      error: 'pcf-scripts is not installed. Run npm ci in the PCF project, then retry the build.',
    };
  }

  if (clean) {
    fsDep.rmSync(outRoot, { recursive: true, force: true });
  }

  const executed = run(scriptPath, ['build', '--buildMode', mode], {
    cwd: resolvedProjectDir,
    shell: false,
  });
  const controls = readBuiltControls(outRoot, { fs: fsDep, path: pathDep });
  const ok = (executed.status === 0 || executed.status === undefined) && !executed.error && !pcfScriptsFailed(executed);
  return {
    ok,
    mode,
    controls,
    stdout: executed.stdout || '',
    stderr: executed.stderr || '',
    ...(ok ? {} : { error: buildError(executed) }),
  };
}

function bundleFindings(result, matrix = loadMatrix()) {
  const findings = [];
  const mode = result && result.mode ? result.mode : 'production';
  const limits = (matrix && matrix.bundle) || {};
  const maxBytes = Number(limits.webpackDefaultMaxBytes) || DEFAULT_LIMIT_BYTES;
  const warnAtFraction = Number(limits.warnAtFraction) || 0.8;
  const warnBytes = Math.floor(maxBytes * warnAtFraction);

  if (mode === 'development') {
    findings.push({
      code: 'PCF_BUILD_DEV_MODE',
      severity: 'warning',
      message: 'The PCF control was built in development mode, which is not suitable for deployment.',
      fix: 'Build with --mode production before deploying.',
    });
  }

  for (const control of (result && result.controls) || []) {
    const label = control.manifestPath || control.controlDir || 'control';
    if (control.bundleBytes > maxBytes) {
      findings.push({
        code: 'PCF_BUNDLE_OVER_LIMIT',
        severity: 'error',
        message: `${label} bundle is ${formatBytes(control.bundleBytes)}, over the 5 MiB webpack default (${formatBytes(maxBytes)}) and likely to exceed the Dataverse organization MaxUploadFileSize setting.`,
        fix: 'Reduce the bundle, split heavy assets out of the control, and verify the target organization MaxUploadFileSize can accept the upload.',
      });
    } else if (control.bundleBytes >= warnBytes) {
      findings.push({
        code: 'PCF_BUNDLE_NEAR_LIMIT',
        severity: 'warning',
        message: `${label} bundle is ${formatBytes(control.bundleBytes)}, near the 5 MiB webpack default (${formatBytes(maxBytes)}); also verify the target organization MaxUploadFileSize setting before deploy.`,
        fix: 'Reduce bundle size before it crosses the webpack default and Dataverse upload limits.',
      });
    }

    for (const item of control.unexplained || control.stray || []) {
      findings.push({
        code: 'PCF_OUT_UNEXPLAINED_FILE',
        severity: 'warning',
        message: `${item.path} is present in the processed PCF output but is not declared by the manifest and is not a localized resx, preview image, or *.LICENSE.txt sidecar.`,
        fix: 'Remove the file from the build output, declare it as a manifest resource, or exclude it from the bundler output before deploy.',
      });
    }
  }

  return findings;
}

function resolveOutRoot(projectDir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const resolvedProjectDir = pathDep.resolve(projectDir);
  const configFile = pathDep.join(projectDir, 'pcfconfig.json');
  let rawOutDir = DEFAULT_OUT_DIR;
  if (fileExists(fsDep, configFile)) {
    try {
      const parsed = JSON.parse(fsDep.readFileSync(configFile, 'utf8'));
      if (parsed && typeof parsed.outDir === 'string' && parsed.outDir.trim()) {
        rawOutDir = parsed.outDir;
      }
    } catch {
      rawOutDir = DEFAULT_OUT_DIR;
    }
  }
  const resolvedOutRoot = pathDep.resolve(resolvedProjectDir, rawOutDir);
  assertInsideProject(resolvedProjectDir, resolvedOutRoot, rawOutDir, pathDep);
  return resolvedOutRoot;
}

function assertInsideProject(projectDir, targetDir, rawOutDir, pathDep = path) {
  // `pcfconfig.json` is user-controlled and has the raw shape `{ "outDir": "../somewhere" }`.
  // Clean builds delete the resolved outDir before invoking pcf-scripts, so require a STRICT child
  // of the project (not the project itself and not an ancestor/sibling) before any caller can read
  // or remove it. Windows file systems are usually case-insensitive, so compare canonical strings
  // case-insensitively when using win32-style paths.
  const project = comparablePath(pathDep.resolve(projectDir), pathDep);
  const target = comparablePath(pathDep.resolve(targetDir), pathDep);
  const relative = pathDep.relative(project, target);
  const comparableRelative = comparablePath(relative, pathDep);
  if (
    !relative
    || comparableRelative === '..'
    || comparableRelative.startsWith(`..${pathDep.sep}`)
    || pathDep.isAbsolute(relative)
  ) {
    throw new Error(`pcfconfig.json outDir '${rawOutDir}' must resolve inside the PCF project as a strict child folder. Set outDir to a child folder such as '${DEFAULT_OUT_DIR}' before running build clean or output classification.`);
  }
}

function comparablePath(value, pathDep) {
  const text = String(value || '');
  return pathDep.sep === '\\' ? text.toLowerCase() : text;
}

function readBuiltControls(outRoot, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  if (!fileExists(fsDep, outRoot)) return [];
  return safeReaddir(fsDep, outRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => readBuiltControl(pathDep.join(outRoot, entry.name), deps))
    .filter(Boolean);
}

function readBuiltControl(controlDir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const manifestPath = pathDep.join(controlDir, 'ControlManifest.xml');
  if (!fileExists(fsDep, manifestPath)) return null;

  // pcf-scripts writes the processed manifest under the configured outDir as:
  //   out/controls/<ControlName>/ControlManifest.xml
  //   out/controls/<ControlName>/bundle.js
  // The processed manifest is the deployment contract, so classify output against its resource
  // paths rather than the source ControlManifest.Input.xml where `index.ts` has not yet become the
  // bundled JavaScript artifact.
  const parsed = parseManifest(fsDep.readFileSync(manifestPath, 'utf8'));
  const referenced = manifestReferences(parsed.model);
  const files = classifyOutputDirectory(controlDir, parsed.model.resources, deps)
    .filter((file) => normalizeRel(file.path) !== 'ControlManifest.xml')
    .map((file) => ({ ...file, path: pathDep.resolve(controlDir, file.path) }));
  const unexplained = files.filter((item) => item.classification === 'unexplained');
  const bundleBytes = referenced
    .filter((rel) => /\.(?:js|jsx|ts|tsx)$/i.test(rel))
    .map((rel) => pathDep.join(controlDir, rel))
    .filter((file) => fileExists(fsDep, file))
    .reduce((sum, file) => sum + fsDep.statSync(file).size, 0);

  return {
    controlDir,
    manifestPath,
    files,
    referenced,
    unexplained,
    stray: unexplained.map((item) => item.path),
    bundleBytes,
  };
}

function manifestReferences(model) {
  return resourcePaths((model && model.resources) || {});
}

/**
 * Classifies processed PCF output files using the A28 packer categories.
 *
 * @param {object} manifestResources parseManifest(...).model.resources, with code/css/resx/img
 *        arrays whose items carry `path`.
 * @param {(string|{path:string, bytes?:number})[]} files directory listing relative to
 *        out/controls/<ControlName>. Absolute paths are accepted when `baseDir` is supplied.
 * @param {object} [opts]
 * @param {string} [opts.baseDir] base directory used to relativize absolute file paths.
 * @param {object} [opts.path] injectable path module for tests.
 * @returns {{path:string, bytes?:number, classification:'explicit'|'localizedResx'|'previewImage'|'legalSidecar'|'unexplained'}[]}
 */
function classifyOutputFiles(manifestResources, files, opts = {}) {
  const pathDep = opts.path || path;
  const resources = manifestResources && manifestResources.resources ? manifestResources.resources : (manifestResources || {});
  const referenced = resourcePaths(resources);
  const referenceSet = new Set(referenced.map(normalizeRel));
  const declaredResx = new Set((resources.resx || []).map((item) => normalizeRel(item.path)));
  return (files || []).map((item) => {
    const originalPath = typeof item === 'string' ? item : item.path;
    const rel = relativeOutputPath(originalPath, opts.baseDir, pathDep);
    return {
      ...(typeof item === 'string' ? {} : item),
      path: rel,
      classification: classifyOutputFile(rel, referenceSet, declaredResx),
    };
  });
}

function classifyOutputDirectory(controlDir, manifestResources, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const files = walkFiles(controlDir, deps).map((file) => ({
    path: pathDep.relative(controlDir, file),
    bytes: fsDep.statSync(file).size,
  }));
  return classifyOutputFiles(manifestResources, files, { baseDir: controlDir, path: pathDep });
}

function resourcePaths(resources) {
  return ['code', 'css', 'resx', 'img']
    .flatMap((kind) => resources[kind] || [])
    .map((item) => normalizeRel(item.path))
    .filter(Boolean);
}

function relativeOutputPath(filePath, baseDir, pathDep) {
  if (!baseDir || !pathDep.isAbsolute(String(filePath || ''))) return normalizeRel(filePath);
  return normalizeRel(pathDep.relative(baseDir, filePath));
}

function classifyOutputFile(rel, referenceSet, declaredResx) {
  const normalized = normalizeRel(rel);
  if (referenceSet.has(normalized)) return 'explicit';
  if (isLocalizedResxSibling(normalized, declaredResx)) return 'localizedResx';
  if (/preview\.(?:png|jpg|jpeg|gif|svg)$/i.test(path.posix.basename(normalized))) return 'previewImage';
  if (/\.LICENSE\.txt$/i.test(normalized)) return 'legalSidecar';
  return 'unexplained';
}

function isLocalizedResxSibling(rel, declaredResx) {
  const match = /^(.*)\.(\d{4})\.resx$/i.exec(rel);
  if (!match) return false;
  const stem = match[1];
  for (const declared of declaredResx) {
    const declaredStem = declared.replace(/(?:\.\d{4})?\.resx$/i, '');
    if (declaredStem === stem) return true;
  }
  return false;
}

function walkFiles(dir, deps = {}) {
  const fsDep = deps.fs || fs;
  const pathDep = deps.path || path;
  const files = [];
  const walk = (current) => {
    for (const entry of safeReaddir(fsDep, current)) {
      const full = pathDep.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files;
}

function safeReaddir(fsDep, dir) {
  try {
    return fsDep.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

function fileExists(fsDep, file) {
  try {
    return fsDep.existsSync(file);
  } catch {
    return false;
  }
}

function buildError(result) {
  if (result && result.error) return String(result.error.message || result.error);
  const detail = [result && result.stderr, result && result.stdout].filter(Boolean).join('\n').trim();
  return detail || 'pcf-scripts build failed.';
}

function pcfScriptsFailed(result) {
  // pcf-scripts can report semantic failure in stdout/stderr even when a wrapper process exits 0:
  //   [build] Failed:
  //   [pcf-1041] [Error] Not a valid sub-command 'production'
  // Treat those raw shapes as failures so quality gates do not publish an "ok" result for a build
  // that the Microsoft PCF toolchain itself rejected.
  const text = [result && result.stdout, result && result.stderr].filter(Boolean).join('\n');
  return /\[(?:build|lint)\]\s+Failed:/i.test(text) || /\[pcf-\d+\]\s+\[Error\]/i.test(text);
}

function normalizeRel(value) {
  return String(value || '').replace(/\\/g, '/');
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
}

module.exports = {
  findControlProject,
  buildControl,
  bundleFindings,
  resolveOutRoot,
  classifyOutputFiles,
  classifyOutputDirectory,
  classifyOutputFile,
  pcfScriptsFailed,
};

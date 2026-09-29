'use strict';

const fs = require('node:fs');
const path = require('node:path');

function repoRoot() { return path.join(__dirname, '..', '..', '..', '..'); }
function pluginLib(name) { return require(path.join(repoRoot(), 'plugins', 'model-apps', 'scripts', 'lib', name)); }

const { validateIntent, lintBindingIntent, renderPlanMarkdown } = pluginLib('pcf-intent.js');
const { parseManifest, lintManifest, diffManifests, findManifests } = pluginLib('pcf-manifest.js');
const { gateSources } = pluginLib('pcf-code-gate.js');
const { verifyBinding } = pluginLib('pcf-binding-verify.js');
const { collectProject, checkProject, hasErrors } = pluginLib('pcf-doctor.js');
const { planUpgrade } = pluginLib('pcf-upgrade.js');
const { loadMatrix } = pluginLib('pcf-matrix.js');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function codes(items, key) { return (items || []).map((item) => item && item[key]).filter(Boolean); }
function mergeFindings(...groups) { return groups.flat().filter(Boolean); }

function collectSources(dir) {
  const sources = [];
  const skip = new Set(['node_modules', 'out', 'obj', 'bin', 'generated']);
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path.join(current, entry.name));
      } else if (/\.[jt]sx?$/.test(entry.name)) {
        const file = path.join(current, entry.name);
        sources.push({ file: path.relative(dir, file), text: readText(file) });
      }
    }
  };
  walk(dir);
  return sources.sort((a, b) => a.file.localeCompare(b.file));
}

function firstManifestModel(dir) {
  const manifestFiles = findManifests(dir);
  if (!manifestFiles.length) return { model: null, parseErrors: [] };
  const parsed = parseManifest(readText(manifestFiles[0]));
  return { model: parsed.model, parseErrors: parsed.errors, manifestPath: manifestFiles[0] };
}

function planSections(markdown) {
  return String(markdown || '').split(/\r?\n/).filter((line) => /^##\s+/.test(line)).map((line) => line.replace(/^##\s+/, '').trim());
}

async function intentFacts(fixtureDir, ev = {}) {
  const intent = readJson(path.join(fixtureDir, 'pcf-intent.json'));
  const validationErrors = validateIntent(intent);
  const lint = lintBindingIntent(intent, { manifestModel: ev.manifestModel || null, matrix: loadMatrix() });
  const markdown = renderPlanMarkdown(intent, { lint });
  const findings = lint.slice();
  return {
    family: 'intent',
    ok: validationErrors.length === 0 && !findings.some((f) => f.severity === 'error'),
    valid: validationErrors.length === 0,
    validationErrors,
    findings,
    allCodes: codes(findings, 'code'),
    hosts: intent.hosts || [],
    template: intent.control && intent.control.template,
    planSections: planSections(markdown),
  };
}

async function manifestFacts(fixtureDir, ev = {}) {
  const hosts = ev.hosts || ['model'];
  const before = path.join(fixtureDir, 'before.xml');
  const after = path.join(fixtureDir, 'after.xml');
  let model;
  let parseErrors = [];
  let lint = { ok: true, errors: [], warnings: [] };
  let diff = { breaking: [], compatible: [] };
  if (fs.existsSync(before) && fs.existsSync(after)) {
    const b = parseManifest(readText(before));
    const a = parseManifest(readText(after));
    parseErrors = [...b.errors, ...a.errors];
    model = a.model;
    lint = lintManifest(a.model, { hosts, matrix: loadMatrix() });
    diff = diffManifests(b.model, a.model);
  } else {
    const found = firstManifestModel(fixtureDir);
    model = found.model || { control: {}, properties: [], resources: { code: [], platformLibraries: [] }, features: [] };
    parseErrors = found.parseErrors || [];
    lint = lintManifest(model, { hosts, matrix: loadMatrix() });
  }
  const findings = mergeFindings(parseErrors, lint.errors, lint.warnings, diff.breaking, diff.compatible);
  return { family: 'manifest', ok: parseErrors.length === 0 && lint.ok && diff.breaking.length === 0, model, lint, diff, findings, allCodes: codes(findings, 'code') };
}

async function codeFacts(fixtureDir, ev = {}) {
  const hosts = ev.hosts || ['model'];
  const { model, parseErrors } = firstManifestModel(fixtureDir);
  const gate = gateSources({ manifestModel: model || { features: [] }, sources: collectSources(fixtureDir), hosts });
  const findings = mergeFindings(parseErrors, gate.errors, gate.warnings);
  return { family: 'code', ok: parseErrors.length === 0 && gate.ok, errors: gate.errors, warnings: gate.warnings, findings, allCodes: codes(findings, 'code') };
}

async function formXmlFacts(fixtureDir) {
  const binding = readJson(path.join(fixtureDir, 'binding.json'));
  const result = verifyBinding(readText(path.join(fixtureDir, 'form.xml')), binding);
  const findings = result.issues || [];
  return { family: 'formxml', ok: result.ok, status: result.status, issues: findings, findings, allCodes: codes(findings, 'code') };
}

async function doctorFacts(fixtureDir, ev = {}) {
  const state = collectProject(fixtureDir);
  const findings = checkProject(state, loadMatrix(), { hosts: ev.hosts || ['model'], needs: ev.needs || [], platform: ev.platform || process.platform });
  return { family: 'doctor', ok: !hasErrors(findings), findings, allCodes: codes(findings, 'id') };
}

async function upgradeFacts(fixtureDir, ev = {}) {
  const state = collectProject(fixtureDir);
  const packageJsonPath = path.join(fixtureDir, 'package.json');
  const pcfproj = fs.readdirSync(fixtureDir).find((name) => /\.pcfproj$/i.test(name));
  state.packageJsonPath = packageJsonPath;
  state.packageJsonText = readText(packageJsonPath);
  state.pcfprojPath = pcfproj ? path.join(fixtureDir, pcfproj) : undefined;
  state.pcfprojText = state.pcfprojPath ? readText(state.pcfprojPath) : state.pcfprojText;
  state.manifestFiles = findManifests(fixtureDir).map((file) => ({ path: file, text: readText(file), model: parseManifest(readText(file)).model }));
  const plan = planUpgrade(state, loadMatrix(), { hosts: ev.hosts || ['model'], platform: ev.platform || process.platform });
  return { family: 'upgrade', ok: true, steps: plan.steps || [], manual: plan.manual || [], stepIds: (plan.steps || []).map((s) => s.id), manualIds: (plan.manual || []).map((m) => m.id), allCodes: [] };
}

async function generatedFacts(fixtureDir, ev = {}) {
  const mf = await manifestFacts(fixtureDir, ev);
  const cf = await codeFacts(fixtureDir, ev);
  const findings = mergeFindings(mf.findings, cf.findings);
  const optional = { build: 'skipped (node_modules absent)', lint: 'skipped (node_modules absent)', test: 'skipped (node_modules absent)' };
  if (fs.existsSync(path.join(fixtureDir, 'node_modules'))) {
    optional.build = 'not-run by offline harness';
    optional.lint = 'not-run by offline harness';
    optional.test = 'not-run by offline harness';
  }
  return { family: 'generated', ok: mf.ok && cf.ok, manifest: mf, code: cf, errors: [...mf.findings, ...cf.errors].filter((f) => (f.severity || f.level) === 'error'), warnings: [...cf.warnings, ...mf.findings].filter((f) => (f.severity || f.level) === 'warning'), findings, allCodes: codes(findings, 'code'), optional };
}

async function computeFacts(ev) {
  const fixtureDir = ev.fixtureDir || ev.fixture;
  if (!fixtureDir) throw new Error('fixture path is required');
  if (ev.family === 'intent') return intentFacts(fixtureDir, ev);
  if (ev.family === 'manifest') return manifestFacts(fixtureDir, ev);
  if (ev.family === 'code') return codeFacts(fixtureDir, ev);
  if (ev.family === 'formxml') return formXmlFacts(fixtureDir, ev);
  if (ev.family === 'doctor') return doctorFacts(fixtureDir, ev);
  if (ev.family === 'upgrade') return upgradeFacts(fixtureDir, ev);
  if (ev.family === 'generated') return generatedFacts(fixtureDir, ev);
  throw new Error('unknown PCF eval family: ' + ev.family);
}

module.exports = { computeFacts, collectSources };


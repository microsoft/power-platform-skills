#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags } = require('./lib/dataverse-auth.js');
const { resolvePackageBin, runNodeScript } = require('./lib/node-tool.js');
const { loadMatrix } = require('./lib/pcf-matrix.js');
const { findControlProject, buildControl, bundleFindings, pcfScriptsFailed } = require('./lib/pcf-build.js');
const { parseManifest, lintManifest } = require('./lib/pcf-manifest.js');
const { gateSources } = require('./lib/pcf-code-gate.js');

const USAGE = `Usage:
  node scripts/pcf-gates.js --project <dir> [--hosts model,pages] [--skip lint,test,build]`;

const KNOWN = ['project', 'hosts', 'skip'];
const NEED_VALUE = ['project', 'hosts', 'skip'];
const GATE_IDS = ['manifest', 'code', 'lint', 'test', 'build'];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

function emitCliResult(ok, payload) {
  if (ok) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  }
  if (payload instanceof Error) {
    process.stderr.write(`${payload.message}\n`);
  } else if (payload && typeof payload === 'object') {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (typeof payload.error === 'string') process.stderr.write(`${payload.error}\n`);
    else process.stderr.write('Operation failed; see stdout JSON\n');
  } else {
    process.stderr.write(`${String(payload)}\n`);
  }
  process.exit(1);
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: {
      hosts: 'comma-separated values: model,pages',
      skip: 'comma-separated values: lint,test,build',
    },
  });
  if (flagError) usageError(flagError);
  const { flags } = parsed;
  if (!flags.project) usageError('--project is required');

  const hosts = splitCsv(flags.hosts || 'model');
  const unknownHost = hosts.find((host) => !['model', 'pages'].includes(host));
  if (unknownHost) usageError(`--hosts contains unknown value '${unknownHost}' (expected model,pages)`);
  const skip = new Set(splitCsv(flags.skip || ''));
  const unknownSkip = [...skip].find((gate) => !['lint', 'test', 'build'].includes(gate));
  if (unknownSkip) usageError(`--skip contains unknown value '${unknownSkip}' (expected lint,test,build)`);

  const found = findControlProject(path.resolve(String(flags.project)));
  if (found.error) {
    emitCliResult(false, { ok: false, gates: [], error: found.error });
    return;
  }

  const matrix = loadMatrix();
  const gates = [];
  const manifestGate = runManifestGate(found.manifests, hosts, matrix);
  gates.push(manifestGate.gate);
  if (manifestGate.parseError) {
    emitCliResult(false, { ok: false, projectDir: found.projectDir, gates });
    return;
  }

  gates.push(runCodeGate(found.projectDir, manifestGate.models, hosts));
  if (!skip.has('lint')) gates.push(runToolGate('lint', found.projectDir, 'pcf-scripts', 'pcf-scripts', ['lint']));
  if (!skip.has('test')) gates.push(runTestGate(found.projectDir, manifestGate.models));
  if (!skip.has('build')) gates.push(runBuildGate(found.projectDir, matrix));

  const ok = gates.every((gate) => gate.ok);
  emitCliResult(ok, { ok, projectDir: found.projectDir, gates });
}

function runManifestGate(manifests, hosts, matrix) {
  const findings = [];
  const models = [];
  let parseError = false;
  for (const manifest of manifests) {
    const parsed = parseManifest(fs.readFileSync(manifest, 'utf8'));
    if (parsed.errors.length) {
      parseError = true;
      findings.push(...parsed.errors.map((finding) => withFile(finding, manifest)));
      continue;
    }
    models.push({ manifest, model: parsed.model });
    const linted = lintManifest(parsed.model, { hosts, matrix });
    findings.push(...linted.errors.map((finding) => withFile(finding, manifest)));
    findings.push(...linted.warnings.map((finding) => withFile(finding, manifest)));
  }
  return { parseError, models, gate: gateFromFindings('manifest', findings) };
}

function runCodeGate(projectDir, models, hosts) {
  const findings = [];
  for (const item of models) {
    const sources = readSources(path.dirname(item.manifest), projectDir);
    const gated = gateSources({ manifestModel: item.model, sources, hosts });
    findings.push(...[...gated.errors, ...gated.warnings].map((finding) => ({
      ...finding,
      fix: finding.fix || 'Change the PCF source to use supported framework APIs, then rerun the quality gates.',
    })));
  }
  return gateFromFindings('code', findings);
}

function runTestGate(projectDir, models) {
  const controlDirs = models.map((item) => path.dirname(item.manifest));
  const missingGeneratedTypes = controlDirs.filter((dir) => !fs.existsSync(path.join(dir, 'generated', 'ManifestTypes.d.ts')));
  if (missingGeneratedTypes.length > 0) {
    const pcfBin = resolvePackageBin(projectDir, 'pcf-scripts', 'pcf-scripts');
    if (!pcfBin) {
      return gateFromFindings('test', [{
        code: 'PCF_TEST_TYPES_MISSING',
        severity: 'error',
        message: 'Unit tests need generated ManifestTypes.d.ts, but pcf-scripts is not installed to generate them.',
        fix: 'Run npm ci in the PCF project, then rerun the quality gates.',
      }]);
    }
    const prepared = runNodeScript(pcfBin, ['build', '--buildMode', 'development'], { cwd: projectDir, shell: false });
    if (!toolSucceeded(prepared)) {
      return gateFromFindings('test', [{
        code: 'PCF_TEST_PREP_FAILED',
        severity: 'error',
        message: `test preparation failed while generating ManifestTypes.d.ts: ${toolDetail(prepared)}`,
        fix: 'Fix the pcf-scripts build errors that prevent generated test types, then rerun the quality gates.',
      }], summarizeTool(prepared));
    }
  }
  return runToolGate('test', projectDir, 'jest', 'jest', ['--ci', '--config', 'jest.config.cjs', '--runInBand']);
}

function runToolGate(id, projectDir, pkgName, binName, args) {
  const bin = resolvePackageBin(projectDir, pkgName, binName);
  if (!bin) {
    return gateFromFindings(id, [{
      code: `PCF_${id.toUpperCase()}_TOOL_MISSING`,
      severity: 'error',
      message: `${binName} is not installed in this PCF project.`,
      fix: 'Run npm ci in the PCF project, then retry the quality gates.',
    }]);
  }

  const result = runNodeScript(bin, args, { cwd: projectDir, shell: false });
  if (toolSucceeded(result)) {
    return { id, ok: true, summary: summarizeTool(result) };
  }
  return gateFromFindings(id, [{
    code: `PCF_${id.toUpperCase()}_FAILED`,
    severity: 'error',
    message: `${id} failed: ${toolDetail(result)}`,
    fix: `Fix the ${id} errors reported by the tool, then rerun the PCF quality gates.`,
  }], summarizeTool(result));
}

function toolSucceeded(result) {
  const semanticFailure = typeof pcfScriptsFailed === 'function' ? pcfScriptsFailed(result) : localPcfScriptsFailed(result);
  return (result.status === 0 || result.status === undefined) && !result.error && !semanticFailure;
}

function localPcfScriptsFailed(result) {
  const text = [result && result.stdout, result && result.stderr].filter(Boolean).join('\n');
  return /\[(?:build|lint)\]\s+Failed:/i.test(text) || /\[pcf-\d+\]\s+\[Error\]/i.test(text);
}

function runBuildGate(projectDir, matrix) {
  const result = buildControl({ projectDir, mode: 'production', clean: true });
  const findings = bundleFindings(result, matrix);
  if (!result.ok) {
    findings.unshift({
      code: 'PCF_BUILD_FAILED',
      severity: 'error',
      message: `Production build failed: ${result.error || toolDetail(result)}`,
      fix: 'Fix the build errors from pcf-scripts build, then rerun the PCF quality gates.',
    });
  }
  return gateFromFindings('build', findings, { stdout: result.stdout || '', stderr: result.stderr || '' });
}

function gateFromFindings(id, findings, summary) {
  return {
    id,
    ok: !findings.some((finding) => finding.severity === 'error'),
    ...(findings.length ? { findings } : {}),
    ...(summary ? { summary } : {}),
  };
}

function readSources(controlDir, projectDir) {
  return walkFiles(controlDir)
    .filter((file) => /\.(?:ts|tsx)$/i.test(file))
    .filter((file) => !isTestSource(path.relative(projectDir, file)))
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

function walkFiles(dir) {
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'out', 'obj', 'bin', 'generated', 'coverage'].includes(entry.name)) walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

function isTestSource(rel) {
  const normalized = rel.replace(/\\/g, '/');
  return /(^|\/)(__tests__|test|tests)\//i.test(normalized) || /\.test\.[cm]?[tj]sx?$/i.test(normalized);
}

function withFile(finding, file) {
  return { ...finding, file: finding.file || file };
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toolDetail(result) {
  if (result && result.error) return String(result.error.message || result.error);
  return [result && result.stderr, result && result.stdout].filter(Boolean).join('\n').trim() || 'tool exited with a non-zero status';
}

function summarizeTool(result) {
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status == null ? 0 : result.status };
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emitCliResult(false, err);
  }
}

module.exports = { main };

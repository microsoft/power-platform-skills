#!/usr/bin/env node
// model-app-maker builder: turn a validated App Spec into a model-driven app.
// Deterministic; reuses the dv-* metadata scripts + the vendored cds-maker-kernel
// + the Dataverse Web API. Dry-run by default; --apply writes, --publish publishes.
//
// Usage:
//   node build-model-app.js --env <orgUrl> --spec @app-spec.json [--apply] [--publish] [--preview] [--sample-data]
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateAppSpec, sampleRecordsFor } = require('./lib/app-spec.js');
const { runKernel } = require('./lib/maker-kernel.js');
const { runAll } = require('./lib/build-steps.js');
const { dataverseRequest, parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');

function defaultDeps(env) {
  return {
    runScript: (name, args) => {
      const r = spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0) {
        throw new Error(`${name} failed: ${r.stderr || r.stdout}`);
      }
      return JSON.parse(r.stdout);
    },
    dv: (method, apiPath, body, opts) => dataverseRequest(env, method, apiPath, body, opts || {}),
    kernel: (job) => runKernel(job),
    log: (m) => process.stderr.write(m + '\n'),
  };
}

// Human-readable build plan (used by the dry-run and printed before --apply).
function planFor(spec) {
  const steps = [];
  steps.push(`create-solution ${spec.solution.uniqueName} (publisher ${spec.solution.publisherPrefix})`);
  for (const e of spec.entities) {
    steps.push(`create-table ${e.schemaName} ("${e.displayName}")`);
    for (const c of e.columns || []) {
      steps.push(`add-column ${e.schemaName}.${c.schemaName} (${c.type || 'Text'})`);
    }
  }
  for (const r of spec.relationships || []) {
    steps.push(`create-relationship ${r.type} ${r.referenced}->${r.referencing}`);
  }
  for (const e of spec.entities) {
    const n = sampleRecordsFor(spec, e).length;
    if (n) {
      steps.push(`add ${n} sample record(s) to ${e.schemaName} (requires --sample-data)`);
    }
  }
  for (const v of spec.views) {
    steps.push(`build + create view "${v.name}" for ${v.entity}`);
  }
  for (const c of spec.charts || []) {
    steps.push(`build + create chart "${c.name}" (${c.chartType}) for ${c.entity}`);
  }
  for (const f of spec.forms) {
    const subs = (f.subgrids || []).map((s) => s.childEntity).join(', ');
    steps.push(`build + write main form for ${f.entity}` + (subs ? ` (sub-grids: ${subs})` : ''));
  }
  steps.push(`build sitemap + appmodule "${spec.app.name}" + components`);
  return steps;
}

async function buildModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec);
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  const plan = planFor(spec);
  if (!opts.apply) {
    (deps.log || (() => undefined))('PLAN:\n' + plan.join('\n'));
    return { ok: true, dryRun: true, plan };
  }
  const result = { ok: true, created: {} };
  await runAll(spec, opts, deps, result);
  return result;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write(
      'Usage: node build-model-app.js --env <url> --spec @app-spec.json [--apply] [--publish] [--preview] [--sample-data]\n'
    );
    process.exit(1);
  }
  const spec = readJsonArg(typeof specArg === 'string' && specArg.startsWith('@') ? specArg : '@' + specArg);
  const opts = {
    apply: flags.apply === true,
    publish: flags.publish === true,
    preview: flags.preview === true,
    sampleData: flags['sample-data'] === true,
    env,
  };
  const r = await buildModelApp(spec, opts, defaultDeps(env));
  emitResult(r.ok, r);
}

if (require.main === module) {
  main();
}
module.exports = { buildModelApp, planFor };

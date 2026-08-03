#!/usr/bin/env node
'use strict';
// write-app-spec-doc: render `model-app-plan.md` — the readable design document — from an App Spec.
//
// /app-builder Phase 1 used to write this document freehand from a prose checklist, which produced an
// abbreviated counts summary that drifted from the spec. Rendering it deterministically means the
// document is always complete and always matches what will actually build, and can be regenerated
// after any spec edit.
//
// Usage:
//   node write-app-spec-doc.js --spec @<working-dir>/app-spec.json [--env <orgUrl>] [--out <path>]
//
// Output: { "ok": true, "docPath": "...", "bytes": N, "warnings": [...] }
// `warnings` echoes the design gaps rendered into the document (no jobs, unmapped jobs, no pages) so
// the orchestrator can surface them in chat rather than leaving them buried in a file the user may
// not open.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');
const { renderAppSpecDoc } = require('./lib/app-spec-doc.js');

// The same three gaps the document calls out, returned as data. Kept here (not in the pure renderer)
// because the renderer's contract is "markdown in one string"; the CLI is what talks to the caller.
function designGaps(spec) {
  const out = [];
  const personas = spec.personas || [];
  const jobs = personas.flatMap((p) => (p.jobs || []).map((j) => ({ persona: p.persona, job: j })));
  if (!jobs.length) {
    out.push('no jobs-to-be-done captured (personas[] is empty) — the app has no recorded purpose and will open only for admins');
  }
  const unmapped = jobs.filter(({ job }) => !((job.surfaces || []).length));
  if (unmapped.length) {
    out.push(`${unmapped.length} job(s) not mapped to a surface: ${unmapped.map(({ persona, job }) => `${persona} → ${job.name}`).join('; ')}`);
  }
  if (!(spec.pages || []).length) {
    out.push('no generative pages — per the genpage-first policy, overview/dashboard/analytics/wizard surfaces should be pages');
  }
  return out;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const specArg = str(flags.spec) || (typeof positional[0] === 'string' ? positional[0] : undefined);
  if (!specArg) {
    process.stderr.write('Usage: node scripts/write-app-spec-doc.js --spec @<app-folder>/app-spec.json [--env <orgUrl>] [--out <path>]\n');
    process.exit(1);
  }

  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  let spec;
  try {
    spec = migrateAppSpec(readJsonArg('@' + specPath));
  } catch (e) {
    emitResult(false, new Error(`cannot read app spec at ${specPath}: ${e.message}`));
    return;
  }

  const markdown = renderAppSpecDoc(spec, { envUrl: str(flags.env) });
  // Default next to the spec, which is the working directory the skill created in Phase 0.
  const docPath = str(flags.out) ? path.resolve(str(flags.out)) : path.join(path.dirname(specPath), 'model-app-plan.md');
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, markdown, 'utf8');

  emitResult(true, { ok: true, docPath, bytes: Buffer.byteLength(markdown, 'utf8'), warnings: designGaps(spec) });
}

if (require.main === module) main();

module.exports = { main, designGaps };

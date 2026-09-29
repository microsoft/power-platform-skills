#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { parseManifest } = require('./lib/pcf-manifest.js');
const { validateIntent, lintBindingIntent, renderPlanMarkdown } = require('./lib/pcf-intent.js');

const USAGE = 'Usage: node scripts/write-pcf-plan.js --intent @pcf-intent.json [--manifest ControlManifest.Input.xml] [--out pcf-plan.md]';

function emitPlanResult(ok, payload) {
  if (process === global.process) {
    emitResult(ok, payload);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!ok) process.stderr.write(`${payload.error || 'PCF plan has blocking finding(s); see stdout JSON'}\n`);
  process.exit(ok ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: ['intent', 'manifest', 'out'],
    needValue: ['intent', 'manifest', 'out'],
  });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }

  const intentArg = flags.intent;
  if (!intentArg) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  let intent;
  let intentPath;
  try {
    intentPath = path.resolve(intentArg.startsWith('@') ? intentArg.slice(1) : intentArg);
    intent = readJsonArg(`@${intentPath}`);
  } catch (err) {
    emitPlanResult(false, { ok: false, error: `cannot read PCF intent: ${err.message}` });
    return;
  }

  const schemaErrors = validateIntent(intent);
  let manifestModel;
  if (flags.manifest) {
    const manifestPath = path.resolve(flags.manifest.startsWith('@') ? flags.manifest.slice(1) : flags.manifest);
    try {
      const parsed = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed.errors.length) {
        emitPlanResult(false, { ok: false, out: null, findings: parsed.errors, error: `manifest at ${manifestPath} is invalid` });
        return;
      }
      manifestModel = parsed.model;
    } catch (err) {
      emitPlanResult(false, { ok: false, error: `cannot read PCF manifest: ${err.message}` });
      return;
    }
  }

  const lint = schemaErrors.map((message) => ({
    code: 'PCF_INTENT_SCHEMA',
    severity: 'error',
    message,
    fix: 'Fix pcf-intent.json so it matches schemaVersion 1 before rendering the plan.',
  }));
  if (schemaErrors.length === 0) {
    lint.push(...lintBindingIntent(intent, { manifestModel }));
  }

  const markdown = renderPlanMarkdown(intent, { lint });
  const outPath = flags.out
    ? path.resolve(flags.out)
    : path.join(path.dirname(intentPath), 'pcf-plan.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown, 'utf8');

  const ok = !lint.some((finding) => finding.severity === 'error');
  emitPlanResult(ok, { ok, out: outPath, findings: lint });
}

if (require.main === module) main();

module.exports = { main };

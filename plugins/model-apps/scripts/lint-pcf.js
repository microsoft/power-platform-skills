#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateFlags } = require('./lib/dataverse-auth.js');
const { loadMatrix } = require('./lib/pcf-matrix.js');
const { parseManifest, lintManifest, diffManifests, findManifests } = require('./lib/pcf-manifest.js');

const USAGE = `Usage: node scripts\\lint-pcf.js (--manifest <file> | --project <dir>) [--hosts model,pages] [--against <old manifest>] [--strict]

Lints PCF ControlManifest.Input.xml files and optionally compares one manifest against an older version.`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: ['manifest', 'project', 'hosts', 'against', 'strict'],
    needValue: ['manifest', 'project', 'hosts', 'against'],
    hints: { hosts: 'comma-separated host list: model,pages' },
  });
  if (flagError) return usage(flagError);

  if ((flags.manifest && flags.project) || (!flags.manifest && !flags.project)) {
    return usage('pass exactly one of --manifest <file> or --project <dir>');
  }
  if (flags.against && flags.project) {
    return usage('--against is only supported with --manifest');
  }

  const hosts = String(flags.hosts || 'model').split(',').map((host) => host.trim()).filter(Boolean);
  const unknownHosts = hosts.filter((host) => !['model', 'pages'].includes(host));
  if (unknownHosts.length) return usage(`unknown host(s): ${unknownHosts.join(', ')}; use model and/or pages`);

  const matrix = loadMatrix();
  const manifests = flags.manifest ? [path.resolve(flags.manifest)] : findManifests(path.resolve(flags.project));
  const againstPath = flags.against ? path.resolve(flags.against) : null;
  const before = againstPath ? parseFile(againstPath) : null;
  const results = manifests.map((manifest) => {
    const current = parseFile(manifest);
    const lint = current.parseErrors.length
      ? { ok: false, errors: current.parseErrors, warnings: [] }
      : lintManifest(current.model, { hosts, matrix });
    const result = { manifest, errors: lint.errors, warnings: lint.warnings };
    if (before && before.parseErrors.length) {
      result.errors.push(...before.parseErrors.map((item) => ({
        ...item,
        message: `The --against manifest '${againstPath}' is invalid: ${item.message}`,
      })));
    } else if (before) {
      result.diff = diffManifests(before.model, current.model);
    }
    if (result.diff) {
      result.errors.push(...result.diff.breaking);
      result.warnings.push(...result.diff.compatible);
    }
    return result;
  });

  const hasErrors = results.some((result) => result.errors.length > 0);
  const hasWarnings = results.some((result) => result.warnings.length > 0);
  const ok = !hasErrors && !(flags.strict && hasWarnings);
  return emitJson(ok, { ok, results });
}

function parseFile(file) {
  const parsed = parseManifest(fs.readFileSync(file, 'utf8'));
  return { model: parsed.model, parseErrors: parsed.errors };
}

function usage(message) {
  process.stderr.write(`✗ ${message}\n${USAGE}\n`);
  process.exit(1);
}

function emitJson(ok, payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  if (!ok) process.stderr.write('PCF manifest lint failed; see stdout JSON\n');
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

module.exports = { main };

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('./registry');

function capture() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-check-fixtures-'));
  const destinationDir = path.join(__dirname, 'checks', '__fixtures__');
  const esbuild = require(path.join(registry.PLUGIN_ROOT, 'template', 'node_modules', 'esbuild'));
  fs.mkdirSync(destinationDir, { recursive: true });
  try {
    for (const entry of registry.load().filter((candidate) => candidate.tier === 2)) {
      const outfile = path.join(outputDir, `${entry.module}.cjs`);
      esbuild.buildSync({
        bundle: true,
        entryPoints: [path.join(registry.PLUGIN_ROOT, entry.fixture)],
        format: 'cjs',
        outfile,
        platform: 'node',
      });
      delete require.cache[outfile];
      const fixture = require(outfile).fixture;
      const payload = {
        capturedFrom: entry.fixture,
        ...(fixture.snapshot ? { snapshot: fixture.snapshot } : {}),
        ...(fixture.rendered ? { rendered: fixture.rendered } : {}),
        context: fixture.context || {},
        ...(fixture.expect ? { expect: fixture.expect } : {}),
      };
      fs.writeFileSync(
        path.join(destinationDir, `${entry.module}.bad.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  return registry.load().filter((candidate) => candidate.tier === 2).length;
}

if (require.main === module) console.log(`prototype-harness: captured ${capture()} check fixtures`);

module.exports = { capture };
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, resolveSiteRoot, assertOutsideSite } = require('../../../scripts/lib/classic-site-style-context');
const { buildRuntimeInspection } = require('../../../scripts/lib/runtime-style-context');

function main(argv) {
  const { out, siteRoot, ...options } = parseArgs(argv, ['url', 'selector', 'maxCandidates', 'mode', 'properties', 'out', 'siteRoot']);
  const code = buildRuntimeInspection(options);
  if (!out) {
    if (siteRoot) throw new Error('--siteRoot is only used with --out.');
    return code;
  }
  if (!siteRoot) throw new Error('--siteRoot is required with --out to keep the collector outside the uploadable site tree.');
  const root = resolveSiteRoot(siteRoot);
  const output = assertOutsideSite(root, out);
  if (path.extname(output).toLowerCase() !== '.js') throw new Error('--out must name a new .js collector file.');
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  // The generated function embeds the approved URL, which can contain sensitive
  // query data. Reuse the artifact boundary and never replace an existing capture.
  // File-capable Playwright hosts invoke async(page) in the server process, not
  // the browser. Explicitly evaluate the self-contained collector in the page;
  // this wrapper neither navigates nor loads arbitrary scripts from the portal.
  const fileCode = `async (page) => {\nreturn await page.evaluate(${code});\n}\n`;
  fs.writeFileSync(output, fileCode, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { path: output, bytes: Buffer.byteLength(fileCode, 'utf8') };
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  }
  catch (error) { console.error(`style-site: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };

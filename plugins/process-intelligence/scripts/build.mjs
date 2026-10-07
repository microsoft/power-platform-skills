// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isBuiltin } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/build.mjs');
  const server = path.join(root, 'server');
  if ((await fs.lstat(server)).isSymbolicLink()) throw new Error('Refusing to build through a linked server directory.');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const canonical = await fs.readFile(path.join(root, '.plugin', 'plugin.json'), 'utf8');
  if (canonical !== await fs.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8') ||
      JSON.parse(canonical).version !== manifest.version) throw new Error('Plugin version and byte-identical manifests must agree.');
  const result = await build({ absWorkingDir: root, entryPoints: ['src/entry.mjs'], outfile: 'server/mcp.mjs',
    platform: 'node', format: 'esm', target: 'node22', bundle: true, write: false, metafile: true,
    legalComments: 'inline', charset: 'utf8', logLevel: 'warning',
    banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' }
  });
  for (const output of Object.values(result.metafile.outputs))
    for (const imported of output.imports) if (imported.external && !isBuiltin(imported.path))
      throw new Error('Bundle has an external runtime package dependency.');
  // The installed runtime has no node_modules: carry complete redistribution notices
  // in the bundle itself, including packages whose source omits a license comment.
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const packagePaths = Object.keys(lock.packages).filter(Boolean).sort((a, b) => b.length - a.length);
  const bundled = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, info] of Object.entries(output.inputs)) {
      if (!info.bytesInOutput || !input.startsWith('node_modules/')) continue;
      // esbuild uses paths such as node_modules/a/node_modules/b/index.js; use
      // the longest lockfile prefix so a nested dependency keeps its own notice.
      const packagePath = packagePaths.find(candidate => input.startsWith(candidate + '/'));
      if (!packagePath) throw new Error('Bundled dependency is missing from the lockfile.');
      bundled.add(packagePath);
    }
  }
  const projectLicense = await fs.readFile(path.resolve(root, '..', '..', 'LICENSE'), 'utf8');
  const sections = [`Process Intelligence (MIT)\n\n${projectLicense}`];
  for (const packagePath of [...bundled].sort()) {
    const directory = path.join(root, ...packagePath.split('/'));
    const names = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(entry.name))
      .map(entry => entry.name).sort();
    if (!names.length) throw new Error(`Missing bundled license text: ${packagePath}`);
    for (const name of names) {
      const text = await fs.readFile(path.join(directory, name), 'utf8');
      if (!text.trim()) throw new Error(`Empty bundled license text: ${packagePath}/${name}`);
      sections.push(`${packagePath.split('node_modules/').at(-1)}@${lock.packages[packagePath].version} - ${name}\n\n${text}`);
    }
  }
  const notices = sections.join('\n\n---\n\n');
  if (!projectLicense.trim() || notices.includes('*/'))
    throw new Error('License text is empty or cannot be safely embedded in a JavaScript comment.');
  const contents = Buffer.concat([result.outputFiles[0].contents,
    Buffer.from(`\n/*! Bundled license information:\n\n${notices}\n*/\n`)]);
  result.metafile.outputs['server/mcp.mjs'].bytes = contents.length;
  const files = { 'server/mcp.mjs': contents,
    'server/bundle-meta.json': JSON.stringify(result.metafile, null, 2) + '\n' };
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(root, ...relative.split('/')), temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: 'wx' }); await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  console.error('Built self-contained server/mcp.mjs with embedded license notices. Startup never builds or installs.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

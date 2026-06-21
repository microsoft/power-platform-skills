// Bundles the extension with esbuild. `vscode` is provided by the host and must
// stay external. Produces dist/extension.js (CommonJS, Node platform).
'use strict';

const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[powerpages-merge] watching…');
  } else {
    await esbuild.build(options);
    console.log('[powerpages-merge] build complete');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

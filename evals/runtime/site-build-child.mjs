// Runs in a separate Node process so a hung or crashing bundle cannot stall
// the grader, and so the parent can enforce a timeout and abort signal.
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const [root, outDir] = process.argv.slice(2);
// configFile:false and an inline PostCSS config stop Vite from executing
// agent-authored vite.config.* or postcss.config.* in this process. The
// workspace source is bundled, never run, by Node.
await build({
  root, configFile: false, logLevel: 'error', clearScreen: false,
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  build: { outDir, emptyOutDir: true, reportCompressedSize: false },
});

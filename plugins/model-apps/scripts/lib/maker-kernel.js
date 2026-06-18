// Thin wrapper that invokes the vendored headless cds-maker-kernel bundle
// (a self-contained CJS produced from ppux) as a subprocess: a JSON job on
// stdin, a JSON result on stdout. Keeps the plugin free of any ppux/internal-feed
// dependency.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BUNDLE = path.join(__dirname, '..', 'vendor', 'cds-maker-kernel.cjs');

function runKernel(job, timeoutMs = 30000) {
  const r = spawnSync(process.execPath, [BUNDLE], {
    input: JSON.stringify(job),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { ok: false, error: { code: 'kernel-spawn', message: r.stderr || `exit ${r.status}` } };
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, error: { code: 'kernel-bad-output', message: String(e) + ': ' + r.stdout } };
  }
}

module.exports = { runKernel, BUNDLE };

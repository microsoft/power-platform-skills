import { execFile } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { confinedPath } from './paths.mjs';

const execFileAsync = promisify(execFile);
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

// Offline trials cannot install packages, so the evaluator compiles a generated
// React site against the runtime's pinned copies of the create-site template
// dependencies (react, react-dom, react-router-dom, vite, @vitejs/plugin-react).
// An import outside that set fails the build, which is a genuine site failure.
export async function buildSite({ workDir, root, signal, timeout = 120_000 }) {
  const source = await confinedPath(workDir, root);
  if (!(await stat(source)).isDirectory()) return { ok: false, error: `${root} is not a directory` };
  // macOS tmpdir() is under the /var -> /private/var symlink. Vite compares the
  // root with resolved module paths, so an unresolved root emits ../../ asset
  // names that Rollup rejects.
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'pp-eval-site-')));
  const project = path.join(scratch, 'project');
  const outDir = path.join(scratch, 'dist');
  const cleanup = () => rm(scratch, { recursive: true, force: true });
  try {
    await cp(source, project, {
      recursive: true, dereference: false, verbatimSymlinks: true,
      filter: name => !['node_modules', 'dist'].includes(path.basename(name)),
    });
    // Windows creates directory symlinks only with Developer Mode or elevation;
    // a junction needs neither. Other platforms ignore the type argument.
    await symlink(path.join(runtimeDir, 'node_modules'), path.join(project, 'node_modules'), 'junction');
    await execFileAsync(process.execPath, [path.join(runtimeDir, 'site-build-child.mjs'), project, outDir], {
      cwd: project, timeout, signal, maxBuffer: 2_000_000, windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '', NODE_ENV: 'production',
        ...Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
          .filter(key => process.env[key]).map(key => [key, process.env[key]])),
      },
    });
    return { ok: true, distDir: outDir, cleanup };
  } catch (error) {
    await cleanup();
    if (signal?.aborted) throw error;
    const detail = String(error.stderr || error.message).split('\n')
      .filter(line => line.trim() && !/^\s+at |triggerUncaughtException|^\s*\^\s*$|^node:internal/.test(line))
      .slice(0, 8).join('\n');
    return { ok: false, error: detail };
  }
}

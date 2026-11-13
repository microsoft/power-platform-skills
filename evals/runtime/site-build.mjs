import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { confinedPath } from './paths.mjs';

const execFileAsync = promisify(execFile);
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

// Offline trials cannot install packages, so expose only the create-site
// template's pinned dependencies to the generated project. Each dependency's
// own imports resolve from the runtime's complete dependency tree.
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
    const templateDir = path.join(runtimeDir, '../../plugins/power-pages/skills/create-site/assets/react');
    const template = JSON.parse(await readFile(path.join(templateDir, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...template.dependencies, ...template.devDependencies })) {
      const target = path.join(project, 'node_modules', name);
      await mkdir(path.dirname(target), { recursive: true });
      // Windows junctions do not require Developer Mode or elevation.
      await symlink(path.join(runtimeDir, 'node_modules', name), target, 'junction');
    }
    const options = {
      cwd: project, timeout, signal, maxBuffer: 2_000_000, windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '', NODE_ENV: 'production',
        ...Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
          .filter(key => process.env[key]).map(key => [key, process.env[key]])),
      },
    };
    // Agent-authored tsconfig files can configure compiler outputs outside scratch
    // or skip type checking. Use the template's options and disable all emission.
    const templateConfig = JSON.parse(await readFile(path.join(templateDir, 'tsconfig.json'), 'utf8'));
    const typecheckConfig = path.join(scratch, 'tsconfig.json');
    await writeFile(typecheckConfig, JSON.stringify({
      compilerOptions: {
        ...templateConfig.compilerOptions, allowJs: true, noEmit: true,
        incremental: false, composite: false, typeRoots: [path.join(project, 'node_modules', '@types')],
      },
      include: [path.join(project, 'src')],
    }));
    await execFileAsync(process.execPath, [path.join(runtimeDir, 'node_modules/typescript/bin/tsc'), '--project', typecheckConfig], options);
    await execFileAsync(process.execPath, [path.join(runtimeDir, 'site-build-child.mjs'), project, outDir], options);
    return { ok: true, distDir: outDir, cleanup };
  } catch (error) {
    await cleanup();
    if (signal?.aborted) throw error;
    const detail = String(error.stderr || error.stdout || error.message).split('\n')
      .filter(line => line.trim() && !/^\s+at |triggerUncaughtException|^\s*\^\s*$|^node:internal/.test(line))
      .slice(0, 8).join('\n');
    return { ok: false, error: detail };
  }
}

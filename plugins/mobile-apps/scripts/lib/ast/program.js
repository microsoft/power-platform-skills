'use strict';

/**
 * Builds the single TypeScript `Program` shared by every semantic mobile rule.
 *
 * One Program per dispatcher invocation is a hard requirement, not an
 * optimisation: creating a Program re-reads and re-parses every transitively
 * imported file, so building one per file (or per rule) turns a 12-screen batch
 * into dozens of full parses. Rules therefore receive an already-built
 * `analysis` object and must never construct their own.
 */

const fs = require('node:fs');
const path = require('node:path');

// Instrumentation for the "one Program per batch" contract. The in-process
// counter is what unit tests assert against; the trace file exists because the
// dispatcher spawns the validator as a child process, so an in-memory counter
// is invisible to the parent test. Both are test-only observability and have no
// effect on validation results.
let programBuildCount = 0;

function getProgramBuildCount() {
  return programBuildCount;
}

function resetProgramBuildCount() {
  programBuildCount = 0;
}

function recordProgramBuild(rootNameCount) {
  programBuildCount += 1;
  const tracePath = process.env.MOBILE_AST_PROGRAM_TRACE_FILE;
  if (!tracePath) return;
  try {
    fs.appendFileSync(tracePath, `program-created rootNames=${rootNameCount}\n`);
  } catch {
    // Tracing must never break validation.
  }
}

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.expo', '.git', 'dist', 'build', 'ios', 'android']);

function readJsonWithComments(ts, filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = ts.parseConfigFileTextToJson(filePath, text);
    if (parsed.error) return null;
    return parsed.config || null;
  } catch {
    return null;
  }
}

/**
 * Reads only `baseUrl` and `paths` out of the app's tsconfig.json.
 *
 * Deliberately does NOT run `parseJsonConfigFileContent`: generated apps
 * `extends: "expo/tsconfig.base"`, which cannot be resolved unless the app's
 * `node_modules` is installed. A validator must still work on a freshly
 * scaffolded app, so the base config is ignored and only the alias table — the
 * part that actually affects symbol resolution — is honoured.
 */
function readPathAliases(ts, projectRoot) {
  const configPath = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(configPath)) return { baseUrl: projectRoot, paths: null };
  const config = readJsonWithComments(ts, configPath);
  const compilerOptions = (config && config.compilerOptions) || {};
  const baseUrl = compilerOptions.baseUrl
    ? path.resolve(projectRoot, compilerOptions.baseUrl)
    : projectRoot;
  return { baseUrl, paths: compilerOptions.paths || null };
}

function buildCompilerOptions(ts, projectRoot) {
  const { baseUrl, paths } = readPathAliases(ts, projectRoot);

  // `@/*` is merged into generated apps by /create-mobile-app. Supplying it as a
  // default keeps resolution working on apps prepared before that merge, and
  // any explicit tsconfig entry wins because it is spread last.
  const defaultPaths = {
    '@/*': ['src/*'],
    '@/components': ['src/components/index'],
    '@/hooks': ['src/hooks/index'],
    '@/utils': ['src/utils/index'],
    '@/tokens': ['src/tokens/index'],
    '@/generated/*': ['src/generated/*'],
  };

  const moduleResolution = ts.ModuleResolutionKind.Bundler !== undefined
    ? ts.ModuleResolutionKind.Bundler
    : ts.ModuleResolutionKind.NodeJs;

  return {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    baseUrl,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution,
    noEmit: true,
    // The validator resolves symbols; it never reports type errors. Skipping the
    // default library avoids reading ~10 MB of lib.d.ts per run and removes a
    // dependency on the compiler's lib folder layout.
    noLib: true,
    noResolve: false,
    paths: { ...defaultPaths, ...(paths || {}) },
    resolveJsonModule: true,
    skipDefaultLibCheck: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ESNext,
    types: [],
  };
}

function collectSourceFiles(rootDir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Root names always include the requested targets plus every local `app/` and
 * `src/` source file. Import resolution alone would pull in most of them, but
 * explicit roots make cross-file rules (route contracts, shared component
 * reuse) see files that nothing in the batch imports.
 */
function buildRootNames(projectRoot, files) {
  const roots = new Set(files.map((file) => path.resolve(file)));
  for (const dir of ['app', 'src']) {
    const full = path.join(projectRoot, dir);
    if (fs.existsSync(full)) {
      for (const file of collectSourceFiles(full)) roots.add(file);
    }
  }
  return [...roots];
}

/**
 * @param {{ ts: object, projectRoot: string, files: string[] }} options
 * @returns {{ program: object, checker: object, compilerOptions: object, rootNames: string[] }}
 */
function createProgram({ ts, projectRoot, files }) {
  const compilerOptions = buildCompilerOptions(ts, projectRoot);
  const rootNames = buildRootNames(projectRoot, files);
  const host = ts.createCompilerHost(compilerOptions, /* setParentNodes */ true);
  const program = ts.createProgram(rootNames, compilerOptions, host);
  recordProgramBuild(rootNames.length);
  return { program, checker: program.getTypeChecker(), compilerOptions, rootNames };
}

module.exports = {
  buildCompilerOptions,
  buildRootNames,
  collectSourceFiles,
  createProgram,
  getProgramBuildCount,
  readPathAliases,
  resetProgramBuildCount,
};

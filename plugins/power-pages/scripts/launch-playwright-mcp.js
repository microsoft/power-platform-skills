#!/usr/bin/env node

// Launches the Playwright MCP server with the best available browser.
// Detects system-installed Chromium-based browsers in preference order,
// then falls back to Playwright's bundled Chromium.
// Self-contained — no external dependencies required.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { detectBrowser } = require('./lib/detect-browser');
const { createPrivateTempDir, removeDir, sweepStaleTempDirs } = require('./lib/private-temp-dir');

const PLAYWRIGHT_MCP_VERSION = '0.0.78';
const PLAYWRIGHT_MCP_PACKAGE = `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`;
const OUTPUT_DIR_ENV = 'PLAYWRIGHT_MCP_OUTPUT_DIR';
const OUTPUT_DIR_PREFIX = 'power-pages-playwright-mcp-';
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function buildMcpArgs(browser, {
  configPath = path.join(__dirname, 'playwright-mcp-fullscreen.config.json'),
  outputDir,
} = {}) {
  // Marketplace installs copy only this plugin directory and do not run npm install,
  // so a lockfile would not materialize a local executable. Keep the runtime package
  // immutable, and disable lifecycle scripts while npx prepares the reviewed version.
  const args = [
    '--yes',
    '--ignore-scripts',
    `--package=${PLAYWRIGHT_MCP_PACKAGE}`,
    'playwright-mcp',
    '--browser',
    browser,
    '--config',
    configPath,
  ];
  if (outputDir) {
    args.push('--output-dir', outputDir);
  }
  return args;
}

// Playwright MCP writes screenshots and other output files to `<cwd>/.playwright-mcp`
// by default, and hosts start this server in the user's project directory. create-site
// takes screenshots during design work, so the default would litter the user's project.
// An explicit PLAYWRIGHT_MCP_OUTPUT_DIR is the server's own override, so it wins and is
// left for the server to read; this launcher never deletes it.
function createOutputDir({
  env = process.env,
  mkdtempSync = fs.mkdtempSync,
  tmpdir = os.tmpdir,
} = {}) {
  if (env[OUTPUT_DIR_ENV]) {
    return null;
  }
  return createPrivateTempDir(OUTPUT_DIR_PREFIX, { mkdtempSync, tmpdir });
}

function removeOutputDir(outputDir, { rmSync = fs.rmSync } = {}) {
  removeDir(outputDir, { rmSync });
}

// GitHub Copilot CLI was observed sending SIGTERM and SIGKILL back to back, killing the
// launcher before even a synchronous delete in its SIGTERM handler could run. Each launch
// therefore sweeps directories left by killed sessions. Playwright adds a snapshot or
// screenshot file on every browser action, which moves the directory mtime, so active
// sessions keep a fresh directory. Sweeping an idle live session is harmless: its images
// were already returned to the model, and the server recreates the directory on its next
// write.
function sweepStaleOutputDirs(options = {}) {
  sweepStaleTempDirs(OUTPUT_DIR_PREFIX, options);
}

function resolveNpxCli({
  execPath = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  // Windows exposes npx as a .cmd shim that cannot run with shell:false. Invoking
  // npm's JavaScript entrypoint through Node preserves raw argv on every platform.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const nodeDir = pathApi.dirname(execPath);
  const candidates = [
    pathApi.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    pathApi.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));

  if (!match) {
    throw new Error(
      'Could not locate npm/bin/npx-cli.js beside the current Node installation. Install Node.js with npm before starting the Playwright MCP server.',
    );
  }

  return match;
}

function launch({
  browser = detectBrowser(),
  npxCliPath,
  resolveNpxCliFn = resolveNpxCli,
  spawnFn = spawn,
  exitFn = (code) => process.exit(code),
  writeError = (message) => process.stderr.write(message),
  createOutputDirFn = createOutputDir,
  removeOutputDirFn = removeOutputDir,
  sweepStaleOutputDirsFn = sweepStaleOutputDirs,
  processRef = process,
} = {}) {
  let resolvedNpxCliPath = npxCliPath;
  if (resolvedNpxCliPath === undefined) {
    try {
      resolvedNpxCliPath = resolveNpxCliFn();
    } catch (error) {
      writeError(`Failed to start Playwright MCP: ${error.message}\n`);
      exitFn(1);
      return null;
    }
  }

  // Created only after npx resolves, so a launch that cannot start leaves nothing behind.
  let outputDir = null;
  try {
    sweepStaleOutputDirsFn();
    outputDir = createOutputDirFn();
  } catch (error) {
    // Screenshots still work without the temp directory; they just fall back to the
    // server's default location, so a temp-dir failure must not block the browser tools.
    writeError(`Playwright MCP output will use the server default directory: ${error.message}\n`);
  }

  const child = spawnFn(process.execPath, [resolvedNpxCliPath, ...buildMcpArgs(browser, { outputDir })], {
    stdio: 'inherit',
    shell: false,
  });

  let cleanedUp = false;
  const cleanUp = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      removeOutputDirFn(outputDir);
    }
  };

  // Hosts stop MCP servers by signalling this launcher. Node's default handler would end
  // the launcher at once and orphan both the server and the directory. Hosts that allow a
  // grace period get a prompt cleanup here: remove the directory as soon as the signal
  // arrives (the server is shutting down either way), then forward the signal so the
  // server closes its browser. Hosts that kill without a grace period are covered by
  // sweepStaleOutputDirs on the next launch.
  const onTerminationSignal = (signal) => {
    cleanUp();
    child.kill(signal);
  };
  const removeSignalHandlers = () => {
    for (const signal of FORWARDED_SIGNALS) {
      processRef.removeListener(signal, onTerminationSignal);
    }
  };
  for (const signal of FORWARDED_SIGNALS) {
    processRef.on(signal, onTerminationSignal);
  }

  child.once('error', (error) => {
    writeError(`Failed to start Playwright MCP: ${error.message}\n`);
    removeSignalHandlers();
    cleanUp();
    exitFn(1);
  });
  child.once('exit', (code) => {
    removeSignalHandlers();
    cleanUp();
    exitFn(code ?? 1);
  });
  return child;
}

if (require.main === module) {
  launch();
}

module.exports = {
  OUTPUT_DIR_PREFIX,
  PLAYWRIGHT_MCP_PACKAGE,
  buildMcpArgs,
  createOutputDir,
  launch,
  removeOutputDir,
  resolveNpxCli,
  sweepStaleOutputDirs,
};

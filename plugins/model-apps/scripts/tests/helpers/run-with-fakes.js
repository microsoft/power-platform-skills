'use strict';
// Runs one of the plugin's scripts in a real process against the fake Power Platform (helpers/fake-power-platform-preload.js) and, when the test
// gives one, a fake pac alone on PATH (helpers/fake-pac.js) — or, when it does not, a PATH with no pac and no Azure CLI at all, so a script that
// reaches for either fails there instead of on the developer's machine. Returns what the run printed and what the fakes saw.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installFakePac, envWithOnlyOnPath } = require('./fake-pac.js');

const PRELOAD = path.resolve(__dirname, 'fake-power-platform-preload.js');
const SCRIPTS = path.resolve(__dirname, '..', '..');

/**
 * @param {string} script - a file name under scripts/, e.g. 'connector.js'
 * @param {string[]} argv
 * @param {object} [options]
 * @param {object} [options.platform] - the fake platform's configuration (see the preload)
 * @param {{ responses: object[], launcher?: 'forwarder' }} [options.pac] - the fake pac's responses; without it no pac is on PATH. `launcher: 'forwarder'` (Windows) installs
 *   it the way the MSI does: a two-line pac.cmd that forwards to a native pac.launcher.exe, which the process runner starts directly
 * @param {object} [options.env] - more environment variables
 * @param {object} [options.files] - { name: content } files written into the run's folder before it starts; the script's arguments may name them
 *   by giving a function, called with the folder's path
 * @param {string[]} [options.read] - names of files in the run's folder to read back after the run (null for one that is not there)
 * @returns {{ status: number, stdout: string, stderr: string, lines: string[], requests: object[], state: object, tokenReads: { dataverse: number, powerApps: number }, pacCalls: object[], outputs: object }}
 */
function runScript(script, argv, { platform = {}, pac, env = {}, files = {}, read = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-platform-run-'));
  try {
    const platformFile = path.join(dir, 'platform.json');
    const logFile = path.join(dir, 'platform-log.json');
    fs.writeFileSync(platformFile, JSON.stringify(platform));
    const pacDir = path.join(dir, 'pac-bin');
    fs.mkdirSync(pacDir);
    const fakePac = pac ? installFakePac(pacDir, pac) : null;
    const childEnv = envWithOnlyOnPath(process.env, pacDir, {
      FAKE_PLATFORM: platformFile,
      FAKE_PLATFORM_LOG: logFile,
      ...(fakePac ? { FAKE_PAC_CONFIG: fakePac.configPath, ...fakePac.env } : {}),
      POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1',
      ...env,
    });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    const result = spawnSync(process.execPath, ['--require', PRELOAD, path.join(SCRIPTS, script), ...argv.map((a) => (typeof a === 'function' ? a(dir) : a))], {
      env: childEnv,
      encoding: 'utf8',
      timeout: 120000,
      cwd: dir,
    });
    const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : { requests: [], state: {}, tokenReads: { dataverse: 0, powerApps: 0 } };
    const outputs = {};
    for (const name of read) {
      const file = path.join(dir, name);
      outputs[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      lines: result.stdout.split(/\r?\n/).filter(Boolean),
      requests: log.requests,
      state: log.state,
      tokenReads: log.tokenReads,
      pacCalls: fakePac ? fakePac.calls() : [],
      outputs,
    };
  } finally {
    // What a test needs from the folder has been read into the returned values; nothing in it is needed after the run. Windows can keep a just-run executable (the copy of node.exe
    // that stands in for a native pac launcher) locked for a moment — a scanner reading it — so the removal retries; and it gives up quietly, because a folder left in the OS temp
    // directory must not fail a test that has already passed or failed on its own merits.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* left in the OS temp dir */ }
  }
}

module.exports = { runScript };

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../registry');

const DEVICE_DIR = __dirname;

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const project = value('--project');
  if (!project) throw new Error('usage: device/run.js --project <dir> [--check all] [--device <udid>] [--boot] [--full]');
  return {
    projectDir: path.resolve(project),
    check: value('--check') || 'all',
    contract: value('--contract'),
    device: value('--device'),
    maestro: value('--maestro') || 'maestro',
    boot: argv.includes('--boot'),
    full: argv.includes('--full'),
  };
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function commandAvailable(command, run = execute) {
  const result = run(command, ['--version']);
  return !result.error && result.status === 0;
}

function simulatorDevices(run = execute) {
  const result = run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  if (result.status !== 0) throw new Error(`simctl device query failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  return Object.entries(parsed.devices || {}).flatMap(([runtime, devices]) => devices.map((device) => ({ ...device, runtime })));
}

function selectDevice(devices, requested) {
  if (requested) return devices.find((device) => device.udid === requested || device.name === requested) || null;
  return devices.find((device) => device.state === 'Booted') || devices.find((device) => /iPhone/.test(device.name) && device.isAvailable !== false) || null;
}

function prepareDevice(options, run = execute) {
  if (process.platform !== 'darwin') return { ready: false, reason: 'Tier 3 iOS checks require macOS' };
  if (!commandAvailable('xcrun', run)) return { ready: false, reason: 'xcrun/simctl is unavailable' };
  if (!commandAvailable(options.maestro, run)) return { ready: false, reason: 'Maestro CLI is unavailable' };
  let devices;
  try { devices = simulatorDevices(run); } catch (error) { return { ready: false, reason: error.message }; }
  const device = selectDevice(devices, options.device);
  if (!device) return { ready: false, reason: options.device ? `simulator ${options.device} is unavailable` : 'no available iPhone simulator' };
  if (device.state !== 'Booted') {
    if (!options.boot) return { ready: false, reason: `simulator ${device.name} is Shutdown; pass --boot to start it` };
    const boot = run('xcrun', ['simctl', 'boot', device.udid]);
    if (boot.status !== 0 && !/current state: Booted|Unable to boot device in current state: Booted/i.test(`${boot.stdout}${boot.stderr}`)) {
      return { ready: false, reason: `failed to boot ${device.name}: ${boot.stderr || boot.stdout}` };
    }
    const ready = run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
    if (ready.status !== 0) return { ready: false, reason: `simulator bootstatus failed: ${ready.stderr || ready.stdout}` };
  }
  return { ready: true, device: { ...device, state: 'Booted' } };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function deepLink(contract, route) {
  const publicRoute = String(route || '').replace(/\/\([^/]+\)/g, '').replace(/^\/+/, '');
  return `${contract.launch.scheme}://${publicRoute}`;
}

function flowFor(entry, contract) {
  const commands = ['- launchApp'];
  const open = (route) => { if (contract.launch.scheme && route) commands.push(`- openLink: ${yamlString(deepLink(contract, route))}`); };
  if (entry.id === 'device.fonts.resolved') {
    open(contract.fonts?.[0]?.route || contract.launch.route);
    for (const probe of contract.fonts || []) commands.push(`- assertVisible:\n    id: ${yamlString(probe.id)}`);
    commands.push('- takeScreenshot:\n    path: resolved-fonts');
  } else if (entry.id === 'device.tabs.not-clipped') {
    open(contract.launch.route || contract.tabs?.[0]?.route);
    for (const tab of contract.tabs || []) commands.push(`- assertVisible:\n    id: ${yamlString(tab.id)}`);
    commands.push('- takeScreenshot:\n    path: native-tabs');
  } else if (entry.id === 'device.keyboard.cta-visible') {
    for (const form of contract.forms || []) {
      open(form.route);
      commands.push(`- tapOn:\n    id: ${yamlString(form.inputId)}`);
      commands.push('- inputText: "Device check"');
      commands.push(`- assertVisible:\n    id: ${yamlString(form.ctaId)}\n    enabled: true`);
      commands.push(`- takeScreenshot:\n    path: ${yamlString(`keyboard-${form.id}`)}`);
      commands.push('- hideKeyboard');
    }
  }
  return `appId: ${yamlString(contract.launch.appId)}\n---\n${commands.join('\n')}\n`;
}

function contractApplicable(entry, contract) {
  if (entry.id === 'device.tabs.not-clipped') return Array.isArray(contract.tabs) && contract.tabs.length > 0;
  if (entry.id === 'device.keyboard.cta-visible') return Array.isArray(contract.forms) && contract.forms.length > 0;
  return true;
}

function runFlow(entry, contract, options, device, run = execute) {
  const root = path.join(options.projectDir, '.mobile-build', 'device');
  const flowDir = path.join(root, 'flows');
  const outputDir = path.join(root, 'artifacts', entry.module);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const flowPath = path.join(flowDir, `${entry.module}.yaml`);
  fs.writeFileSync(flowPath, flowFor(entry, contract));
  const reportPath = path.join(outputDir, 'report.xml');
  // Maestro documents --device as a global option and JUNIT/test-output paths on
  // `test`: https://docs.maestro.dev/maestro-cli/maestro-cli-commands-and-options
  const result = run(options.maestro, [
    `--device=${device.udid}`, '--no-ansi', 'test', flowPath,
    '--format=JUNIT', `--output=${reportPath}`, `--test-output-dir=${outputDir}`, '--flatten-debug-output',
  ], { cwd: options.projectDir, timeout: 180000 });
  const screenshot = path.join(outputDir, 'simulator.png');
  const captured = run('xcrun', ['simctl', 'io', device.udid, 'screenshot', screenshot]);
  return {
    executed: true,
    exitCode: result.status == null ? 1 : result.status,
    output: `${result.stdout}${result.stderr}`.trim(),
    report: fs.existsSync(reportPath) ? reportPath : null,
    screenshot: captured.status === 0 && fs.existsSync(screenshot) ? screenshot : null,
  };
}

function evaluate(entries, contract, evidence, full) {
  const results = [];
  for (const entry of entries) {
    const check = require(path.join(DEVICE_DIR, 'checks', `${entry.module}.js`));
    const result = check.run(evidence[entry.id] || {}, contract);
    const status = result.notRun ? 'NOT_RUN' : result.pass ? 'PASS' : 'FAIL';
    results.push({ id: entry.id, status, blocking: entry.blocking, failures: result.failures || [], report: result.report || null });
  }
  const failed = results.some((result) => result.status === 'FAIL' && result.blocking);
  const notRun = results.some((result) => result.status === 'NOT_RUN');
  return { full, pass: !failed && !(full && notRun), results };
}

function runDevice(options, dependencies = {}) {
  const run = dependencies.execute || execute;
  const entries = registry.load().filter((entry) => entry.tier === 3 && (options.check === 'all' || entry.id === options.check || entry.module === options.check));
  if (entries.length === 0) throw new Error(`unknown Tier 3 check ${options.check}`);
  const contractPath = path.resolve(options.projectDir, options.contract || '.mobile-build/device-contract.json');
  let contract = null;
  let contractError = null;
  try { contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')); } catch (error) { contractError = `device contract unavailable: ${error.message}`; }
  const evidence = {};
  if (contract) {
    if (!contract.launch?.appId || !contract.launch?.scheme) {
      for (const entry of entries) evidence[entry.id] = { executed: false, reason: 'device contract requires launch.appId and launch.scheme' };
    } else {
      const prepared = prepareDevice(options, run);
      if (!prepared.ready) {
        for (const entry of entries) evidence[entry.id] = { executed: false, reason: prepared.reason };
      } else {
        const installed = run('xcrun', ['simctl', 'get_app_container', prepared.device.udid, contract.launch.appId, 'app']);
        if (installed.status !== 0) {
          for (const entry of entries) evidence[entry.id] = { executed: false, reason: `app ${contract.launch.appId} is not installed on ${prepared.device.name}` };
        } else {
          for (const entry of entries) {
            evidence[entry.id] = contractApplicable(entry, contract)
              ? runFlow(entry, contract, options, prepared.device, run)
              : { executed: false, reason: 'check is not applicable to this plan' };
          }
        }
      }
    }
  } else {
    contract = {};
    for (const entry of entries) evidence[entry.id] = { executed: false, reason: contractError };
  }
  const report = evaluate(entries, contract, evidence, options.full);
  const reportPath = path.join(options.projectDir, '.tmp', 'device-check-results.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ ...report, evidence }, null, 2)}\n`);
  return { ...report, reportPath };
}

function main() {
  try {
    const result = runDevice(parseArgs(process.argv.slice(2)));
    for (const check of result.results) {
      const reason = check.failures.length > 0 ? ` reason=${JSON.stringify(check.failures.join('; '))}` : '';
      console.log(`prototype-device: ${check.status === 'NOT_RUN' ? 'NOT RUN' : check.status} ${check.id}${reason}`);
    }
    console.log(`prototype-device: REPORT ${result.reportPath}`);
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    console.error(`prototype-device: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { commandAvailable, contractApplicable, deepLink, evaluate, execute, flowFor, parseArgs, prepareDevice, runDevice, runFlow, selectDevice, simulatorDevices, yamlString };

#!/usr/bin/env node

/**
 * Open the Power Apps Wrap page for an app.
 *
 * Usage:
 *   node scripts/open-wrap-url.js --app-id <appId> --env-id <environmentId> [--env <Prod|Test>] [--dry-run]
 */

const os = require('os');
const { spawnSync } = require('child_process');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    appId: '',
    envId: '',
    env: 'Prod',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--app-id') {
      out.appId = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (a === '--env-id') {
      out.envId = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (a === '--env') {
      out.env = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (a === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: node scripts/open-wrap-url.js --app-id <appId> --env-id <environmentId> [--env <Prod|Test>] [--dry-run]\n'
      );
      process.exit(0);
    }
    fail(`Unknown argument: ${a}`);
  }

  return out;
}

function looksLikeGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buildWrapUrl(envId, appId, env) {
  const host = env === 'Prod' ? 'make.powerapps.com' : 'make.test.powerapps.com';
  return `https://${host}/environments/${encodeURIComponent(envId)}/wrap?appID=${encodeURIComponent(appId)}`;
}

function commandExists(command) {
  const check = spawnSync('command', ['-v', command], {
    shell: true,
    stdio: 'ignore',
  });
  return check.status === 0;
}

function canOpenURL(url) {
  const platform = os.platform();

  if (platform === 'darwin') {
    return commandExists('open')
      ? { ok: true }
      : { ok: false, reason: 'open command is not available on this machine.' };
  }

  if (platform === 'win32') {
    return commandExists('cmd')
      ? { ok: true }
      : { ok: false, reason: 'cmd/start is not available on this machine.' };
  }

  return commandExists('xdg-open')
    ? { ok: true }
    : { ok: false, reason: 'xdg-open is not available on this machine.' };
}

function openInBrowser(url) {
  const platform = os.platform();

  try {
    if (platform === 'darwin') {
      const res = spawnSync('open', [url], { stdio: 'ignore' });
      return { ok: res.status === 0, reason: res.status === 0 ? '' : 'open returned a non-zero exit code.' };
    }

    if (platform === 'win32') {
      const res = spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      return { ok: res.status === 0, reason: res.status === 0 ? '' : 'start returned a non-zero exit code.' };
    }

    const res = spawnSync('xdg-open', [url], { stdio: 'ignore' });
    return { ok: res.status === 0, reason: res.status === 0 ? '' : 'xdg-open returned a non-zero exit code.' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown error opening URL' };
  }
}

function main() {
  const { appId, envId, env, dryRun } = parseArgs(process.argv.slice(2));

  if (!appId) {
    fail('Missing required --app-id <appId>');
  }

  if (!envId) {
    fail('Missing required --env-id <environmentId>');
  }

  if (!looksLikeGuid(envId)) {
    fail(`Environment ID does not look valid: ${envId}`);
  }

  if (!looksLikeGuid(appId)) {
    process.stderr.write(
      `Warning: app ID does not look like a GUID (${appId}). Continuing because some tenants use non-GUID aliases.\n`
    );
  }

  if (env !== 'Prod' && env !== 'Test') {
    fail(`Invalid --env value: ${env}. Use exactly Prod or Test.`);
  }

  const url = buildWrapUrl(envId, appId, env);

  process.stdout.write(`${url}\n`);

  if (dryRun) {
    return;
  }

  const canOpen = canOpenURL(url);
  if (!canOpen.ok) {
    process.stderr.write(`Could not open URL: ${canOpen.reason}\n`);
    process.stderr.write(`Open manually: ${url}\n`);
    process.exit(1);
  }

  const opened = openInBrowser(url);
  if (!opened.ok) {
    process.stderr.write(`Could not auto-open browser: ${opened.reason}\n`);
    process.stderr.write(`Open manually: ${url}\n`);
    process.exit(1);
  }
}

main();

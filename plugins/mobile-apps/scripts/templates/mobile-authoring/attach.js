#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');

function reuseVscodeWindow(env = process.env) {
  return env.TERM_PROGRAM === 'vscode';
}

function options(argv = process.argv.slice(2), env = process.env) {
  const result = {
    bridgeUrl: env.DEV_PLAYER_BUILDER_URL || 'http://127.0.0.1:5177',
    metroUrl: env.DEV_PLAYER_METRO_URL || 'http://127.0.0.1:8081',
    reuseVscodeWindow: reuseVscodeWindow(env),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return { help: true };
    if (!['--bridge', '--metro-url'].includes(name)) throw new Error(`Unknown attach option: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${name}.`);
    if (name === '--bridge') result.bridgeUrl = value;
    else result.metroUrl = value;
  }
  const bridge = new URL(result.bridgeUrl);
  if (bridge.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(bridge.hostname)
    || bridge.username || bridge.password || bridge.pathname !== '/' || bridge.search || bridge.hash) {
    throw new Error('The attach command accepts only a loopback HTTP bridge origin.');
  }
  result.bridgeUrl = bridge.origin;
  return result;
}

function requestAttach(input, projectRoot = fs.realpathSync(process.cwd())) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL('/demo/attach', input.bridgeUrl);
    const body = Buffer.from(JSON.stringify({
      projectRoot,
      metroUrl: input.metroUrl,
      ...(input.reuseVscodeWindow ? { vscodeWindow: true } : {}),
    }));
    const request = http.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: 15000,
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 65536) request.destroy(new Error('Attach response exceeded 64 KiB'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error('The local bridge returned an invalid attach response')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(typeof parsed.error === 'string' ? parsed.error : `Attach failed with HTTP ${response.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('The local bridge did not respond in time')));
    request.on('error', reject);
    request.end(body);
  });
}

async function main(argv = process.argv.slice(2)) {
  const input = options(argv);
  if (input.help) {
    process.stdout.write('Usage: npm run authoring:attach -- [--metro-url <url>] [--bridge <loopback-origin>]\n');
    return 0;
  }
  const result = await requestAttach(input);
  process.stdout.write(`Attached ${result.appName || 'app'} to ${result.metroUrl}.\n`);
  if (result.vscodeWindow) {
    process.stdout.write('Authoring will reuse this VS Code window and preserve its running terminals.\n');
  }
  process.stdout.write('Scan the normal Metro QR in Mobile Preview. Edit app will use an isolated candidate and write back only after Apply.\n');
  return 0;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Authoring attach failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { reuseVscodeWindow, options, requestAttach, main };

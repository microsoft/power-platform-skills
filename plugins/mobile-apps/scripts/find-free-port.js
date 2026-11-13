#!/usr/bin/env node

/**
 * find-free-port.js - report the first TCP port, from `--start` upward, that nothing is listening
 * on, on any interface.
 *
 * Why this exists: `/create-mobile-app` starts its preview with the template's
 * `npm run dev -- --port <port>` from a background terminal. Given an explicit port, the template's
 * `power-apps-dev` refuses a taken one (`Expo port <port> is already in use`) instead of moving on,
 * and without a TTY Expo itself exits with `EADDRINUSE`. Picking a free port first keeps the
 * preview from failing on a machine that already runs Metro or another dev server.
 *
 * The probes match where the server binds. `power-apps-dev` serves the phone on the LAN, so Metro
 * listens on every interface, and `power-apps-dev` checks the port with a host-less bind. A
 * loopback-only probe called a port free while another dev server held it on every interface, so
 * the skill's retry kept choosing the port `power-apps-dev` refused. So a port is free only when
 * it binds on the IPv4 and IPv6 wildcards and on both loopback addresses. The loopback probes stay
 * because macOS lets a wildcard bind succeed beside a specific-address listener, and `localhost`
 * may resolve to 127.0.0.1 or ::1 (Expo bound ::1 on macOS with Node 22) for the `--localhost`
 * fallback. A host without IPv6 reports EADDRNOTAVAIL or EAFNOSUPPORT for `::` and ::1, which
 * counts as free there.
 *
 * There is an unavoidable window between this probe and Expo binding the port. The skill treats
 * either refusal as a cue to run this again rather than as a failure.
 *
 * Usage:
 *   node find-free-port.js [--start 19006] [--attempts 50]
 * Prints one line of JSON: {"port":19006,"url":"http://localhost:19006"}
 */

'use strict';

const net = require('node:net');

const PROBE_HOSTS = ['0.0.0.0', '::', '127.0.0.1', '::1'];
const UNSUPPORTED_ADDRESS_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function canBind(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => {
      resolve(UNSUPPORTED_ADDRESS_CODES.has(error.code));
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function isPortFree(port) {
  for (const host of PROBE_HOSTS) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}

async function findFreePort({ start = 19006, attempts = 50 } = {}) {
  if (!Number.isInteger(start) || start < 1024 || start > 65535) {
    throw new Error('--start must be an integer between 1024 and 65535');
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('--attempts must be a positive integer');
  }
  const last = Math.min(65535, start + attempts - 1);
  for (let port = start; port <= last; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port between ${start} and ${last}`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--start') options.start = Number(argv[++index]);
    else if (argument === '--attempts') options.attempts = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (require.main === module) {
  findFreePort(parseArgs(process.argv.slice(2)))
    .then((port) => {
      process.stdout.write(`${JSON.stringify({ port, url: `http://localhost:${port}` })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}

module.exports = { findFreePort, isPortFree };

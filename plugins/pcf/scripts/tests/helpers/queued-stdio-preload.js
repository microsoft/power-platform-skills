'use strict';
// Loaded with `node --require` ahead of a script: gives the script the stdout and stderr a pipe gets on Linux and macOS — a `net.Socket` over the pipe, whose writes are QUEUED when the pipe cannot take them at
// once — on every platform. Node makes a pipe on descriptor 1 or 2 synchronous on Windows (lib/net.js: "Make stdout and stderr blocking on Windows"), so a script run there with its own stdout can never show what a
// reader on Linux or macOS gets when `process.exit` follows a large write (https://nodejs.org/api/process.html#a-note-on-process-io). Here `process.stdout` and `process.stderr` are sockets over descriptors 3 and 4
// instead, which Node leaves asynchronous everywhere; the test spawns the script with `stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']` and reads what it printed from `output[3]` and `output[4]`.
// The same helper as model-apps' tests/helpers/queued-stdio-preload.js: this plugin's suite runs on its own.
const net = require('node:net');

for (const [name, fd] of [['stdout', 3], ['stderr', 4]]) {
  const socket = new net.Socket({ fd, readable: false, writable: true });
  Object.defineProperty(process, name, { configurable: true, enumerable: true, get: () => socket });
}

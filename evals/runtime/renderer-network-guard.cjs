'use strict';

// Only trusted template renderers run in this child. Deny network APIs as a
// second boundary, and keep the Copilot token out of the child's environment.
const deny = () => { throw new Error('Network access is disabled for offline renderers'); };
for (const moduleName of ['node:http', 'node:https']) {
  const module = require(moduleName);
  module.request = deny;
  module.get = deny;
}
const net = require('node:net');
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:dgram').createSocket = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };

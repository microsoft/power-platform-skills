'use strict';

const { Serializer } = require('./serialize.js');

// Build the designer tool handlers from a driver + a serializer. Each handler
// returns a plain { ok, ... } object; tools.js wraps these as MCP tool results.
// Kept free of the MCP SDK and zod so it is unit-testable with `node --test`.
function makeHandlers(driver, seq) {
  const queue = seq || new Serializer();
  return {
    // Open a form-editor URL in the designer and wait until the bridge is ready.
    async open(args) {
      const url = (args || {}).url;
      return queue.run(async () => {
        if (url) await driver.goto(url);
        await driver.inject();
        return driver.waitReady();
      }, 60000); // navigation + designer load can take a while
    },
    // Read-only; no need to serialize.
    async status() {
      return driver.status();
    },
    async inspect() {
      return queue.run(() => driver.call('inspect', []));
    },
    async addField(args) {
      const a = args || {};
      return queue.run(() => driver.call('addField', [a.fieldLogicalName, a.targetSectionId, !!a.force]));
    },
  };
}

// Shape a handler result as an MCP tool result. isError flips when the bridge
// reported ok:false so the agent sees a clean tool error.
function toToolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: !!(result && result.ok === false),
  };
}

module.exports = { makeHandlers, toToolResult };

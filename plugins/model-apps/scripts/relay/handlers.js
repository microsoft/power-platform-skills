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
    // Read-only discovery; the discovery service may fetch from the env, so allow longer.
    async listControls(args) {
      const a = args || {};
      return queue.run(() => driver.call('listControls', [a.fieldLogicalName]), 30000);
    },
    async describeControl(args) {
      const a = args || {};
      return queue.run(() => driver.call('describeControl', [a.controlId]), 30000);
    },
    async setControl(args) {
      const a = args || {};
      return queue.run(() => driver.call('setControl', [a.fieldLogicalName, a.controlId, a.params || null, a.formFactors || null]), 30000);
    },
    async addComponent(args) {
      const a = args || {};
      return queue.run(() => driver.call('addComponent', [a.controlId, a.targetSectionId, a.params || null, a.formFactors || null]), 30000);
    },
    async getControl(args) {
      const a = args || {};
      return queue.run(() => driver.call('getControl', [a.fieldLogicalName]));
    },
    async removeControl(args) {
      const a = args || {};
      return queue.run(() => driver.call('removeControl', [a.fieldLogicalName]));
    },
    async setFieldProps(args) {
      const a = args || {};
      return queue.run(() => driver.call('setFieldProps', [a.fieldLogicalName, a.props || {}]));
    },
    async moveControl(args) {
      const a = args || {};
      return queue.run(() => driver.call('moveControl', [a.fieldLogicalName, a.targetElementId, a.position || null]));
    },
    async addSubgrid(args) {
      const a = args || {};
      return queue.run(() => driver.call('addSubgrid', [a.targetSectionId, a.entity, {
        relationshipName: a.relationshipName, viewId: a.viewId, recordsPerPage: a.recordsPerPage, displayName: a.displayName,
      }]), 30000);
    },
    async addTab(args) {
      const a = args || {};
      return queue.run(() => driver.call('addTab', [a.targetTabId || null, a.columns || null, a.displayName || null]), 30000);
    },
    async addSection(args) {
      const a = args || {};
      return queue.run(() => driver.call('addSection', [a.targetElementId, a.columns || null, a.displayName || null]), 30000);
    },
    async addColumn(args) {
      const a = args || {};
      return queue.run(() => driver.call('addColumn', [a.sectionId, a.columns]));
    },
    async addEventHandler(args) {
      const a = args || {};
      return queue.run(() => driver.call('addEventHandler', [a.target || 'form', {
        eventType: a.eventType, library: a.library, functionName: a.functionName,
        enabled: a.enabled, passExecutionContext: a.passExecutionContext, parameters: a.parameters,
      }]));
    },
    async addLibrary(args) {
      const a = args || {};
      return queue.run(() => driver.call('addLibrary', [a.libraryName]), 30000);
    },
    async setFormProps(args) {
      const a = args || {};
      return queue.run(() => driver.call('setFormProps', [a.props || {}]));
    },
    async removeElement(args) {
      const a = args || {};
      return queue.run(() => driver.call('removeElement', [a.elementId]));
    },
    async undo() {
      return queue.run(() => driver.call('undo', []));
    },
    async redo() {
      return queue.run(() => driver.call('redo', []));
    },
    // PERSIST — gated by an explicit operator opt-in. The relay never saves unless
    // started with MM_ALLOW_SAVE=1 (publish: MM_ALLOW_PUBLISH=1). The agent cannot
    // bypass this; it is set at relay launch.
    async save() {
      if (process.env.MM_ALLOW_SAVE !== '1') {
        return { ok: false, error: { code: 'save-disabled', message: 'form_save is disabled by default. Start the relay with MM_ALLOW_SAVE=1 to allow persisting the form.' } };
      }
      return queue.run(() => driver.call('save', []), 60000);
    },
    async publish() {
      if (process.env.MM_ALLOW_PUBLISH !== '1') {
        return { ok: false, error: { code: 'publish-disabled', message: 'form_publish is disabled by default. Start the relay with MM_ALLOW_PUBLISH=1 to allow publishing (makes the form live for users).' } };
      }
      return queue.run(() => driver.call('publish', []), 120000);
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

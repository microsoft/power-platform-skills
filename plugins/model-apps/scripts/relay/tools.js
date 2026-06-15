'use strict';

// Registers the model-maker designer tools on an McpServer. Thin: each tool
// delegates to a handler (handlers.js) and shapes the result (toToolResult).
// zod is only needed here (input schemas), so unit tests target handlers.js
// instead and never import this module.
const { z } = require('zod');
const { toToolResult } = require('./handlers.js');

function registerTools(server, handlers) {
  server.registerTool(
    'designer_open',
    {
      description: 'Open a model-driven form in the designer (and wait until it is ready). URL shape: /e/<env>/s/<solution>/entity/<entity>/form/edit/<formId>.',
      inputSchema: { url: z.string().describe('The form-editor URL to open.') },
    },
    async (args) => toToolResult(await handlers.open(args))
  );

  server.registerTool(
    'designer_status',
    { description: 'Form-designer bridge readiness, and how the FormDesignerService handle was acquired (export vs fiber).', inputSchema: {} },
    async () => toToolResult(await handlers.status())
  );

  server.registerTool(
    'form_inspect',
    { description: 'Inspect the form open in the designer: its sections (with ids) and the table fields not yet placed.', inputSchema: {} },
    async () => toToolResult(await handlers.inspect())
  );

  server.registerTool(
    'form_addField',
    {
      description: 'Add an existing table field to a form section in the open designer, via the designer\'s own add-field command (live, WYSIWYG).',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the column to add, e.g. "telephone1"'),
        targetSectionId: z.string().describe('Section id from form_inspect (node.id.guidString)'),
        force: z.boolean().optional().describe('Add even if the field is already on the form (default false).'),
      },
    },
    async (args) => toToolResult(await handlers.addField(args))
  );
}

module.exports = { registerTools };

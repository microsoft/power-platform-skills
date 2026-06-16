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

  server.registerTool(
    'form_listControls',
    {
      description: 'List the custom controls (PCF / AI Builder, e.g. "Business card reader") the environment offers for a field — the default component-picker list, filtered by the field\'s data type. Omit fieldLogicalName for the unbound/default list. Read-only.',
      inputSchema: {
        fieldLogicalName: z.string().optional().describe('Logical name of the field to list controls for, e.g. "name". Omit for the unbound/default list.'),
      },
    },
    async (args) => toToolResult(await handlers.listControls(args))
  );

  server.registerTool(
    'form_describeControl',
    {
      description: 'Describe one custom control: its binding kind (fieldBound / dataset / lookup / unbound) and its parameter schema (name, usage, required, defaults, enum values) read from the control manifest. Use this to learn what params form_setControl needs. Read-only.',
      inputSchema: {
        controlId: z.string().describe('Control id from form_listControls, e.g. "Intelligence.BusinessCardReaderControl.BusinessCardReader"'),
      },
    },
    async (args) => toToolResult(await handlers.describeControl(args))
  );

  server.registerTool(
    'form_setControl',
    {
      description: 'Set a custom control (PCF / AI Builder) on a field already placed on the form, via the designer\'s own command (live, WYSIWYG). Generic across controls. Requires the first-party façade build (enableModelMakerBridge). Param application is not yet supported — use form_describeControl to see a control\'s schema.',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the field whose control to set, e.g. "name"'),
        controlId: z.string().describe('Control id from form_listControls, e.g. "Intelligence.BusinessCardReaderControl.BusinessCardReader"'),
        params: z.record(z.any()).optional().describe('Control parameters (schema from form_describeControl). Not yet applied; provided for forward compatibility.'),
        formFactors: z.array(z.string()).optional().describe('Form factors to apply the control on (e.g. ["Web"]). Default Web.'),
      },
    },
    async (args) => toToolResult(await handlers.setControl(args))
  );
}

module.exports = { registerTools };

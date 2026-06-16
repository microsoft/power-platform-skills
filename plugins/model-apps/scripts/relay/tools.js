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
      description: 'Set a custom control (PCF / AI Builder) on a FIELD already placed on the form, via the designer\'s own command (live, WYSIWYG). Generic across field-bound controls. Requires the first-party façade build (enableModelMakerBridge). For unbound/dataset controls (PowerBI, subgrid) use form_addComponent instead.',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the field whose control to set, e.g. "name"'),
        controlId: z.string().describe('Control id from form_listControls, e.g. "Intelligence.BusinessCardReaderControl.BusinessCardReader"'),
        params: z.record(z.any()).optional().describe('Control parameters (schema from form_describeControl). Each: a value, or { value, bound:true } to bind to a field. e.g. { FilterPaneVisible: "true" }'),
        formFactors: z.array(z.string()).optional().describe('Form factors to apply the control on (e.g. ["Web"]). Default Web.'),
      },
    },
    async (args) => toToolResult(await handlers.setControl(args))
  );

  server.registerTool(
    'form_getControl',
    {
      description: 'Read the control currently bound to a field cell — the control class id and any applied custom controls. Use to verify form_setControl. Read-only.',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the field, e.g. "name"'),
      },
    },
    async (args) => toToolResult(await handlers.getControl(args))
  );

  server.registerTool(
    'form_addComponent',
    {
      description: 'Place a custom control (PCF / AI Builder) as a NEW component in a form section — for UNBOUND / dataset controls (e.g. PowerBI, a subgrid) that are not bound to a field. Generic + param-driven. Requires the first-party façade build (enableModelMakerBridge).',
      inputSchema: {
        controlId: z.string().describe('Control id from form_listControls, e.g. "MscrmControls.PowerBIPCFControl"'),
        targetSectionId: z.string().describe('Section id from form_inspect (node.id.guidString) to place the component in'),
        params: z.record(z.any()).optional().describe('Control parameters (schema from form_describeControl), e.g. { PowerBIReport: "<reportUniqueName>", FilterPaneVisible: "true" }'),
        formFactors: z.array(z.string()).optional().describe('Form factors (e.g. ["Web"]). Default Web.'),
      },
    },
    async (args) => toToolResult(await handlers.addComponent(args))
  );

  server.registerTool(
    'form_removeControl',
    {
      description: 'Remove a field/control from the open form via the designer\'s own delete command (live). Works on any build (no façade needed).',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the field/control to remove, e.g. "fax"'),
      },
    },
    async (args) => toToolResult(await handlers.removeControl(args))
  );

  server.registerTool(
    'form_setFieldProps',
    {
      description: 'Set common properties on a placed field/control: label (display name), visibility, read-only, show-label, locked, available-on-phone. Live; undoable; works on any build.',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the field, e.g. "telephone1"'),
        props: z.object({
          label: z.string().optional().describe('Display label'),
          visible: z.boolean().optional().describe('Visible (false hides by default)'),
          readonly: z.boolean().optional().describe('Read-only'),
          showLabel: z.boolean().optional().describe('Show the label'),
          locked: z.boolean().optional().describe('Lock the control'),
          availableForPhone: z.boolean().optional().describe('Available on phone'),
        }).describe('Properties to set (only the keys you pass are changed)'),
      },
    },
    async (args) => toToolResult(await handlers.setFieldProps(args))
  );

  server.registerTool(
    'form_moveControl',
    {
      description: 'Move a placed field/control to another section (or before/after another element) via the designer\'s own move command. Works on any build.',
      inputSchema: {
        fieldLogicalName: z.string().describe('Logical name of the field/control to move'),
        targetElementId: z.string().describe('Target section id (or a sibling cell id) from form_inspect'),
        position: z.string().optional().describe('Insert position relative to the target, e.g. "before" / "after" (default: append)'),
      },
    },
    async (args) => toToolResult(await handlers.moveControl(args))
  );

  server.registerTool(
    'form_addSubgrid',
    {
      description: 'Add a SUBGRID (related-records grid) to a form section — e.g. related Contacts on an Account form. Set the related table + 1:N relationship + view. Requires the first-party façade build (enableModelMakerBridge).',
      inputSchema: {
        targetSectionId: z.string().describe('Section id from form_inspect to place the subgrid in'),
        entity: z.string().describe('Related table logical name, e.g. "contact"'),
        relationshipName: z.string().optional().describe('1:N relationship schema name for related records, e.g. "contact_customer_accounts". Omit for an "all records" grid.'),
        viewId: z.string().optional().describe('Saved query (view) id to show, GUID with braces. Omit for the table default view.'),
        recordsPerPage: z.number().optional().describe('Rows per page (default 4)'),
        displayName: z.string().optional().describe('Subgrid label'),
      },
    },
    async (args) => toToolResult(await handlers.addSubgrid(args))
  );

  server.registerTool(
    'form_addTab',
    {
      description: 'Add a tab to the open form (with 1/2/3 columns). Requires the first-party façade build (enableModelMakerBridge).',
      inputSchema: {
        columns: z.number().optional().describe('Number of columns: 1, 2, or 3 (default 1)'),
        displayName: z.string().optional().describe('Tab label (default "New Tab")'),
        targetTabId: z.string().optional().describe('Anchor tab id from form_inspect (default: after the last tab)'),
      },
    },
    async (args) => toToolResult(await handlers.addTab(args))
  );

  server.registerTool(
    'form_addSection',
    {
      description: 'Add a section (with 1-4 columns) to the open form. Requires the first-party façade build (enableModelMakerBridge).',
      inputSchema: {
        targetElementId: z.string().describe('A section id (insert as a sibling) or tab id from form_inspect'),
        columns: z.number().optional().describe('Number of columns: 1-4 (default 1)'),
        displayName: z.string().optional().describe('Section label (default "New Section")'),
      },
    },
    async (args) => toToolResult(await handlers.addSection(args))
  );

  server.registerTool(
    'form_addColumn',
    {
      description: 'Set a section\'s column count (1-4) — the designer\'s add/remove-column operation (a column is part of a section\'s layout, not a standalone element). Live; undoable; works on any build.',
      inputSchema: {
        sectionId: z.string().describe('Section id from form_inspect'),
        columns: z.number().describe('Target number of columns: 1-4'),
      },
    },
    async (args) => toToolResult(await handlers.addColumn(args))
  );

  server.registerTool(
    'form_addEventHandler',
    {
      description: 'Add a form/control event handler (form script). onLoad/onSave on the form (target "form"); onChange on a field (target = field logical name). The referenced library (web resource) must already be on the form. Live; works on any build.',
      inputSchema: {
        target: z.string().optional().describe('"form" for onLoad/onSave (default), or a field logical name for onChange'),
        eventType: z.string().describe('Event: "onload", "onsave", or "onchange"'),
        library: z.string().describe('Form library (web resource) name the function lives in'),
        functionName: z.string().describe('Function to call, e.g. "MyNamespace.onLoad"'),
        enabled: z.boolean().optional().describe('Enabled (default true)'),
        passExecutionContext: z.boolean().optional().describe('Pass execution context as first parameter (default true)'),
        parameters: z.string().optional().describe('Comma-separated additional parameters'),
      },
    },
    async (args) => toToolResult(await handlers.addEventHandler(args))
  );

  server.registerTool(
    'form_addLibrary',
    {
      description: 'Register a JS web-resource library on the form so form_addEventHandler can reference it. Reports whether the web resource actually exists in the env (exists:true). Live; works on any build.',
      inputSchema: {
        libraryName: z.string().describe('Web resource (library) name, e.g. "new_myscript" or "account_main.js"'),
      },
    },
    async (args) => toToolResult(await handlers.addLibrary(args))
  );

  server.registerTool(
    'form_setFormProps',
    {
      description: 'Set FORM-level properties: name (display title), description, maxWidth (pixels), showImage, showNavigation. Live; undoable; works on any build.',
      inputSchema: {
        props: z.object({
          name: z.string().optional().describe('Form display title'),
          description: z.string().optional(),
          maxWidth: z.number().optional().describe('Max width in pixels'),
          showImage: z.boolean().optional(),
          showNavigation: z.boolean().optional(),
        }).describe('Form properties to set (only the keys you pass change)'),
      },
    },
    async (args) => toToolResult(await handlers.setFormProps(args))
  );

  server.registerTool(
    'form_getFormProps',
    { description: 'Read the form-level properties (name / description / maxWidth / showImage / showNavigation) — the read-back for form_setFormProps. Read-only.', inputSchema: {} },
    async () => toToolResult(await handlers.getFormProps())
  );

  server.registerTool(
    'form_removeElement',
    {
      description: 'Remove ANY form element by id — a tab, section, or cell (from form_inspect). For a field, form_removeControl is easier. Live; works on any build.',
      inputSchema: { elementId: z.string().describe('Element id (tab/section/cell) from form_inspect') },
    },
    async (args) => toToolResult(await handlers.removeElement(args))
  );

  server.registerTool(
    'form_undo',
    { description: 'Undo the last designer change. Live; works on any build.', inputSchema: {} },
    async () => toToolResult(await handlers.undo())
  );

  server.registerTool(
    'form_redo',
    { description: 'Redo the last undone designer change. Live; works on any build.', inputSchema: {} },
    async () => toToolResult(await handlers.redo())
  );

  server.registerTool(
    'form_save',
    {
      description: 'PERSIST the form (saveAsync) — writes the FormXml back to Dataverse. DISABLED by default; the operator must start the relay with MM_ALLOW_SAVE=1. Until then this returns {code:"save-disabled"}. Everything else the relay does is in-memory only.',
      inputSchema: {},
    },
    async () => toToolResult(await handlers.save())
  );

  server.registerTool(
    'form_publish',
    {
      description: 'PERSIST + PUBLISH the form (publishAsync = save then publishCustomizations) — makes it LIVE for users. DISABLED by default; the operator must start the relay with MM_ALLOW_PUBLISH=1. Returns {code:"publish-disabled"} otherwise.',
      inputSchema: {},
    },
    async () => toToolResult(await handlers.publish())
  );
}

module.exports = { registerTools };

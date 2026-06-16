---
name: model-maker
description: Co-authors model-driven FORM artifacts live in the designer. Use when the user says "edit form X", "add a field to the <table> form", "co-author a form", "open the form designer", or wants an agent to change a model-driven form's layout. Drives the designer's own commands via the designer-relay MCP server so changes render live (WYSIWYG) with the designer's real validation. Not for genux pages (use /genpage), tables/columns (use the plugin's DV scripts), or canvas apps.
allowed-tools: Read, Bash, Glob, Grep, mcp__designer-relay__designer_open, mcp__designer-relay__designer_status, mcp__designer-relay__form_inspect, mcp__designer-relay__form_addField, mcp__designer-relay__form_listControls, mcp__designer-relay__form_describeControl, mcp__designer-relay__form_setControl, mcp__designer-relay__form_addComponent, mcp__designer-relay__form_addSubgrid, mcp__designer-relay__form_addSection, mcp__designer-relay__form_addTab, mcp__designer-relay__form_getControl, mcp__designer-relay__form_setFieldProps, mcp__designer-relay__form_removeControl, mcp__designer-relay__form_moveControl
---

# model-maker — live form co-authoring

Co-author a model-driven **form** by driving the live form designer through the
`designer-relay` MCP server. The designer is the master; the agent is a
co-editor, so every change runs the designer's own validation and renders
immediately in the open tab.

This skill is the thin intent loop. It does NOT re-implement metadata,
scaffolding, or solution lifecycle — those stay with the plugin's DV scripts
(`scripts/`) and PAC.

## Prerequisites

- `designer-relay` MCP server available (this plugin's `.mcp.json`). One-time:
  `cd scripts/relay && npm install` (pulls the MCP SDK, `playwright-core`, `zod`;
  no browser download — it uses system **Edge**).
- A persistent, signed-in Edge profile (`MM_EDGE_PROFILE`) so AAD auth survives;
  Edge launches lazily on the first `designer_open`.
- `az` logged in for the target org (the plugin's `scripts/lib/dataverse-auth.js`
  uses `az account get-access-token`).

## Workflow

1. **Confirm the target environment** with the user (org URL) before any change —
   the mandatory multi-env safety check.

2. **Resolve the form-editor URL.** You need `envId`, `solutionId`, `entity`,
   `formId`. Use the plugin's DV wrapper to find the form, e.g. the Account main
   form:

   ```bash
   node scripts/dataverse-request.js <orgUrl> GET \
     "systemforms?\$select=name,formid,type&\$filter=objecttypecode eq 'account' and type eq 2"
   ```

   Then build:
   `https://make.powerapps.com/e/<envId>/s/<solutionId>/entity/<entity>/form/edit/<formId>`
   (use `make.test.powerapps.com` for test envs; the default `solutionId` is
   `00000001-0000-0000-0001-00000000009b`). The page is top-level, not an iframe.

3. **Open it:** `designer_open(url)` → then `designer_status` until `ok:true`
   (it reports `source: export | fiber`).

4. **Inspect:** `form_inspect` → returns the form's sections (each with an `id`)
   and the table fields not yet placed (`available`). Present the relevant ones.

5. **Clarify** with the user exactly which field(s) and which section.

6. **Act:** `form_addField({ fieldLogicalName, targetSectionId })`. It guards
   duplicates (the designer does not block dupes on body sections) and surfaces
   the designer's validation. The control renders live in the tab.

7. **Review:** ask the user to eyeball the tab; iterate from step 4.

8. **Persist** only when the user is done — saving/publishing and solution
   handling stay with PAC / the `dv-solution` flow, not this skill.

## Setting a custom control (PCF / AI Builder) on a field

To change a field's control (e.g. *Business card reader* on Account Name) instead
of adding a field:

1. Make sure the field is on the form (`form_inspect`; add it first if not).
2. **Discover:** `form_listControls({ fieldLogicalName })` → the controls the env
   offers for that field, each with `bindingKind` and a `name` (the control id).
   Omit the field for the unbound/default list.
3. **Understand requirements:** `form_describeControl({ controlId })` → the
   control's `bindingKind` + `requiredParams` + full param schema. If
   `requiredParams` aren't satisfied by defaults (e.g. PowerBI `PowerBIReport`,
   Canvas `appId`, AgentResponse `topicName`), ask the user for those values.
4. **Apply — route by `bindingKind`:**
   - **fieldBound** → `form_setControl({ fieldLogicalName, controlId, params? })`.
   - **unbound / dataset** (PowerBI, subgrid) → `form_addComponent({ controlId,
     targetSectionId, params? })` (a section id from `form_inspect`). These can't be
     set on a field.

   `params` is `{ name: value }` (or `{ name: { value, bound:true } }` to bind a
   param to a field); the result's `appliedParams` echoes what was set, and an
   unrecognized name returns `code:'unknown-param'`. Both need the first-party
   façade build; on a normal build they return `code:'needs-facade'` (discovery
   still works — setting/placing needs the `enableModelMakerBridge` designer build).
5. **Verify:** `form_getControl({ fieldLogicalName })` → the cell's `classId` flips
   to the CustomControl class and `customControls` lists the control you set. (More
   reliable than the canvas in a debug build, which may not repaint.)

## Structural & property edits

Beyond controls, the relay edits form structure and properties (most are DIRECT
commands that work on any build — only `form_addSubgrid` needs the façade):

- **Edit a field's properties:** `form_setFieldProps({ fieldLogicalName, props: {
  label?, visible?, readonly?, showLabel?, locked?, availableForPhone? } })` →
  verify with `form_getControl` (it returns label/visible/readonly/locked).
- **Add a related-records subgrid:** `form_addSubgrid({ targetSectionId, entity,
  relationshipName?, viewId?, recordsPerPage? })` (e.g. `entity:'contact'`,
  `relationshipName:'contact_customer_accounts'`).
- **Remove a control:** `form_removeControl({ fieldLogicalName })`.
- **Move a control:** `form_moveControl({ fieldLogicalName, targetElementId,
  position? })` (target = a section id from `form_inspect`).
- **Add a section / tab:** `form_addSection({ targetElementId, columns?,
  displayName? })` (target = a section/tab id; 1-4 columns); `form_addTab({
  columns?, displayName?, targetTabId? })` (1-3 columns; anchors after the last
  tab). `form_inspect` returns `tabs:[{id}]` and `sections:[{id}]` for targeting.

## Tools (designer-relay)

| Tool | Returns |
| --- | --- |
| `designer_open(url)` | opens the form, waits for readiness, returns status |
| `designer_status` | `{ ok, source, capability }` |
| `form_inspect` | `{ ok, result: { formType, sections:[{id}], available:[{name,displayName}] } }` |
| `form_addField(fieldLogicalName, targetSectionId, force?)` | `{ ok, result }` or `{ ok:false, validation }` (e.g. duplicate-field) |
| `form_listControls(fieldLogicalName?)` | `{ ok, result: { controls:[{name,displayName,bindingKind,…}] } }` — controls the env offers for a field (read-only) |
| `form_describeControl(controlId)` | `{ ok, result: { bindingKind, requiredParams, params:[…] } }` — a control's param schema (read-only) |
| `form_setControl(fieldLogicalName, controlId, params?, formFactors?)` | `{ ok, result:{ appliedParams } }` or `{ ok:false, error:{ code:'needs-facade' \| 'no-cell' \| 'unknown-param' } }` (field-bound) |
| `form_addComponent(controlId, targetSectionId, params?, formFactors?)` | `{ ok, result:{ appliedParams } }` or `{ ok:false, error:{ code:'needs-facade' \| 'no-section' \| 'unknown-param' } }` (unbound/dataset, e.g. PowerBI) |
| `form_addSubgrid(targetSectionId, entity, relationshipName?, viewId?, recordsPerPage?)` | `{ ok, result }` — related-records subgrid (needs façade build) |
| `form_addSection(targetElementId, columns?, displayName?)` | `{ ok, result }` — add a 1-4 column section (needs façade build) |
| `form_addTab(targetTabId?, columns?, displayName?)` | `{ ok, result }` — add a 1-3 column tab (needs façade build) |
| `form_setFieldProps(fieldLogicalName, props)` | `{ ok, result:{ applied } }` — set label/visible/readonly/showLabel/locked/availableForPhone (any build) |
| `form_removeControl(fieldLogicalName)` | `{ ok, result }` — remove a control (any build) |
| `form_moveControl(fieldLogicalName, targetElementId, position?)` | `{ ok, result }` — move a control (any build) |
| `form_getControl(fieldLogicalName)` | `{ ok, result: { classId, dataFieldName, customControls:[{name}], label, visible, readonly, locked, showLabel } }` — the read-back/verify for set ops |

## Notes & limits

- **Form field add** and **custom-control discovery** (`form_listControls` /
  `form_describeControl` / `form_getControl`) work on any build. **Setting** /
  **placing** a control (`form_setControl` / `form_addComponent`) needs the
  first-party façade build. Move / set-props / add tab|section|column / events /
  save are the next verbs.
- `params` are applied for both `form_setControl` and `form_addComponent` (via the
  designer's own model API); the result's `appliedParams` echoes what stuck. Use
  `form_describeControl` to learn a control's `requiredParams` + schema. PowerBI's
  `PowerBIReport` takes a report **uniqueName** (a real one from the env).
- If `designer_status` reports `source: fiber`, the handle came from the React
  fiber walk (works on the deployed build); `source: export` means the
  first-party `window.__formDesignerApi` is live. See the design spec / POC
  findings in the `powerplatform-modelpages-ade` repo (`docs/ModelMaker/`).
- The relay serializes designer ops (one at a time) with per-op timeouts.

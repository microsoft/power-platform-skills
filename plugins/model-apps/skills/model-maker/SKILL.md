---
name: model-maker
description: Co-authors model-driven FORM artifacts live in the designer. Use when the user says "edit form X", "add a field to the <table> form", "co-author a form", "open the form designer", or wants an agent to change a model-driven form's layout. Drives the designer's own commands via the designer-relay MCP server so changes render live (WYSIWYG) with the designer's real validation. Not for genux pages (use /genpage), tables/columns (use the plugin's DV scripts), or canvas apps.
allowed-tools: Read, Bash, Glob, Grep, mcp__designer-relay__designer_open, mcp__designer-relay__designer_status, mcp__designer-relay__form_inspect, mcp__designer-relay__form_addField
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

## Tools (designer-relay)

| Tool | Returns |
| --- | --- |
| `designer_open(url)` | opens the form, waits for readiness, returns status |
| `designer_status` | `{ ok, source, capability }` |
| `form_inspect` | `{ ok, result: { formType, sections:[{id}], available:[{name,displayName}] } }` |
| `form_addField(fieldLogicalName, targetSectionId, force?)` | `{ ok, result }` or `{ ok:false, validation }` (e.g. duplicate-field) |

## Notes & limits

- Only **form field add** is wired today (the proven thin slice). Move /
  set-props / add tab|section|column / events are the next verbs.
- If `designer_status` reports `source: fiber`, the handle came from the React
  fiber walk (works on the deployed build); `source: export` means the
  first-party `window.__formDesignerApi` is live. See the design spec / POC
  findings in the `powerplatform-modelpages-ade` repo (`docs/ModelMaker/`).
- The relay serializes designer ops (one at a time) with per-op timeouts.

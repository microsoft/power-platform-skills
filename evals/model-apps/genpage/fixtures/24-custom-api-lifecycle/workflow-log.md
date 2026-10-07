# Synthetic workflow evidence

Constructed from custom-api.md and SKILL.md Phases 4.6/6, not an agent capture.

## Phase 0 - Working directory
Working directory created: D:\work\custom-api-lifecycle.

## Phase 1 - Planning
- node --version -> v20.20.2
- pac help -> PAC CLI Version 2.11.0 (> 2.10.0)
- pac auth list -> active environment https://contoso.crm.dynamics.com; maker@contoso.com
- Unattended default: interaction mode -> unattended (synthetic)
- Unattended default: new or edit -> create new page
- Solution selection question SKIPPED (code-only flow).
- The existing server contract declares Action output NewStatus and Function output Total.

## Phase 1 - Builder gate and discovery
- Command: node scripts\lib\feature-flags.js custom-api
- Result: enabled, exit 0.
- Command: node scripts\list-custom-apis.js https://contoso.crm.dynamics.com --entities salesorder
- Result: discovery in tool-results.json; exact names, kinds, bound entity and parameterKinds.
- Unattended default: plan approval -> approved

## Phase 4.6 - Re-probe before generation
- Command: node scripts\lib\feature-flags.js custom-api
- Result: enabled, exit 0; this is the fresh probe after discovery and planning.
- actions.json is the bare array matching the plan and discovered metadata.

## Phase 5 - Runtime generation
- Write page.tsx; actual snapshot is stages/with-api.tsx.
- Bound Action uses executeAction and host recordId; global Function uses executeFunction without boundTo.
- Response.ok precedes outputs; errors use sanitized message, the Action has a latch and no indeterminate auto-retry.

## Phase 6 - Create
- Command: node scripts\genpage-upload.js --code-file page.tsx --actions actions.json --name-file page-name.txt --prompt-file create-prompt.txt --agent-message-file create-message.txt --add-to-sitemap
- Prompt scope: full User Requirements.
- Result: create in tool-results.json; created/config.json has both bindings.

## Edit Phase 6 - Preserve
- Command: node scripts\lib\feature-flags.js custom-api
- Result: enabled.
- Write page.tsx; snapshot stages/with-api.tsx remains unchanged.
- Command: node scripts\genpage-upload.js --page-id 99999999-9999-4999-8999-999999999999 --code-file page.tsx --prompt-file preserve-prompt.txt --agent-message-file preserve-message.txt
- Prompt scope: spacing-only edit; --actions omitted, preserved/config.json retains both entries.

## Edit Phase 6 - Explicit clear
- Command: node scripts\lib\feature-flags.js custom-api
- Result: enabled.
- Write page.tsx; final source contains no API calls.
- Command: node scripts\genpage-upload.js --page-id 99999999-9999-4999-8999-999999999999 --code-file page.tsx --actions clear-actions.json --prompt-file clear-prompt.txt --agent-message-file clear-message.txt
- Prompt scope: remove both controls and clear bindings; clear-actions.json is [], cleared/config.json is empty.

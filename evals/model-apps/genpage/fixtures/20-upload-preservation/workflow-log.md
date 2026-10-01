# Synthetic workflow evidence

Constructed transport/read-back cases, not a captured agent run. Create and edit have independent page identities.

## Phase 0 - Working directory
Working directory created: D:\work\upload-preservation.

## Phase 1 - Planning
- node --version -> v20.20.2
- pac help -> PAC CLI Version 2.11.0 (> 2.10.0)
- pac auth list -> active environment https://contoso.crm.dynamics.com; maker@contoso.com
- Unattended default: interaction mode -> unattended (synthetic)
- Unattended default: new or edit -> create new page, followed by an independent edit preservation case
- Solution selection question SKIPPED (code-only flow).
- Unattended default: plan approval -> approved

## Phase 6 - Create transport
- File-writing tool wrote create/page-name.txt, create/prompt.txt and create/agent-message.txt verbatim.
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --code-file revenue.tsx --name-file create\page-name.txt --prompt-file create\prompt.txt --agent-message-file create\agent-message.txt --model gpt-4.1 --add-to-sitemap`
- Prompt scope: full User Requirements, including quotes and the final newline.
- Result: create in tool-results.json. PAC seam and read-back retain Revenue $100 $(Get-Date) without shell expansion.

## Edit Phase 6 - Preserve omitted metadata and bindings
- Downloaded config and own-page metadata are stored separately in edit/.
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --page-id 88888888-8888-4888-8888-888888888888 --code-file revenue.tsx --prompt-file edit\prompt.txt --agent-message-file edit\agent-message.txt`
- Prompt scope: Add sorting only.
- Name/model/connectors/actions/data-sources flags omitted. Associated reads and forwarding retain the own name, model, account and untouched binding sets; the sitemap title is independent.
- Result: edit in tool-results.json, read back in edit/config-after.json and edit/page-after.json.

## Phase 6 - Straight-quote refusal control
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --code-file revenue.tsx --name-file quote\page-name.txt --prompt-file create\prompt.txt --agent-message-file create\agent-message.txt --model gpt-4.1 --add-to-sitemap`
- Result: quote-refusal, ok:false, zero PAC writes. The approved name was not rewritten to bypass refusal.

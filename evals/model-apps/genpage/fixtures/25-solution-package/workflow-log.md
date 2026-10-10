# Synthetic workflow evidence

Constructed from SKILL.md Phase 6.7, not an agent capture. The malformed-id control is independent and writes nothing.

## Phase 0 - Working directory
Working directory created: D:\work\solution-package.

## Phase 1 - Planning
- node --version -> v20.20.2
- pac help -> PAC CLI Version 2.11.0 (> 2.10.0)
- pac auth list -> active environment https://contoso.crm.dynamics.com; maker@contoso.com
- Unattended default: interaction mode -> unattended (synthetic)
- Unattended default: new or edit -> create new pages
- Solution selection question SKIPPED for create (code-only flow).
- Unattended default: plan approval -> approved, including explicit optional packaging into ContosoPages.

## Phase 6 - Deployment
- Command: node scripts\genpage-upload.js --code-file list.tsx --connectors connectors.json --name-file names\list.txt --prompt-file prompt.txt --agent-message-file agent-message.txt --add-to-sitemap
- Command: node scripts\genpage-upload.js --code-file schedule.tsx --name-file names\schedule.txt --prompt-file prompt.txt --agent-message-file agent-message.txt --add-to-sitemap
- Command: node scripts\genpage-upload.js --code-file metrics.tsx --name-file names\metrics.txt --prompt-file prompt.txt --agent-message-file agent-message.txt --add-to-sitemap
- Prompt scope: full User Requirements.
- Results: three associated deployed page ids in tool-results.json.

## Phase 6.7 - Packaging
- Command: node scripts\provision-solution.js https://contoso.crm.dynamics.com ContosoPages Contoso
- Result: target unique name and solution id in tool-results.json.
- Command: node scripts\add-page-to-solution.js https://contoso.crm.dynamics.com ContosoPages 11111111-1111-4111-8111-111111111111 --page-ids 22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444 --connection-refs cnt_docs
- Resolve both environment-specific component types and the connection reference before any write.
- Add app first, every page explicitly, then cnt_docs; read-back confirms all direct components plus the pulled sitemap dependency.
- Command: node scripts\dataverse-request.js https://contoso.crm.dynamics.com GET "solutioncomponents?$filter=_solutionid_value eq aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&$select=objectid,componenttype"
- Result: readback in tool-results.json.

## Phase 6.7 - Invalid identity refusal control
- Command: node scripts\add-page-to-solution.js https://contoso.crm.dynamics.com ContosoPages bad-app-id --page-ids 22222222-2222-4222-8222-222222222222,33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444 --connection-refs cnt_docs
- Result: ok:false, Not a GUID; the error is surfaced verbatim. Zero requests and zero writes.

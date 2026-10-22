# Synthetic workflow evidence

Constructed from SKILL.md Phases 6 and 6.5, not a captured agent run.

## Phase 0 - Working directory
Working directory created: D:\work\navigation-contract.

## Phase 1 - Planning
- node --version -> v20.20.2
- pac help -> PAC CLI Version 2.11.0 (> 2.10.0)
- pac auth list -> active environment https://contoso.crm.dynamics.com; maker@contoso.com
- Unattended default: interaction mode -> unattended (synthetic)
- Unattended default: new or edit -> create new page
- Solution selection question SKIPPED (code-only flow).
- Unattended default: plan approval -> approved

## Phase 5 - Generation
Three mock pages were constructed. before/ holds the authored TSX snapshots.

## Phase 6 - Deployment
tool-results.json records three wrapper creates, using name-file, prompt-file and agent-message-file.
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --code-file before\overview.tsx --name-file names\overview.txt --prompt-file prompt.txt --agent-message-file agent-message.txt --model gpt-4.1 --add-to-sitemap`
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --code-file before\pet.tsx --name-file names\pet.txt --prompt-file prompt.txt --agent-message-file agent-message.txt --model gpt-4.1 --add-to-sitemap`
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --code-file before\pet-gallery.tsx --name-file names\pet-gallery.txt --prompt-file prompt.txt --agent-message-file agent-message.txt --model gpt-4.1 --add-to-sitemap`
Prompt scope: full User Requirements.

## Phase 6.5 - Navigation fix-up
The filename-to-page-id map is backed by the three associated create results.
The actual before/after files change only effective navigation pageId spans.
Optional calls, escaped property keys, overwritten early values and Unicode comment terminators are exercised.
Only overview.tsx and pet.tsx reupload with --page-id and a delta --prompt-file; pet-gallery.tsx is byte-identical and does not reupload.
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --page-id 22222222-2222-4222-8222-222222222222 --code-file overview.tsx --prompt-file fixup-prompt.txt --agent-message-file fixup-message.txt --model gpt-4.1`
- Command: `node scripts\genpage-upload.js --env https://contoso.crm.dynamics.com --app-id 11111111-1111-4111-8111-111111111111 --page-id 33333333-3333-4333-8333-333333333333 --code-file pet.tsx --prompt-file fixup-prompt.txt --agent-message-file fixup-message.txt --model gpt-4.1`
Prompt scope: Resolve cross-page navigation placeholders to real page GUIDs (post-deploy fix-up).

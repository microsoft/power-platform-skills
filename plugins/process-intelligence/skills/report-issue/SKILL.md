---
name: report-issue
description: Use when the user wants a Process Intelligence bug-report draft or support summary for a failed operation.
allowed-tools: AskUserQuestion
---

# Draft a Process Intelligence issue

**Draft first, do not submit by default.** There is no fixed destination repository.
Use only the user's supplied information; this workflow performs no diagnostic collection.

1. Capture the symptom, reproduction, expected/actual behavior and sanitized error code.
   Include versions only when supplied. Ask one focused question at a time for missing
   essentials; do not ask again for supplied facts or invent missing details.
2. Do not collect or read logs, profiles, credentials, transcripts or unrelated environment data.
   Do not run authentication, credential checks, shell commands or business calls to prepare a report.
   Remove tokens, claims, usernames, tenant/environment/user identifiers, raw errors,
   tool inputs/results, business values, machine paths and internal URLs from the draft.
3. Show the full preview: intended destination and visibility, title, symptom, reproduction,
   expected/actual behavior, supplied versions and safe error codes. Include supplied session/request
   correlation IDs only after the user reviews them; a private destination is not permission to
   include sensitive data. Allow corrections. Missing evidence does not prove success, failure,
   cancellation or a hung backend.
4. Stop at the draft. Any later submission requires explicit approval of the exact destination
   and final content, through the host's supported issue-creation tool. Do not automatically submit,
   put the report in a URL query, upload files or silently check credentials.

---
name: assign-offline-profile
description: Use when the user needs to bind users or teams to a Mobile Offline Profile so they actually receive offline sync on their devices. Without this, the profile exists in Dataverse but no one's app uses it.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

**References:**

- [offline-profile-schema.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-schema.md) — `usermobileofflineprofilemembership` / `teammobileofflineprofilemembership` entity field map
- [dataverse-offline-api.md](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md) — Web API recipe (§12 — membership POSTs)

# Assign Offline Profile

Bind one or more users and/or teams to an existing Mobile Offline Profile. Without this step, the profile exists in Dataverse but is unbound — no one's app actually uses it for offline sync.

Per the maker portal's UX (the "Assign profile to user" dialog under env settings), this is a separate operation from profile creation. Many users hit "I created the profile but offline still doesn't work" — the missing piece is membership.

## Workflow

1. Verify project + locate profile → 2. Pick users/teams → 3. Discover existing memberships → 4. Confirm diff (single gate) → 5. POST memberships → 6. Verify → 7. Summary

---

### Step 1 — Verify project + locate profile

```bash
test -f power.config.json
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Profile ID resolution (in order):

| Source | Used when |
|---|---|
| `$ARGUMENTS` contains `--profile-id <guid>` | Explicit override |
| `$ARGUMENTS` contains `--profile-name <name>` | Resolve via `GET /mobileofflineprofiles?$filter=name eq '<name>'&$select=mobileofflineprofileid` |
| `offline-profile.json` in cwd | Read top-level `profileId` field |
| Otherwise | `GET /mobileofflineprofiles` and present `AskUserQuestion` with the list (max 4 options) |

STOP if no profile can be resolved. Print: `Run /setup-offline-profile first, or pass --profile-id`.

> **`power.config.json` is intentionally NOT consulted here.** That file is owned by `npx power-apps init`. The profile ID lives in `offline-profile.json` only.

### Step 2 — Pick users/teams

`$ARGUMENTS` parsing:

| Flag | Effect |
|---|---|
| `--user <upn>` (repeatable) | Add specific user(s) by UPN (`user@domain.com`) |
| `--team <name>` (repeatable) | Add specific team(s) by name |
| `--me` | Add the current Dataverse user from `WhoAmI` / `systemusers(<UserId>)` — useful for solo dev demos |
| `--all-app-users` | Add every user with **System User** role in the current env (broad; intended for prod rollout — confirm at gate) |
| `--unassign-user <upn>` / `--unassign-team <name>` | Remove an existing membership rather than add |

If no flags passed, present `AskUserQuestion`:

> **Question**: "Who should receive this offline profile?"
>
> **Options** (max 4):
> - `Just me (the current user)` — equivalent to `--me`
> - `Pick specific users by UPN` — you reply with comma-separated emails in the next message
> - `Pick a team` — list env's teams and pick one
> - `All users with System User role` — equivalent to `--all-app-users`; broad scope, confirm at gate

For pick-users flow: after the choice, print:

> "Reply with comma-separated UPNs (e.g. `rm1@contoso.com, rm2@contoso.com`)"

Then read the next user message and parse.

### Step 3 — Discover existing memberships

For idempotency:

```bash
# Existing user memberships for this profile
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "usermobileofflineprofilememberships?\$filter=_mobileofflineprofileid_value eq <profileId>&\$select=usermobileofflineprofilemembershipid,_systemuserid_value&\$expand=systemuserid_systemuser(\$select=domainname)"

# Existing team memberships for this profile
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "teammobileofflineprofilememberships?\$filter=_mobileofflineprofileid_value eq <profileId>&\$select=teammobileofflineprofilemembershipid,_teamid_value&\$expand=teamid_team(\$select=name)"
```

Build the set of `already-bound` UPNs and team names.

For each candidate user/team from Step 2, look up their `systemuserid` / `teamid` (skip if already in `already-bound`):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "systemusers?\$filter=domainname eq '<upn>'&\$select=systemuserid,fullname,domainname&\$top=1"

node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "teams?\$filter=name eq '<team-name>' and teamtype eq 0&\$select=teamid,name&\$top=1"
```

(`teamtype eq 0` excludes Access Teams and Owner Teams — only Manage Teams get profile assignments.)

Construct three lists:
- `to_add` — resolved IDs to POST
- `to_remove` — resolved IDs to DELETE (from `--unassign-*` flags)
- `not_found` — UPNs/team-names that didn't resolve (warn)
- `already_bound` — skipped no-ops

### Step 4 — Confirm diff (single gate)

`AskUserQuestion`:

> **Question header**: `Confirm membership changes`
>
> **Question body**:
>
> ```
> Profile: <name> (<profileId>)
>
> Will ADD:
>   - User: rahul@contoso.com (Rahul Bansal)
>   - User: charanma@... (Charan Mahankali)
>   - Team: Field Service RMs (12 members)
>
> Will REMOVE:
>   (none)
>
> Already bound (skipping):
>   - User: admin@... (no-op)
>
> Could not resolve:
>   - someone@external.com — not in this env's system users
>
> Proceed?
> ```
>
> **Options**:
> - `Proceed`
> - `Cancel`

### Step 5 — POST memberships

For each in `to_add`, POST sequentially (parallel POSTs occasionally return 429):

**User membership:**

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "usermobileofflineprofilememberships" \
  --body '{
    "MobileOfflineProfileId@odata.bind": "/mobileofflineprofiles(<profileId>)",
    "SystemUserId@odata.bind": "/systemusers(<systemuserid>)"
  }' \
  --include-headers
```

Expected 204 with `OData-EntityId` → capture membership GUID.

**Team membership:**

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "teammobileofflineprofilememberships" \
  --body '{
    "MobileOfflineProfileId@odata.bind": "/mobileofflineprofiles(<profileId>)",
    "TeamId@odata.bind": "/teams(<teamid>)"
  }' \
  --include-headers
```

For each in `to_remove`, DELETE:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> DELETE \
  "usermobileofflineprofilememberships(<membershipid>)"
```

> **⚠️ Duplicate handling:** POSTing a membership that already exists returns `409 Conflict`. The `dataverse-request.js` wrapper's `looksLikeDuplicate` rescue treats this as silent success (the Step 3 dedup should catch most cases first). Re-runs are safe.

### Step 6 — Verify

Re-query memberships from Step 3 and assert the diff applied:
- Every `to_add` now appears in the GET response
- Every `to_remove` no longer appears

If the verification disagrees, return `BLOCKED: membership writes did not commit` and print the discrepancy.

### Step 7 — Summary

Print:

```
✓ Membership updates applied.

  Profile      : <name>
  Total members: <N users + M teams>
  Added        : <list>
  Removed      : <list>
  Skipped      : <list> (already bound)

Users will receive the profile on their next mobile app sign-in. Existing
sessions need to sign out + sign in to trigger the profile pull.
```

Update `memory-bank.md` `## Offline profile` block:

```yaml
membership:
  users: [rahul@..., charanma@...]
  teams: [Field Service RMs]
  lastAssignedAt: 2026-05-19T...
```

## Status code (final line)

- `DONE` — every requested add/remove applied; verify confirmed
- `DONE_WITH_CONCERNS: <list>` — some UPNs/teams could not be resolved, or `--all-app-users` matched 0 users (env may not have the role granted yet)
- `NEEDS_CONTEXT: <missing>` — couldn't determine profileId (no offline-profile.json, no --profile flags, no profiles in env)
- `BLOCKED: <reason>` — auth failure, profile not found in env, or verification disagreement

## Failure recovery

Memberships are individually committed (no transaction). If Step 5 fails mid-loop:
- Partially-added memberships remain (visible in env)
- Re-running with the same arguments is idempotent (Step 3 dedup catches what's already bound)
- Use `--unassign-*` to undo specific bindings if needed

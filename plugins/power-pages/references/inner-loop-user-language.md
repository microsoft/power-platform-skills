# Inner-Loop User-Language Style

**Audience:** Authors of inner-loop SKILL.md files (`git-configure`, `git-sync`) and the agent narrating their execution.

**Goal:** Inner-loop skills speak to **end users**, not to developers reading API docs. The user should see **what's happening**, not **how the helpers do it**. This file is the single source of truth for that voice — every inner-loop SKILL.md links here instead of restating the rules.

---

## 1. Hard rules — never appear in user-facing chat

These leak helper internals and confuse non-developer users:

| Don't say | Why | Say instead |
|---|---|---|
| `ConnectionType=0` / `ConnectionType=1` | Raw OData field — meaningless to users. | "solution binding" / "environment binding" |
| `bound: true` / `bound: false` | Raw helper-output JSON. | "Connected." / "Not connected." |
| `enabledForSourceControlIntegration: true` | Raw Dataverse column name. | "source control is enabled for this solution" (only if relevant) |
| `sourcecontrolsyncstatus: 1` / `: 3` | Raw enum code. | "staging in progress" / "synced" |
| `ConnectToGit` / `DisconnectFromGit` / `RefreshChangesFromGit` / `CommitToGit` | Raw OData action names. | "connect to Git" / "disconnect" / "refresh from Git" / "commit" |
| `cleanState: "Clean"` | Raw helper JSON. | "Workspace is clean." |
| `pendingChangesCount: 167` | Raw JSON. | "167 pending changes" (in prose) |
| `gitintegrationid`, `sourcecontrolconfigurationid`, `sourcecontrolbranchconfigurationid` | Raw entity / column names. | Don't mention; these are server bookkeeping. |
| Raw helper stdout pasted as a JSON block | Looks like a console dump. | Distill into a one-line plain-English summary. |
| GUIDs in success messages | Visual noise (`52cdfb68-415e-...`). | Use friendly names; show GUIDs **only when something fails** so the user can give them to support. |
| Gate IDs / marker IDs (`git-configure:6.consent-setup`) | Internal scaffolding. | Just ask the question. |

## 2. Soft rules — fine in moderation

These can appear when they help the user:

- **Solution unique names** (e.g. `SPATest`, `InternLearning`) — yes, these are user-set and recognizable.
- **Branch names**, **repo names**, **ADO org/project names** — yes, the user picked them.
- **Folder paths** like `/solutions/SPATest/` — yes, helps users find files in ADO.
- **Counts** in prose ("2 pending changes", "12 conflicts") — yes.
- **HTTP status codes only on failure** — for support, not for success paths.

## 3. Phase / progress numbering

Inner-loop skills have 8–11 internal phases, but a single user request rarely touches all of them (e.g. disconnect skips Phase 3 and 4). The user should see a clean sequential progress count for THEIR run — internal phase numbers stay internal.

**Pattern:**

```
Phase {N} — {plainTitle}
```

- `N` = sequential 1, 2, 3, … counting only phases that actually fire on this run.
- `plainTitle` = a 2–4 word user-friendly title (no "Render Plan + Single Consent Gate" — say "Plan & consent" instead).

**Example — disconnect run:**

```
Phase 1 — Detecting what to do
Phase 2 — Discovering current binding
Phase 3 — Preflight checks
Phase 4 — Verifying workspace is clean
Phase 5 — Plan & consent
Phase 6 — Disconnecting
Phase 7 — Verifying & saving record
Phase 8 — Done
```

**Example — setup run:**

```
Phase 1 — Detecting what to do
Phase 2 — Discovering project & environment
Phase 3 — Preflight checks
Phase 4 — Choosing binding strategy
Phase 5 — Choosing ADO coordinates
Phase 6 — Plan & consent
Phase 7 — Connecting
Phase 8 — Verifying & saving record
Phase 9 — Done
```

The agent should **announce the visible phase title before starting work** in that phase, then **report a one-line outcome** when the phase finishes. No need to announce phases that auto-complete in <1s. Never show the internal SKILL.md phase number to the user.

## 4. The plan-render table — keep as-is

The current pre-consent plan table format is already user-friendly — keep it:

```
Git Configuration Plan
Action: Connect SPATest to Git (solution binding)

| Environment | prod-sri-pp-alm — https://orge5975cc4.crm.dynamics.com/ |
| Solution    | SPA Test (SPATest) v1.0.0.0                              |
| ADO target  | GitIntegration22 / priyanshu-alm / alm-test              |
| Branch      | main                                                     |
| Path        | /solutions/SPATest/                                      |

Reversibility: Reversible — disconnect later via /power-pages:git-configure.
Blast radius: Solution-scoped. …
Preflight: All green (Managed Env Standard, no CMK, license available, …).
```

Notice: the **Action** line uses plain language ("Connect SPATest to Git"), not the OData verb. The preflight one-liner can mention technical concepts (Managed Env, CMK, license) because those are user-recognizable platform terms.

## 5. Status updates and progress

Status updates ARE wanted — users like seeing the skill making progress. But every update must be **about what changed for the user**, not about which API call returned what shape.

| Don't say | Say instead |
|---|---|
| "Ran 1 shell command. Binding succeeded — bound: true (first solution binding on this env)." | "Connected. SPATest is now Git-tracked under /solutions/SPATest/." |
| "Server confirms the binding is live: SPATest → GitIntegration22/priyanshu-alm/alm-test@main, enabledForSourceControlIntegration: true, sync status 1 (staging in progress), 2 pending changes so far." | "SPATest is wired up. The platform is staging components in the background — 2 pending changes so far. I'll wait until the count stabilises before reporting." |
| "DisconnectFromGit returned 204 immediately; binding cleared after ~45s async cleanup." | "Disconnected. The platform finished cleanup in ~45 s." |
| "RefreshChangesFromGit complete (statecode 3 = Succeeded)." | "Refreshed from Git." |

## 6. Failure reporting — different rules

When something fails, **do** include the technical details — the user needs them for self-help or support:

- HTTP status codes (404, 409, 0x80040217, etc.).
- The relevant GUID(s) for the failed record.
- The exact error message from Dataverse / ADO.
- A one-line "what to try next" recommendation.

But still avoid raw JSON dumps — format the failure as a short structured message:

```
❌ Connect failed.
Reason: Folder /solutions/SPATest/ on main already has 47 items from another solution.
Fix: Run /power-pages:git-configure again and pick a different folder name, or remove
the existing content from ADO first.
For support: gitIntegrationId 386e71c8-a011-42b0-a04b-1ef89b752683
```

## 7. Quick reference — translation table

Use these phrasings consistently across all inner-loop skills:

| Internal concept | User-facing phrase |
|---|---|
| Solution binding (`ConnectionType=0`) | "solution binding" or "this solution is Git-tracked" |
| Environment binding (`ConnectionType=1`) | "environment binding" or "the whole environment is Git-tracked" |
| `ConnectToGit` action | "connect" / "wire up Git" |
| `DisconnectFromGit` action | "disconnect" |
| `RefreshChangesFromGit` action | "refresh from Git" / "pull updates" |
| `CommitToGit` action | "commit" / "push to Git" |
| `sourcecontrolsyncstatus 1` | "staging in progress" |
| `sourcecontrolsyncstatus 3` | "synced" |
| `pendingChangesCount > 0` | "{N} pending changes" |
| `cleanState Clean` | "workspace is clean" |
| `cleanState Dirty` | "workspace has uncommitted changes" |
| `bound: true` | "connected" |
| `bound: false` | "not connected" |
| Async-still-syncing timeout | "the platform is still working in the background" |
| Server-side bookkeeping records | (don't mention) |

When in doubt: read the line aloud. If it sounds like API documentation, rewrite it.

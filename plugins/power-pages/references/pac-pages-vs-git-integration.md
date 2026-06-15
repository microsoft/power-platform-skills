# `pac pages upload-code-site` vs Git Integration

Workflow guidance for Power Pages developers who use both **PAC CLI direct uploads** (the existing `deploy-site` workflow) **and** Dataverse **Git integration** (this project's inner-loop skills).

> Built from the architecture doc §3.5 footgun #6 and what we know about how `pac pages upload-code-site` interacts with the underlying solution.

---

## 1. The surprise in one sentence

`pac pages upload-code-site` writes directly to the **same `mspp_webfile` rows in Dataverse** that Connect-to-Git is tracking. So every PAC upload **shows up as pending Changes** in the Source-control tab the next time you open it — even if you "just wanted to test something quickly."

---

## 2. Why this happens

Power Pages code sites compile a React/Vue/Angular/Astro app into a folder of assets, and `pac pages upload-code-site` uploads each asset as an `mspp_webfile` Dataverse row (plus updating site config rows). Those rows belong to the Power Pages site solution. Git integration tracks **every unmanaged-solution component**, including `mspp_webfile`. So:

- Edit a `.tsx` file locally → run `pac pages upload-code-site` → those files are now in Dataverse → Git integration sees N changed web files → they appear in the Changes tab → next `CommitToGit` includes them.

There's no separation between "deployed via PAC" and "edited via maker portal" once a component is in the env. Dataverse only knows the row's current state.

---

## 3. Two valid workflow patterns

### Pattern A — "Build locally, commit on the build server"

For teams that treat the code site as a single deployable artifact:

```
   Local dev → npm run build → pac pages upload-code-site → commit-to-git
```

- Devs work in their IDE, run a local preview, push the build to Dataverse via PAC.
- Inner-loop skills are used to commit the bundled web files to Git after a successful upload.
- One commit per upload cycle (squash-merged automatically by the platform for large solutions).
- Recommended for: code-only sites with no maker-portal-editable content.

### Pattern B — "Edit in maker portal, push via Git"

For teams that mix code-site content with maker-portal-edited content (Web Templates, content snippets, table permissions):

```
   Maker portal edit → commit-to-git (immediately)
   Local dev → npm run build → pac pages upload-code-site → commit-to-git
```

- Two distinct sources of changes (UI + code), both flowing through Git integration.
- Devs should `commit-to-git --dry-run` before every commit to see the mix.
- Recommended for: hybrid sites.

---

## 4. The race condition to avoid

If a dev runs `pac pages upload-code-site` **while there are already pending Changes** from a maker-portal edit:

- Both sets of changes commingle in the Changes tab.
- The next `CommitToGit` bundles them under one commit message.
- The audit trail becomes "the developer pushed 12 changed files" with no separation of "I edited Header in the portal" vs "I rebuilt the bundle and uploaded it."

**Mitigation in our skills:**

1. `commit-to-git` Phase 4 (plan rendering) **always lists each component by name** before asking for the commit message — so even commingled changes are visible to the user.
2. `commit-to-git --dry-run` warns if it detects a mix of `mspp_webfile` (likely from PAC upload) AND other component types (maker-portal edits) AND the list is large (> 20 items): *"Looks like a code-site upload commingled with maker-portal edits. Consider committing one batch at a time for cleaner history. Continue, or split?"*
3. `plan-inner-loop` surfaces this as Pattern IL-012 in `inner-loop-error-catalog.md` if a deployment-time failure traces back to it.

---

## 5. Recommended interaction sequence

When using both PAC and Git integration in the same project:

| Step | Why |
|---|---|
| 1. `plan-inner-loop` → confirm `Connected & Clean` | Don't start an upload on top of pending state |
| 2. `npm run build` | Build outside the agent so failures surface early |
| 3. `/power-pages:deploy-site` (runs `pac pages upload-code-site`) | Uploads the build to Dataverse |
| 4. `plan-inner-loop` → expect `Dirty` now | Confirm the upload landed |
| 5. `/power-pages:git-sync --dry-run` | Pre-flight check (file sizes, supported types) |
| 6. `/power-pages:git-sync --commit` with a meaningful message | Captures *what* was deployed in Git audit trail |
| 7. (Optional) `/power-pages:open-pr` | Code review of the upload before it merges to `main` |

This is the **same number of total commands** as the manual workflow today, but each step is automated, verified, and recoverable.

---

## 6. What the user must NOT do

- ❌ Don't run `pac pages upload-code-site` to "preview your design" without intending to commit. The upload is durable in Dataverse; it will be in the next commit unless you `revert-workspace` it.
- ❌ Don't manually delete `mspp_webfile` rows in Dataverse to "clean up" pending Changes — that creates a "deleted in env" entry that propagates to Git on next commit. Use `revert-workspace` instead.
- ❌ Don't run `pac pages download-code-site` to "reset" — that re-syncs the local working copy from the env, which is correct, but does NOT clear pending Changes in Dataverse.

---

## 7. References

- [Power Pages code sites (overview)](https://learn.microsoft.com/power-pages/configure/create-code-sites)
- [PAC CLI `pac pages` reference](https://learn.microsoft.com/power-platform/developer/cli/reference/pages)
- This repo: `skills/deploy-site/SKILL.md` — the canonical PAC upload skill
- This repo: `skills/commit-to-git/SKILL.md` — the inner-loop commit skill
- Architecture doc §3.5 (the original footgun list)

# Conflict Resolution Patterns

UX and behavior reference for `resolve-conflicts`, `sync-from-git`, and any future skill that surfaces a Dataverse Git integration "Conflicts" tab to the user.

> Built from [Microsoft Learn: Source control repository operations § Conflict resolution](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations#conflict-resolution).

---

## 1. What "Conflict" means in Connect-to-Git terms

A **conflict** is a Dataverse component (web page, web template, table, plugin, env var, etc.) that has been changed in **both**:

- The current environment (sitting in the Changes tab), AND
- The bound ADO branch (incoming from `RefreshChangesFromGit`, sitting in the Updates tab),

…since the last successful commit-or-pull cycle. The platform detects this by comparing the per-component hash in Dataverse against the per-component hash in Git.

> 🧠 **Conceptual model.** This is **not** a textual three-way merge like `git merge`. Dataverse Git integration tracks one hash per component, not line-level changes. The user picks "keep mine" or "accept theirs" **per component**; there is no "merge the two versions" option.

---

## 2. The two resolution actions

| Action | API/Platform effect | Tab the component moves to |
|---|---|---|
| **Keep existing changes** | The env's version is marked authoritative; the Git version is marked superseded | **Changes** (now safe to commit) |
| **Accept incoming changes** | The Git version is marked authoritative; the env's version is marked superseded | **Updates** (now safe to pull) |

> ⚠️ Resolving a conflict via either action does **not** immediately mutate the env or the repo. It just **marks the decision** so that the next `CommitToGit` (for "keep existing") or `PullChangesFromGit` (for "accept incoming") proceeds without re-detecting the conflict.

The two helpers that implement these are `resolve-conflict-keep.js` and `resolve-conflict-accept.js`. Both call platform APIs that mark the component on the conflict list; neither performs the actual commit/pull.

---

## 3. The "deleted in Git" sub-case

A component can appear in the Conflicts tab as **deleted in Git, modified locally**:

- The user (or a teammate) deleted the component from the bound branch.
- The user has unsaved local changes to the same component.

For this sub-case, the resolution choice becomes:

| Choice | Effect |
|---|---|
| **Keep existing** (your local change) | The component will be re-committed to Git on the next `CommitToGit`, effectively undeleting it. |
| **Accept incoming** (the deletion) | The next `PullChangesFromGit` will delete it from your env. If you also pass `DeleteDeletedComponents: true`, the env-level row is hard-deleted; otherwise it's just removed from the solution. |

The `resolve-conflicts` skill must surface this distinction explicitly — a flat "accept incoming" without telling the user it means deletion is a foot-gun.

---

## 4. UI / HTML report contract

`resolve-conflicts` renders `docs/inner-loop/conflicts.html` with **one card per conflict**. Each card must show:

| Field | Source | Notes |
|---|---|---|
| Component type + display name + GUID | `list-conflicts.js` | e.g., "Web Template — Header — `abc-123…`" |
| "Local" side preview | Read from Dataverse | YAML diff or formatted summary (mspp_webpage HTML excerpt, etc.) |
| "Incoming" side preview | Fetched from ADO via `ado-client.js` | YAML excerpt from the bound branch at `<rootFolder>/<solution>/<componentPath>` |
| Last-modified-by + when (local) | `modifiedby`, `modifiedon` Dataverse columns | Helps user judge whose change is newer |
| Last-modified-by + when (incoming) | ADO commit metadata for the file | |
| "Deleted in Git" warning banner | If incoming side returns 404 from ADO | Triggers §3 sub-case |
| Two buttons: **Keep existing** / **Accept incoming** | — | Map to the two helpers above |

The HTML template lives under `skills/resolve-conflicts/assets/conflicts.html`.

---

## 5. Bundling rule (anti-prompt-fatigue)

Per the gate lint rules: **if there are more than 3 conflicts, the skill must bundle the decisions into one `AskUserQuestion` with a table**, not prompt 30 times in a row.

Implementation pattern:

```
if (conflicts.length <= 3) {
  for each conflict:
    askUser({ category: 'progress', options: ['Keep existing', 'Accept incoming'] })
}
else {
  renderHtml(conflicts.html)
  askUser({
    category: 'progress',
    text: "Open docs/inner-loop/conflicts.html and pick a decision for each component below.",
    options: ['I'm done — apply my decisions', 'Cancel — leave conflicts untouched'],
    bundledTable: conflicts.map(c => ({ name: c.displayName, choice: '<dropdown>' }))
  })
}
```

The bundled choice is then applied via N parallel `resolve-conflict-keep.js` / `resolve-conflict-accept.js` calls. Failures are surfaced per-component without rolling back the successes (graceful-failure principle).

---

## 6. "Resolve before pull" rule

Connect-to-Git enforces that **`PullChangesFromGit` cannot proceed while Conflicts > 0**. The `sync-from-git` skill flow:

1. `refresh-changes-from-git.js` → populates Updates + Conflicts
2. If `conflicts > 0`: dispatch `resolve-conflicts` (sub-skill or direct invocation)
3. After `resolve-conflicts` reports Conflicts = 0: continue to `pull-changes-from-git.js`

`sync-from-git` must verify Conflicts = 0 via a fresh `list-conflicts.js` call **after** `resolve-conflicts` returns — it cannot trust the sub-skill's exit code alone (Five Pillars §2: verify, don't trust).

---

## 7. Selective 3-way merge (IMPLEMENTED) + remaining v2 items

**Three-way textual merge** of a conflicted component's source field is now **implemented** via the VS Code companion extension. When the user picks **"Selectively merge (recommended)"** in the conflict-decisions gate, the flow assembles BASE/OURS/THEIRS, opens a real 3-way merge in VS Code (with a diff3 pre-seed + AI assistance), commits the merged file to ADO, and accepts + pulls it into the environment. Full spec: `skills/git-sync/references/selective-merge-reference.md`. This replaces the old "export both sides as YAML and merge manually" workaround for text-mergeable types (web template `source`, content snippet `value`, web page `copy`/`summary`).

Still deferred to **v2**:

- **Text web-file merge** (CSS/JS) — web-file bytes live in a separate annotation, not the `powerpagecomponent.content` envelope; v1 routes web files to binary keep/accept.
- **JSON/multi-line site-setting value merge** — the value is embedded in the `.sitesetting.yml`; v1 routes settings to binary keep/accept.
- **Dedicated side-by-side merge editor + in-editor `vscode.lm` refine** — v1 uses conflict-marker resolution with the built-in merge-conflict CodeLens + an agent-computed proposal.
- **Partial resolution** (resolve some conflicts, commit, then resolve others) — the `commit-to-git` path requires zero conflicts before it'll accept the next commit, so users must resolve all of them in one pass.

---

## 8. References

- [Source control operations — view changes](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations#view-changes-in-the-solutions-area)
- [Source control operations — conflict resolution](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations#conflict-resolution)
- [PullChangesFromGit — `DeleteDeletedComponents` option](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/pullchangesfromgit)
- This repo: `references/approval-gates.md` §3 (`progress` category) for the per-conflict gate model.

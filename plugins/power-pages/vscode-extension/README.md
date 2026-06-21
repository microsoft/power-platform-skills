# Power Pages Selective Merge (companion VS Code extension)

The merge UI for the Power Pages inner-loop **selective conflict resolver**. The
Power Pages agent (Copilot CLI) drives Dataverse + Azure DevOps; this extension
provides the in-editor 3-way merge experience that the portal's binary
*accept incoming* / *keep current* buttons can't.

## How it fits together

```
Agent (scripts/lib)                         VS Code extension
──────────────────                          ─────────────────
read OURS (Dataverse) ┐
fetch BASE/THEIRS (ADO)│ build-merge-inputs
                       ▼
   merge-workspace.writeMergeWorkspace()
   • diff3 pre-seed (propose-merge)
   • writes <os-temp>/pp-merge/<runId>/ (secure, owner-only, off-tree)
       manifest.json, units/<id>/{base,ours,theirs,proposed,result}.txt
                       │  vscode://power-pages.powerpages-merge/open?dir=<runDir>
                       ▼
                                    ─────►  read manifest, walk units one-by-one:
                                           • conflicted → native 3-way Merge Editor
                                             (OURS | Result | THEIRS, per-hunk accept)
                                           • clean → open result.txt for review
                                           • fallback → result.txt markers + OURS↔THEIRS diff
                                           • user selectively merges (+ AI help)
                                           • write result.txt + completion.json
                       ◄─────────────────
   merge-workspace.readMergeCompletion()
   • refuses leftover <<<<<<< markers (D6)
                       ▼
   apply-merged-component:
   • commit merged file → ADO (Pushes API)
   • RefreshChangesFromGit → accept-incoming → PullChangesFromGit
   • Dataverse now holds the merged content
```

No network and no open ports between the agent and the extension — the handshake
is a file manifest in a secure, owner-only OS-temp store (`<os-temp>/pp-merge/<runId>/`,
off the project/session tree, wiped on completion). The agent computes the AI/diff3
proposal; **nothing is auto-applied** — a human confirms every merge, and a result
that still contains conflict markers is never committed.

## The bridge contract (`manifest.json`, schemaVersion 1)

```jsonc
{
  "schemaVersion": 1,
  "runId": "merge-…",
  "binding": { "organization": "…", "project": "…", "repository": "…", "branch": "…" },
  "units": [
    {
      "unitId": "Search__source",
      "conflictId": "…", "componentId": "…",
      "componentName": "Search", "componentType": 8, "field": "source",
      "adoPath": "/solutions/…/Search.webtemplate.source.html",
      "status": "mergeable",            // or "add-add"
      "hasConflicts": true, "conflictCount": 1, "eol": "lf",
      "files": { "base": "units/…/base.txt", "ours": "…", "theirs": "…", "proposed": "…", "result": "…" }
    }
  ],
  "binaryComponents": [ /* web files / scalar settings → handled by the agent's keep/accept flow */ ],
  "deferredUnits": [ /* non-mergeable fields inside a merged component (deleted-in-git / identical / path-unresolved) → agent resolves via keep/accept; the extension only displays them */ ]
}
```

The extension edits each unit's `result.txt` in place and writes `completion.json`
when finished. The agent reads the `result.txt` files back.

## Commands

- **Power Pages Merge: Open Merge Run** — manually pick a run folder.
- **Mark Resolved & Next** — save, verify no markers remain, advance to the next unit (status-bar button).
- **Open OURS ↔ THEIRS Reference Diff** — side-by-side reference for the current unit.
- **Finish & Return to Agent** — write `completion.json`.
- **Cancel Run** — write a `cancelled` completion; nothing is applied.

## Develop / build

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run test:unit     # pure-logic unit tests (node:test)
npm run compile       # esbuild → dist/extension.js
npm run package       # vsce package → .vsix (sideload)
```

`vscode` is a host-provided external; only `dist/extension.js` ships in the `.vsix`.

## Scope (v1)

- Text-mergeable Power Pages component fields: **web template `source`**,
  **content snippet `value`**, **web page `copy`/`summary`**. Web files and scalar
  site settings stay on the agent's binary keep/accept path.
- Resolution uses git-style conflict markers + the built-in merge-conflict
  CodeLens. The dedicated side-by-side 3-way merge editor and in-editor
  `vscode.lm` AI refine are planned for v2.

# Offline Profile ↔ Schema Reconciliation

Keeps a Mobile Offline Profile in sync with the app's Dataverse schema across the whole
development lifecycle. Whenever the data model changes (a table or column is added), the
offline profile can silently fall behind — a new table isn't in the profile, so it never
syncs to the device, and a new column isn't in `selectedColumns`, so it's blank offline.

This reference is the single source of truth for that reconciliation flow. The schema
skills (`/add-dataverse`, `/setup-datamodel`, `/edit-app`) and the publish skill
(`/deploy`) all reference it instead of duplicating the logic.

There are two related-but-distinct offline checks — do not confuse them:

| Script | Question | Network? | Used by |
|---|---|---|---|
| `scripts/offline-profile-delta.js` | Is a table/column in the **schema** but **not in the offline profile** yet? | **No** (local file diff) | schema skills + `/deploy` (this doc) |
| `scripts/verify-offline-profile.js` | Does `offline-profile.json` still match the **live published profile** in Dataverse (drift/reverts)? | Yes (Dataverse) | `/setup-offline-profile` Step 9.5 |

---

## The delta check

```bash
node "${PLUGIN_ROOT}/scripts/offline-profile-delta.js" [--project-root <path>]
```

Purely local and deterministic — no `az` token, no Dataverse call — so it is safe and
fast to run as a gate. It auto-locates `.datamodel-manifest.json` (root or
`docs/plan-artifacts/`) and `offline-profile.json` (root). Output is single-line JSON on
stdout; exit `0` when the comparison ran (branch on `status`), exit `1` on a fatal error
(bad args, an explicit `--manifest`/`--profile` path that doesn't exist, or an
unreadable/invalid JSON file).

| `status` | Meaning | What to do |
|---|---|---|
| `no-manifest` | No Dataverse schema in the project (connectors-only, or data model not applied). | Nothing to reconcile. Continue silently. |
| `no-profile` | The app has a data model but **no** offline profile. | The app never set up offline (or opted out). Do **not** auto-run an edit. Offer `/setup-offline-profile` only if the user wants offline; otherwise continue. |
| `in-sync` | Every schema table is in the profile and no new columns since each table's baseline. | Continue. |
| `delta` | ≥1 table missing from the profile, and/or ≥1 table has new columns since its baseline. | Reconcile — see below. |
| `error` | Fatal — `offline-profile.json` (or the manifest) is unreadable/invalid JSON; the script also **exits non-zero**. | Surface the `error` string and **stop** (do not treat as `in-sync`/continue): coverage can't be validated against a corrupt file. Skip reconciliation; the user must fix the file and re-run. At `/deploy` this maps to STOP-or-`deploy without offline` override. |

A `delta` result carries:

- `missingTables[]` — `{ logicalName, displayName, status }` for each schema table absent
  from the profile. This is the **strong, always-computable** signal.
- `tablesWithNewColumns[]` — `{ logicalName, itemId, newColumns[] }` for each profiled
  table that gained schema columns since it was last reconciled.
- `columnBaselineMissing[]` — profiled tables whose snapshot predates the `schemaColumns`
  baseline (see below). Column delta can't be computed for these; treat as advisory only.

---

## The `schemaColumns` baseline (why column delta is precise, not noisy)

An offline profile's `selectedColumns` is a **curated subset** — the offline architect
deliberately omits columns that don't need to sync. So "column in the schema but not in
`selectedColumns`" is NOT, by itself, a delta; it's usually an intentional exclusion.

To tell a *genuinely new* column apart from a *deliberately excluded* one, each table
entry in `offline-profile.json` records `schemaColumns` — the set of schema column
logical names that existed when that table was last reconciled into the profile. The
delta is then `manifest.columns − schemaColumns` (new since the baseline), never
`manifest.columns − selectedColumns`.

The offline skills write/refresh this baseline:

- `/setup-offline-profile` (Step 9a) and `/add-table-to-offline-profile` (Step 7) write
  `schemaColumns` = the table's current manifest columns when the item is created.
- `/edit-offline-profile` (Step 6) refreshes `schemaColumns` to the current manifest
  columns after a column edit, re-baselining so a reconciled delta clears.

Legacy snapshots without `schemaColumns` degrade gracefully: table-level delta still
works; the table is reported under `columnBaselineMissing` instead of producing false
positives. Running `/edit-offline-profile --table <t> --columns reset` re-establishes the
baseline.

---

## Reconcile a `delta` (schema skills)

After a schema change, when the delta is `delta`, prompt the user (one `AskUserQuestion`,
default = update now):

> "You changed the data model. `<N>` new table(s) and `<M>` new column(s) aren't in the
> offline profile `<name>` yet, so they won't sync to devices. Update the offline profile
> now?"
> - **Yes — update the offline profile (recommended)**
> - Skip — I'll run it later (it will be re-checked at `/deploy`)

On **Yes**, apply in this order (both are non-interactive when the target is explicit):

1. For each `missingTables[]` entry → `/add-table-to-offline-profile --table <logicalName>`
   (or `--all-new` to add them all at once).
2. For each `tablesWithNewColumns[]` entry →
   `/edit-offline-profile --table <logicalName> --columns add:<comma-separated newColumns>`.

Re-run the delta check afterward; expect `in-sync`. Surface any remaining `delta` as a
concern rather than looping.

Skip the prompt entirely on `no-manifest`, `in-sync`, and `no-profile` (for `no-profile`,
only mention `/setup-offline-profile` if the user has expressed interest in offline).

---

## Gate a `delta` (`/deploy`, the final publish step)

`/deploy` is the last chance to catch schema that never made it into the offline profile
before it ships. Run the delta check **before** `npx power-apps push`:

- `no-manifest` / `no-profile` / `in-sync` → no gate; continue (for `no-profile`, print a
  one-line note that no offline profile exists).
- `delta` → **STOP before pushing.** Print `missingTables` + `tablesWithNewColumns`, then
  offer:
  - **Update the offline profile now** (recommended) → run the reconcile steps above,
    re-check to `in-sync`, then continue to push.
  - **Deploy anyway** → requires an explicit override (type `deploy without offline`),
    mirroring the environment-mismatch gate. A bare `y`/`yes` is not enough — deploying a
    schema the offline profile doesn't cover is a silent data-availability bug on devices.

This makes the deploy gate the backstop for any schema change whose reconciliation prompt
was skipped earlier in the lifecycle.

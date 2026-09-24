# Refresh Flow — `/design-system --refresh <dimension>`

Single-dimension edit to an existing design system. Changes the approved section of `brand/design-system.md` and its token artifact (`brand/tokens.ts` or the optional `brand/tokens.dark.ts`), optionally re-renders the HTML gallery.

Apply [app-edit-routing.md](../../../shared/references/app-edit-routing.md) first.
An approved create/edit child call reuses the supplied change and approval rather
than rerunning intent selection. Return any scope-changing drift resolution to
the owner. A token refresh still requires the owner's runtime wiring and
affected-screen verification; a gallery is not proof of app integration.

## Snapshot contract

Use one history contract for refresh, reskin, `--add-dark-mode`, changing or
removing a custom dark palette, and rollback. After approval and **before the
first write or deletion**, including drift resolution, capture the current state
under one collision-free `<timestamp>-<command>` ID in `brand/.history/`:

| Snapshot member | Contents |
|---|---|
| `<id>.md` | Exact current `brand/design-system.md`. |
| `<id>.tokens.ts` | Exact current `brand/tokens.ts`, when present. |
| `<id>.tokens.dark.ts` | Exact current `brand/tokens.dark.ts`, only when present. Never derive this copy from the light palette. |
| `<id>.state.json` | Explicit dark artifact presence (`"darkTokens": "present"` or `"absent"`) and the current approved selection (`"darkPalette": "approved"` or `"default"`). |

For example, a design using an approved custom dark palette records:

```json
{ "darkTokens": "present", "darkPalette": "approved" }
```

A default-dark design with no dark artifact records:

```json
{ "darkTokens": "absent", "darkPalette": "default" }
```

Presence is not approval: preserve an existing unapproved dark file in the
snapshot with `"darkTokens": "present", "darkPalette": "default"` and do not wire
it. Derive the approved selection from the current Design/approval record, not
the filename. If that selection is unknown or an approved dark palette lacks its
artifact, STOP and resolve the mismatch with the owner before mutating anything.

Verify every expected snapshot member before proceeding; a failed or incomplete
backup blocks the change. Keep the pre-write snapshot unchanged afterward. For
first-time generation with no prior design, record the complete approved initial
state using this same format after generation; do not replace a pre-edit backup
with that initial snapshot on a rerun.

Legacy snapshots without `.state.json` have **unknown**, not absent, dark state.
Resolve and explicitly approve that target state before rollback; do not infer
permission to delete a dark file from a missing history member. A target requiring
a custom dark palette without its saved payload blocks rollback rather than
re-deriving colors. A missing legacy light-token copy may be regenerated from the
saved spec with approval, but never from the current spec.

## Allowed dimensions

| Dimension | What changes | Tokens affected | Affects screens? |
|-----------|-------------|-----------------|------------------|
| `palette` | Approved light or custom-dark palette; name the target in the delta | color.* in the selected artifact | inspect dark wiring and affected screens |
| `typography` | ## Typography | typography.* | no (tokens swap) |
| `components` | ## Components | size.*, radius.* | yes (primitives regenerate) |
| `density` | ## Spacing + ## Components heights | space.*, size.* | inspect affected layouts |
| `negatives` | ## Negatives | none (screen constraints) | inspect screens for newly forbidden patterns |
| `motion` | ## Motion | motion.* | inspect consumers |

## Flow

### Step 1 — Validate existing spec

```
Read brand/design-system.md
If missing → STOP: "No design system found. Run /design-system first."

Read brand/tokens.ts
If missing → WARN: "tokens.ts missing — will regenerate from spec."

Read brand/tokens.dark.ts if present, and the current approved dark selection.
If absent and default dark is selected → keep it absent; no dark file is required.
If an approved custom dark palette is missing → STOP and return the mismatch to the owner.
```

### Step 2 — Drift detection

Compare `brand/design-system.md` ↔ `brand/tokens.ts`:

```
1. Parse tokens.ts — extract palette hex values, typography families, spacing scale, radius values
2. Parse design-system.md — extract same fields from markdown tables
3. Key-by-key comparison
4. If all match → proceed (no drift)
5. If any diverge → STOP and present:
```

```
⚠ Drift detected between brand/design-system.md and brand/tokens.ts:

  palette.primary:
    spec says:    #4a6b8a
    tokens.ts:    #2d5f8a   ← hand-edited

  typography.heading.weight:
    spec says:    600
    tokens.ts:    700         ← hand-edited

How do you want to resolve?

  (1) Adopt tokens.ts as new spec
      → Update design-system.md to match hand-edits, snapshot to .history/
      → Cost: ~2k tokens

  (2) Discard tokens.ts edits
      → Regenerate tokens.ts from spec, snapshot tokens.ts to .history/
      → Cost: deterministic, ~5 sec

  (3) Merge interactively
      → Per-token prompt: keep spec / keep tokens.ts / enter new value
      → Cost: ~3-5k tokens

  (4) Cancel
      → No changes, exit
```

**Why drift detection matters:** without it, `--refresh palette` overwrites hand-edits silently. Drift detection turns this into a conscious choice.

Also compare an existing `brand/tokens.dark.ts` with the approved dark palette
record before overwriting or removing it. Missing approval or hand-edited dark
values require the same explicit resolution; file presence alone is not approval.
Every resolution uses the pre-write snapshot contract above, including an
otherwise light-only refresh.

### Step 3 — Cost preview (mandatory)

```
> /design-system --refresh palette

This will:
  - Re-run palette extraction with new input
  - Update the approved light or dark token artifact (name it in the delta)
  - Re-render brand/design-system.html (~25k tokens, optional)
  - Snapshot current to brand/.history/

Estimated cost: ~3k tokens (refresh-only) OR ~28k (with HTML preview)
Estimated time: ~30 sec OR ~2 min
Affects screens: inspect dark runtime wiring and affected screens

Render HTML preview after? [y/N]
Continue? [y/N]
```

**Cost table (baked into skill):**

| Command | Tokens | Wall time | Affects screens? |
|---------|--------|-----------|------------------|
| `--refresh palette` | ~3k | ~30 sec | inspect dark wiring and affected screens |
| `--refresh typography` | ~3k | ~30 sec | no |
| `--refresh components` | ~5k | ~45 sec | yes (primitives regenerate) |
| `--refresh density` | ~3k | ~30 sec | inspect layouts |
| `--refresh negatives` | ~2k | ~20 sec | inspect screen constraints |
| `--refresh motion` | ~3k | ~30 sec | inspect consumers |
| HTML preview render | +25k | +90 sec | no |

### Step 4 — Prompt for specific change

**Palette:**
```
Current palette:
  bg:          #f7f6f3
  surface:     #ffffff
  primary:     #1e293b
  accent:      #FF6A00
  text:        #1a1a1a
  text-muted:  #6b6b6b
  border:      #d8d6d0

What do you want to change?
(Enter specific changes, e.g. "accent to forest green, more saturated")
```

Name whether the approved palette change targets light values, custom-dark
values, or removal of the custom-dark override. If dark state is outside the
approved scope, preserve its file presence and contents exactly; do not
auto-derive, replace, or remove it when refreshing the light palette.

**Typography:**
```
Current typography:
  Heading: Inter, 22px, weight 600
  Body:    Inter, 16px, weight 400
  Mono:    JetBrains Mono, 14px

What do you want to change?
(Enter specific changes, e.g. "heading to Fraunces, add letter-spacing -0.02em")
```

**Negatives:**
```
Current forbidden patterns:
  ✗ No shadows
  ✗ No serif fonts
  ✗ No decorative motion
  ✗ No tap targets under 52px

Add or remove?
  add: "no chevrons on list rows"
  remove: "no shadows" (removes that rule)
```

**One-major-change-per-prompt enforced:** if user says "change palette AND typography" → refuse:

```
One dimension at a time — keeps changes reviewable.
Which first? [palette / typography]
```

### Step 5 — Update the spec

Before either spec or token write, show the concrete proposed delta and obtain
approval unless it exactly matches the current owner's approved scope. Include
any dark-file creation, replacement, or removal and the resulting default/custom
selection in that delta. Capture the current spec/tokens as a paired history
snapshot plus the optional dark artifact and explicit state, following the
[snapshot contract](#snapshot-contract), so rollback restores the pre-edit state.
Cancellation leaves both artifacts unchanged and preserves the dark artifact's
presence, contents, and approved selection.

1. Read full `brand/design-system.md`
2. Find the relevant section (e.g. `## Palette`)
3. Replace ONLY that section with updated content
4. Leave all other sections untouched
5. Update `## Provenance` timestamp and note

### Step 6 — Update the approved token artifacts

1. For a light-spec change, re-derive `brand/tokens.ts` from the updated
   `brand/design-system.md`; a dark-only change does not rewrite light tokens.
2. Only if approved, create or replace `brand/tokens.dark.ts` with the named
   `darkTokens` export and complete color shape in
   [Approved dark palette](./tamagui-integration.md#approved-dark-palette-conditional).
   Removing a custom palette deletes only `brand/tokens.dark.ts` after the
   explicit removal approval and verified safety snapshot; never delete other
   brand artifacts or unrelated files.
3. If dark state is not in scope, leave `brand/tokens.dark.ts` unchanged when
   present and absent when absent. Default dark mode still works without it.

### Step 7 — Snapshot to history

Retain the paired pre-write snapshot from Step 5, including the dark artifact
presence/absence and approved selection. Do not replace it with copies of the new
artifacts: that would make rollback restore the edited state.

### Step 8 — Re-render HTML (if requested)

If user said yes to HTML preview:
1. Re-render `brand/design-system.html` using updated spec
2. Open in browser

### Step 9 — Confirmation gate

Review the applied diff; this is not the first approval. Revisions return to the
pre-write gate. Return changed files, the resulting approved dark selection, and
screen-impact notes to the owning orchestrator before it performs runtime
verification using [Tamagui integration](./tamagui-integration.md).

```
Updated: ## {{dimension}}

  {{show before/after diff for changed values}}

Confirm? [y/N/edit again]
```

### Step 10 — Update memory bank

```markdown
## Design history
- {{ISO date}} — /design-system --refresh {{dimension}} — {{summary of change}}
```

---

## Version history commands

### `/design-system --history`

List all logical snapshots, including their saved default/custom dark selection
and dark artifact presence/absence:

```
Brand design system history:
  1. 2026-05-01T14:23:00Z  initial          Initial design; default dark, artifact absent
  2. 2026-05-08T09:15:00Z  refresh-palette  Before accent change; default dark, artifact absent
  3. 2026-05-12T16:44:00Z  add-dark-mode    Before adding custom dark; default dark, artifact absent
```

### `/design-system --diff <timestamp>`

Show diff between the current spec/token artifacts and the named snapshot,
including `brand/tokens.dark.ts` contents or its creation/removal, and the
saved versus current approved dark selection. `--history` and `--diff` are
read-only; do not materialize missing artifacts.

```
diff brand/design-system.md vs brand/.history/2026-05-01T14-23-00Z-initial.md

## Palette
  accent:  #FF6A00 → #4a6b8a  (changed)
  
## Negatives
  + ✗ No orange anywhere  (added)
```

### `/design-system --rollback <timestamp>`

1. Resolve and validate every target snapshot member and its explicit dark state
   using the [snapshot contract](#snapshot-contract). Preview the exact spec,
   token, dark-file, and default/custom selection delta without writing.
2. Obtain confirmation before any write (or reuse the owner's exact approval).
3. Snapshot current state to `.history/`, including dark presence/absence and
   approval, and verify the safety backup before any restore or deletion.
4. Restore the approved spec and saved light tokens exactly (only a missing light
   copy uses the saved-spec fallback above). Restore dark state as follows:

   | Current dark artifact | Target dark artifact | Approved restore action |
   |---|---|---|
   | present | present | Replace `brand/tokens.dark.ts` with the exact saved target contents, even when current and target both use custom dark palettes. Do not regenerate from light tokens or keep the newer dark values. |
   | absent | present | Restore `brand/tokens.dark.ts` from the exact saved target contents. |
   | present | absent | Remove only the current `brand/tokens.dark.ts` after explicit approval of that removal and a verified safety backup. Do not delete any unrelated files. |
   | absent | absent | Leave `brand/tokens.dark.ts` absent; do not generate or import it. |

5. Return the restored approved selection to the owner. Reconcile the Design plan
   to that target, not the abandoned newer palette, then reapply
   [Tamagui integration](./tamagui-integration.md#restored-dark-state) and verify
   affected screens. For approved custom dark, `appDarkTheme` must consume the
   restored `darkTokens.color`; for default dark, remove stale custom-dark
   imports/overrides and use the base dark branch. In either case the provider's
   `brandedDarkTheme` must map the same resolved `appDarkTheme`. Artifact-only
   rollback reports this outstanding runtime work rather than claiming the app
   has been restored.

```
Rolling back to 2026-05-01T14:23:00Z (initial):
  - Current state will be saved to .history/ as safety backup
  - brand/design-system.md will be restored
  - brand/tokens.ts will be restored (or regenerated from the saved spec if missing)
  - brand/tokens.dark.ts will match the target's recorded presence and exact contents
  - The target's approved default/custom dark selection will drive runtime reconciliation

This restores the listed brand state, not unrelated app changes. Continue? [y/N]
```

History capped at 50 logical snapshots — prune only the oldest snapshot's known
members together, with notice; never prune unrelated files.

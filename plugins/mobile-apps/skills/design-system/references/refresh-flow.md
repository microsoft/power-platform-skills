# Refresh Flow — `/design-system --refresh <dimension>`

Single-dimension edit to an existing design system. Changes one section of `brand/design-system.md`, regenerates `brand/tokens.ts`, optionally re-renders the HTML gallery.

## Allowed dimensions

| Dimension | What changes | Tokens affected | Affects screens? |
|-----------|-------------|-----------------|------------------|
| `palette` | ## Palette + ## Status palette | color.* | no (tokens swap automatically) |
| `typography` | ## Typography | typography.* | no (tokens swap) |
| `components` | ## Components | size.*, radius.* | yes (primitives regenerate) |
| `density` | ## Spacing + ## Components heights | space.*, size.* | no |
| `negatives` | ## Negatives | none (advisory) | no |
| `motion` | ## Motion | motion.* | no |

## Flow

### Step 1 — Validate existing spec

```
Read brand/design-system.md
If missing → STOP: "No design system found. Run /design-system first."

Read brand/tokens.ts
If missing → WARN: "tokens.ts missing — will regenerate from spec."
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

### Step 3 — Cost preview (mandatory)

```
> /design-system --refresh palette

This will:
  - Re-run palette extraction with new input
  - Update brand/tokens.ts (1 file)
  - Re-render brand/design-system.html (~25k tokens, optional)
  - Snapshot current to brand/.history/

Estimated cost: ~3k tokens (refresh-only) OR ~28k (with HTML preview)
Estimated time: ~30 sec OR ~2 min
Affects screens: NO — primitives auto-pick up tokens

Render HTML preview after? [y/N]
Continue? [y/N]
```

**Cost table (baked into skill):**

| Command | Tokens | Wall time | Affects screens? |
|---------|--------|-----------|------------------|
| `--refresh palette` | ~3k | ~30 sec | no |
| `--refresh typography` | ~3k | ~30 sec | no |
| `--refresh components` | ~5k | ~45 sec | yes (primitives regenerate) |
| `--refresh density` | ~3k | ~30 sec | no |
| `--refresh negatives` | ~2k | ~20 sec | no |
| `--refresh motion` | ~3k | ~30 sec | no |
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

1. Read full `brand/design-system.md`
2. Find the relevant section (e.g. `## Palette`)
3. Replace ONLY that section with updated content
4. Leave all other sections untouched
5. Update `## Provenance` timestamp and note

### Step 6 — Regenerate tokens.ts

1. Re-derive `brand/tokens.ts` from the updated `brand/design-system.md`
2. Write new tokens.ts

### Step 7 — Snapshot to history

```bash
mkdir -p brand/.history
ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
cp brand/design-system.md "brand/.history/${ts}-refresh-${dimension}.md"
cp brand/tokens.ts "brand/.history/${ts}-refresh-${dimension}.tokens.ts"
```

### Step 8 — Re-render HTML (if requested)

If user said yes to HTML preview:
1. Re-render `brand/design-system.html` using updated spec
2. Open in browser

### Step 9 — Confirmation gate

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

List all snapshots:

```
Brand design system history:
  1. 2026-05-01T14:23:00Z  initial          Inspection direction, Inter typography
  2. 2026-05-08T09:15:00Z  refresh-palette  Changed accent from orange to slate-blue
  3. 2026-05-12T16:44:00Z  add-dark-mode    Auto-derived dark palette
```

### `/design-system --diff <timestamp>`

Show diff between current spec and the named snapshot:

```
diff brand/design-system.md vs brand/.history/2026-05-01T14-23-00Z-initial.md

## Palette
  accent:  #FF6A00 → #4a6b8a  (changed)
  
## Negatives
  + ✗ No orange anywhere  (added)
```

### `/design-system --rollback <timestamp>`

1. Snapshot current state to `.history/` first (safety net)
2. Copy the target snapshot to `brand/design-system.md`
3. Regenerate `brand/tokens.ts` from restored spec
4. Confirmation gate before write

```
Rolling back to 2026-05-01T14:23:00Z (initial):
  - Current state will be saved to .history/ as safety backup
  - brand/design-system.md will be restored
  - brand/tokens.ts will be regenerated

This will undo all changes since that snapshot. Continue? [y/N]
```

History capped at 50 entries — oldest auto-pruned with notice.

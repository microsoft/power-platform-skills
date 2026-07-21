---
name: preview-screens
description: Use when the user wants to preview generated screens in a browser without starting Metro / a simulator — for example after /create-mobile-app finishes or after /edit-app regenerates a screen.
user-invocable: true
allowed-tools: Read, Write, Glob, Grep, Bash
model: sonnet
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Preview Screens

Generates a self-contained HTML file that renders every screen in the app as a phone-frame mockup (375 × 812) with tab navigation and a dark/light toggle. The agent reads TSX files, understands the Tamagui component tree, and produces equivalent HTML/CSS — no programmatic TSX parsing.

## When to use

- After generating screens, to see a quick visual preview without running Metro/Expo
- To share a screenshot-ready mockup with stakeholders
- To verify layout before deploying

## When NOT to use

- To run the actual app → use `npx expo start`
- To modify screens → use `/edit-app`; `screen-builder` is an internal agent invoked by orchestrator skills

## Workflow

1. Locate project → 2. Discover screens → 3. Read reference mapping → 4. Read & convert each screen → 5. Assemble preview.html → 6. Write file → 7. Open in browser

---

### Step 1 — Locate project

Determine the working directory:

- If `$ARGUMENTS` contains `--working-dir <path>`, use that.
- Otherwise use the current working directory.

Validate the project:

```text
Glob pattern="power.config.json" path="<working_dir>"
```

If missing, check for `package.json`. If neither exists, report the error and stop.

Read `memory-bank.md` if present to get the project name for the page title:

```text
Grep pattern="^# " path="<working_dir>/memory-bank.md"
```

Fallback: read `name` from `package.json`.

### Step 2 — Discover screens

Find all TSX files under the app directory:

```text
Glob pattern="app/**/*.tsx" path="<working_dir>"
```

**Exclude** these patterns — they are not screens:
- `_layout.tsx` (navigation layouts)
- `+not-found.tsx` (Expo Router error boundary)
- Files in directories starting with `.`
- `index.tsx` at the app root if it only contains an auth redirect (read it to check)

**Derive screen names** from file paths:
- `app/(app)/home.tsx` → "Home"
- `app/(app)/recipes/index.tsx` → "Recipes"
- `app/(app)/recipes/[id].tsx` → "Recipe Detail"
- `app/login.tsx` → "Login"
- `app/oauth-callback.tsx` → skip (not a visible screen)

If `native-app-plan.md` exists in the working directory, read its `## Screens` section for human-friendly labels.

Build an ordered list: `[ { path, screenName, screenId } ]`.

**Default tab ordering — Home first, then two details, then the rest.** Step 5 marks the first entry as `active`, so the order below directly controls which screen the user lands on when `preview.html` opens.

Sort the list with this priority:

1. **Home / dashboard first.** The first screen matching any of these paths (in this priority): `app/(app)/home.tsx`, `app/(app)/index.tsx`, `app/(app)/dashboard.tsx`, `app/index.tsx` (only if it's a real home screen — not the auth redirect you already filtered out in Step 2). If `native-app-plan.md` flags one screen as the home/landing screen, prefer that.
2. **Then up to two detail screens.** A "detail" screen is any TSX whose route segment uses a dynamic param — file path contains `[` and `]` (e.g. `app/(app)/recipes/[id].tsx`, `app/(app)/orders/[orderId]/edit.tsx`). Take the first two in the order they were discovered (alphabetical by path is fine).
3. **Then everything else** in discovery order.

If there are fewer than two detail screens, just include whatever exists and continue with the rest — do not pad with non-detail screens to force a count of 3.

Do not drop any screens — this rule only reorders. Every discovered screen still gets a tab.

### Step 3 — Read reference mapping

Load the Tamagui-to-HTML mapping reference:

```text
Read file_path="${CLAUDE_SKILL_DIR}/../../shared/references/tamagui-html-mapping.md"
```

Internalize:
- Component → HTML element + CSS mappings (Section 1)
- Token → pixel values for spacing, font-size, color (Section 2)
- Conversion guidelines — placeholder rules, icon substitutions, what to skip (Section 3)
- Phone frame HTML template (Section 4) — this is the outer shell

Also check if the project has custom brand tokens:

```text
Glob pattern="tamagui.config.ts" path="<working_dir>"
```

If found, read it and extract any custom color tokens (look for `tokens: { color: { ... } }`). Add them as additional CSS custom properties in the generated HTML.

### Step 4 — Read and convert each screen

**Print before starting:**
> "→ Reading + converting <N> screens to HTML/CSS (one print per screen as I go)."

For each screen in the ordered list from Step 2:

1. **Read the full TSX file.**

2. **Identify the component tree.** Walk the JSX return statement and note every Tamagui component, its props, and its children.

3. **Generate equivalent HTML/CSS** using the mapping from Step 3:
   - `YStack` → `<div style="display:flex; flex-direction:column; ...">`
   - Map every shorthand prop to its CSS equivalent (`f={1}` → `flex:1`, `bg="$color2"` → `background:var(--color2)`, etc.)
   - Map token values to pixels (`p="$4"` → `padding:16px`)
   - Replace `<Ionicons name="..." />` icons with Unicode equivalents (see mapping reference Section 3, Guideline 4 — the icon substitution table uses Ionicons names)

4. **Handle dynamic content:**
   - `.map()` over arrays → generate 3–4 representative placeholder items
   - `useQuery` / `useMutation` → show the populated state only (skip loading/error branches)
   - Form `defaultValues` → pre-fill inputs with those values

   Native PDF/pen controls need honest static approximations:
   - PDF viewer actions → render a compact report/PDF block with a filename, generated timestamp, storage label (for example `Stored in Evidence PDF File` or `On-device share only`), and a disabled `View PDF` button. If the source URL is not visibly HTTPS, label it `Preview unavailable in browser` rather than showing a fake viewer.
   - Generated PDF reports → render the generated/ready state and any persistence label from the plan or code, such as `Uploads to Evidence PDF File`. Do not embed a browser PDF iframe or imply the native viewer runs in preview.
   - Pen/signature input → render a signature pad placeholder with an ink stroke sample and a captured-preview state. Include the persistence label when known, such as `Stored in Signature Image` or `Uploads to Signature File`.
   - Do not wire browser click handlers that pretend to capture pen input, open native PDF viewer, share, print, or upload. This preview is visual only.

5. **Produce a `<div class="screen" id="screen-{screenId}">` wrapping the converted HTML.**

Use inline styles on elements. Keep each screen's HTML self-contained (no shared CSS classes between screens, except the theme variables).

### Step 5 — Assemble preview.html

Use the phone frame template from the mapping reference (Section 4) as the outer shell.

Replace the placeholders:

- **`{{APP_NAME}}`** — project name from Step 1
- **`{{TABS}}`** — one `<button class="tab" ...>` per screen, first tab gets class `active`
- **`{{SCREENS}}`** — all screen `<div>` blocks from Step 4, first screen gets class `active`

If the project has custom brand tokens (from Step 3), add them to the `:root` CSS block.

### Step 6 — Write the file

```text
Write file_path="<working_dir>/preview.html"
```

Print confirmation:

```
✅ Preview generated: <working_dir>/preview.html
   Screens: <N> (<comma-separated list of screen names>)
   Toggle: dark/light mode button in top-right
```

### Step 7 — Open in browser

**Do NOT prompt.** The `visual_companion` flag in `<working_dir>/memory-bank.md` already encodes the answer; asking again is redundant. The flag is set by `/design-system` (Step 6.75) during project creation, or defaults to `yes` if `/design-system` was not run.

Read the flag and act:

```bash
grep -E "^visual_companion:[[:space:]]*(yes|no)" "<working_dir>/memory-bank.md" 2>/dev/null
```

| Flag | Action |
|---|---|
| `visual_companion: no` | Print the link and stop. Do not auto-open. |
| `visual_companion: yes` (or missing memory-bank, or standalone invocation) | Print the link, then auto-open. |

**`visual_companion: no`** — print:

> "Preview is at: `file://<working_dir>/preview.html` (Visual Companion off — open manually.)"

**Otherwise** — print the link AND auto-open in one breath, no prompt:

> "Preview is at: `file://<working_dir>/preview.html` — opening now."

Then try OS-appropriate openers in sequence and fall back to printing the link if none work:

```bash
open "<working_dir>/preview.html" 2>/dev/null \
  || xdg-open "<working_dir>/preview.html" 2>/dev/null \
  || powershell.exe -NoProfile -Command "Start-Process '<working_dir>\preview.html'" 2>/dev/null \
  || echo "Could not auto-open. Open this URL in your browser: file://<working_dir>/preview.html"
```

`open` is macOS-only; the chain covers Linux (`xdg-open`) and Windows / WSL (`powershell.exe Start-Process`). On headless / SSH sessions all three fail silently and the user just opens the link they were already given.

---

## Notes

- **Read-only with respect to source code.** This skill only creates/overwrites `preview.html` — it never modifies TSX files, layouts, configs, or the memory bank.
- **Static approximation.** The preview does not execute React, handle state, or fetch data. Dynamic lists show placeholder items. Interactions (button taps, navigation) are not functional.
- **Native capabilities are placeholders.** PDF viewer, PDF report, sharing, printing, and pen/signature capture are shown as static states only. Browser preview must not imply native capture/viewer APIs work there.
- **Re-running** `/preview-screens` overwrites the previous `preview.html`.
- **No memory-bank update** needed — previews are ephemeral artifacts.

## References

- [tamagui-html-mapping.md](../../shared/references/tamagui-html-mapping.md) — component + token mapping + phone frame template
- [tamagui-component-recipes.md](../../shared/references/tamagui-component-recipes.md) — copy-paste Tamagui snippets (context for recognizing patterns)
- [screen-templates.md](../../shared/references/screen-templates.md) — screen archetype layouts

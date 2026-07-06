# Internal Style Picker

**Shared instructions: [shared-instructions.md](../../../../shared/shared-instructions.md)** — read first.

A self-contained moodboard-before-build reference for `/design-system`. Three named directions, each anchored in real-world reference apps the user already knows. Output is a single HTML page with three phone-frame mockups of the same screen rendered three different ways — user picks one (or describes a hybrid), `/design-system` locks the choice into the design system, downstream agents cascade from it.

## When to use

- **Auto** — used by `/create-mobile-app` through `/design-system`
- **Sub-step** — used by `/design-system` as a folded direction picker. In this mode, the style picker renders the 3-up, asks the user, and returns the picked direction — but does NOT write the full design system spec (that's `/design-system`'s job).
- **After complaint** — user says "this doesn't feel right" → re-run `/design-system --reskin` (which calls this sub-step internally)

## When NOT to use

- The user has already specified a brand reference app or design system (no need for a 3-up picker — go straight to that)
- The plan declares an industry that maps unambiguously to one direction AND the user said "use the industry default" (one preview is enough)
- Sub-skill of another skill that's already in plan mode (would create a duplicate gate)

## Inputs

- `working_dir` — absolute path to the project root (must contain `native-app-plan.md`)
- Optional: `target_screen` — screen name to render (defaults to the most representative; see Step 2)
- Optional: `default_direction` — `inspection | saas | product` to highlight as the recommended pick (defaults to keyword-inferred from app name + purpose)
- Optional: `sub_step_mode` — `true` when invoked by `/design-system`. Changes behavior:
  - Still renders `_design_vibe.html` and asks the user
  - Returns picked direction + merged dimensions to caller
  - Does NOT write `## Design Direction` to plan (caller does that)
  - Accepts `brand_notes` and `logo_palette` for tinting the 3-up
- Optional: `brand_notes` — free-text brand notes to display as recommendation banner
- Optional: `logo_palette` — extracted hex values from `--logo` to tint vibe options

## Workflow

1. Verify plan + pick the target screen
2. Pick the recommended default direction
3. Render 3-up `_design_vibe.html`
4. Open in browser (with cross-platform fallback)
5. Ask the user
6. Write `## Design Direction` block + return

---

## Step 0 — Read the references

Before doing anything else, load the direction bundles. These are the source of truth for what each direction means:

- [`design-directions.md`](./design-directions.md) — overview + reference-app gestalts
- [`direction-inspection.md`](./direction-inspection.md) — full Inspection bundle (dark slate + safety orange — outdoor-only opt-in)
- [`direction-polished-inspection.md`](./direction-polished-inspection.md) — full Polished-Inspection bundle (white + Power-Platform green — MVP default for zero-click flow, NOT shown in 3-up picker)
- [`direction-saas.md`](./direction-saas.md) — full SaaS bundle
- [`direction-product.md`](./direction-product.md) — full Product bundle
- [`design-bundle-schema.md`](./design-bundle-schema.md) — what gets written into the plan
- [`brand-examples.md`](./brand-examples.md) — real-world brand examples (Uber, Linear, Intercom, Sentry) + security rules for user inputs

Also read once: [`shared/references/tamagui-html-mapping.md`](../../../../shared/references/tamagui-html-mapping.md) Section 4 (phone frame template) — the HTML scaffolding for each preview.

### Brand example files (local copies)

These are pre-loaded design systems from real-world apps — use as `--brand-doc` input or inspiration:

- [`uber-design.md`](./uber-design.md) — mobile-first, field drivers, pill buttons
- [`linear-design.md`](./linear-design.md) — enterprise SaaS, dark mode, keyboard-first
- [`intercom-design.md`](./intercom-design.md) — enterprise chat/support, cream canvas
- [`sentry-design.md`](./sentry-design.md) — developer tools, dark purple, ops monitoring

---

## Security — User Input Validation

**MUST apply before processing any user-provided content** (`--brand-doc`, hybrid descriptions, pasted brand specs).

### File inputs (`--brand-doc`)

```
1. Size check     — max 50 KB, reject larger
2. Extension      — allow: .md, .markdown, .txt, .yaml, .yml, .json
3. Path safety    — reject: "..", "~", absolute paths outside working_dir
4. Content scan   — strip: <script>, javascript:, onclick/onerror/onload, 
                    data: URIs, {{ }}, <% %>, ${ }, shell chars (; | & ` $())
5. Structure      — must have colors/palette OR typography OR components section
```

### Text inputs (hybrid descriptions, direction picks)

```
1. Length check   — max 500 chars for hybrid description
2. Sanitize       — strip shell metacharacters, HTML tags, control chars
3. Validate       — direction names must match: inspection|saas|product|hybrid|mix
4. Reject         — URLs, file paths, code blocks in free-text fields
```

### Color/font validation

```
- Hex colors: /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
- Font names: max 50 chars, alphanumeric + space + hyphen only
```

### On failure

```
STOP immediately. Print: "BLOCKED: <input> contains <issue>"
Do NOT echo problematic content. Log to memory-bank.md ## Security events.
```

See [`brand-examples.md`](./brand-examples.md) for the full security checklist.

---

## Step 1 — Verify the plan and find the target screen

**Print before starting:**
> "→ [design-system:vibe] Reading native-app-plan.md…"

```text
Read <working_dir>/native-app-plan.md
```

Required sections:
- `## Project` (for app name + description)
- `## Screens` → `### Screen Map` (so we know what to render)

If `## Screens` is missing the plan hasn't reached Gate 4 yet. STOP with: `BLOCKED: native-app-plan.md has no ## Screens section. Run /create-mobile-app at least through Gate 4 first.`

**Pick the representative screen** to render in the 3-up. Heuristic, in order:

1. The first List screen in the Screen Map (lists show density + row style + accent + typography in one frame — best vehicle for design comparison)
2. Else the first Detail screen (shows surface treatment + hierarchy)
3. Else the Home / dashboard screen
4. Else the first non-baseline screen (skip Login, OAuth, Splash)

Print the choice: `→ [design-system:vibe] Rendering "<screen_name>" in 3 directions.`

If the user passed `target_screen` explicitly, use that instead.

## Step 2 — Pick the recommended default direction

**Print before starting:**
> "→ [design-system:vibe] Inferring recommended direction from app description…"

If `default_direction` was passed in the prompt, use it.

Otherwise scan `## Project` description and `## Design` industry (if present) for keywords:

| Keywords | Recommended direction |
|---|---|
| inspection, field, work order, delivery, audit, site visit, route, dispatch, technician, asset | **Inspection** |
| tracker, request, approval, internal, dashboard, report, employee, helpdesk, expense, time, leave | **SaaS** |
| consumer, customer, premium, engagement, experience, learning, wellness, onboarding, exec dashboard | **Product** |
| Anything else | **SaaS** (safest default for a Power Apps audience) |

The recommendation only **highlights** one card in the picker — the user can still pick any. Do not skip showing all three.

## Step 3 — Render the 3-up `_design_vibe.html`

**Print before starting:**
> "→ [design-system:vibe] Rendering 3 phone-frame mockups (Inspection / SaaS / Product)…"

For each direction, synthesize a single phone-frame HTML mock of the chosen screen, using:
- The screen's spec from `### Per-Screen Specs` for the layout structure (which sections, how many rows)
- The direction's bundle from `references/direction-<name>.md` for ALL visual choices (palette, typography, list style, surface, density, motion-frozen-into-static)
- Plausible placeholder data (3–4 list items synthesized from the entity name)

The three mocks must use the **same screen, same data, same layout structure** — only the design tokens differ. That's what makes the comparison legible.

Compose the 3-up page:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Design Vibe — pick a direction</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; margin: 0; padding: 32px; }
    .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; max-width: 1400px; margin: 0 auto; }
    .col { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .col h2 { margin: 0; font-size: 22px; }
    .col h2 .recommended { background: #fef3c7; color: #92400e; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-left: 8px; vertical-align: middle; }
    .ref { color: #6b6b70; font-size: 14px; text-align: center; max-width: 320px; }
    .swatches { display: flex; gap: 6px; }
    .sw { width: 18px; height: 18px; border-radius: 4px; border: 1px solid #00000014; }
    .frame { /* paste phone frame CSS from tamagui-html-mapping.md Section 4 */ }
    .pick { background: #111; color: #fff; border: 0; padding: 12px 20px; border-radius: 999px; font-size: 14px; cursor: pointer; }
  </style>
</head>
<body>
  <h1 style="text-align:center; max-width:900px; margin:0 auto 32px;">
    Three directions for <em>{{app name}}</em>
  </h1>
  <p style="text-align:center; color:#6b6b70; max-width:600px; margin:0 auto 48px;">
    Same screen, three design vibes. Pick the one that fits, or describe a hybrid.
  </p>
  <div class="row">
    <!-- Direction A: Inspection -->
    <div class="col">
      <h2>Inspection {{recommended? <span class="recommended">recommended</span>}}</h2>
      <div class="ref">Like Uber Driver, ServiceTitan, Procore.<br>Glove-friendly, outdoor-readable, status-driven.</div>
      <div class="swatches">{{6 swatch divs from inspection palette}}</div>
      <div class="frame">{{phone frame with screen rendered using inspection tokens}}</div>
      <button class="pick" onclick="alert('Tell the agent: pick a')">Pick Inspection</button>
    </div>
    <!-- Direction B: SaaS -->
    <div class="col">
      <h2>SaaS{{recommended? ...}}</h2>
      <div class="ref">Like Asana, Teams, Salesforce mobile.<br>Trusted, familiar, what your org already knows.</div>
      <div class="swatches">{{...}}</div>
      <div class="frame">{{...}}</div>
      <button class="pick" onclick="alert('Tell the agent: pick b')">Pick SaaS</button>
    </div>
    <!-- Direction C: Product -->
    <div class="col">
      <h2>Product{{recommended? ...}}</h2>
      <div class="ref">Like Linear, Notion, Spotify.<br>Premium feel, type-led, used by choice.</div>
      <div class="swatches">{{...}}</div>
      <div class="frame">{{...}}</div>
      <button class="pick" onclick="alert('Tell the agent: pick c')">Pick Product</button>
    </div>
  </div>
</body>
</html>
```

Write to `<working_dir>/_design_vibe.html` (underscore prefix matches `_plan_preview.html`'s "ephemeral artifact" naming).

**Rendering rules per direction:**

- **Inspection** — slate background (`#0f172a` or `#1e293b`), safety-orange accent (`#FF6A00`), Inter only at 16pt+ body, card rows with a 4px left status stripe, big bottom-pinned action button, no shadows, fully saturated status pills
- **SaaS** — white/cool-gray background, indigo accent (`#4f46e5`), Inter at default sizes, hairline-bordered cards (1px `#e5e7eb`), top-right `+` for create, subtle shadow on raised cards, desaturated pill backgrounds
- **Product** — warm cream background (`#faf8f5`) OR rich dark (`#1a1614`), single muted accent (sage `#7d9b76`, rust `#b85c38`, or coral `#e87a64`), display heading font (Lora / Fraunces / Inter Display) with `letter-spacing: -0.02em`, sentence-style rows (no icon, no chevron, just title + grey meta line), full-bleed sections, sparse vertical rhythm

If the screen archetype doesn't fit a direction (e.g. an auth screen has no list to show), still render with the direction's tokens applied to its actual content — don't substitute a different screen.

### Hard render rules — these are what makes the comparison legible

The three frames must contrast on **density, typography, and motion** — not just color. If a reviewer can't tell from a thumbnail which is which, the render failed. Enforce:

**1. Density spread (visible at thumbnail size).**

| | Inspection | SaaS | Product |
|---|---|---|---|
| Visible list rows above the fold | 7–9 | 5–6 | 3–4 |
| Row vertical padding | 10–12px | 14–16px | 22–28px |
| Section gap between groups | 8px | 16px | 40px+ |
| Page margin (left/right) | 12px | 16px | 24–32px |

If your render has roughly the same number of rows in all three frames, you've shipped color variations, not direction variations. Fix it before assembling the page.

**2. Typography contrast (must be obvious).**

- **Inspection** — heading: Inter Bold 22px, tracking 0. Numerals tabular.
- **SaaS** — heading: Inter Semibold 20px, tracking 0. Mixed case sentence titles.
- **Product** — heading: **Fraunces 28px Medium** (or Lora / Söhne) — visibly different family, tracking `-0.02em`. Body still sans (Inter) but with looser line-height (1.7 vs 1.4).

If all three headers look like the same sans-serif font, you've under-cooked Product. The display font on Product is the single biggest "is this designed?" signal — render it as a webfont (`@import` Fraunces from Google Fonts at the top of the HTML) so the file is self-contained.

**3. Dark/light is independent of direction.** Inspection ships dark by default because outdoor work demands it, but every direction CAN render either way. Don't conflate "I want dark" with "I want Inspection." If the user later says "I love Product but in dark," that's a valid hybrid — the bundle's `background` field flips to `rich-dark` while everything else stays Product.

**4. Motion is shown by static cues, not animation.**

- **Inspection** — no motion cues; pressed-state shadow on the primary button to imply "tap-snappy"
- **SaaS** — small `↑` indicator on a "raised" card to imply lift; subtle drop shadow under the FAB
- **Product** — a faint chevron `›` on the title-only row to imply "this scrolls into something"; airy spacing implies fade-in stagger

**5. Edge content beats clean content.** Real apps break at edges. Each frame must include one of:
- A title that overflows and truncates with an ellipsis
- A row with one missing field (no meta line)
- A row showing an error state (red dot or "couldn't load")
- A long status that wraps to two lines
- A timestamp older than a year (so date formatting is tested)

Pick at least one edge per frame; spread different edges across the three so reviewers see how each direction handles them. Use realistic data based on the app's domain — for an inspection app, "Boiler Room — Lvl 3, panel 4 (north wall section)" tests truncation; "J. Martínez" tests diacritics; "—" tests missing meta.

**6. Add a one-line "when to pick this" under the reference apps.**

- Inspection: *"Pick this if your users wear gloves, work outdoors, or care about status at a glance."*
- SaaS: *"Pick this if your users live in dashboards and you want Microsoft 365 family resemblance."*
- Product: *"Pick this if design itself is the differentiator and retention matters."*

These render as italic grey text directly under the reference-app line so a user who doesn't recognize the apps still gets the gist.

**7. Hybrid input field (visible in the page, not just in chat).**

After the three columns, render a fourth full-width row:

```html
<div class="hybrid">
  <h3>Or describe a hybrid</h3>
  <p>Examples: "Product look with Inspection's data density" · "SaaS structure but Product's typography" · "Inspection but in light mode"</p>
  <p class="hint">Tell the agent in chat — I'll regenerate this page with your hybrid as a 4th frame.</p>
</div>
```

This sets the expectation that hybrid is real, named, and supported — without requiring a working form (the chat is the input).

**8. Explicit dark/light toggle per frame.** Render a small `Light / Dark` toggle pill above each phone frame, and make the alternate state available via `?dark=1` URL params or a click handler that swaps the frame's classes. This is what prevents the "I picked dark for aesthetics → got pushed into Inspection" failure mode.

## Step 4 — Open the preview in the user's browser

**Print before starting:**
> "→ [design-system:vibe] Opening the preview in your default browser…"

Print the file path as a clickable link FIRST (always), then ask before launching:

> "Three directions are at: `file://<working_dir>/_design_vibe.html`
>
> Want me to try opening it in your default browser? (yes / no — default: yes)"

On `yes` (or no answer), try OS-appropriate openers in sequence and fall back to the printed link if all fail:

```bash
open "<working_dir>/_design_vibe.html" 2>/dev/null \
  || xdg-open "<working_dir>/_design_vibe.html" 2>/dev/null \
  || powershell.exe -NoProfile -Command "Start-Process '<working_dir>\_design_vibe.html'" 2>/dev/null \
  || echo "Could not auto-open. Please open this URL: file://<working_dir>/_design_vibe.html"
```

Do not block on whether the browser opened — the link is printed.

## Step 5 — Ask the user which direction

After the browser opens (or the user opens the link), ask:

> "Which direction fits? Reply with:
> - `a` or `inspection` — for the Inspection direction
> - `b` or `saas` — for the SaaS direction
> - `c` or `product` — for the Product direction
> - `hybrid: <description>` — e.g. `hybrid: Product look with Inspection's data density` or `hybrid: Inspection in light mode`
> - `mix: <picks>` — pick individual elements across directions, e.g. `mix: Inspection's status pills, Product's typography, SaaS's spacing`
> - `dark` / `light` — flip the recommended direction's mode without changing direction
> - `again` — show me a different cut (regenerates with palette/font alternates of the same three directions)
> - `none of these` — and tell me what's missing; I'll re-render
>
> Optional: tell me what each direction got *wrong* — that tightens the next render."

Use `AskUserQuestion` with options if available; otherwise plain text.

**Handling responses:**

- **`a` / `b` / `c`** → resolve to the direction name; go to Step 6
- **`hybrid: ...`** → parse the description, merge bundles by picking the named dimensions from each, regenerate `_design_vibe.html` with the merged bundle as a 4th column titled "Your hybrid", re-open, ask "use this hybrid? (yes / refine)"
- **`mix: ...`** → element-level remix. Parse the picks (`Inspection's status pills, Product's typography, SaaS's spacing`), build a custom bundle by overriding the recommended direction's fields with the named picks, render as a 4th frame titled "Your mix", same re-open / confirm loop as hybrid
- **`dark` / `light`** → flip the recommended direction's `background` field only (`dark-slate` ↔ `cool-gray-light`, `warm-cream` ↔ `rich-dark`); keep direction otherwise. Re-render the single affected frame so the user sees the swap before committing
- **`again`** → regenerate with alternate accents (e.g. Product with rust instead of sage; Inspection with amber instead of orange) — same three directions, different concrete realizations. Cap to 1 `again` per session to avoid taste-paralysis.
- **`none of these`** → ask what's missing AND what each direction got wrong (capture as a "rejected" log line in `memory-bank.md`). Regenerate the 3-up with adjustments (palette swap, density change, etc.), re-open, ask again
- **No reply / unclear** → ask once more, then default to the recommended direction with: `Defaulting to <name> based on app description; you can run /design-system --reskin any time to swap.`

Cap re-renders at **3 iterations** to avoid infinite loops. After 3 the skill must lock in either the user's last clear pick or the recommended default.

**Always log the rejected directions** to `memory-bank.md` under `## Design history` — what the user said no to is the strongest signal for any future re-run. One line per rejection: `- 2026-05-01 — Rejected SaaS: "too templated, looks like every internal tool"`.

## Step 6 — Write the `## Design Direction` block into the plan

**Skip this step entirely if `sub_step_mode` is true** — the caller (`/design-system`) writes the full spec at Sub-step 3 instead.

**Print before starting:**
> "→ [design-system:vibe] Writing ## Design Direction into native-app-plan.md…"

Locate `native-app-plan.md`. If a `## Design Direction` block already exists, replace it. If not, insert it **immediately before** `## Design` (or `## Screens` if `## Design` is absent).

Use the schema from [`design-bundle-schema.md`](./design-bundle-schema.md). For the picked direction, copy the canonical bundle from the matching `direction-<name>.md` and prepend a header line stating the user's choice + reference apps:

```markdown
## Design Direction

**Picked:** Product
**Reference apps:** Linear, Notion, Spotify
**Picked at:** 2026-04-30T12:34:56Z (via /design-system style picker)

surface: flat-warm
palette: cream + sage
typography: display-headings + sans-body
list_style: sentence
density: sparse
motion: liberal-tasteful
status_saturation: monochrome-plus-accent
empty_state: type-led
tone: conversational
primary_action_shape: pill-full-width-on-key-screens
accent_color: sage (#7d9b76)
heading_font: Fraunces
body_font: Inter
```

For a hybrid pick, the `Picked:` line reads `Hybrid (Product base + Inspection data density)` and the bundle dimensions show the merged values.

Append a one-line note for downstream agents:

```markdown
> Downstream agents (`screen-planner`, `screen-builder`) MUST use these values as the defaults for their own per-screen Surface / Density / List style / Motion fields unless a per-screen spec explicitly overrides.
```

## Step 7 — Update the memory bank

Append one line to `<working_dir>/memory-bank.md` under `## Design history` (create the section if missing):

```markdown
- 2026-04-30 — Picked direction: Product (Linear/Notion/Spotify reference). Via /design-system style picker.
```

## Step 8 — Return

**If `sub_step_mode` is true:** return the picked direction and all resolved dimensions to the caller (`/design-system`) without writing to the plan:

```
DESIGN_VIBE_RESULT
direction: <Inspection|SaaS|Product|Hybrid>
surface: <value>
palette: <value>
typography: <value>
list_style: <value>
density: <value>
motion: <value>
status_saturation: <value>
empty_state: <value>
tone: <value>
primary_action_shape: <value>
accent_color: <name (#hex)>
heading_font: <font>
body_font: <font>
reference_apps: <comma-separated>
```

The caller uses these dimensions to write `brand/design-system.md` at Sub-step 3.

**If auto mode (not sub-step):** return one line to the caller:

> Design direction picked: <Inspection|SaaS|Product|Hybrid>. Block written to `<working_dir>/native-app-plan.md` § Design Direction. Preview kept at `<working_dir>/_design_vibe.html` for reference.

If invoked from `/create-mobile-app` Gate 4, the orchestrator continues with screen-builder fan-out using the new direction.

---

## Plug-in / play-out contract

This skill's only side-effect on shared state is **one block** written into `native-app-plan.md`. Existing agents check for it conditionally:

- `agents/screen-planner.md` — if `## Design Direction` exists, use its values as defaults for per-screen Density / Surface / Restraint fields. Otherwise fall back to today's industry-inferred logic.
- `agents/screen-builder.md` — if `## Design Direction` exists, read `list_style`, `motion`, `tone`, `primary_action_shape` and apply them when choosing row/component patterns from the user's screen spec. Samples remain code/API references only. Otherwise use today's defaults.

If this skill folder is removed:
1. The orchestrator's Gate 4 falls back to its existing single-preview flow (no `## Design Direction` block ever gets written)
2. screen-planner and screen-builder's `if (block exists)` conditions evaluate false → behave exactly as today
3. No other file change required

## Notes

- **Read-only with respect to source code.** This skill writes only `_design_vibe.html`, the `## Design Direction` block in `native-app-plan.md`, and one line in `memory-bank.md`. It never touches TSX, configs, or generated services.
- **Reuses existing infrastructure.** The phone-frame template comes from `shared/references/tamagui-html-mapping.md`; the browser-open chain is the same as `/preview-screens` and `native-app-planner` Gate 4. No new dependencies.
- **Re-runnable.** Each run overwrites `_design_vibe.html` and replaces the `## Design Direction` block. Memory bank entries accumulate so the design history is preserved.

## References

- [design-directions.md](./design-directions.md) — overview of the 3 directions
- [direction-inspection.md](./direction-inspection.md) — full bundle
- [direction-saas.md](./direction-saas.md) — full bundle
- [direction-product.md](./direction-product.md) — full bundle
- [design-bundle-schema.md](./design-bundle-schema.md) — block schema downstream agents read
- [brand-examples.md](./brand-examples.md) — real-world brand examples + security rules
- [uber-design.md](./uber-design.md) — Uber design system
- [linear-design.md](./linear-design.md) — Linear design system
- [intercom-design.md](./intercom-design.md) — Intercom design system
- [sentry-design.md](./sentry-design.md) — Sentry design system
- [shared/references/tamagui-html-mapping.md](../../../../shared/references/tamagui-html-mapping.md) — phone frame template + token mapping

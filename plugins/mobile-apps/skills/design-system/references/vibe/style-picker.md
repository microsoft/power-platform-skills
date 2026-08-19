# Internal Style Picker

**Shared instructions: [shared-instructions.md](../../../../shared/shared-instructions.md)** — read first.

A self-contained moodboard-before-build reference for `/design-system`. Three
visual personality profiles, each anchored in familiar product qualities.
Output is one HTML page with the same user jobs and representative data rendered
through three meaningfully different compositions. Product archetype and
workflow stay fixed; visual personality/materialization changes.

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
- Optional: `target_screen` — Home or primary repeated-loop screen (see Step 1)
- Required when a plan exists: approved `## Product Experience`, including
  product archetype, workflow, Home composition, First Viewport, media, and
  reference fidelity
- Optional: `default_personality` — canonical personality to highlight; defaults
  to the approved Product Experience, never keyword/industry inference
- Optional: `design_intake` — structured reference intake. When fidelity is
  `high` or `strict-structural`, skip the picker because structure is already
  binding.
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
- [`direction-polished-inspection.md`](./direction-polished-inspection.md) — legacy status-led compatibility preset, not shown in the 3-up picker
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

1. Home when it has an approved composition and First Viewport Contract.
2. Else the screen hosting the primary repeated user loop.
3. Else the first Detail screen with an object/media hero.
4. Else the first List screen.
5. Else the first non-baseline screen (skip Login, OAuth, Splash).

Print the choice: `→ [design-system:vibe] Rendering "<screen_name>" in 3 directions.`

If the user passed `target_screen` explicitly, use that instead.

## Step 2 — Pick the recommended visual personality

**Print before starting:**
> "→ [design-system:vibe] Reading the approved visual personality…"

If `default_personality` was passed, use it. Otherwise read
`## Product Experience → Visual personality`:

| Canonical personality | Highlighted profile |
|---|---|
| `utility` | Utility (legacy inspection bundle) |
| `polished-operational` | Polished Operational (legacy SaaS bundle) |
| `premium-brand-forward`, `editorial`, `immersive`, `playful-consumer` | Premium Brand-forward (legacy Product bundle, then adapt named dimensions) |
| `reference-driven` | Skip picker and materialize the binding design intake |
| missing in standalone project | Polished Operational, marked least-assumptive |

The recommendation only highlights one profile. A profile choice may adjust
visual personality before Gate 3 approval; it never changes product archetype
or workflow capabilities.

## Step 3 — Render the 3-up `_design_vibe.html`

**Print before starting:**
> "→ [design-system:vibe] Rendering 3 phone-frame mockups (Utility / Polished Operational / Premium Brand-forward)…"

For each profile, synthesize a phone-frame HTML mock using:

- the same user jobs, entities, actions, and representative data;
- the approved Product Experience as non-negotiable behavior;
- the profile bundle for personality, hierarchy, surfaces, density, type, and
  motion cues;
- a profile-appropriate composition. Section order, dominant component,
  grouping, media prominence, and action placement SHOULD differ visibly.

The three mocks use the same jobs and data, not the same layout structure. A
comparison that changes only tokens has failed.

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
    <!-- Profile A: Utility -->
    <div class="col">
      <h2>Utility {{recommended? <span class="recommended">recommended</span>}}</h2>
      <div class="ref">Like Uber Driver, ServiceTitan, Procore.<br>Glove-friendly, outdoor-readable, status-driven.</div>
      <div class="swatches">{{6 swatch divs from inspection palette}}</div>
      <div class="frame">{{phone frame with screen rendered using inspection tokens}}</div>
      <button class="pick" onclick="alert('Tell the agent: pick a')">Pick Utility</button>
    </div>
    <!-- Profile B: Polished Operational -->
    <div class="col">
      <h2>Polished Operational{{recommended? ...}}</h2>
      <div class="ref">Like Asana, Teams, Salesforce mobile.<br>Trusted, familiar, what your org already knows.</div>
      <div class="swatches">{{...}}</div>
      <div class="frame">{{...}}</div>
      <button class="pick" onclick="alert('Tell the agent: pick b')">Pick Polished Operational</button>
    </div>
    <!-- Profile C: Premium Brand-forward -->
    <div class="col">
      <h2>Premium Brand-forward{{recommended? ...}}</h2>
      <div class="ref">Like Linear, Notion, Spotify.<br>Premium feel, type-led, used by choice.</div>
      <div class="swatches">{{...}}</div>
      <div class="frame">{{...}}</div>
      <button class="pick" onclick="alert('Tell the agent: pick c')">Pick Premium Brand-forward</button>
    </div>
  </div>
</body>
</html>
```

Write to `<working_dir>/_design_vibe.html` (underscore prefix matches `_plan_preview.html`'s "ephemeral artifact" naming).

**Rendering rules per direction:**

- **Utility** — high-contrast surface, direct type, 52pt+ frequent targets,
  explicit status, bottom-reachable action, and task/queue-first composition
- **Polished Operational** — calm neutral surfaces, selective hairlines,
  restrained accent, clear object/current-work hierarchy, and functional chrome
- **Premium Brand-forward** — warm or rich surfaces, distinct display role,
  object/media-led hierarchy, full-bleed or asymmetric sections, and enriched
  motion cues. Letter spacing remains `0`.

If the screen archetype doesn't fit a direction (e.g. an auth screen has no list to show), still render with the direction's tokens applied to its actual content — don't substitute a different screen.

### Hard render rules — these are what makes the comparison legible

The three frames must contrast on **density, typography, and motion** — not just color. If a reviewer can't tell from a thumbnail which is which, the render failed. Enforce:

**1. Density spread (visible at thumbnail size).**

| | Utility | Polished Operational | Premium Brand-forward |
|---|---|---|---|
| Visible list rows above the fold | 7–9 | 5–6 | 3–4 |
| Row vertical padding | 10–12px | 14–16px | 22–28px |
| Section gap between groups | 8px | 16px | 40px+ |
| Page margin (left/right) | 12px | 16px | 24–32px |

If your render has roughly the same number of rows in all three frames, you've shipped color variations, not direction variations. Fix it before assembling the page.

**2. Typography contrast (must be obvious).**

- **Utility** — heading: Inter Bold 22px, tracking 0. Numerals tabular.
- **Polished Operational** — heading: Inter Semibold 20px, tracking 0. Mixed case sentence titles.
- **Premium Brand-forward** — heading: **Fraunces 28px Medium** (or another approved display family), tracking `0`. Body remains a readable sans with looser line-height.

If all three headers and dominant regions share the same hierarchy, the Premium
profile is under-specified. Use an approved/local display face when available;
do not fetch a font merely for a preview.

**3. Dark/light is independent of personality.** Utility may be light; Premium
may be dark. Theme choice never changes product archetype or personality.

**4. Motion is shown by static cues, not animation.**

- **Utility** — no decorative motion cues; direct pressed state
- **Polished Operational** — restrained elevation/transition cues
- **Premium Brand-forward** — composition and spacing imply enriched transition; no decorative glyph is required

**5. Edge content beats clean content.** Real apps break at edges. Each frame must include one of:
- A title that overflows and truncates with an ellipsis
- A row with one missing field (no meta line)
- A row showing an error state (red dot or "couldn't load")
- A long status that wraps to two lines
- A timestamp older than a year (so date formatting is tested)

Pick at least one edge per frame; spread different edges across the three so reviewers see how each direction handles them. Use realistic data based on the app's domain — for an inspection app, "Boiler Room — Lvl 3, panel 4 (north wall section)" tests truncation; "J. Martínez" tests diacritics; "—" tests missing meta.

**6. Add a one-line "when to pick this" under the reference apps.**

- Utility: *"Pick this when speed, harsh context, or explicit status dominates."*
- Polished Operational: *"Pick this for quiet, trustworthy repeated work."*
- Premium Brand-forward: *"Pick this when identity, object/media presence, or retention matters."*

These render as italic grey text directly under the reference-app line so a user who doesn't recognize the apps still gets the gist.

**7. Hybrid input field (visible in the page, not just in chat).**

After the three columns, render a fourth full-width row:

```html
<div class="hybrid">
  <h3>Or describe a hybrid</h3>
  <p>Examples: "Premium hierarchy with Utility touch targets" · "Polished structure with Premium typography" · "Utility in light mode"</p>
  <p class="hint">Tell the agent in chat — I'll regenerate this page with your hybrid as a 4th frame.</p>
</div>
```

This sets the expectation that hybrid is real, named, and supported — without requiring a working form (the chat is the input).

**8. Explicit dark/light toggle per frame.** Render a small `Light / Dark`
toggle above each phone frame. Theme changes do not change personality.

**9. Runtime-fidelity label.** Place this exact caption below every phone frame:
`Static approximation — runtime screenshot required`. The picker approves a
direction; it does not prove native rendering or reference fidelity.

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
> - `a`, `utility`, or legacy `inspection` — Utility
> - `b`, `polished`, or legacy `saas` — Polished Operational
> - `c`, `premium`, or legacy `product` — Premium Brand-forward
> - `hybrid: <description>` — e.g. `hybrid: Premium hierarchy with Utility touch targets`
> - `mix: <picks>` — e.g. `mix: Utility status treatment, Premium typography, Polished spacing`
> - `dark` / `light` — flip the recommended direction's mode without changing direction
> - `again` — show me a different cut (regenerates with palette/font alternates of the same three directions)
> - `none of these` — and tell me what's missing; I'll re-render
>
> Optional: tell me what each direction got *wrong* — that tightens the next render."

Use `AskUserQuestion` with options if available; otherwise plain text.

**Handling responses:**

- **`a` / `b` / `c`** → resolve to the direction name; go to Step 6
- **`hybrid: ...`** → parse the description, merge bundles by picking the named dimensions from each, regenerate `_design_vibe.html` with the merged bundle as a 4th column titled "Your hybrid", re-open, ask "use this hybrid? (yes / refine)"
- **`mix: ...`** → element-level remix. Parse the profile dimensions, build a
  custom materialization bundle without changing product archetype/workflow,
  render it as a 4th frame, then confirm/refine.
- **`dark` / `light`** → flip the recommended direction's `background` field only (`dark-slate` ↔ `cool-gray-light`, `warm-cream` ↔ `rich-dark`); keep direction otherwise. Re-render the single affected frame so the user sees the swap before committing
- **`again`** → regenerate alternate concrete realizations of the same three
  profiles. Cap to one retry.
- **`none of these`** → ask what's missing AND what each direction got wrong (capture as a "rejected" log line in `memory-bank.md`). Regenerate the 3-up with adjustments (palette swap, density change, etc.), re-open, ask again
- **No reply / unclear** → ask once more, then default to the recommended direction with: `Defaulting to <name> based on app description; you can run /design-system --reskin any time to swap.`

Cap re-renders at **3 iterations** to avoid infinite loops. After 3 the skill must lock in either the user's last clear pick or the recommended default.

**Always log rejected profiles** to `memory-bank.md` under `## Design history`.

## Step 6 — Write the `## Design Direction` block into the plan

**Skip this step entirely if `sub_step_mode` is true** — the caller (`/design-system`) writes the full spec at Sub-step 3 instead.

**Print before starting:**
> "→ [design-system:vibe] Writing ## Design Direction into native-app-plan.md…"

Locate `native-app-plan.md`. If a `## Design Direction` block already exists, replace it. If not, insert it **immediately before** `## Design` (or `## Screens` if `## Design` is absent).

Use the schema from [`design-bundle-schema.md`](./design-bundle-schema.md). For the picked direction, copy the canonical bundle from the matching `direction-<name>.md` and prepend a header line stating the user's choice + reference apps:

```markdown
## Design Direction

**Picked:** Premium Brand-forward
**Reference apps:** Linear, Notion, Spotify
**Picked at:** 2026-04-30T12:34:56Z (via /design-system style picker)

visual_personality: premium-brand-forward
visual_ambition: premium
materialization_profile: product
product_archetype: <copied from Product Experience>
home_composition: <copied/approved>
reference_fidelity: none
surface: editorial
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

For a hybrid pick, `Picked:` names canonical profiles and the bundle documents
merged dimensions. Copied Product Experience fields remain unchanged.

Append a one-line note for downstream agents:

```markdown
> Downstream agents (`screen-planner`, `screen-builder`) MUST use these values as the defaults for their own per-screen Surface / Density / List style / Motion fields unless a per-screen spec explicitly overrides.
```

## Step 7 — Update the memory bank

Append one line to `<working_dir>/memory-bank.md` under `## Design history` (create the section if missing):

```markdown
- 2026-04-30 — Picked personality: Premium Brand-forward; materialization profile: product. Via /design-system style picker.
```

## Step 8 — Return

**If `sub_step_mode` is true:** return the picked direction and all resolved dimensions to the caller (`/design-system`) without writing to the plan:

```
DESIGN_VIBE_RESULT
visual_personality: <utility|polished-operational|premium-brand-forward|hybrid>
materialization_profile: <inspection|saas|product|hybrid>
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

> Visual personality/materialization picked: <value>. Block written to `<working_dir>/native-app-plan.md` § Design Direction. Preview kept at `<working_dir>/_design_vibe.html` as a static approximation.

If invoked from `/create-mobile-app` Gate 4, the orchestrator continues with screen-builder fan-out using the new direction.

---

## Plug-in / play-out contract

This skill's only side-effect on shared state is **one block** written into `native-app-plan.md`. Existing agents check for it conditionally:

- `agents/screen-planner.md` — reads Product Experience first, then uses Design Direction for materialization defaults. Missing Product Experience is not an industry fallback.
- `agents/screen-builder.md` — Product Experience controls composition/media/reference; Design Direction controls materialization details. Samples remain code/API references only.

If this skill folder is removed:
1. The orchestrator's Gate 3 uses the approved Product Experience with least-assumptive materialization (no `## Design Direction` block)
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

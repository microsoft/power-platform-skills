## Phase 4: Plan Approval

**Goal**: Render the implementation plan as an HTML document, open it in the user's default browser, and get approval before starting implementation.

> **Why HTML instead of a chat message**: A structured HTML plan (like the ones produced by `/integrate-backend`, `/add-server-logic`, and `/add-cloud-flow`) lets the user skim sections, compare swatches, and preview typography — all impossible in a terminal. The scaffold loader in their browser may also be full-screen, so surfacing the plan in a new tab puts it where they can actually read it.

### 4.1 Read the Design References

Read `${PLUGIN_ROOT}/references/design-aesthetics.md` and `${PLUGIN_ROOT}/references/page-blueprints.md` if they are not already in context. Every field you populate below must trace back to the experience brief from Phase 3.

> **AI Readiness in the plan.** If `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty, reflect each placement in the matching `PAGES_DATA` entry's `description` or `content` — e.g., *"Reserved slot for an AI summary card; populated later by `/add-ai-webapi`. The page ships without AI."* This keeps the user's expectation honest: the site does not depend on generative-AI features being enabled on the tenant, and there is no "Run /add-ai-webapi" placeholder visible to end-users. If `AI_SUMMARY_PLACEMENTS` is empty, omit any AI references from the plan.

### 4.2 Build the Plan Data

Assemble a single JSON object with the following keys. The plan template rejects any data that's missing a required key, so include all of them.

| Key | Type | Content |
|-----|------|---------|
| `SITE_NAME` | string | Site/brand name from Phase 1, preserved as entered |
| `PLAN_TITLE` | string | Localized equivalent of `"Implementation Plan"` in `SITE_LOCALE` |
| `FRAMEWORK` | string | `React` / `Vue` / `Angular` / `Astro` |
| `SITE_LANGUAGE` | string | Readable content-language name from Phase 1, written in that language when practical |
| `SITE_LOCALE` | string | Canonical BCP-47 content locale |
| `SITE_DIRECTION` | string | `ltr` or `rtl` |
| `AESTHETIC` | string | Chosen aesthetic (e.g., `Minimal & Clean`) |
| `MOOD` | string | Chosen mood (e.g., `Professional & Trustworthy`) |
| `SUMMARY` | string | One localized paragraph describing what the site is and who it serves |
| `PLAN_LABELS` | object | Complete localized template-label dictionary defined below |
| `DESIGN_DIRECTION_DATA` | object | The experience brief: `{ thesis, brandSource, audience, primaryAction, secondaryAction, principalDoubt, proofStrategy, heroConcept, signatureMoment }` - all strings. `brandSource` says where tokens came from (e.g., `"Fresh identity"`, `"Matched to https://contoso.com"`) |
| `TYPOGRAPHY_DATA` | object | `{ primary: { name, sample, reason }, secondary: { name, sample, reason } }` - `primary` is the body face, `secondary` the display face; `name` must be a family from the verified faces table in design-aesthetics.md (or the brand's own Google Font) |
| `PALETTE_DATA` | array | `[{ var, hex, description }]` - one entry per color token from design-aesthetics.md section 3 |
| `MOTION_DATA` | array | `[{ label, description }]` - first-screen entrance, signature moment, scroll reveals, interaction states, route transitions |
| `BACKGROUNDS_DATA` | array | `[{ label, description }]` - hero atmosphere, section bands, textures, patterns |
| `PAGES_DATA` | array | `[{ name, route, description, content: [...], components: [...] }]` - `content` is the page's narrative beats in order, one line per section with its purpose; `components` is shared component names used |
| `COMPONENTS_DATA` | array | `[{ name, purpose, usedBy: [...] }]` — shared components with the page names that consume them |
| `ROUTES_DATA` | array | `[{ path, page }]` — every route the router will register |
| `BIDIRECTIONAL_REVIEW_DATA` | array | Every planned visible or interactive component as `{ component, classification, reason, states: [...], viewports: ["desktop" or "narrow"], checks: [...] }`; all maker-facing strings are localized |
| `REVIEW_DATA` | object | `{ agentChecks: [...], makerReview: [...] }` using the responsibility contract below |
| `DEPLOYMENT_DATA` | array | `[{ title, description, recommended?: boolean }]` — mark exactly one as `recommended: true` |

Read the entry-linked `assets/plan-labels.example.json` for the complete `PLAN_LABELS` key set.
Translate every value into `SITE_LOCALE`, preserving `{siteName}` and `{count}` exactly.
Include every key; never fall back to English for individual labels.


**Write all maker-facing plan data in the selected content language.** This
includes `PLAN_TITLE`, `SUMMARY`, `PLAN_LABELS`, descriptive `AESTHETIC` and
`MOOD` names, typography reasons/samples, palette descriptions, motion and
background labels/descriptions, page display names/descriptions/content
outlines, component display names/purposes, route page labels, review items,
and deployment titles/descriptions.

Keep technical values unchanged: framework and package names, file paths,
routes, commands, locale tags, CSS variables, hex colors, identifiers, API
names, and brand/product names. When a page or component `name` is also the
planned code identifier, keep it unchanged; localize only human-readable
display names. Use complete translated phrases rather than joining translated
fragments in English word order.

Build `REVIEW_DATA` as two non-empty localized string arrays:

```json
{
  "agentChecks": [
    "The root document uses the canonical site locale and resolved writing direction",
    "The bidirectional-readiness audit reports no errors; layout uses logical CSS and every physical exception is documented and verified",
    "Every visible or interactive component is classified, and the planned review scope is reconciled with the actual source and rendered application",
    "Every applicable state and viewport of direction-aware, direction-fixed, and unknown or third-party components has verification evidence",
    "Localized form labels, placeholders, hints, helper text, validation messages, prefixes, suffixes, and overlays follow the active UI direction; only classified machine-oriented values remain LTR",
    "Representative routes work in the selected direction and a pseudo-opposite direction at desktop and narrow widths without console errors, broken reading order, or broken focus order",
    "Unknown-direction content uses bdi or dir=auto, while URLs, email addresses, code, paths, GUIDs, and identifiers are explicitly isolated",
    "Dates, numbers, currency, percentages, and relative time use locale-aware Intl formatting",
    "Typography covers the selected script and expanded or opposite-direction text does not clip or overlap",
    "Directional components, interactions, icons, and assets behave according to their reviewed mirror, preserve, or replace classification",
    "Every route has zero critical or serious axe-core accessibility violations"
  ],
  "makerReview": [
    "Language, terminology, tone, regional wording, and regulated content are appropriate",
    "Visual hierarchy and reading flow feel natural in the selected direction and the opposite-direction preview",
    "Typography remains readable and preserves the intended brand character",
    "Icon and image direction choices are culturally and semantically appropriate",
    "Text wrapping, expansion, and narrow-screen layouts remain visually acceptable"
  ]
}
```

Translate these as complete criteria rather than copying the English wording.
The two groups communicate responsibility:

- `agentChecks` are objective commitments the agent must execute and report
  during Phases 5–7. They are not instructions for the maker.
- `makerReview` contains linguistic, cultural, brand, and visual judgments that
  automation cannot approve. The maker reviews them in the live preview during
  Phase 7.

Do not move subjective maker judgments into `agentChecks`, and do not ask the
maker to repeat deterministic source, browser, or accessibility checks.

### 4.3 Render the HTML Plan

Pick an output path under `<PROJECT_ROOT>/docs/`. Default is `create-site-plan.html`; if that file already exists, pick a descriptive variant like `create-site-plan-v2.html` (the render script refuses to overwrite existing files).

```bash
node "${PLUGIN_ROOT}/scripts/render-createsite-plan.js" --output "<PROJECT_ROOT>/docs/create-site-plan.html" --data - <<'PLAN'
<plan JSON>
PLAN
```

Send the plan JSON on stdin as shown, so no temp file is written and nothing in it - such as the brand URL the user typed - is parsed by the shell; the quoted `'PLAN'` delimiter turns off expansion.

The script prints `{"status":"ok","output":"<path>"}` on success. Capture and use that actual output path for the next step.

### 4.4 Open the Plan in the Default Browser

Open `<OUTPUT_PATH>` in the default browser using the platform-appropriate file opener for the current environment. For example, use `open` on macOS, `xdg-open` on Linux, or the equivalent default-browser opener available on Windows.

### 4.5 Present a Brief Summary in the Terminal

Keep the terminal message short — **the full plan lives in the HTML file now**. Include:

- One sentence confirming the plan was rendered and where (the output path).
- A 3-5 line bullet summary: the design thesis, signature moment, framework, content language, page and component count, and primary palette color.
- A pointer: "See the open browser tab for the design direction, pages, color swatches, typography samples, and deployment options."

Do NOT dump the full plan contents into the terminal — that defeats the purpose of the HTML view.

### 4.6 Raise the "Awaiting Input" Banner

The user may still be looking at the full-screen scaffold loader when you ask for approval.
Write `<PROJECT_ROOT>/public/scaffold-status.json`:

```json
{ "message": "Ready to build", "awaitingInput": true, "inputPrompt": "Plan approval needed — review the plan in your browser and answer in the terminal." }
```

Immediately after the user answers, update the same file with `"awaitingInput": false`.

### 4.7 Ask for Approval

<!-- gate: create-site:4.7.plan-approval | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:4.7.plan-approval):** Final sign-off on the rendered HTML plan before Phase 5 starts replacing the scaffold with real pages, components, and design tokens.
>
> **Trigger:** Phase 4.3 rendered `docs/create-site-plan.html`; Phase 4.4 opened it in the browser.
> **Why we ask:** Phase 5 rewrites the entire scaffold (theme.css, Layout, Home page, components, routes) — undoing that touches every commit in the implementation phase.
> **Cancel leaves:** Nothing destructive — the scaffold itself can be deleted with the project directory; no Dataverse / deploy fired.

Ask the user:

| Question | Header | Options |
|----------|--------|---------|
| Does this plan look good? | Plan | Approve and start building (Recommended), I'd like to make changes |

- **If "Approve"**: Proceed to Phase 5.
- **If "I'd like to make changes"**: Ask what they want changed, update the JSON, and re-render to a new filename (the render script won't overwrite). Re-open that new file in the browser and repeat 4.5–4.7.

**Output**: Approved implementation plan, with an HTML copy committed alongside the project for the user to reference during and after implementation.

---

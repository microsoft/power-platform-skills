# Mobile Design Philosophy

Required reading for `screen-builder` and `native-app-planner`. Defines **why** screens look a certain way. Companion docs: `screen-templates.md` (archetypes), `tamagui-component-recipes.md` (snippets), `accessibility-checklist.md` (a11y).

---

## Quality Bar

Every screen should feel designed, not generated. Benchmark: a well-made iOS app — same attention to whitespace, alignment, hierarchy. Screenshot your screen next to iOS Settings — if it looks busier or more cramped, fix it.

---

## 1. Visual Hierarchy

Give each screen a clear task or reading focus. Make the next meaningful action prominent when one exists; passive content need not invent a primary CTA.

| Role | Tamagui | Size |
|---|---|---|
| Screen title | `H3`/`H4` | 20–23px |
| Section header | `Text fontSize="$5" fontWeight="600"` | 16px |
| Body / row title | `Text fontSize="$5"` | 16px |
| Secondary | `Paragraph color="$color10"` | 14px |
| Caption / meta | `Text fontSize="$3" color="$color9"` | 13px |

- **Weight:** `700` titles, `600` section headers, `400` body. Never bold body text.
- **Color:** Primary `$color12`, secondary `$color10`, tertiary `$color9`. Accent (`$blue10`) for interactive only.
- **Spacing:** More space = more importance. If two texts are equally spaced, user assumes equal importance.

### Typography Pairing

When the aesthetic direction calls for it (Editorial, Soft/Organic), pair a **serif heading font** with a **sans-serif body/UI font**. For Industrial, Refined Minimal, and Bold/Expressive, use a single sans-serif family and differentiate through weight alone.

| Aesthetic direction | Heading font | Body/UI font | Headline tracking | Body lineHeight |
|---|---|---|---|---|
| Editorial | Serif (Lora, Playfair) | Inter (default) | -0.5 to -1.0 at `$7`+ | 1.6x |
| Soft / Organic | Rounded sans (Nunito) | Inter | -0.3 at `$7`+ | 1.5x |
| Industrial | Inter mono-weight stack | Inter + `$mono` for data | 0 (weight only) | 1.4x |
| Refined Minimal (default) | Inter | Inter | -0.3 at `$8`+ only | 1.5x |
| Bold / Expressive | DM Sans bold | DM Sans lighter weight | -0.5 to -0.8 | 1.5x |

**Negative tracking on headlines:** Apply `letterSpacing` of -0.5 to -1.0 on `fontSize="$7"` and above. Never apply negative tracking below `$6`. This pulls letters closer and makes headings feel authoritative, not loose.

**Line height for body:** Long-form body text (detail screen descriptions, onboarding copy) uses 1.5–1.6x line height for reading comfort. Dense list rows use tighter default (1.3x).

**Column width for prose:** On content-heavy screens (detail, onboarding), wrap prose in `<YStack maxW={520}>` (roughly 62ch at 16px). On phones this is naturally satisfied; apply Config v5 `$sm` variants only to preserve readable width on larger surfaces without changing the native workflow.

**Full pairing configs and font loading instructions** → see `typography-and-tone.md`.

---

## 2. Spatial Rhythm (4px Grid)

Tokens: `$1`=4, `$2`=8, `$3`=12, `$4`=16, `$5`=20, `$6`=24. No hardcoded px.

| Area | Value |
|---|---|
| Screen horizontal padding | `px="$4"` to `px="$5"` |
| Between sections | `gap="$5"` to `gap="$6"` |
| Between list items | `gap="$3"` |
| Card internal padding | `p="$4"` to `p="$5"` |
| Label to input | `gap="$2"` |

All text shares the same left margin. Never mix center-aligned and left-aligned in the same flow.

---

## 3. Information Density

- **List rows:** 2–3 lines max. Title (bold) + description + optional meta.
- **Cards:** 1 title, 1 subtitle, 0–1 action. >3 pieces → split with separator.
- **Forms:** 3–5 visible fields before scroll. Group with section headers.
- **Glance Test:** Can user understand this screen in 2 seconds from title + one visual element alone?

### Home Screen Dashboard

Home is a route, not a universal dashboard shell. Choose its surface from the actor's entry and task: discovery for shopping, a lesson/resume workspace for learning, an actionable queue for expense review, or a checklist/capture flow for an inspection. These are examples, not domain defaults.

A dashboard is useful when comparing multiple signals helps choose the next action. Include only evidence needed for that decision; no mandatory summary tiles, recent-row quotas, progress rings, hero cards, or duplicate list tabs. A direct list/queue Home can be correct even when there is meaningful current state.

Judge the experience through actor → task → entry → decision → committed outcome → next destination → recovery. Supporting tables can stay embedded; legitimate record-management tasks can use CRUD. Repeated structures are useful consistency when tasks repeat, not a reason to force decorative differences.

---

## 4. Touch & Interaction

- Primary actions → bottom of screen (easy thumb reach). Destructive → harder to reach + confirm.
- Touch targets: minimum 44×44pt. Use `hitSlop` on small elements.
- One-handed use is the default phone posture: frequent actions live in the lower half or in native bottom chrome; top-right actions are secondary or mirrored by an accessible row/menu action.
- `pressStyle={{ scale: 0.97 }}` for cards/rows, `opacity: 0.85` for buttons. Not both at full intensity.
- Swipe actions: always provide a visible button alternative.

### Input Ergonomics

- Reduce typing with defaults, recent values, native pickers, steppers, segmented controls, camera/scan, location, and lookup rows before asking for free text.
- Tamagui `Input` / `TextArea` use web-standard keyboard hints: `inputMode`, `type`, `autoComplete`, `enterKeyHint`, and `onKeyDown`. Raw React Native inputs retain their native keyboard props.
- Dates use native date/time pickers. Numbers use numeric keyboards and tolerant parsing. Long text uses `TextArea`, not a tiny single-line input.
- Forms preserve user work: validation/network failures never clear fields; dirty cancel/back requires confirmation; long or multi-step forms need a draft/save-resume path.

---

## 5. Color — 60/30/10 Rule

| Share | Role | Tokens |
|---|---|---|
| **60%** | Neutral base | `$background`, `$surface0`, `$color12`, `$color2` |
| **30%** | Complementary surfaces | `$color4`, `$color5`, `$borderColor` |
| **10%** | Accent — interactive only | `$blue10`/`$accentBase`, `$red10`, `$green10` |

>3 non-neutral colors visible at once = too busy. Strip one.

**No raw grays.** Never use `#f5f5f5`, `#e0e0e0`, `#1a1a1a` or similar pure gray hex values. Always use Tamagui tokens (`$background`, `$color2`, `$color12`) which carry subtle hue tinting. Raw grays make the app feel like a wireframe.

**Surfaces: fill, not borders.** Cards separate from the background via fill difference (`bg="$color2"` on `$background`), not `borderWidth={1}` on everything. Reserve borders for: list item separators (`borderBottomWidth={0.5}`), input fields, and intentional dividers between concepts. If every surface has a border, the screen looks like a wireframe.

**Status colors:** use readable semantic tokens, for example `bg="$green3" color="$green10"`. Saturation follows measured contrast, environment, and urgency — not an industry label. Outdoor visibility can justify stronger contrast without making every field-app screen a status dashboard.

**Dark mode:** elevation via lighter surfaces (not shadow). Reduce text contrast one step. Accent colors brighter. Never pure `#000000` background or pure `#ffffff` text — use hue-tinted near-black and warm cream. See `color-palette-architecture.md` dark mode rules.

**Status colors:** Error `$red10`, Success `$green10`, Warning `$yellow10`, Info `$blue10`. Never color alone — pair with text/icon.

**Contrast floor for mobile chrome:** inactive tabs, helper text, metadata that users need to act on, picker chevrons, modal body copy, and icon affordances use `$color10` or stronger. `$color8` and below are decorative/faint only, not readable UI text.

**Yellow/orange status badges:** do not put white text on yellow/orange fills unless a measured contrast check proves AA. Prefer `bg="$yellow3" color="$yellow11"` or `bg="$orange3" color="$orange11"`.

---

## 6. Loading, Empty & Error States

**Loading:** Skeleton shapes matching real content layout — never centered spinner. Skeleton row = gray blocks matching row height.

**Empty:** Specific explanation and a useful next action when available ("No claims awaiting your review"; refresh or return). A relevant icon can help; an illustration or create CTA is not mandatory on a read-only surface.

**Error:** Inline, not modal. `$red10` text + "Try again" button. Auth errors → redirect to login.

**Offline/interruption:** Show known connection problems and preserve input with retry. Plan resumability for long-running work against supported local/persistent storage; do not imply an offline queue exists because an offline profile was configured. Failed required writes/uploads are not successful completion.

---

## 7. Industry-Adaptive Design

Separate **domain confidence** from **visual preference**. Record confirmed actor/task evidence, reasonable inferences, and consequential unknowns independently of palette, type, and tone. A blue brand does not prove finance; learning does not imply gamification; approval does not imply signature capture; no missing context defaults to field inspection or aviation.

| Evidence about the work | Design implication to consider |
|---|---|
| Comparing many values to decide | Aligned, scannable rows; real units and meaningful ordering |
| Reading or practicing a lesson | Readable prose/exercise area, retained place, unobtrusive controls |
| Evaluating a purchase | Useful product imagery/attributes, quantity and price clarity, committed basket/order state |
| Reviewing evidence before a decision | Evidence adjacent to policy/context; explicit approve/reject outcome and failure recovery |
| Gloved/outdoor use explicitly confirmed | Larger targets and measured high contrast; not automatic camera, map, or offline features |
| Sensitive information explicitly identified | Appropriate reveal/session policy backed by existing auth and authorization |

These implications depend on the job, not the industry name. Brand choices remain explicit user/design decisions; use host defaults when unspecified instead of inventing domain certainty.

---

### Field/Ops Workflow Screens

When field-work requirements include ordered steps, evidence, triage, or hand-off, use the appropriate workflow composition. A simple equipment-management task may legitimately use ordinary list/detail/form screens. The following are optional examples, not mandatory industry screens.

| Workflow | Mobile UX shape |
|---|---|
| Active assignment | Assignment context and the evidence/blocker needed to choose start/resume; summary metrics only when useful |
| Walkaround / ordered checklist | Sticky step header, Step N / total, previous/next controls, evidence capture, defect chips, completion gate |
| Scan / location gate | Only when required and allowlisted: capture/location input, confidence/permission state, retry; authorized override if specified |
| Severity triage | Segmented severity filters, status chips, dense asset rows, active-filter count, high contrast status text |
| Dispatch / hand-off | Ready queue, persisted decision/transfer state; signature or biometric gate only if explicitly required and supported |
| Audit history | Toggle between per-step grouping and chronological log, timestamp + actor + action rows, verification/hash status when relevant |

Use saturated status/accent colors only when they improve field readability. Yellow/orange still need dark readable text unless contrast has been measured.

---

## 8. Micro-Details (Quality Signals)

1. **Consistent radius:** One for cards (`$4`), one for buttons (`$3`), circular for avatars.
2. **Text truncation:** Titles `numberOfLines={1}`, descriptions `numberOfLines={2}`.
3. **Separator vs gap:** `<Separator />` between different concepts, `gap` within same section.
4. **Button hierarchy:** One primary using a confirmed theme such as `theme="blue"`, or explicit Tamagui 2 frame/text composition (`<Button bg="$blue10"><Button.Text color="$color1">Save</Button.Text></Button>`); rest secondary. Do not put text-style props directly on `Button`, and do not use `theme="active"` unless that theme exists in the project config. Destructive styling uses verified danger tokens or a confirmed theme only in confirm dialogs.
5. **Icon + text:** Icon-only OK in headers. In body, always pair with label.
6. **Consistent row structure:** Same height, padding, info architecture in a list.
7. **Header weight:** Background difference or bottom border — never floating.
8. **Intentional space:** Use `mt="auto"` to push actions to bottom naturally.
9. **Monospace for data:** IDs, timestamps, coordinates, currency → `fontFamily="$mono"`.

---

## 9. Emotional Design (Peak-End Rule)

Make completion clear after significant effort. Choose restrained confirmation or a richer moment according to the task and motion preferences; not every flow needs celebration:

| Trigger | Response |
|---|---|
| Core task done | Checkmark animation + personalized summary |
| Milestone reached | Badge/context card ("5th inspection this week") |
| Long form completed | Summary card of what was submitted |
| First-time action | "You're all set" + next-step CTA |

Endings: confirmation after the required save succeeds; undo only when supported; truthful draft status when a real draft mechanism exists. Preserve context and name the next destination.

---

## 10. Aesthetic Direction

The following are optional starting points, not domain-to-style mandates. Apply the approved brand/direction without letting it choose the app's jobs or surfaces.

| Direction | When | Characteristics |
|---|---|---|
| **Industrial** | Field ops, maintenance | Monospace data, uppercase tracked labels, edge-to-edge rows, single accent |
| **Editorial** | Content, learning | Serif headings, generous line height, minimal cards, section numbers |
| **Refined Minimal** | Productivity, enterprise (default) | Inter, precise weight hierarchy, low-radius bordered cards |
| **Soft / Organic** | Healthcare, wellness, consumer | Rounded sans-serif, warm shadow, tinted surfaces |
| **Bold / Expressive** | E-commerce, social | Saturated brand color, strong shadows, full-color accent cards |

---

## 11. Layout Beyond Cards — Content-First Design

### Cards vs. bare content

**Don't use cards for:** Dense lists (>7 items) → edge-to-edge rows. Key-value data → info rows. Sequential content → timeline flow. Reading/prose (detail body, help text) → bare on `$background`.

**Use cards for:** Genuinely grouped content. Different semantic levels. Interactive items (drag/reorder). Stats/summary data that needs visual separation.

Cards add visual noise to reading flows. If a screen's primary purpose is reading or writing, render text directly on `$background` with no card wrapper. Cards are for grouped interactive content or visually distinct data units.

### Section break spacing

Between major content sections, use `gap="$8"` to `gap="$10"` (32–40px). This is dramatically more generous than the `$5`–`$6` guidance in Section 2 and is the single biggest visual quality lever. Within a section, keep tight spacing (`$2`–`$3`).

| Content type | Container | Between sections | Internal gap |
|---|---|---|---|
| Prose/reading (detail body, help) | Bare on `$background` | `gap="$8"` to `gap="$10"` | `gap="$3"` |
| Data list (rows of records) | Edge-to-edge rows | `Separator` between items | `gap="$2"` within row |
| Dashboard (stat cards, charts) | Cards on `$background` | `gap="$5"` between card groups | `gap="$2"` within card |
| Form fields | Bare on `$background` | `gap="$6"` between field groups | `gap="$2"` label-to-input |
| Mixed (text + data + actions) | Alternating bare/card | `gap="$8"` between content types | varies |

### Layout follows content type, not component type

Do not default to "wrap everything in a Card." Ask: is this content meant to be **read**, **scanned**, or **interacted with**?
- **Reading** → bare content on paper, generous spacing, max-width constraint
- **Scanning** → dense rows with separators, tight spacing
- **Interacting** → cards with press styles, standard spacing

### Structured asymmetry

Monospace date on left, title center, badge right. Vary spacing: tight within groups (`gap="$2"`), generous between sections (`gap="$8"`+).

**Centered text is wrong** outside of empty states and onboarding. Left-align all content flows.

---

## 12. Shadows & Polish

Two-layer shadows feel natural. Use `shadows.sm/md/lg` from `tamagui-component-recipes.md`.

**Dark mode:** No shadows — use surface elevation (`$color3` on `$color2`) + hairline borders.

**Hairline rules:** `borderBottomWidth={0.5}` between list items. 0.5px on retina = refined; 1px = clunky.

**Status indicators beyond pills:** Colored dot prefix (`● Open`), left border accent (3px), uppercase tracked text. Reserve filled pills for high-priority states.

---

## 13. Anti-Patterns Checklist

Before returning, check none of these are present:

- [ ] Centered text at top of screen (left-align except empty/onboarding)
- [ ] Equal-padding card stack with nothing else
- [ ] Buttons saying "Submit"/"OK" instead of action-specific labels
- [ ] Skeleton shapes that don't match populated layout
- [ ] Same border radius on everything
- [ ] Engineer-facing strings shown to users
- [ ] Emoji as icons (use Lucide)
- [ ] Generic "No items" empty state without icon/explanation/CTA
- [ ] Long forms with no progress indicator
- [ ] Long/multi-step forms with no draft or resume path
- [ ] Inputs using the default text keyboard for numbers, phone, email, URL, dates, or search
- [ ] Primary action only in the top-right corner on a phone screen
- [ ] `allowFontScaling={false}` on readable text
- [ ] >3 non-neutral colors visible at once
- [ ] Borders on every card/surface — cards should use background fill difference (`$color2` on `$background`), not `borderWidth={1}` on everything. Reserve borders for list item separators only (`borderBottomWidth={0.5}`)
- [ ] Status colors selected from an industry stereotype instead of measured contrast and actual urgency
- [ ] Pure gray palette with no hue — if the plan specifies a custom palette or industry, apply the named palette (see `color-palette-architecture.md`). Even default apps should use Tamagui's built-in hue-tinted tokens, not raw gray hex values
- [ ] Dark mode uses pure black (#000) or raw white (#fff) — dark surfaces should be near-black with a hue tint, text should be warm cream not pure white (see `color-palette-architecture.md` dark mode rules)

If 3+ are present, fix before returning.

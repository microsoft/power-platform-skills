# Mobile Visual Quality Contract

Canonical visual contract for planned previews and generated Expo/Tamagui
screens. Design direction may change the palette and mood, but it may not
remove the hierarchy, spacing, action, or imagery requirements below.

## 1. Typography roles

Use semantic roles consistently. Do not invent a new font size in an
individual screen.

| Role | Tamagui baseline | Size / line | Weight | Use |
|---|---|---|---|---|
| Display | `$9` | 28 / 34 | 700 | One dominant metric or confirmation title |
| Heading | `$8` | 23 / 30 | 700 | Screen title |
| Title | `$6`–`$7` | 18–20 / 24–28 | 600 | Card and section titles |
| Body | `$5` | 16 / 24 | 400 | Primary readable content and form values |
| Body small | `$4` | 14 / 20 | 400–500 | Supporting metadata |
| Caption | `$2` | 12 / 16 | 500–600 | Labels and compact status metadata |
| Data | `$4`–`$8` | role-dependent | 500–700 | Amounts, quantities, IDs, times, and KPIs |

- Keep body copy at 16px on consumer, form-heavy, healthcare, and field
  workflows. A dense trained-user queue may use 14px supporting text, never
  14px for the only readable value.
- Use negative tracking only for Heading/Display roles.
- Let Dynamic Type scale. Layout must wrap or truncate intentionally rather
  than disabling font scaling.
- Prefer the platform/system stack for native familiarity. Use a brand or
  display font only when Gate 3 explicitly approves it, normally for headings.

## 2. Spacing rhythm

Use the shared 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 scale.

- 4–8: icon-to-label and tightly related metadata.
- 12–16: row/card internal padding and form-field gaps.
- 24: section separation.
- 32–48: major hierarchy or intentional sparse composition.
- Do not mix unrelated arbitrary numeric gaps in one screen.
- Dense screens reduce vertical whitespace, not touch targets or readable type.

## 3. Action hierarchy

Every screen has at most one visually dominant primary action.

| Variant | Height | Label | Treatment |
|---|---:|---|---|
| Primary | 48px; 52–56px for field/gloved use | 600 weight, action-specific verb | Accent fill + on-accent text |
| Secondary | Same height as primary when paired | 600 weight | Neutral/transparent fill + border |
| Tertiary | Minimum 44px touch target | 500–600 weight | Chromeless text/icon |
| Destructive | 48px minimum | Explicit destructive verb | Danger treatment; never the default emphasis |

- Paired primary and secondary actions use the same height and radius.
- Button radius follows the app radius policy: tight `$2`, medium `$3`, loose
  `$4`, pill `$10`.
- Bottom-pinned actions must account for the bottom safe-area inset.
- Home/dashboard primary actions use visible labels. An icon-only FAB is only
  valid for one obvious list-create action and still needs an accessible label.
- Prefer shared `PrimaryActionButton`, `SecondaryActionButton`, and
  `DestructiveActionButton` primitives over styling direct `<Button>` instances.

## 4. Surfaces, borders, and elevation

Choose one dominant surface strategy for the app and keep it consistent:

- `flat`: edge-to-edge content with separators.
- `subtle-depth`: filled surfaces differentiated by one token step.
- `strong-cards`: filled cards with one consistent border/elevation recipe.
- `editorial`: fewer containers and deliberate whitespace.

Do not combine borders, strong shadows, tinted fills, and status stripes on the
same ordinary card. Use one separation mechanism plus one status cue. Dark mode
uses surface contrast instead of heavy shadows.

## 5. Screen composition recipes

Every generated/modified screen names one primary recipe. Recipes define
hierarchy, not business content.

| Key | Composition |
|---|---|
| `operational-dashboard` | Context header → current/next item → status/progress strip → 2–4 KPIs → short recent queue |
| `workflow-queue` | Title/search/filter → scan-first rows → one create/advance action |
| `record-detail` | Identity/status hero → grouped facts → related activity → bottom actions |
| `form-capture` | Title/progress → required fields → optional disclosure → persistent save action |
| `media-detail` | Purposeful image/media hero → identity/value → supporting facts → primary action |
| `commerce-discovery` | Context header → recommendation/hero → categories → product/media rows → persistent navigation |
| `cart-summary` | Editable line items → fulfillment message → totals → checkout action |
| `checkout-sections` | Delivery/contact → order summary → payment → final total → place-order action |
| `confirmation-receipt` | Confirmation state → identifier/summary → next action → optional relevant recommendations |
| `content-led` | Title → primary content → restrained metadata/actions; no artificial dashboard chrome |

If no specialized recipe fits, use the nearest archetype recipe and document
the domain-specific difference. Do not produce a generic stack of cards.

## 6. Domain imagery eligibility

Imagery is scenario-dependent, not a universal decoration requirement.

Use imagery only when at least one is true:

- the Dataverse record has an image/file/URL field;
- camera capture or evidence is part of the approved workflow;
- the user supplied approved brand/product assets;
- visual identification materially improves selection or verification.

Every imagery-enabled screen contract must state:

1. source and ownership;
2. user purpose;
3. aspect ratio and crop behavior;
4. loading/error fallback;
5. accessible label or decorative status.

Do not fetch arbitrary stock imagery, invent product photos, or use external
copyrighted assets. When imagery is unavailable, use a tokenized placeholder,
initials, icon, or content-led layout without leaving an empty hero.

## 7. Preview fidelity

Plan and design previews must use the same typography roles, spacing rhythm,
radius policy, action hierarchy, surface strategy, and named composition recipe
as generated screens. Placeholder content is allowed; a different visual system
is not.

Previews remain concepts and must retain the prominent
`DESIGN CONCEPT — NOT THE GENERATED APP` warning.

## 8. Enforcement

- `screen-planner` records the shared visual contract once and names a
  composition recipe per generated/modified screen.
- `/design-system` materializes typography, spacing, size, radius, component,
  and imagery decisions.
- `screen-builder` uses the shared action primitives and semantic roles.
- validators block raw numeric typography on Tamagui text and undersized or
  unshaped direct primary buttons.

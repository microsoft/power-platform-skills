# Canvas App QA Runtime Checklist

Use this compact checklist after `validate-canvas-screen.cs` passes. The script owns
deterministic YAML and layout-structure checks; this file owns the visual, behavioral,
responsive, and evidence checks that require the screen brief or human judgment.

Do not read `QAChecks.md` during normal generation. It is the detailed repair reference
for an unfamiliar validator failure or unresolved semantic defect.

## Reporting

```text
QA coverage: 1-44 COMPLETE
QA repairs: QACHK-MISSING-FORMULA-PREFIX FIXED(2) · QACHK-CONTAINER-MIN-SIZE FIXED(1)
QA N/A: QACHK-GRID-CONTRACT · QACHK-TIMER-LIFECYCLE
```

- Include validator repairs and manual repairs in `QA repairs`.
- Use `N/A` only when the construct is absent from the assigned scope.
- `COMPLETE` means the persisted YAML passed preflight and every applicable manual rule
  below was inspected.

## Automated preflight checks

The validator checks these rules and prints targeted file/line repairs:

- `QACHK-MISSING-FORMULA-PREFIX`
- `QACHK-DUPLICATE-PROPERTY-KEY`
- `QACHK-ENUM-LITERAL` for unquoted numeric members
- `QACHK-MISSING-VARIANT` for GroupContainer and Gallery
- `QACHK-CONTAINER-MIN-SIZE`
- `QACHK-FILLPORTIONS-DEFAULT`
- `QACHK-SCROLL-TRAP`
- `QACHK-NO-HEIGHT-TRAP`
- `QACHK-TEXT-PADDING`
- `QACHK-FILLPORTIONS-HEIGHT-CONFLICT`
- `QACHK-FILLPORTIONS-WIDTH-CONFLICT`
- `QACHK-GALLERY-TEMPLATE-LAYOUT`
- `QACHK-FIXED-LAYOUT-WIDTH`
- `QACHK-ITEM-DISPLAY-TEXT`
- `QACHK-CARD-PLACEHOLDER` for missing image slots
- `QACHK-GRID-CONTRACT` for required grid properties
- `QACHK-ROOT-CONTAINMENT` for responsive screen roots
- `QACHK-READ-ONLY-ANCESTOR`

`QACHK-CONTROL-CREATION-KEYWORDS` remains manual because the authoritative creation
contract is supplied by the screen brief, not inferable from YAML alone.

## Manual checks

1. `QACHK-CONTROL-CREATION-KEYWORDS` — Every created control exactly matches the brief's
   `Control`, `ComponentName`, `ComponentLibraryUniqueName`, `Variant`, and `Layout`.
2. `QACHK-ENUM-LITERAL` — Every enum qualifier matches the brief's `Enum name:` and every
   non-identifier member is quoted.
3. `QACHK-CROSS-AXIS-ALIGNMENT` — Text-bearing vertical containers use Stretch; intentional
   fixed-size children use an explicit appropriate `AlignInContainer`.
4. `QACHK-WRAP-MISSING` — Single-line navigation, badge, KPI, title, and header text uses
   `Wrap: =false`; prose and descriptions retain wrapping.
5. `QACHK-NO-HEIGHT-TRAP` — Fixed main-axis sizes fit children, gaps, padding, and every
   responsive branch; no parent/descendant sizing feedback loop exists.
6. `QACHK-ACCESSIBLE-LABEL-MISSING` — Every content or input control has a meaningful
   accessible label; interactive galleries have `TabIndex: =0`; decorative controls are
   intentionally unlabeled.
7. `QACHK-NO-REFLOW` — Every substantive horizontal row fits or stacks/wraps at desktop,
   tablet, and phone widths.
8. `QACHK-ROOT-NOT-SCROLLABLE` — Content taller than the shortest viewport has a working
   root scroll path without a direct-child fill trap.
9. `QACHK-LOW-CONTRAST-TEXT` — Text on every explicit colored surface has an explicit,
   readable foreground.
10. `QACHK-VARIANT-SURFACE-CONTRAST` — Fluent appearance/theme surfaces and foreground
    colors remain readable in every formula branch.
11. `QACHK-CARD-PLACEHOLDER` — Every supported ModernCard slot is intentionally populated
    or blanked, and its height fits all visible slots.
12. `QACHK-GALLERY-ROW-FITS-CONTENT` — Every `TemplateSize` branch fits the complete row,
    including nested minimums, gaps, padding, actions, and card image bands.
13. `QACHK-GRID-CONTRACT` — Grid row count, column count, height, gaps, padding, and child
    positions use one consistent responsive formula.
14. `QACHK-DUPLICATE-GRID-SEARCH` — A searchable data grid does not duplicate a separate
    search control over the same source.
15. `QACHK-TIMER-LIFECYCLE` — Automatic timers have a reliable start/reset edge, cannot be
    accidentally paused, and display the requested direction and expiry state.
16. `QACHK-HIDDEN-BOUNDED-LIST` — Small bounded lists show all rows through the root scroll;
    sizing never depends on rendered `AllItems` state.
17. `QACHK-SEMANTIC-VALUE-BINDING` — Badges, cards, avatars, and similar controls bind the
    visible semantic value, not only styling or accessibility metadata.
18. `QACHK-ACTION-LABEL-FIT` — Every labeled action fits at each breakpoint; multiword
    actions in vertical AutoLayout use an explicit usable width.
19. `QACHK-ACTION-CONTRACT` — Every Required Record Field and Required Action exists,
    is reachable, and implements its complete brief contract.
20. `QACHK-MUTATION-OUTCOME` — Every mutation preserves stable identity, updates the
    canonical source, and shows an in-viewport receipt with write-set/proof-set parity.
21. `QACHK-BEHAVIOR-ACCEPTANCE` — Symbolically execute every assigned Given/When/Then
    scenario, including invalid, empty, clear, rejection, and boundary paths.
22. `QACHK-HORIZONTAL-BUDGET` — Child minimum widths, gaps, and padding fit every horizontal
    branch without shrinking actions below 44px or clipping required content.
23. `QACHK-MANUAL-BOUNDS` — Simultaneously visible manual-layout rectangles stay inside
    the parent and do not overlap except for intentional nonblocking overlays.
24. `QACHK-TEXT-CONTENT-FIT` — The longest required text fits or wraps within both its
    control and containing row/card/template at every breakpoint.
25. `QACHK-VISUAL-CONTRACT` — Typography, palette, spacing, surfaces, action styles, and
    hierarchy match `canvas-app-shared.md`.
26. `QACHK-EXCESS-WHITESPACE` — Fill portions, fixed heights, spacers, and SpaceBetween do
    not create unexplained blank regions or push primary work below the fold.
27. `QACHK-CORE-VISUALIZATION` — Every named visualization has meaningful populated
    content, truthful empty behavior, and the required relationship/comparison encoding.
28. `QACHK-PRIMARY-ACTION-REACHABILITY` — Each required action is enabled in an attainable
    state, at least 44px by 44px, unobscured, and reachable from the initial task path.
29. `QACHK-LIFECYCLE-IDENTITY` — Edit, delete, approve, reject, and status changes target a
    stable selected record, never display text, row position, or a partial reconstructed row.
30. `QACHK-SHARED-SOURCE-DERIVATION` — Filters, ordering, alerts, KPIs, dashboards,
    visualizations, and reports read the same mutable source updated by actions.

## Directional mutation rule

For opposing transitions, inspect both contracts and both concrete scenarios. The operation
selector must be visible and pointer-selectable, submission must fail closed when operation
or amount/value is invalid, and the handler must read the current explicit choice. For
arithmetic pairs, verify increase is `old + amount`, decrease is `old - amount`, and the
receipt shows operation, old value, amount, expected value, and actual persisted value.

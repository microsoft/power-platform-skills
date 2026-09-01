# Canvas App YAML — Controls, Properties and Enums

Choosing a control type, and writing properties and enum values that the compiler accepts.
`describe_control` output is the only authority on which properties a control has.

## Contents

- Discover before you choose
- Interpret property defaults and requirements
- Layout containers
- Data display
- Selection controls — `ItemDisplayText` is a per-item formula
- Properties are per-control — never transfer them by analogy
- Control template versions
- Enum type names
- Enum member values
- Option set values
- Color and button-state patterns
- Timer lifecycle
- Read-only ancestors
- Cross-screen navigation
- Semantic display values
- Common property reference
- Troubleshooting

## Discover before you choose

**⚠️ Required — not optional:** run `list_controls` before planning your layout. Controls
you don't know exist can't influence your design, and the catalog includes high-level
controls (`ModernTabList`, `ModernCard`, and others) that are easy to miss and expensive
to reinvent with primitives.

The resulting list will also specify if any Code Components or Canvas Components are available as control instances in the app. The result identifies the `ComponentName` to pass to `describe_control`.

Run `describe_control` on every type you plan to use.

## Interpret property defaults and requirements

The `Default` shown for a property is the value the property takes when it is omitted from the YAML.
Properties marked `Required: true` must be provided, even when no default is shown.
Omit other properties to accept their default.

### Refresh Canvas and Code Component descriptions

`describe_control` results for Canvas and Code Components are snapshots of the current
Studio document, not durable catalog entries. Re-run `describe_control` for the returned
`ComponentName` after a successful `compile_canvas` applies changes to a local component
definition or its custom properties. Do not reuse component descriptions from an earlier
turn after any of those events. Refresh immediately before recording component properties
in a plan or editing a component instance.

## Layout containers

| Use Case | Control Type | Variant |
|----------|--------------|---------|
| Precise positioning | `GroupContainer` | `ManualLayout` |
| Horizontal responsive layout | `GroupContainer` | `AutoLayout` with `LayoutDirection: =LayoutDirection.Horizontal` |
| Vertical responsive layout | `GroupContainer` | `AutoLayout` with `LayoutDirection: =LayoutDirection.Vertical` |

Default to AutoLayout. Use ManualLayout only when the user explicitly requests
pixel-perfect positioning or the app is a fixed-size desktop dashboard. Mobile and
cross-device apps MUST use AutoLayout. See `${PLUGIN_ROOT}/references/LayoutGuide.md` for the patterns.

⚠️ **`GroupContainer` has no `OnSelect` — it cannot be clicked.** This is a common dead
end when building card UI: the container lays out perfectly but tapping it does nothing.

- **Clickable cards:** use `ModernCard` instead — it has `OnSelect` and is designed for it.
- **Clickable non-card areas:** overlay a transparent `Button` or `Rectangle` (both have
  `OnSelect`) at the same position and size. Set the `Appearance` property to transparent
  where available; otherwise `Fill: =RGBA(0,0,0,0)` and `BorderThickness: =0`.

⚠️ **`ModernCard` fills unset slots with placeholder content.** It is not an empty
surface. A card that sets only `Title` renders a large stock photograph above it and the
literal words `Subtitle` and `Description` below it, and the photo consumes most of the
card's height — so the value you did set ends up clipped. Nothing about this reaches
`compile_canvas`.

Set every slot the card displays, and blank the ones you do not want:

```yaml
- KpiOpenCard:
    Control: ModernCard
    Properties:
      Image: =Blank()          # required — otherwise a stock photo appears
      HeaderImage: =Blank()    # when supported — otherwise header artwork can remain
      Title: =CountRows(colTasks) & ""
      Subtitle: ="Open tasks"
      Description: ="Across all projects"
```

Use only properties returned by `describe_control`; some card versions expose
`HeaderImage`, `ImageAccessibleLabel` and `HeaderImageAccessibleLabel`. When present,
blank both image slots for a text-only card and set their accessible labels explicitly.
Do not compress Title, Subtitle and Description into a short fixed-height KPI card; let
the card size naturally, reduce the displayed slots, or choose a height that fits them.

When you do want the image, give the card enough `Height` for the image band **plus** the
text, and remember that a card used as a gallery row template needs the gallery's
`TemplateSize` to match.

## Data display

| Use Case | Control Type | Key Properties |
|----------|--------------|----------------|
| List of items | `Gallery` | Items, TemplateSize, OnSelect |
| Modern tabular data | `ModernDataGrid` only when its definition can configure columns; otherwise Gallery + header row | Items, Searchable, Sortable, OnChange |
| Forms | `Form` | DataSource, Item, OnSuccess |

### ModernDataGrid does not need a second search box

`ModernDataGrid.Searchable` renders its own search input. When the screen already has a
separate search field or filter bar, leave `Searchable` false or unset and bind the grid's
`Items` to the external filter formula. Two independent search affordances make it
unclear which filter is active.

`ModernDataGridColumn` properties are version-specific. Copy the current
`describe_control` definition into the screen brief.

If the current `ModernDataGrid` definition exposes no `Fields`, `Columns`, or supported
child-column contract, do not create a new grid for a local collection. It can compile
and still render "There are no fields in this data table." Use an explicit header row
plus a Gallery row shell and implement sorting through the Gallery `Items` formula.

## Selection controls and filters — `ItemDisplayText` is a per-item formula

Choose the interaction before styling the control. These rules apply equally to form
fields, filters, sort choices, periods, statuses, and category selectors:

- For a short static required set, prefer `ModernRadio` or visible choice buttons when the options fit, then a `ModernDropdown` that selects an option by click or tap.
- Use `ModernCombobox` only for a large set that benefits from search or when free-form entry is explicitly required. Do not use it for a short required set merely because modern controls are preferred.
- Give a required short-choice field a valid initial selection when the business rule permits one. If an explicit choice is required, show a visible placeholder and validation, but keep selection independent of typed filtering or keyboard-only commitment.
- A populated `Items` formula is not enough. The planned control must expose readable options and commit the selected record or value through its normal pointer interaction.
- Record the exact selected-value property returned by `describe_control` and bind it into
  the consumer formula. Never guess `Selected.Value`, invent a child listbox, or assume
  that opening a popup commits a value.
- For a filter, show the active choice and provide a reachable clear/reset action. Verify
  the consumer against at least two matching records and one non-matching record.

`ItemDisplayText` and `ItemKey` on `ModernDropdown`, `ModernCombobox` and similar controls
are evaluated once per row with `ThisItem` in scope. They take an expression, not a column
name in quotes:

```yaml
# WRONG — every option renders the constant string, or renders blank
Items: =colWorkTypes
ItemDisplayText: ="Value"

# RIGHT — the option shows that row's Value field
Items: =colWorkTypes
ItemDisplayText: =ThisItem.Value
```

A dropdown whose options all appear empty is almost always this mistake. When `Items` is
already a single-column table you can omit `ItemDisplayText` entirely.

`Default` is not evaluated in the dropdown's per-item scope. Do not use
`Default: =First(Self.Items)`, which can fail because `Self.Items` is unavailable there.
Use an explicit record compatible with `Items`, or a record from the same source:

```yaml
Items: '=[{Value:"All"},{Value:"Open"},{Value:"Closed"}]'
Default: '=First([{Value:"All"},{Value:"Open"},{Value:"Closed"}])'
```

For a bounded Gallery, calculate its height with `Self.TemplateHeight`.
`Self.TemplateSize` is not a supported runtime property even when `TemplateSize` is the
authored YAML property:

```yaml
Height: =CountRows(Self.Items) * Self.TemplateHeight
```

For charts, `ItemColorSet` is a color-table literal, not a table of records:

```yaml
ItemColorSet: =[RGBA(0,102,204,1), RGBA(16,124,65,1)]
```

## Properties are per-control — never transfer them by analogy

Three traps produce most `Unknown property` errors.

### Trap 1 — assuming a styling property is universal

Corner-radius, shadow, and padding properties are **not** available on every control.
`Rectangle` in particular has **no** radius properties:

```text
Unknown property 'RadiusTopLeft' for control type 'Rectangle'.
```

`ModernCard` does not have them either — it exposes a single numeric `BorderRadius`
instead. For a rounded, filled surface with independent corners use a `GroupContainer`,
which supports all four `Radius*` properties plus `DropShadow` and the four `Padding*`
properties.

### Trap 2 — assuming text styling is spelled the same everywhere

The modern React controls and the FluentV9 controls disagree about basic names. This is
the most common single-property mistake:

| Intent | `ModernText`, `ModernButton`, `ModernDropdown`, `ModernTextInput`, `ModernNumberInput`, `PieChart` | `Badge` | `ModernCard` |
|--------|---------------------------------------------------------------------------------------------------|---------|--------------|
| Text color | `Color` | `FontColor` | `TitleColor` / `SubtitleColor` / `DescriptionColor` |
| Font size | `Size` | `FontSize` | `TitleSize` / `SubtitleSize` / `DescriptionSize` |
| Displayed string | `Text` | `Content` | `Title` / `Subtitle` / `Description` |
| Corner rounding | `RadiusTopLeft` … `RadiusBottomRight` | none | `BorderRadius` |

`Progress` is narrower still: no `Fill`, no `Color`, no `Font*`. It is styled through
`BasePaletteColor` and its three `Progress.*` enums.

`Gallery` has `Fill` but no text properties at all — style the labels inside it, not the
container.

### Trap 3 — deriving creation keywords from `list_controls`

`list_controls` returns the name used to query `describe_control`; it is not the authored
YAML contract. The `Control creation keywords` block in `describe_control` is
authoritative. Copy its `Control:` value and any required `ComponentName`,
`ComponentLibraryUniqueName`, `Variant`, and `Layout` keywords verbatim.

## Control template versions

Do not add, remove, or replace an `@version` suffix yourself. If compilation reports a
template-version conflict, re-run `describe_control` and make every instance use the
exact `Control:` value currently returned for that type:

```text
Another instance of control type 'ModernText' has already been referenced using a
different version '1.0.0'. All control instances for the same type must currently
reference the same version.
Control type 'ModernText@1.5.0' has a version that is newer than the current version
of '1.0.0'. Using the current version, which may produce errors.
```

"may produce errors" means the app now binds the *older* template, and every property that
exists only in the newer one is reported as unknown — naming the internal control type,
not the one you wrote:

```text
Unknown property 'Color' for control type 'Text'.
```

Those properties may be valid on `ModernText`; resolve the creation-keyword mismatch
before changing them. Do not assume the bare or versioned form is correct without
checking `describe_control`.

## Enum type names

**Never construct an enum type name. Copy it.** `describe_control` prints the exact type
name on the `Enum name:` line under every enum property. That name is the only correct
one, and it cannot be derived from the control name:

| Control | Property | `Enum name:` reported by `describe_control` |
|---------|----------|---------------------------------------------|
| `ModernDropdown` | `Appearance` | `Appearance` |
| `ModernTextInput` | `Appearance` | `Appearance` |
| `ModernNumberInput` | `Appearance` | `Appearance` |
| `ModernButton` | `Appearance` | `ButtonAppearance` |
| `Badge` | `Appearance` | `BadgeCanvas.Appearance` |
| `Badge` | `Shape` | `BadgeCanvas.Shape` |
| `Badge` | `ThemeColor` | `BadgeCanvas.ThemeColor` |
| `Progress` | `Shape` | `Progress.Shape` |
| `Progress` | `Thickness` | `Progress.Thickness` |
| `ModernNumberInput` | `Precision` | `DecimalPrecision` |

Five controls, one property name, four different enum types. Guessed names like
`BadgeAppearance`, `DropdownAppearance` or `ProgressBar.ProgressColor` all fail with
`Name isn't recognized`.

Wrap the enum **name** in `'` whenever it contains a dot, a space, or a special
character. Then append `.Member`:

```yaml
# Enum name contains a dot -> quote the name, not the member
- StatusBadge:
    Control: Badge
    Properties:
      Appearance: ='BadgeCanvas.Appearance'.Tint
      Shape: ='BadgeCanvas.Shape'.Rounded
      ThemeColor: ='BadgeCanvas.ThemeColor'.Success

# Plain enum name -> no quoting needed
- ProjectPicker:
    Control: ModernDropdown
    Properties:
      Appearance: =Appearance.Underline
```

⚠️ An enum member is never a bare identifier. `ThemeColor: =Subtle` fails with
`Name isn't recognized` exactly like a wrong type name does. Removing the qualifier is
never the fix — correcting the qualifier is.

## Enum member values

The **member** obeys a separate quoting rule from the type name, and it is the rule that
is missed most often.

**A member that starts with a digit must be wrapped in `'`.** `describe_control` reports
these members bare — `values: 0, 1, 2, 3, 4, 5, Auto` — but that listing is not the
literal you write:

```yaml
# WRONG — Power Fx parses `DecimalPrecision`, then hits `.1` and stops
Precision: =DecimalPrecision.1

# RIGHT
Precision: =DecimalPrecision.'1'
```

This is not a `Name isn't recognized` failure. The parser reads the digit as the start of
a new number, so the property emits **`Expected operator` and `Expected an operand`
together** — two messages on one property, naming no enum at all. Seven such properties
produce twenty-one errors that never mention the word "enum".

Every enum whose members are numeric is affected; `DecimalPrecision` is the one you will
meet most. Whenever a control definition lists members that begin with a digit, write the
quoted form.

## Option set values

Escape an option set name or value with `'` when it contains spaces or special characters,
or starts with a number:

```yaml
# Option set name with a space
- galItemsGallery:
    Control: Gallery
    Properties:
      Items: =Filter(Accounts, 'Account Status' = 'Account Status'.Active)

# Option set with special characters
- lblDueDate:
    Control: ModernText
    Properties:
      Text: =ThisItem.DueDate
      Visible: =ThisItem.Status = 'Status (Assignments)'.Active
```

## Color and button-state patterns

```yaml
# Color constants
Fill: =Color.White
BasePaletteColor: =Color.Blue

# RGBA
Fill: =RGBA(240, 240, 240, 1)
FontColor: =RGBA(0, 0, 0, 1)

# Conditional color
BasePaletteColor: =If(isActive, Color.Blue, Color.Gray)
```

Fluent appearances own their surface. `ButtonAppearance.Secondary`, `Outline`, `Subtle`
and `Transparent` can remain light even when `Fill` is set. Pair those appearances with a
dark `Color`, or switch to `Primary` and set `BasePaletteColor` for a dark surface. Do not
assume `Fill` overrides the variant.

## Timer lifecycle

An automatic Timer needs a start edge after the control exists. If `AutoStart: =false`
and the `Start` variable is set true before navigation, the timer can remain at its
initial value until the user clicks it. For timers that gate a workflow:

- Prefer `AutoStart: =true`.
- On screen entry and on each next-item action, set the running variable false, toggle
  `Reset`, then set running true.
- Use `AutoPause: =false` unless manual pause is explicitly required.
- Display remaining time, not elapsed time:
  `Text: =If(varTimerFinished, "00:00", Text(Time(0, 0, Max(0, RoundUp((Self.Duration - Self.Value) / 1000, 0))), "mm:ss"))`.
- Do not use the timer surface as an unlabeled pause button. Add a separate labelled
  control when pause/resume is required.

## Read-only ancestors

`DisplayMode` is inherited. Do not put row action buttons inside a Gallery or container
set to `DisplayMode.View`; the descendants become disabled even when they look enabled.
Use `Selectable: =false` to prevent Gallery selection while leaving the Gallery in
`DisplayMode.Edit`.

## Cross-screen navigation

`ModernTabList` is for tabs that switch panels within one screen. Do not use its
`OnChange` to navigate between screens: the selected tab can update while `Navigate`
does not, leaving the highlight and visible screen out of sync. For cross-screen primary
navigation, use a row of ModernButtons whose `OnSelect` performs the navigation and whose
appearance is derived from the current screen.

## Semantic display values

Semantic controls need their visible value property. `Badge.AccessibleLabel` does not
replace `Badge.Content`; omitting Content can render placeholder text such as `AB`.

## Common property reference

**Positioning:**

- `X`, `Y` — position (absolute in ManualLayout)
- `Width`, `Height` — size
- `Align` — text alignment (horizontal)
- `VerticalAlign` — text alignment (vertical)

**Styling:**

- `Fill` — background color (absent on `Badge` and `Progress`)
- `Color` — text color on the modern React controls; `Badge` spells it `FontColor`
- `BasePaletteColor` — theme color for `Badge`, `Progress`, and the modern inputs
- `Size` — font size on the modern React controls; `Badge` spells it `FontSize`
- `FontWeight` — Bold, Semibold, Normal, Lighter

**Behavior:**

- `DisplayMode` — Edit, View, Disabled
- `Visible` — boolean visibility
- `OnSelect` — click handler
- `OnVisible` — screen load handler

**Layout (AutoLayout):**

- `LayoutDirection` — Horizontal or Vertical
- `LayoutAlignItems` — Center, Start, End, Stretch
- `LayoutJustifyContent` — Center, SpaceBetween, Start, End
- `LayoutGap` — spacing between items
- `LayoutOverflowY` — vertical overflow (`Scroll` for scrollable containers)
- `FillPortions` — proportional sizing
- `PaddingTop`/`PaddingBottom`/`PaddingLeft`/`PaddingRight` — container padding

## Troubleshooting

- **`Unknown property`:** run `describe_control` and use only the properties it returns
  for that exact control type.
- **Many `Unknown property` errors naming a control type you never wrote** (e.g. `'Text'`
  when your YAML says `ModernText`): a template version conflict. Re-run
  `describe_control`, copy its complete creation-keyword block to every instance of that
  type, and re-compile.
- **A property works on one control but not a similar one:** property support is per
  control type, and the modern React, FluentV9 and Classic families disagree. Check the
  per-control table above rather than reasoning by analogy.
- **`Name isn't recognized` on an enum:** the enum type name is wrong. Copy the
  `Enum name:` line from `describe_control` verbatim; quote it with `'` if it contains a
  dot. Deleting the qualifier is not a fix.
- **`Expected operator` AND `Expected an operand` on the same property:** an enum member
  that starts with a digit was written unquoted. `Precision: =DecimalPrecision.1` must be
  `Precision: =DecimalPrecision.'1'`. Note that this pair of messages names no enum and is
  *not* `Name isn't recognized` — see "Enum member values" above.
- **A `ModernCard` renders a large stock photograph, or the words "Title" / "Subtitle" /
  "Description":** those slots were left unset. `ModernCard` fills unset slots with
  placeholder content rather than collapsing them. Set `Image`, `Title`, `Subtitle` and
  `Description` for every slot the card shows, and set `Image: =Blank()` when the card is
  meant to be text-only.
- **Button text is too small:** set `Size` on `ModernButton` — but confirm the font
  property exists on that control first.

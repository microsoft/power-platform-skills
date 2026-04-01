# Canvas App YAML Generation Guide

This guide captures best practices and learnings for generating Canvas App YAML screens.

## Quick Start Checklist

When generating a new Canvas App screen:

Always review this technical guide AND the design guide prior to designing a screen.

1. ⚠️ **Run `list_controls` FIRST — this is non-optional** - Controls you don't know exist can't influence your design. Skipping this step leads to rebuilding things like `Avatar`, `Badge`, `Progress`, `ModernTabList`, and `ModernCard` from scratch using primitive controls. Run `list_controls` before planning layout or choosing any control type.
2. ✅ **Explore examples** - Review existing `.pa.yaml` files for patterns if available
3. ✅ **Plan state management** - Identify what variables you need (Set() calls)
4. ✅ **Choose layout strategy** - ManualLayout for precise control, AutoLayout for responsive design
5. ✅ **Select control types** - Match controls to use case
6. ✅ **Write formulas carefully** - Use Power Fx syntax with `=` prefix
7. ✅ **Validate early and often** - Use `compile_canvas` tool to catch errors

## File Structure

Have one .pa.yaml file for the App object, and a separate file for each screen.

```yaml
Screens:
  ScreenName:
    Properties:          # Optional screen-level properties
      Fill: =RGBA(...)
      OnVisible: |-      # Initialize variables on screen load
        =Set(var1, value);
        Set(var2, value)
    Children:
      - ControlName:
          Control: ControlType
          Variant: VariantName    # Optional
          Properties:
            PropertyName: =formula
          Children:      # Only for controls with children
            - NestedControl:
                ...
```

## YAML Syntax Rules

### Multi-line formulas — use `|-`

Any formula that spans multiple lines must use the `|-` block scalar. The `=` prefix goes on the first content line, not on the `|-` line:

```yaml
OnSelect: |-
  =Set(x, 1);
  Set(y, 2)
```

Single-line formulas can be written inline:

```yaml
Text: =firstName & " " & lastName
```

### Strings that contain `: ` must be quoted

YAML treats `key: value` as a mapping. If a plain string value contains a colon followed by a space, wrap the whole value in quotes:

```yaml
# WRONG — YAML parses "Label: something" as a nested mapping key
HintText: =Label: enter a value

# RIGHT
HintText: ="Label: enter a value"
```

### Power Fx record literals must be quoted — `={Value: "..."}` will fail

⚠️ This is a common source of hard-to-diagnose errors. A Power Fx record literal looks like `{Value: "x"}`, but in a YAML plain scalar that `Value:` is parsed as a YAML mapping key before Power Fx ever sees it. Always wrap record literals in a quoted YAML string:

```yaml
# WRONG — YAML parses `Value:` as a mapping key, formula never runs
Default: ={Value: "Tab1"}

# RIGHT — outer quotes make the whole thing a YAML string first
Default: "={Value: ""Tab1""}"

# Also valid — single quotes (no escaping needed for inner double quotes)
Default: '={Value: "Tab1"}'
```

This applies anywhere a record literal appears inline: `Default`, `Selected`, `Items` (when hardcoded), and similar properties. `ModernTabList.Default` is the most common place this bites.

## Control Type Selection

**⚠️ Required — not optional:** Run list_controls before planning your layout. Controls you don't know exist can't influence your design, and the catalog includes high-level controls (`Avatar`, `Badge`, `Progress`, `ModernTabList`, `ModernCard`, and others) that are easy to miss and expensive to reinvent with primitives.

### Layout Containers

| Use Case | Control Type | Variant |
|----------|--------------|---------|
| Precise positioning | `GroupContainer` | `ManualLayout` |
| Horizontal Responsive layout | `GroupContainer` | `Horizontal` with `LayoutDirection: =LayoutDirection.Horizontal` |
| Vertical Responsive layout | `GroupContainer` | `Vertical` with `LayoutDirection: =LayoutDirection.Vertical` |

⚠️ **`GroupContainer` has no `OnSelect` — it cannot be clicked.** This is a common dead end when building card UI: the container lays out perfectly but tapping it does nothing.

- **Clickable cards:** Use `ModernCard` instead — it has `OnSelect` and is designed for this.
- **Clickable non-card areas:** Overlay a transparent `Button` or `Rectangle` (both have `OnSelect`) on top of the container at the same position and size. If applicable, set the Appearance property to transparent; otherwise set `Fill: =RGBA(0,0,0,0)` and `BorderThickness: =0` to make it invisible.

### Data Display

| Use Case | Control Type | Key Properties |
|----------|--------------|----------------|
| List of items | `Gallery` | Items, TemplateSize, OnSelect |
| Tabular data | `Table` | Items, columns |
| Grid data with editing | `DataGrid` | Items, columns, OnSelect |
| Forms | `Form`, `EntityForm` | DataSource, Item, OnSuccess |

## Common Property Patterns

### Positioning (ManualLayout)

```yaml
Properties:
  X: =100                    # Absolute position
  Y: =50
  Width: =200               # Fixed width
  Height: =40
```

### Responsive Sizing

```yaml
Properties:
  X: =(Parent.Width - Self.Width) / 2    # Center horizontally
  Width: =Parent.Width                    # Full width
  Height: =Parent.Height - Self.Y         # Fill remaining height
```

### Colors

```yaml
# Using color constants
Fill: =Color.White
BasePaletteColor: =Color.Blue

# Using RGBA
Fill: =RGBA(240, 240, 240, 1)
FontColor: =RGBA(0, 0, 0, 1)

# Conditional colors
BasePaletteColor: =If(isActive, Color.Blue, Color.Gray)
```

### Button States

```yaml
Properties:
  DisplayMode: =If(isDisabled, DisplayMode.Disabled, DisplayMode.Edit)
  Text: =buttonText
  OnSelect: |-
    =If(condition,
      false,                           # Guard clause - do nothing
      Set(variable, value);            # Execute logic
      Set(anotherVar, anotherValue)
    )
```

## Power Fx Formula Patterns

### State Management

```yaml
# Initialize variables on screen load
OnVisible: |-
  =Set(variable1, "initial value");
  Set(variable2, 0);
  Set(variable3, false)

# Update state on interaction
OnSelect: |-
  =Set(counter, counter + 1);
  Set(status, "updated")
```

### Conditional Logic

```yaml
# Simple conditional
Text: =If(isActive, "Active", "Inactive")

# Nested conditionals
Text: =If(status = "complete",
       "Done!",
       If(status = "pending",
          "In Progress",
          "Not Started"))

# Boolean expressions
Visible: =isEnabled && !isHidden
DisplayMode: =If(gameOver || alreadyPlayed, DisplayMode.Disabled, DisplayMode.Edit)
```

### String Operations

```yaml
# Concatenation
Text: =firstName & " " & lastName
Text: =currentPlayer & " wins!"

# String comparison
## Not equal (empty string)
Visible: =searchText <> ""
## Equal (case-sensitive)
Visible: =selectedOption = "Option1"
```

### Converting date/time values to text

When using format specifiers, always use them in lower case (e.g., `mm` for month, not `MM`)

```yaml

# Convert date to text using the "dddd, mmmm d, yyyy" format (e.g., "Monday, January 1, 2024")
Text: =Text(varDate, "dddd, mmmm d, yyyy")

# Convert current time to text using the "hh:mm:ss" format (e.g., "14:30:00")
Text: =Text(Now(), "hh:mm:ss")
```

### Escaping enum values

Some enum names and/or values need to be escaped with `'` to be parsed correctly in Power Fx.
That is the case if the name or the value contains spaces, special characters, or if it starts with a number. For example:
```yaml
# Using enum values with dots: the enum name is 'ButtonCanvas.Appearance' and it has a value 'Transparent'
- ButtonCanvas1:
    Control: Button
    Properties:
      Appearance: ='ButtonCanvas.Appearance'.Transparent

# Using enum values that start with a number: the enum name is 'DecimalPrecision' and it has a value '2'
- NumberInput1:
    Control: ModernNumberInput
    Properties:
      Precision: =DecimalPrecision.'2'
```

### Escaping option set values

Some option set names and values need to be escaped with `'` to be parsed correctly in Power Fx. That is the case if
the name or the value contains spaces, special characters, or if it starts with a number. For example:
```yaml
# Using option set values with spaces: the option set name is 'Account Status' and it has a value 'Active'
- galItemsGallery:
    Control: Gallery
    Properties:
      Items: =Filter(Accounts, 'Account Status' = 'Account Status'.Active)

# Using option set with special characters
- lblDueDate:
    Control: ModernText
    Properties:
      Text: =ThisItem.DueDate
      Visible: =ThisItem.Status = 'Status (Assignments)'.Active
```

## Layout Strategies

### Manual Grid Layout

For precise control (e.g., game boards, forms):

```yaml
- Container:
    Control: GroupContainer
    Variant: ManualLayout
    Properties:
      X: =100
      Y: =100
      Width: =300
      Height: =300
    Children:
      - Button1:
          Control: Button
          Properties:
            X: =0
            Y: =0
            Width: =90
            Height: =90
```

**Pattern:** Calculate positions as `(size * index) + (spacing * index)`

### Auto Layout (Responsive)

For flexible, responsive designs:

```yaml
- Container:
    Control: GroupContainer
    Variant: AutoLayout
    Properties:
      LayoutDirection: =LayoutDirection.Horizontal
      LayoutAlignItems: =LayoutAlignItems.Center
      LayoutJustifyContent: =LayoutJustifyContent.SpaceBetween
      LayoutGap: =16
      PaddingTop: =8
      PaddingBottom: =8
    Children:
      - Button1:
          Properties:
            FillPortions: =1    # Takes proportional space, change for relative proportions within a container
```

**Key Learnings:**

1. **Dynamic Gallery Height:** Use `Height: =CountRows(Self.AllItems) * Self.TemplateHeight`
2. **Enable Container Scrolling:** Set `LayoutOverflowY: =LayoutOverflow.Scroll`
3. **AutoLayout Child Properties:** Children have `AlignInContainer`, `FillPortions`, `LayoutMinWidth/Height`, `LayoutMaxWidth/Height`
4. **Pure AutoLayout:** Don't mix ManualLayout inside AutoLayout containers

## Event Handling Patterns

### Guard Clauses

```yaml
OnSelect: |-
  =If(gameOver || pos1 <> "",
    false,                      # Do nothing if condition met
    Set(pos1, currentPlayer);   # Otherwise execute logic
    UpdateGameState()
  )
```

### Sequential Operations

```yaml
OnSelect: |-
  =Set(pos1, currentPlayer);
  Set(gameOver, CheckWinCondition());
  Set(currentPlayer, If(currentPlayer = "X", "O", "X"))
```

## Named Formulas (NFs) and User Defined Functions (UDFs)

Define reusable logic in `App.Formulas`. This is ideal for constants, complex calculations, 
or any logic that needs to be shared across multiple controls or screens.

```yaml
App:
  Properties:
    Formulas: |-
      =// Named constants
      MaxItems = 100;
      ColorPrimary = RGBA(52, 120, 246, 1);

      // Functions with parameters
      GetStatusColor(status: Text): Color =
        If(
          status = "complete", Color.Green,
          status = "pending", Color.Yellow,
          Color.Gray
        );

      TogglePlayer(current: Text): Text =
        If(current = "X", "O", "X");
```

**Benefits:** Maintainability, readability, consistency, performance

## Best Practices

### State Management
- ✅ Initialize all variables in `OnVisible`
- ✅ Use descriptive variable names
- ✅ Keep state updates sequential with semicolons

### Formula Design
- ✅ Use guard clauses to prevent invalid operations
- ✅ Keep formulas readable with proper indentation
- ❌ Don't create deeply nested If statements

### Layout
- ✅ Use ManualLayout for precise, fixed layouts
- ✅ Use AutoLayout for responsive, flexible layouts
- ✅ Use pure AutoLayout for scrollable screens
- ✅ Set `LayoutOverflowY: =LayoutOverflow.Scroll` on scrollable containers
- ✅ Set dynamic gallery heights: `Height: =CountRows(Self.AllItems) * Self.TemplateHeight`
- ❌ Don't mix ManualLayout inside AutoLayout containers
- ❌ Don't create nested scrollbars

### Control Selection
- ✅ Use ListControls tool to discover options
- ✅ Use DescribeControl tool to verify properties
- ❌ Don't guess at property names

### Validation
- ✅ Use compile_canvas tool to validate directory
- ✅ Validate after major changes
- ❌ Don't skip validation until the end

### Data
If the app you're building requires any references to external data sources, temporarily use `ClearCollect` in the App.OnStart property to populate collections with mock data. 

## Common Property Reference

**Positioning:**
- `X`, `Y` - Position (absolute in ManualLayout)
- `Width`, `Height` - Size
- `Align` - Text alignment (horizontal)
- `VerticalAlign` - Text alignment (vertical)

**Styling:**
- `Fill` - Background color
- `FontColor` - Text color
- `BasePaletteColor` - Button color theme
- `Size` - Font size
- `FontWeight` - Font weight (Bold, Semibold, Normal)

**Behavior:**
- `DisplayMode` - Edit, View, Disabled
- `Visible` - Boolean visibility
- `OnSelect` - Click handler
- `OnVisible` - Screen load handler

**Layout (AutoLayout):**
- `LayoutDirection` - Horizontal or Vertical
- `LayoutAlignItems` - Center, Start, End, Stretch
- `LayoutJustifyContent` - Center, SpaceBetween, Start, End
- `LayoutGap` - Spacing between items
- `LayoutOverflowY` - Vertical overflow (Scroll for scrollable containers)
- `FillPortions` - Proportional sizing
- `PaddingTop/Bottom/Left/Right` - Container padding

## Troubleshooting

- **Formula doesn't update UI:** Ensure you're using `Set()` to update variables
- **Button text is too small:** Buttons don't support `Size` property - make button larger
- **Variables reset unexpectedly:** Variables are screen-scoped - use `OnVisible` to initialize
- **Layout doesn't look right:** Check if you're mixing ManualLayout and AutoLayout
- **Validation fails with "Unknown property":** Use describe_control tool to see valid properties

## Implementation Workflow

1. **list_controls** — required before planning layout; know what exists before writing any YAML
2. **describe_control** — verify property names and variants for each control you plan to use
3. **Draft screen structure** — sketch the container/control hierarchy before filling in properties
4. **Write properties and formulas** — positioning, colors, state, event handlers
5. **Validate with compile_canvas** — catch errors early; don't wait until the end
6. **Fix errors** — use describe_control to confirm valid property names before guessing
7. **Iterate** — validate after each meaningful change until the screen compiles clean
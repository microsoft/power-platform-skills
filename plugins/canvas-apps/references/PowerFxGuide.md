# Canvas App YAML — Power Fx Formulas, Events and Data

Formula patterns for state, events, reusable logic, and mock data.

## Contents

- State management
- Conditional logic
- String operations
- Date and time formatting
- Event handling
- Named formulas and user defined functions
- Mock data collections
- Formula rules of thumb
- Troubleshooting

## State management

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

`Set()` creates app-wide variables; `UpdateContext()` creates screen-scoped ones. A value
that resets on navigation was created with `UpdateContext`; a value that unexpectedly
persists across screens was created with `Set`.

## Conditional logic

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

## String operations

```yaml
# Concatenation
Text: =firstName & " " & lastName

# Not equal (empty string)
Visible: =searchText <> ""

# Equal (case-sensitive)
Visible: =selectedOption = "Option1"
```

Any value containing `: ` must be quoted at the YAML level — see
`${PLUGIN_ROOT}/references/YamlSyntax.md`.

## Date and time formatting

Format specifiers are lower case (`mm` for month, not `MM`):

```yaml
# "dddd, mmmm d, yyyy" -> "Monday, January 1, 2024"
Text: =Text(varDate, "dddd, mmmm d, yyyy")

# "hh:mm:ss" -> "14:30:00"
Text: =Text(Now(), "hh:mm:ss")
```

## Event handling

### Guard clauses

```yaml
OnSelect: |-
  =If(gameOver || pos1 <> "",
    false,                      # Do nothing if condition met
    Set(pos1, currentPlayer);   # Otherwise execute logic
    UpdateGameState()
  )
```

### Sequential operations

```yaml
OnSelect: |-
  =Set(pos1, currentPlayer);
  Set(gameOver, CheckWinCondition());
  Set(currentPlayer, If(currentPlayer = "X", "O", "X"))
```

### Confirm the action and clear the state that caused it

An action that changes data must say so, and must leave the form in a clean state. Two
defects show up constantly in generated apps: a quantity silently changes with no
acknowledgement, and a validation message stays on screen after the record it complained
about was successfully saved.

```yaml
OnSelect: |-
  =Patch(colInventory, ThisItem, {Quantity: ThisItem.Quantity - varAdjustBy});
  Notify("Issued " & varAdjustBy & " units", NotificationType.Success);
  Set(varAdjustBy, 0);
  Set(varShowValidation, false)
```

- Use `Notify(...)` or a transient in-screen message after every create, update, or delete.
- Reset the inputs and the flags that drove validation in the same handler.
- Gate validation text on a variable you clear on success, not on the raw field value.
- After a failed submit shows validation, clear that flag from every relevant input's
  `OnChange`, or keep the message visible only while the required fields remain invalid.
  An error must not remain visible once the user has corrected all fields.

### Toggle once, report the same next value

Do not mutate a record and then inspect that same `ThisItem` to infer what happened.
Compute the next value once and use it for both the write and the confirmation:

```yaml
OnSelect: |-
  =Set(varNextCheckedIn, !ThisItem.CheckedIn);
  Patch(colMembers, ThisItem, {CheckedIn: varNextCheckedIn});
  Notify(
    ThisItem.Name & If(varNextCheckedIn, " checked in", " marked not ready"),
    NotificationType.Success
  )
```

## Named formulas and user defined functions

Define reusable logic in `App.Formulas` — constants, complex calculations, and anything
shared across controls or screens.

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

## Mock data collections

When an app references external data that is not yet connected, populate collections with
`ClearCollect` in `App.OnStart`.

For a small, read-only table used by only one control, keep it local instead:

```yaml
Items: |-
  =Table(
    {Title: "Draft"},
    {Title: "Review"},
    {Title: "Publish"}
  )
```

Use an `App.OnStart` collection when several screens share the records or interactions
add, edit or remove rows. Never `ClearCollect` fixed display data in a screen's
`OnVisible`; that couples rendering to navigation and reruns the seed every visit.

**Keep mock data compact.** `App.OnStart` runs before the first screen paints and its
entire text is serialized into the saved app, so oversized seed data slows startup and
bloats the document.

- ✅ 5–8 rows per collection — enough to make galleries, filters, and empty states look real
- ✅ Descriptions of one short sentence (roughly 60–100 characters)
- ❌ Paragraph-length prose per row
- ❌ Dozens of rows to "look full" — a gallery reads the same with 6 rows

If a screen needs more variety, vary the field values, not the row count.

The collection schemas defined here resolve app-wide, so a single wrong field name in
`App.pa.yaml` fails every screen that binds to it. Compile `App.pa.yaml` on its own before
any screen is written.

## Formula rules of thumb

- ✅ Initialize screen interaction state in `OnVisible` and app-wide state in
  `App.OnStart`
- ✅ Derive responsive layout directly from current width
- ✅ Use descriptive variable names
- ✅ Keep state updates sequential with semicolons
- ✅ Use guard clauses to prevent invalid operations
- ✅ Keep formulas readable with proper indentation
- ❌ Don't create deeply nested `If` statements
- ❌ Don't store breakpoints, column counts or page widths in variables
- ❌ Never call `Navigate` from `App.OnStart` or the start screen's `OnVisible`

## Troubleshooting

- **Formula doesn't update the UI:** the value is not stored in a variable — use `Set()`.
- **A variable resets when you navigate:** it was created with `UpdateContext` where you
  needed `Set`. A value that unexpectedly persists is the reverse.
- **Dozens of unrelated `Name isn't valid` or `'.' operator cannot be used on Error
  values` errors:** almost always cascading from an `App.pa.yaml` failure. Fix `App`
  first, then re-compile.
- **`Navigate is not permitted in OnStart`:** set `App.StartScreen` instead.
- **`No type found for variable 'x'. Ensure that it is Set to a non-Blank value
  somewhere in the app.`:** you wrote `Set(x, Blank())` — or seeded a mock collection
  column with `Blank()` and nothing else. Power Fx infers a variable's type from the
  values assigned to it, and `Blank()` carries no type. An empty string (`""`) is a
  typed Text value and does not cause this error. Seed the variable with a typed literal,
  or set it from real data after the collection exists:

  ```powerfx
  // WRONG — no type to infer
  Set(varSelectedTask, Blank());

  // RIGHT — the record type comes from the collection
  ClearCollect(colTasks, {Id: 1, Title: "Draft agenda", Hours: 2});
  Set(varSelectedTask, First(colTasks));
  ```

  When the variable genuinely starts empty, still type it first and clear it after:
  `Set(varSelectedTask, First(colTasks)); Set(varSelectedTask, Blank());`

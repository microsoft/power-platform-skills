# Canvas App YAML — File Structure and Syntax

How a `.pa.yaml` file is shaped, the syntax rules that decide whether it parses, and the starting workspace every new app arrives with.

## Contents

- File structure
  - Named objects representations
  - Creating control instances
  - The `Variant` keyword may be optional, required or not allowed
  - Canvas and Code Component discovery
  - Canvas Component instances
  - Code Component (aka third-party control) instances
- YAML syntax rules
  - Multi-line formulas
  - Values containing `: ` must be quoted
  - Power Fx record literals must be quoted
  - Every property value starts with `=`
  - Reading `YamlInvalidSyntax` reasons
- The starting workspace — `Screen1` and `_EditorState.pa.yaml`
- App configuration

## File structure

Each '*.pa.yaml' file should contain a single top-level object. These are specified using one of the following top-level keywords:
- `App` - Represents the 'App' object in the app. The filename for this object should be `App.pa.yaml`.
- `EditorState` - Controls the Studio ordering of screens and local component definitions through `ScreensOrder` and `ComponentDefinitionsOrder`. Use filename `_EditorState.pa.yaml`.
- `ComponentDefinitions` - A named-object-mapping of local component definitions. Use filename `<the component's name>.pa.yaml`.
- `Screens` - A named-object-mapping of screens in the app Use filename `<the screen's name>.pa.yaml`.

You should ensure each top-level object is placed into its own pa.yaml file, using the correct top-level keyword.

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
          Variant: VariantName    # Required for controls that declare variants
          Properties:
            PropertyName: =formula
          Children:      # Only for controls with children
            - NestedControl:
                ...
```

### Named objects representations

In the Power Apps YAML schema, data structures represent objects that have names.
There are two common structures used to represent sets of these objects:

#### named-object-sequence

A YAML sequence (aka array) where each item represents a single named object. The ordering of these objects IS SIGNIFICANT and is implied by their order in the YAML source.

Example: The `Children` keyword is always a named-object-sequence.
```yaml
Children:
  - child1:
      Control: Text
  - child9:
      Control: Text
  - child2:
      Control: Text
```
The meaning of the `Children` order depends on the parent, but in most cases it reflects either Z-index order or order within a layout container.

#### named-object-mapping

A YAML mapping where each item's name is a keyword in the mapping. No ordering of these named objects is implied.
When the server writes YAML, it usually normalizes the order to provide consistent round-tripping, such as for source-control diffs.

Example: All control instances and most top-level objects (App, Screens, ComponentDefinitions) support a `Properties` keyword
which contains the Power Fx expressions for each input property available for the control.
```yaml
  - myControl1:
      Control: ControlTypeId
      Properties:
        PropertyName1: =formula
        PropertyName3: =formula
        PropertyName2: =formula
```

### Creating control instances

A control instance is any control that is not a top-level object. These are usually specified under the `Children` keyword of a parent object.
The structure of the `Children` is a named-object-sequence, as mentioned above.

For each control instance, the following YAML object keywords are used to create a control instance (aka control creation keywords):
- `Control` - Required. aka 'ControlTypeId'. Indicates the control type.
- `ComponentName` - Required for any Canvas or Code Component instances (i.e. when `Control` is `CanvasComponent` or `CodeComponent`). See below for more info
- `ComponentLibraryUniqueName` - Required for instances of Canvas Components that are imported from a Component Library. This value comes from the library's unique name in Dataverse.
- `Variant` - Indicates a variant or flavor of the control which often defines additional properties and or behaviors. For some controls, this keyword may be optional, required or not allowed.
- `Layout` - Indicates the direction that a control should layout their children. For some controls, this keyword may be required or not allowed.

To get details of whether a control requires any of the above keywords, you must make a call to the `describe_control` tool.

### The `Variant` keyword may be optional, required or not allowed

The call to `describe_control` specifies whether the `Variant` keyword is optional or required. If the result doesn't list any variants, then the `Variant` keyword is not allowed.

The two controls you will use constantly are:

| ControlTypeId | Allowed `Variant` values |
|---------|--------------------------|
| `GroupContainer` | `AutoLayout`, `GridLayout`, `ManualLayout` |
| `Gallery` | `Vertical`, `Horizontal`, `VariableHeight` (and many layout presets) |
* this list is not exhaustive; depend instead on the call to `describe_control`.

### Canvas Component instances

Canvas components (`Control: CanvasComponent`) are controls that are defined within the same Power App (aka local component), or imported from a Component Library stored in Dataverse.

Local component definitions can be authored in the `Components/` folder as `.pa.yaml` files.

Canvas component instances use the following control creation keywords:
```yaml
Control: CanvasComponent # required
ComponentName: Dialog  # the name of the component after being imported into the app
ComponentLibraryUniqueName: cat_powercatcomponentlibrary_0be3a # Required for library components; otherwise, not used for local components
```
Note: The following keywords are not supported for Canvas Components: `Variant`, `Layout`

### Code Component (aka third-party control) instances

Code components (`Control: CodeComponent`) are third-party controls made available by the Dataverse environment through a solution. Currently, they must be imported through the Power Apps Studio client.

Code component instances use the following control creation keywords:
```yaml
Control: CodeComponent # required
ComponentName: cat_PowerCAT.Spinner  # the name of the code component
```
Note: The following keywords are not supported for Code Components: `ComponentLibraryUniqueName`, `Variant`, `Layout`.

## YAML syntax rules

### Multi-line formulas — use `|-`

Any formula that spans multiple lines must use the `|-` block scalar. The `=` prefix goes
on the first content line, not on the `|-` line:

```yaml
OnSelect: |-
  =Set(x, 1);
  Set(y, 2)
```

Single-line formulas can be written inline:

```yaml
Text: =firstName & " " & lastName
```

### Any value containing `: ` must be quoted — including formulas

YAML treats `key: value` as a mapping, so a plain (unquoted) scalar may not contain a
colon followed by a space *anywhere*. This bites hardest on the most ordinary thing in a
canvas app: a label that concatenates a caption with a value.

```yaml
# WRONG — the value is a plain scalar containing ": ", so YAML splits it
HintText: =Label: enter a value
Text: ="Location: " & ThisItem.Location
AccessibleLabel: ="Votes: " & ThisItem.Votes

# RIGHT — single-quote the whole value; inner double quotes need no escaping
HintText: '="Label: enter a value"'
Text: '="Location: " & ThisItem.Location'
AccessibleLabel: '="Votes: " & ThisItem.Votes'

# ALSO RIGHT — a block scalar has no such restriction
Text: |-
  ="Location: " & ThisItem.Location
```

The failure is reported as:

```text
An error occurred while parsing PaYaml. Error code: YamlInvalidSyntax;
Reason: While scanning a plain scalar value, found invalid mapping.
```

It names no control and no line, so it is expensive to hunt down after the fact. Scan for
`: ` in every value as you write it. The rule covers hint text, headings, tooltips, and
any `Text`, `Content`, `Title`, `Subtitle` or `AccessibleLabel` that formats a caption.

### Power Fx record literals must be quoted — `={Value: "..."}` will fail

A Power Fx record literal looks like `{Value: "x"}`, but in a YAML plain scalar that
`Value:` is parsed as a YAML mapping key before Power Fx ever sees it. Always wrap record
literals in a quoted YAML string:

```yaml
# WRONG — YAML parses `Value:` as a mapping key, formula never runs
Default: ={Value: "Tab1"}

# RIGHT — outer quotes make the whole thing a YAML string first
Default: "={Value: ""Tab1""}"

# Also valid — single quotes (no escaping needed for inner double quotes)
Default: '={Value: "Tab1"}'
```

This applies anywhere a record literal appears inline: `Default`, `Selected`, `Items`
(when hardcoded), and similar properties. `ModernTabList.Default` is the most common place
this bites.

### Every property value starts with `=`

A `.pa.yaml` property value is a Power Fx expression, not a YAML literal. Omitting the
`=` fails the whole file:

```text
An error occurred while parsing PaYaml. Error code: YamlInvalidSyntax;
Reason: Power Fx expressions must start with '='.
```

```yaml
# WRONG
Text: Weekly Timesheet
Width: 320
Visible: true

# RIGHT
Text: ="Weekly Timesheet"
Width: =320
Visible: =true
```

With a `|-` block the `=` goes on the first content line, never on the `|-` line itself.

### Reading `YamlInvalidSyntax` reasons

A file that fails to parse reports **no other diagnostics**, so its real errors stay
hidden until it parses. Fix these first, and map the reason string directly to a cause:

| Reason | Cause | Fix |
|--------|-------|-----|
| `Power Fx expressions must start with '='` | A property value missing its `=` prefix | Add `=`; quote literal text as `="..."` |
| `While scanning a plain scalar value, found invalid mapping` | An unquoted value containing `: ` — a caption concatenation or a record literal | Wrap the whole value in `'...'`, or convert it to a `|-` block |
| `Expected 'MappingEnd', got 'Scalar' (at Line: N, Col: N)` | A key indented to the wrong level | Go to the reported line and align it with its siblings |
| `While parsing a block collection, did not find expected '-' indicator` | A `Children:` entry written without its leading `- ` | Add `- ` before the control name |
| `Named object value cannot be null` | A key with nothing after it — an empty `Properties:`, or a property with no value | Give it a value or delete the key |
| `Duplicate name 'X' used at ...` | The same property key written twice in one `Properties:` block | Delete the duplicate; the message reports the first use's line and column |
| `While scanning a multi-line double-quoted scalar, found wrong indentation` | A quoted string wrapped across lines | Put it on one line, or convert the property to a `|-` block |
| `found character that cannot start any token` | A tab character | Replace tabs with spaces |

**Use the coordinates.** These messages carry `Line`, `Col`, and — for duplicates — the
location of the first use. Open that exact line rather than re-reading the file or
rewriting the screen. A parse error is one wrong character, never a design problem.

## The starting workspace — `Screen1` and `_EditorState.pa.yaml`

A new blank app is **not** an empty workspace. It already contains:

- `App.pa.yaml` — app-level properties
- `Screen1.pa.yaml` — one default screen, possibly with an empty container scaffold
- `_EditorState.pa.yaml` — Studio ordering metadata (`ScreensOrder` and `ComponentDefinitionsOrder`)

### Reuse `Screen1` — never leave it stranded

⚠️ The most common generated-app defect is an app that ships with a blank `Screen1` next
to the real screens. It appears in the screen list, it is usually first in `ScreensOrder`,
and it makes the app look unfinished.

**Rule:** In CREATE mode, the first screen of your design MUST be written into
`Screen1.pa.yaml`, replacing its contents wholesale. Keep the top-level key as `Screen1`
and include `Screen1` in the intended position in `_EditorState.pa.yaml`. Give every
control inside it a meaningful name.

```yaml
# Screen1.pa.yaml — the app's first real screen. Do NOT create "Home.pa.yaml"
# and leave this file blank.
Screens:
  Screen1:
    Properties:
      Fill: =RGBA(18, 18, 20, 1)
      OnVisible: =Set(varSelectedTab, "Sessions")
    Children:
      - HomeRoot:
          Control: GroupContainer
          Variant: AutoLayout
          ...
```

Edit `_EditorState.pa.yaml` when the requested Studio order differs from the current
order. List exact screen and component-definition names in the desired sequence:

```yaml
EditorState:
  ScreensOrder:
    - Screen1
    - DetailsScreen
  ComponentDefinitionsOrder:
    - HeaderComponent
```

Preserve existing names that are not being removed from the app. Names omitted from an
order list are placed after listed entries, so include the full list when deterministic
ordering matters.

## App configuration

- ✅ Set `App.StartScreen` to the intended landing screen — `=Screen1` in CREATE mode.
- ✅ Write your first screen into the pre-existing `Screen1.pa.yaml`.
- ❌ Never call `Navigate` from `App.OnStart` or from the start screen's `OnVisible`. The
  compile reports `Navigate is not permitted in OnStart`; set `App.StartScreen` instead.

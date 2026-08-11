# Canvas App YAML — File Structure and Syntax

How a `.pa.yaml` file is shaped, the syntax rules that decide whether it parses, and the
starting workspace every new app arrives with.

**Who does what.** Discovery and compilation belong to the orchestrator and the
`canvas-app-planner`: they run `list_controls`, `describe_control`, the data and API
tools, and `compile_canvas`. A `canvas-screen-builder` has only `Read`, `Write` and
`Edit` — it never discovers and never compiles, and relies entirely on the property names,
enum names and variants recorded in its screen brief. Where these guides say "run
`list_controls`" or "compile early", that instruction is addressed to the orchestrator and
planner.

## Contents

- Before you write YAML
- File structure
- `Variant` is required for controls that declare variants
- Multi-line formulas
- Values containing `: ` must be quoted
- Power Fx record literals must be quoted
- Every property value starts with `=`
- Reading `YamlInvalidSyntax` reasons
- The starting workspace — `Screen1` and `_EditorState.pa.yaml`
- App configuration

## Before you write YAML

1. ⚠️ **Run `list_controls` first — this is non-optional.** Controls you don't know exist
   can't influence your design, and the catalog includes high-level controls that are
   expensive to reinvent from primitives.
2. Run `describe_control` for every control type you intend to use, and record the exact
   property names, `Enum name:` lines and variants.
3. Review this guide, `${PLUGIN_ROOT}/references/ControlGuide.md`,
   `${PLUGIN_ROOT}/references/LayoutGuide.md` and
   `${PLUGIN_ROOT}/references/DesignGuide.md` before designing a screen.
4. Plan state: the variables each screen sets, and where they are initialized.
5. Choose a layout strategy: AutoLayout for responsive, ManualLayout only for fixed
   desktop dashboards.
6. Compile early and often rather than saving validation for the end.

## File structure

Have one `.pa.yaml` file for the App object, and a separate file for each screen.

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

### `Variant` is required for controls that declare variants

`Variant` is not a styling nicety. A control whose template declares variants has no
default, and omitting the key fails the compile:

```text
The keyword 'Variant' is required but is missing or empty.
```

The message names no file and no control, so it is expensive to locate after the fact.
The two you will use constantly are:

| Control | Allowed `Variant` values |
|---------|--------------------------|
| `GroupContainer` | `AutoLayout`, `GridLayout`, `ManualLayout` |
| `Gallery` | `Vertical`, `Horizontal`, `VariableHeight` (and many layout presets) |

`Form` (`Modern`, `Classic`) and the data-card and data-grid-column controls also require
one. `describe_control` lists a `Variants` section for any control that needs it — if that
section is present, the key is mandatory.

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
- `_EditorState.pa.yaml` — Editor metadata (`ScreensOrder`)

### Reuse `Screen1` — never leave it stranded

⚠️ The most common generated-app defect is an app that ships with a blank `Screen1` next
to the real screens. It appears in the screen list, it is usually first in `ScreensOrder`,
and it makes the app look unfinished.

**Rule:** In CREATE mode, the first screen of your design MUST be written into
`Screen1.pa.yaml`, replacing its contents wholesale. Keep the top-level key as `Screen1`
so `_EditorState.pa.yaml` stays consistent, and give every control inside it a meaningful
name.

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

Never edit `_EditorState.pa.yaml`; Studio owns it.

## App configuration

- ✅ Set `App.StartScreen` to the intended landing screen — `=Screen1` in CREATE mode.
- ✅ Write your first screen into the pre-existing `Screen1.pa.yaml`.
- ❌ Never call `Navigate` from `App.OnStart` or from the start screen's `OnVisible`. The
  compile reports `Navigate is not permitted in OnStart`; set `App.StartScreen` instead.

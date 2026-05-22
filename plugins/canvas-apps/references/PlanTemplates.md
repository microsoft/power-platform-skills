# Canvas App Plan — Document Templates

These templates define the structure for `canvas-app-plan.md`, the single source of truth
consumed by `canvas-screen-builder` agents. Use the mode-appropriate template below.

---

## CREATE Mode Plan Structure

```markdown
# Canvas App Plan

## Mode
CREATE

## App Requirements
[The original user requirements passed to this agent]

## Working Directory
[The absolute path where .pa.yaml files should be written]

## Discovery Summary
- Controls available: [N] — notable: [list of most relevant]
- Data sources: [names or "none connected"]
- Connectors: [names or "none connected"]

## Data Source Schemas
[For each data source used in the app, embed the FULL output of get_data_source_schema]
[Screen builders will reference column names and Power Fx types from here]
[Omit entirely if no data sources are used]

### [DataSourceName]
[Full get_data_source_schema output]

## API Details
[For each connector used in the app, embed the FULL output of describe_api]
[Screen builders will reference operation names and parameters from here]
[Omit entirely if no connectors are used]

### [ApiName]
[Full describe_api output]

## Screens
| Screen | File | Purpose | Key Controls |
|--------|------|---------|--------------|
| [Name] | [Name].pa.yaml | [description] | [controls] |

## Aesthetic Direction
- Palette: [description]
- Primary background: RGBA([...])
- Accent color: RGBA([...])
- Text primary: RGBA([...])
- Text secondary: RGBA([...])
- Layout strategy: [AutoLayout (Vertical/Horizontal) / ManualLayout + rationale]
- Typography scale: [header size/weight, body size/weight, caption size]

## Named Variables and Shared State
[App-level variables, named formulas, collection names — so each builder uses consistent names]
[Example: selectedItem (Record), isLoading (Boolean), appTheme (Record with color fields)]

## Control Definitions
[For each control type used in the design, embed the FULL output of describe_control]
[Builders will reference property names from here — do not summarize or abbreviate]

### [ControlTypeName]
[Full describe_control output]

### [ControlTypeName]
[Full describe_control output]

## Per-Screen Specifications

### [Screen Name]
- **File:** [Name].pa.yaml
- **Purpose:** [description]
- **Layout:** [VerticalAutoLayout / ManualLayout, root container details]
- **Key Controls:** [list with purpose of each]
- **Data Binding:** [variable names, data source references, collection names]
- **Navigation:** [which screen(s) this navigates to, trigger conditions]
- **State:** [any local variables set in OnVisible]

### [Screen Name]
[repeat for each screen]

## TechnicalGuide Key Conventions
[Embed the most critical YAML syntax rules from TechnicalGuide.md that screen-builders must follow:
- Formula prefix (= required)
- Multi-line formula syntax (|- block scalar)
- String quoting rules
- Record literal syntax
- Enum escaping patterns
- Any patterns specific to this app's control choices]
```

---

## EDIT Mode Plan Structure

```markdown
# Canvas App Plan

## Mode
EDIT

## Edit Requirements
[The original user edit requirements passed to this agent]

## Working Directory
[The absolute path where .pa.yaml files are located]

## Current App Summary
- Screens: [list each screen with brief description]
- Layout strategy: [ManualLayout / AutoLayout / mixed]
- Current palette:
  - Background: RGBA([...])
  - Accent: RGBA([...])
  - Text primary: RGBA([...])
  - Text secondary: RGBA([...])
- Variables in use: [list variable names and types]
- Data sources: [names or "none connected"]

## Screens to Modify
| Screen | File | Summary of Changes |
|--------|------|--------------------|
| [Name] | [Name].pa.yaml | [description] |

## Screens to Add
| Screen | File | Purpose |
|--------|------|---------|
| [Name] | [Name].pa.yaml | [description] |
(omit this section if no new screens)

## Data Source Schemas
[For each data source involved in the edit, embed the FULL output of get_data_source_schema]
[Editors will reference column names and Power Fx types from here]
[Omit entirely if no data sources are involved]

### [DataSourceName]
[Full get_data_source_schema output]

## API Details
[For each connector involved in the edit, embed the FULL output of describe_api]
[Editors will reference operation names and parameters from here]
[Omit entirely if no connectors are involved]

### [ApiName]
[Full describe_api output]

## Control Definitions
[For each NEW control type not already in the existing app, embed the FULL output of describe_control]
[Editors will reference property names from here — do not summarize or abbreviate]
[Omit entirely if no new control types are being added]

### [ControlTypeName]
[Full describe_control output]

## Per-Screen Edit Specifications

### [Screen Name] (Existing)
- **File:** [Name].pa.yaml
- **Current State:** [brief summary of what the screen currently contains]
- **Changes Required:** [specific numbered list of changes to apply]
- **Controls to Add:** [control name, type, properties — or "none"]
- **Controls to Remove:** [control name — or "none"]
- **Properties to Update:** [control name → property name → new value]

### [Screen Name] (New)
- **File:** [Name].pa.yaml
- **Purpose:** [description]
- **Layout:** [VerticalAutoLayout / ManualLayout, root container details]
- **Key Controls:** [list with purpose of each]
- **Data Binding:** [variable names, data source references, collection names]
- **Navigation:** [which screen(s) this navigates to, trigger conditions]
- **State:** [any local variables set in OnVisible]

## TechnicalGuide Key Conventions
[Embed the most critical YAML syntax rules from TechnicalGuide.md that screen-editors must follow:
- Formula prefix (= required)
- Multi-line formula syntax (|- block scalar)
- String quoting rules
- Record literal syntax
- Enum escaping patterns
- Any patterns specific to controls used in this edit]
```

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
- **Control Prefix:** [short unique prefix, e.g., `Hom_`]
- **Purpose:** [description]
- **Layout:** [VerticalAutoLayout / ManualLayout, root container details]
- **Key Controls:** [prefixed control names and purpose]
- **Data Binding:** [variable names, data source references, collection names]
- **Navigation:** [which screen(s) this navigates to, trigger conditions]
- **State:** [any local variables set in OnVisible]

#### Contract (required for verification)

- **Primary Content:** [the main data-displaying element — e.g., "Gallery named `Hom_TaskList` with Items bound to `Filter(Tasks, Status = selectedStatus)`" or "Form named `Req_OrderForm` bound to selectedOrder"]
- **Primary Interaction:** [the main user action — e.g., "Button named `Req_SubmitBtn` whose OnSelect calls `Patch(Orders, orderForm.LastSubmit)`" or "Gallery item tap sets selectedTask and navigates to Detail"]
- **Required Handlers:** [list of OnSelect/OnChange/OnVisible formulas that must be non-empty and functional — e.g., "Req_SubmitBtn.OnSelect must call Patch()", "Hom_Gallery1.OnSelect must set selectedItem"]
- **Journey Steps:** [which user journey steps this screen implements — e.g., "View all tasks", "Filter by status", "Navigate to detail"]
- **Outcome Handling:** [required feedback and state management — specify each that applies]
  - Validation: [e.g., "Form validates required fields before submit; shows inline errors"]
  - Success feedback: [e.g., "After Patch() succeeds, show notification and navigate to List"]
  - Failure feedback: [e.g., "On Patch() error, show error banner with message"]
  - State refresh: [e.g., "After save, refresh Gallery.Items to show updated data"]
  - Empty state: [e.g., "If Gallery.Items is empty, show 'No tasks found' message"]

### [Screen Name]
[repeat for each screen — every screen MUST have a Contract section with prefixed control names]

## Core Functional Journeys

Define 3–5 end-to-end user journeys that the app must support. Each journey spans one or more
screens and represents a complete user goal. The orchestrating skill verifies these journeys
after all screens are built.

**Priority:** Order journeys by importance — P1 journeys are critical paths that must work;
P2/P3 are secondary flows.

### Journey: [Journey Name] (P1)

- **Entry Point:** [screen and control where the journey starts — e.g., "Home screen, 'Add Task' button"]
- **Screens Involved:** [ordered list of screens the user traverses — e.g., "Home → TaskForm → Home"]
- **Required Operations:** [data operations that must occur — e.g., "Patch() to create new Task record"]
- **Expected Outcome:** [what success looks like — e.g., "New task appears in Home screen gallery"]
- **Success Behavior:** [user feedback on success — e.g., "Success notification shown, form clears, navigates to Home"]
- **Failure Behavior:** [user feedback on failure — e.g., "Error banner shown, form remains for retry"]

#### Journey Step Mapping

| Step                | Screen   | Control        | Event Property         | Formula Must Include         |
| ------------------- | -------- | -------------- | ---------------------- | ---------------------------- |
| 1. User taps Add    | Home     | Hom_AddTaskBtn | OnSelect               | `Navigate(TaskForm`          |
| 2. User fills form  | TaskForm | Frm_TaskForm   | (data entry)           | Form fields bound to newTask |
| 3. User taps Save   | TaskForm | Frm_SaveBtn    | OnSelect               | `Patch(Tasks,`               |
| 4. Success feedback | TaskForm | (notification) | OnSelect (after Patch) | `Notify(` or navigation      |
| 5. Return to list   | TaskForm | Frm_SaveBtn    | OnSelect               | `Navigate(Home`              |

[Map every step to exactly one screen, control (with prefix), and event — no step may be orphaned]

### Journey: [Journey Name] (P2)

[repeat for each core journey — minimum 3, maximum 5]

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

#### Contract (required for verification — even for modified screens)

- **Primary Content:** [after changes, what is the main data-displaying element — must be specific]
- **Primary Interaction:** [after changes, what is the main user action — must be specific]
- **Required Handlers:** [all handlers that must be non-empty after changes — include both existing and new]
- **Journey Steps:** [which user journey steps this screen implements after changes]
- **Outcome Handling:** [required feedback and state management after changes]
  - Validation: [if applicable]
  - Success feedback: [if applicable]
  - Failure feedback: [if applicable]
  - State refresh: [if applicable]
  - Empty state: [if applicable]

### [Screen Name] (New)
- **File:** [Name].pa.yaml
- **Purpose:** [description]
- **Layout:** [VerticalAutoLayout / ManualLayout, root container details]
- **Key Controls:** [list with purpose of each]
- **Data Binding:** [variable names, data source references, collection names]
- **Navigation:** [which screen(s) this navigates to, trigger conditions]
- **State:** [any local variables set in OnVisible]

#### Contract (required for verification)

- **Primary Content:** [the main data-displaying element — e.g., "Gallery showing tasks filtered by assignee" or "Form bound to selectedOrder"]
- **Primary Interaction:** [the main user action — e.g., "Submit button that calls Patch() to save record" or "Gallery item tap sets selectedTask and navigates to Detail"]
- **Required Handlers:** [list of OnSelect/OnChange/OnVisible formulas that must be non-empty and functional — e.g., "SubmitBtn.OnSelect must call Patch()", "Gallery1.OnSelect must set selectedItem"]
- **Journey Steps:** [which user journey steps this screen implements — e.g., "View all tasks", "Filter by status", "Navigate to detail"]
- **Outcome Handling:** [required feedback and state management]
  - Validation: [if applicable]
  - Success feedback: [if applicable]
  - Failure feedback: [if applicable]
  - State refresh: [if applicable]
  - Empty state: [if applicable]

## Core Functional Journeys

Define 3–5 end-to-end user journeys that the edit must preserve or enable. Each journey spans
one or more screens and represents a complete user goal.

**Priority:** Order journeys by importance — P1 journeys are critical paths that must work;
P2/P3 are secondary flows.

### Journey: [Journey Name] (P1)

- **Entry Point:** [screen and control where the journey starts]
- **Screens Involved:** [ordered list of screens]
- **Required Operations:** [data operations that must occur]
- **Expected Outcome:** [what success looks like]
- **Success Behavior:** [user feedback on success]
- **Failure Behavior:** [user feedback on failure]
- **Affected by this edit:** [Yes/No — if Yes, explain how]

#### Journey Step Mapping

| Step               | Screen   | Control   | Event Property          | Formula Must Include       |
| ------------------ | -------- | --------- | ----------------------- | -------------------------- |
| [Step description] | [Screen] | [Control] | [OnSelect/OnChange/etc] | [Required formula pattern] |

[Map every step to exactly one screen, control, and event — no step may be orphaned]

### Journey: [Journey Name] (P2)

[repeat for each core journey — minimum 3, maximum 5]

## TechnicalGuide Key Conventions
[Embed the most critical YAML syntax rules from TechnicalGuide.md that screen-editors must follow:
- Formula prefix (= required)
- Multi-line formula syntax (|- block scalar)
- String quoting rules
- Record literal syntax
- Enum escaping patterns
- Any patterns specific to controls used in this edit]
```

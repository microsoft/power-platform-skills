---
name: generate-canvas-app
version: 1.0.0
description: Generate a complete, visually distinctive Power Apps canvas app with YAML. USE WHEN the user wants to create, build, or generate a Canvas App or pa.yaml files.
author: Microsoft Corporation
user-invocable: true
---

# Generate a Canvas App

Create a complete Power Apps canvas app for the following requirements:

$ARGUMENTS

## CRITICAL: Review Guidance First

Before designing anything, you MUST read and internalize both reference documents:

- `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md` — Technical best practices, control selection, validation workflow, formulas, layout strategies
- `${CLAUDE_PLUGIN_ROOT}/references/DesignGuide.md` — Design principles, aesthetic guidelines, anti-patterns to avoid, visual composition

Read both files before planning any layout or choosing any control types.

## Generation Workflow

1. **Discover** — Call `list_controls`, `list_apis`, and `list_data_sources` to understand what is available before making any design decisions. Controls you don't know exist can't influence your design. After all three calls complete, share a brief discovery summary with the user:

   > **Discovery complete.** Found [N] controls, [N] connectors, [N] data sources.
   > Notable controls available for this app: [3-5 most relevant controls, e.g., ModernCard, Gallery, ModernTabList].
   > Data sources: [list names, or "none connected"].
   > Connectors: [list relevant ones, or "none connected"].

2. **Plan** — Using what you learned from discovery, think through the full app: how many screens it needs and what major phases of work are required. Call `TaskCreate` once per task to capture every screen and phase (e.g., "Design screen layout and aesthetic", "Implement Home screen", "Implement Detail screen", "Validate and fix compilation errors"). Do not begin implementation until all tasks are created.

   After creating all tasks, present the plan to the user:

   > **App Plan**
   >
   > **Screens ([N] total):**
   > | Screen | Purpose | Key Controls |
   > |--------|---------|--------------|
   > | [Name] | [one-line description] | [2-3 main control types] |
   >
   > **Data:** [how data will be loaded — data sources used, or "collections/mock data"]
   >
   > **Aesthetic direction:** [e.g., "Minimal & professional — muted palette, card-based layout, strong typographic hierarchy"]

   Then use `AskUserQuestion`:

   | Question | Options |
   |----------|---------|
   | Does this plan look good? | Approve and start building (Recommended), I'd like to make changes |

   - If approved: proceed to Design.
   - If changes requested: ask what they want changed, revise the plan, and re-present it.

3. **Design** — Choose an aesthetic direction and layout strategy. Identify the primary screens, visual hierarchy, and control types. Before writing any YAML, call `describe_control` for every control type in your design — including seemingly obvious ones like Button, Rectangle, and GroupContainer. Property names differ significantly between Classic and FluentV9 families. Never assume. Call `TaskUpdate` to mark the Design task complete when done.

   After finalizing the design, share the direction with the user:

   > **Design direction locked in.**
   > - **Aesthetic:** [e.g., Bold & editorial — high-contrast dark background, accent RGBA(255,90,60,1)]
   > - **Layout:** [e.g., VerticalAutoLayout containers, two-column split on Detail screen]
   > - **Typography:** [e.g., 28px bold headers, 14px body, strong size contrast]
   > - **Key controls:** [4-6 controls driving the design, e.g., ModernCard, Gallery, Badge, ModernTabList]
   > - **Screens to implement:** [list screen names in order]

4. **Implement** — Write the `.pa.yaml` files following conventions from `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md`. Include state initialization in `OnVisible`, event handlers with guard clauses, and Power Fx formulas with the `=` prefix. Write the simplest working version of a formula, then let `compile_canvas` catch errors. Don't deliberate on formulas you can validate in under 10 seconds. Reserve reasoning for errors the compiler can't catch (logic bugs, wrong data source fields). Before writing each screen's YAML, announce progress:

   > **Implementing [Screen Name] ([N] of [Total])...**

   Call `TaskUpdate` to mark each screen's task complete as each screen is finished.

5. **Validate** — Call `compile_canvas` after implementing each screen. Fix any errors before moving on — do not defer validation to the end. After each `compile_canvas` call, report the result:

   - On success: > **[Screen Name] compiled successfully.**
   - On failure: > **[Screen Name] has [N] error(s) — fixing before moving on.** [brief description of errors]

6. **Iterate** — Repeat validate → fix until all screens compile clean. Call `TaskUpdate` to mark the validation task complete when all screens pass.

7. **Complete** — When all screens pass validation, present a final summary:

   > **App generation complete.**
   >
   > | Screen | File | Status |
   > |--------|------|--------|
   > | [Screen Name] | [filename].pa.yaml | Compiled |
   >
   > **Aesthetic:** [one-line description] | **Screens:** [N] | **Data:** [source or collections]

---
name: edit-plan
description: "Use when the user wants to change one part of an existing mobile native-app-plan.md without immediately mutating app code: data model, native capabilities, connectors, screens/navigation, or design direction. Safe plan-only workflow; follow with /sync-from-plan or the relevant specialist skill."
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Task
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Edit Plan

Surgical updater for `native-app-plan.md`. It changes one plan surface, gates the diff with the user, and leaves app mutation to `/edit-app`, `/sync-from-plan`, or a specialist skill. This is the safe option when the user wants to rethink the plan without touching source files yet.

## When To Use

- Add or remove one entity/table in the plan.
- Add or remove a native capability.
- Add or remove a connector requirement.
- Reorder screens, change navigation, or revise one screen spec.
- Change design direction without rebuilding screens yet.

Use `/edit-app` when the user expects the app code to be updated end-to-end.

## Workflow

### Step 1 — Locate Plan And State

```bash
test -f native-app-plan.md && echo "OK: plan found" || echo "ERROR: no plan"
test -f .code-apps-native/state.json && cat .code-apps-native/state.json || true
```

If `native-app-plan.md` is missing, stop. This skill edits an existing plan only.

Read lifecycle state when present:

- `prototype` means follow-up data changes should regenerate mock services and then `/sync-from-plan`.
- `dataverse` means follow-up data changes should run `/add-dataverse`, `npm run generate-schemas`, then `/sync-from-plan`.

### Step 2 — Pick One Section

Ask:

```text
Which section do you want to edit?
(a) Data Model
(b) Native Capabilities
(c) Connectors
(d) Screens / Navigation
(e) Design
(f) Cancel
```

Then ask for the requested change in one sentence.

Enforce one major section per run. If the request spans multiple sections, ask which to do first.

### Step 3 — Produce Updated Section

For Data Model and Screens, prefer the existing planner agents:

| Section | Planner |
|---|---|
| Data Model | `mobile-app:data-model-architect` in edit mode |
| Screens / Navigation | `mobile-app:screen-planner` in edit mode |

Native Capabilities and Connectors can be edited inline using the existing plan plus `shared/references/connector-planning.md` and the template native allowlist.

Design edits should usually route to `/design-system --refresh <dimension>` when the user wants actual brand artifacts. For plan-only design edits, update the `## Design` / `## Design Direction` section and stop after the plan diff.

### Step 4 — Gate The Diff

Show a before/after summary or unified diff for the changed section only. Ask:

```text
Approve this plan edit?
(a) Approve and save
(b) Revise
(c) Cancel
```

On revise, loop once with feedback. On cancel, leave the plan untouched.

### Step 5 — Write Plan And Suggest Follow-Up

Replace only the approved section in `native-app-plan.md`. Preserve all other content verbatim.

Print the precise follow-up based on lifecycle mode:

| Section changed | Prototype follow-up | Dataverse follow-up |
|---|---|---|
| Data Model | Run `node skills/create-mobile-prototype/scripts/gen-mock-services.js <project>` then `/sync-from-plan` | `/add-dataverse --skip-planning`, `npm run generate-schemas`, then `/sync-from-plan` |
| Connectors | Regenerate connector throw-stubs, then `/sync-from-plan` | `/add-connector` / `/add-sharepoint`, `npm run generate-schemas`, then `/sync-from-plan` |
| Native Capabilities | `/add-native <capability>`, then `/sync-from-plan` | `/add-native <capability>`, then `/sync-from-plan` |
| Screens / Navigation | `/sync-from-plan` | `/sync-from-plan` |
| Design | `/design-system` or `/sync-from-plan` if screen JSX must change | `/design-system` or `/sync-from-plan` if screen JSX must change |

Final response must make clear: plan changed, app code not changed.
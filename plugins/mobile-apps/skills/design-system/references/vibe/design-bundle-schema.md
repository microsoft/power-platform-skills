# Legacy `## Design Direction` Compatibility

Read only when an existing project contains this block or a caller explicitly requests it. New ordinary design uses the plan's `## Design` plus compact `brand/design-system.md` and `brand/tokens.ts`; no duplicate bundle/sidecar is mandatory.

## Existing shape

Older plans may include:

```markdown
## Design Direction
**Picked:** <name or custom description>
**Reference apps:** <optional supplied references>
**Picked at:** <timestamp>

direction: <name or custom description>
surface: <treatment>
background: <treatment>
palette: <description>
typography: <description>
heading_font: <family>
body_font: <family>
density: <choice>
list_style: <choice>
motion: <choice>
tone: <choice>
```

Other existing keys (action shape/position, status treatment, etc.) remain useful when relevant. Keep keys consumed by existing code or instructions. A partial block is not a reason to discard explicit choices and apply industry defaults.

## Reconciliation

- Read it once with the assigned context. Treat fields as existing design decisions, not proof of runtime token/font availability.
- Explicit user corrections, per-screen task needs, native constraints, and accessibility outrank inherited style preferences.
- Carry applicable values into the current spec/config and update conflicting plan values in place. Do not append competing copies.
- Named direction values are not restricted to `inspection|saas|product|hybrid`; preserve custom descriptions.
- Reference brands, exhaustive keys, or a hybrid recipe are not required validation fields.
- If absent, infer from approved job/journeys and design context—not an industry default.

Changes after building flow through `/edit-app` and actual integration/source updates before implementation preview regeneration.

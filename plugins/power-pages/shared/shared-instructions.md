# Shared Instructions

**This file aggregates all cross-cutting instructions that apply to every skill in the Power Pages plugin.**

All skills reference this single file. When new shared instructions are added, update this file only - no changes needed to individual skills.

---

## Planning Policy

**📋 [planning-policy.md](./planning-policy.md)**

Before implementing major changes, Claude MUST enter plan mode first. This ensures user approval before significant work begins.

**Key Points:**
- Use `EnterPlanMode` tool before writing code for new features or multi-file changes
- Present plan for user approval
- Exit plan mode with `ExitPlanMode` when approved

---

## Memory Bank

**📋 [memory-bank.md](./memory-bank.md)**

The memory bank persists context across sessions. Every skill reads it at start and updates it after major steps.

**Key Points:**
- Check for `<PROJECT_ROOT>/memory-bank.md` before starting
- Skip completed steps, resume from where the user left off
- Update after each major step to save progress

---

## Cleanup

**📋 [cleanup-reference.md](./cleanup-reference.md)**

Remove temporary helper files after skill completion.

**Key Points:**
- Only clean up after confirming success
- Never remove `memory-bank.md`, `.powerpages-site/`, or source files

---

## Authoring Tool

**📋 [authoring-tool-reference.md](./authoring-tool-reference.md)**

Configure the authoring tool site setting for Power Pages sites.

**Key Points:**
- Required for `.powerpages-site/` folder structure to work
- Create the site setting file when setting up site settings

---

## Adding New Shared Instructions

When adding a new cross-cutting concern:

1. Create the new file in `shared/` (e.g., `new-policy.md`)
2. Add a section to THIS file referencing the new file
3. No changes needed to individual SKILL.md files

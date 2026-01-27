# Planning Policy

**Before implementing major changes, Claude MUST enter plan mode first.**

## When Planning is Required

- Adding new features or components
- Modifying existing workflows or logic
- Changes affecting multiple files
- Schema, API, or configuration changes
- Adding new pages, forms, or UI components
- Modifying Dataverse table structures
- Changes to authentication or authorization

## How to Plan

1. **Enter Plan Mode**: Use the `EnterPlanMode` tool before writing any code
2. **Explore**: Read relevant files and understand the current implementation
3. **Design**: Create a clear implementation approach
4. **Present**: Show the plan to the user for approval
5. **Wait**: Do not proceed until the user approves
6. **Exit**: Use `ExitPlanMode` when ready to implement

## When Planning is NOT Required

- Single-line fixes (typos, minor corrections)
- Documentation-only updates
- Memory bank updates
- Adding comments or improving readability
- Running diagnostic commands

## Planning Checklist

Before exiting plan mode, ensure your plan covers:

- [ ] What files will be created or modified
- [ ] What the changes will do
- [ ] Any dependencies or prerequisites
- [ ] Potential risks or rollback steps
- [ ] Testing approach

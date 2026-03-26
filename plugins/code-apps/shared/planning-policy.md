# Planning Policy

**Before implementing major changes, Claude MUST enter plan mode first.**

## When Planning is Required

- Adding new features or components
- Modifying existing workflows or logic
- Changes affecting multiple files
- Adding or modifying data sources / connectors
- Changes to app configuration or environment settings
- UI restructuring or new page/component creation

## How to Plan

1. **Enter Plan Mode**: Use the `EnterPlanMode` tool before writing any code
2. **Explore**: Read relevant files and understand the current implementation
3. **Design**: Create a clear implementation approach
4. **Present**: Show the plan to the user for approval
5. **Wait**: Do not proceed until the user approves
6. **Exit**: Use `ExitPlanMode` tool when ready to implement

## When Planning is NOT Required

- Single-line fixes (typos, minor corrections)
- Documentation-only updates
- Memory bank updates
- Adding comments or improving readability
- Running diagnostic commands
- Predefined connector skill workflows (`/add-teams`, `/add-excel`, `/add-sharepoint`, etc.) -- these follow fixed linear steps that don't require architectural decisions

## Planning Checklist

Before exiting plan mode, ensure your plan covers:

- [ ] What files will be created or modified
- [ ] What the changes will do
- [ ] Any dependencies or prerequisites
- [ ] Potential risks or rollback steps
- [ ] Testing approach

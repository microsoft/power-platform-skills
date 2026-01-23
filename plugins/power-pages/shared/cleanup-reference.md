# Cleanup Helper Files

After successfully completing a skill, remove any temporary helper scripts or files that were created in the project root during execution.

## What to Remove

Any temporary scripts or helper files created during the skill that are not part of the final site structure.

## What NOT to Remove

- `memory-bank.md` (needed for session continuity)
- `.powerpages-site/` folder and all its contents
- `src/` folder and source files
- Configuration files (`package.json`, `powerpages.config.json`, `tsconfig.json`, etc.)
- Any files that existed before running the skill

## When to Cleanup

Only clean up helper files after confirming the skill completed successfully and the setup is working correctly.

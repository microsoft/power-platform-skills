# Development Standards

Standards that apply to all Power Apps code app skills.

## Versioning

- Always display version at the top of the UI (e.g., `v1.0.0`)
- Increment the version on each deploy
- User can opt out of version display

## Theme

- Default to dark theme (`backgroundColor: '#1e1e1e'`, `color: '#fff'`)
- User can override theme preference

## Node.js

- **Node.js 22+ is required** -- `@microsoft/power-apps-cli code add-data-source` rejects Node 20 and earlier
- Check with `node --version` before starting
- If the user has multiple versions, suggest `nvm use 22`

## Build & Deploy

- **Always** run `npm run build` before `pac code push` -- never skip the build step
- Verify `dist/` folder contains `index.html` and `assets/` before deploying
- When adding multiple connectors: do **NOT** deploy after each one — run `npm run build` to verify, then deploy once after all connectors are added

## TypeScript

- The template uses strict mode -- unused imports cause build failures (TS6133)
- Remove any imports you don't use before building
- Don't edit generated files in `src/generated/`

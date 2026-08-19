# Template Contract

Stage 1 inspects the live workspace before relying on this contract. Later stages reuse the persisted compatibility snapshot and perform targeted delta verification as defined below.

## Runtime Shape

- Expo SDK 55, React Native 0.83, React 19, TypeScript strict mode.
- Expo Router owns file-based navigation under `app/`.
- `PowerAppsProvider` in `app/_layout.tsx` is the root runtime boundary. Preserve its `msalConfig`, `powerConfig`, `schemaMap`, supplied `tamaguiConfig`, and optional offline, theme, consent, telemetry, and host callback wiring; keep all routes beneath it.
- The current host owns Gesture Handler, `ThemeProvider`, `TamaguiProvider`, portal/toast, `QueryClientProvider`, auth, and Power Apps host context. Never duplicate these or create another query client. App Builder verifies the installed prop contract and adds only contexts the host does not own, such as safe-area, app repository composition, or an approved feature-specific provider.
- The starter `app/index.tsx` routes authenticated users to `/(app)/home` and unauthenticated users to `/login`. App Builder updates the authenticated destination to the approved default route inside its four-or-five-destination tab shell while preserving the unauthenticated login redirect until temporary mock-review auth is enabled.
- `app/login.tsx` signs in through `useAuth`; `app/oauth-callback.tsx` completes the host auth session; `app/(app)/_layout.tsx` protects signed-in routes. Business routes belong under `app/(app)/` unless the approved flow is intentionally public.
- App Builder may temporarily bypass only the two route guards for post-Stage-4 mock review, marking both changes `MOCK_PREVIEW_AUTH_BYPASS`. It may replace only template-empty auth IDs with non-secret all-zero UUID placeholders and must not remove the host provider or auth routes. Stages 5-7 preserve this recorded review mode while mock remains active. Dataverse Adapters restores the pre-preview auth state and both guards before switching the active data mode from mock to Dataverse.
- Tamagui 2 is configured in `tamagui.config.ts`; Material Community Icons are available.
- React Query, React Hook Form, Zod, Async Storage, and common Expo native modules are already dependencies.
- `app/(app)/home.tsx` is customer-owned starter content and may be replaced, but the root provider and authentication routes are infrastructure rather than starter UI.

The current template ships a broad Expo/Tamagui surface. Inspect live versions and verify required imports through existing usages, package type declarations, and type-check. Before App Builder has assembled all approved screens and workflows, do not run `npm run web`, `npm run dev`, `bundle:*`, `build:*`, or another command that builds or launches the complete app. Do not enumerate package exports with ad hoc runtime scripts or hard-coded matrices. Plan with `ux-quality.md` and prefer installed Router, image/media, camera/picker, location, file/output, secure storage/local authentication, device/network, gesture/animation, safe-area, form/query, icon, Tamagui composition, portal, and feedback capabilities over custom substitutes.

## Commands

Use scripts from the live `package.json`. The expected commands are:

```text
npm run dev
npm run web
npm run generate-schemas
npm run type-check
npm run bundle:web
```

`npm run dev` runs `predev`, which invokes the template's schema generator before Metro starts, but this workflow does not use it to launch a native app. A missing `power.config.json` may be an expected pre-initialization state, but do not invent a placeholder or claim the app launches. Use `npm run web` as the only complete-app runtime target at an eligible App Builder or later-stage gate. After any data-source change, run `npm run generate-schemas` explicitly and rely on the command result without inspecting or editing `src/generated/`.

`bundle:web` validates web JavaScript bundling. Never run `bundle:android`, `bundle:ios`, `build:android`, `build:ios`, native launch commands, simulators, or dev clients as part of this workflow. Power Apps Wrap deployment remains a separate explicit operation handled by its owning deployment workflow.

Stages 1-3 use semantic/static checks and `npm run type-check` only. App Builder runs type-check after each implementation wave and triggers the first complete-app web bundle, test, or web launch only after all approved screens, workflows, providers, theme, typography, and icons are assembled. Stages 5-8 may run relevant web-only complete-app commands against that accepted App Builder baseline after their own integration work.

## Ownership

Change freely:

- `app/`
- `src/`, except generated output
- app-owned assets and documentation

Treat carefully:

- `app.config.js`
- `babel.config.js`
- `metro.config.js`
- `tamagui.config.ts`
- `tsconfig.json`

Preserve all `CUSTOMIZATION` and `CUSTOMER APP SETTINGS` markers and edit only inside the matching marked section when a root-file change is necessary. Preserve these template-owned behaviors:

- `app.config.js`: Power Apps native host/offline plugins, Expo Router, Secure Store, dev-client conditional, auth broker URL schemes, package IDs, and icon/version environment overrides;
- `babel.config.js`: `react-native-reanimated/plugin` remains last;
- `metro.config.js`: `withPowerNativeMetroLogging`, `/__pawrap_verify`, `mjs` resolution, and single-copy resolver behavior remain intact;
- `tamagui.config.ts`: `defaultConfig`, native animations, exported config/type augmentation, and its customization markers remain intact;
- `tsconfig.json`: strict mode, bundler module resolution, template path mappings, and Expo type includes remain intact.

Never edit or remove `expo.extra.powerappsNative` in `app.json`. Do not conflate `auth.config.json` (`msal.clientId` and `msal.tenantId`) with Wrap build configuration in `wrap.config.json`.

Generated boundary:

- Never read, inspect, create, patch, or manually edit files under `src/generated/`.
- Only supported template and Power Apps generation commands may write under `src/generated/`; validate the command result rather than generated file contents.
- `power.config.json` is Power Apps tooling output consumed by the root provider. Validate it when present; do not hand-author connection metadata.
- `offline-profile.json` is optional tooling output. The root layout intentionally tolerates only its absence; malformed content or other load failures are blockers.

## Native Boundary

The wrapped native binary can use only native modules shipped by the template and supported by the host. Confirm a capability against the current `package.json`, existing Expo config plugins, and target-platform behavior; package name alone is not enough. No stage may install an Expo/React Native native module, config plugin, transitive native dependency, package that changes Pods/Gradle/native projects, or package requiring a rebuilt binary. Workspace-local pure JavaScript libraries may be installed in any stage after verifying Expo/React/React Native/web/bundler compatibility and confirming their complete dependency path is JavaScript-only. If classification is uncertain, do not install the package.

The offline plugin is already registered but self-deactivates without a valid `offline-profile.json`. Creating and assigning a Dataverse mobile offline profile belongs to the dedicated offline skills, not the native-capabilities stage.

## Compatibility Snapshot

Stage 1 Plan records these facts in `.stages/mobile-app-state.md` and its handoff:

- installed Expo, React Native, React, Tamagui, Power Apps host, and offline package versions;
- available package scripts and installed native modules;
- current route/auth/provider structure, supported root host inputs, and provider exports relevant to planned capabilities;
- presence and status of `power.config.json` and `offline-profile.json`;
- customization markers in any root file the stage may touch;
- existing app code and components that must be extended rather than replaced.

Later stages carry this snapshot forward. Inspect only files changed by the previous stage that intersect the active stage, plus direct dependencies and ownership surfaces named by the active skill. Refresh affected facts when a stage changes dependencies, root configuration, provider/auth wiring, generated configuration, or auth-shell routes. Perform the full inspection again only when the snapshot is absent or stale, targeted verification detects external drift, or a required invariant fails.

If a required provider, auth route, host plugin, Metro behavior, Babel ordering, or upgrade marker is missing, classify the workspace as incompatible or blocked rather than silently rebuilding template infrastructure.

## Stage 1 Initial Inspection

Read these anchors first:

1. `package.json`
2. `CUSTOMIZATION.md`
3. `app/_layout.tsx`
4. `app/index.tsx`
5. `app/(app)/_layout.tsx`
6. `app/(app)/home.tsx`
7. `tamagui.config.ts`
8. `app.config.js`
9. `app.json`, `babel.config.js`, `metro.config.js`, and `tsconfig.json`
10. `auth.config.json`, `power.config.json`, `offline-profile.json`, `wrap.config.json`, and `.stages/mobile-app-state.md` when present
11. current `assets/` inventory; exclude `src/generated/` from inspection

Do not broadly map the repository before forming a local implementation hypothesis.
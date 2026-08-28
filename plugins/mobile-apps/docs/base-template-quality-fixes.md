# Mobile Base Template Quality Contracts

The Mobile Apps plug-in ships a deterministic Expo template contract so a new
application reaches planning and screen generation from a clean, production
ready baseline. These rules apply to the bundled template and to
`/create-mobile-app`.

## Visual and Runtime Baseline

- The Tamagui configuration always exposes semantic surfaces, media,
  accents, text hierarchy, status foreground/background pairs, and a
  `fonts.mono` role in both light and dark themes.
- Shared components use literal-safe semantic tokens, minimum touch targets,
  accessible roles and labels, selected-state semantics, and readable
  on-accent foregrounds.
- The starter home, login, and OAuth callback routes use semantic tokens,
  Ionicons, and route-owned safe-area edges.
- The root layout owns `SafeAreaProvider`, host light/dark theme selection,
  the project Tamagui config, generated schema wiring, and the optional
  offline profile. It does not wrap the router slot in `SafeAreaView`; each
  rendered route owns its visible edges to prevent double insets.
- OAuth callback replacement is guarded so React development effects cannot
  trigger duplicate navigation.

## Deterministic Template Preparation

`scripts/prepare-mobile-template.js` is the sole Step 5 mutation path. It:

1. Updates the display name and slug.
2. Removes only an empty placeholder `power.config.json`.
3. Removes recognized legacy example hooks and the obsolete app-owned query
   client.
4. Creates shared source directories and copies approved helpers only when a
   destination is missing.
5. Merges the six shared-code aliases and their subpath mappings, makes every
   path target explicitly relative, and removes deprecated `baseUrl`.
6. Structurally adds missing root provider, theme, Tamagui, and safe-area
   wiring without replacing custom navigation or unrelated providers.
7. Verifies postconditions and fails for unsupported layouts or dangling
   legacy imports.

The script is idempotent. Existing helper bytes, provider props, custom
nesting, `offlineProfile`, and generation-boundary `@ts-ignore` comments are
preserved. Failed preparation rolls back every touched file, including deleted
placeholder or legacy files.

## Generated-File Ownership

Template preparation never creates, resets, or deletes `src/generated/`.
Models, services, connector schemas, and barrels are owned exclusively by
Power Apps data-source and schema-generation commands. This keeps generated
artifacts compatible with protected-path validation and prevents hand-written
stubs from masking incomplete initialization.

## Environment and Approval Safety

Environment resolution supports `--no-cache`. Discovery before the rough-plan
approval may read an existing cache but cannot create
`.resolved-environment.json` or rewrite `auth.config.json`. Persistence begins
only after the user proceeds.

The app instance identity is also minted only after `proceed`, so `edit` and
`abort` leave the fresh template unchanged. If a populated
`power.config.json` already targets the approved environment, initialization
is skipped only when its app display name also matches. Initialization reads
the prepared name from `app.config.js` and passes it to the CLI as one process
argument, so punctuation such as apostrophes cannot break shell parsing.

HTTP failures report the status and a redacted response shape, such as an
empty object or structured error keys. Tokens, query credentials, JWTs, and
raw response bodies are not printed.

## Dataverse, Sample Data, and Offline Order

Dataverse mutation produces `.datamodel-manifest.json` before sample-data or
offline-profile work begins. Connector-only behavior is determined by the
approved planning mode, never inferred from a missing manifest. The manifest
includes app-used reuse-as-is tables as well as new or extended tables, so a
reuse-only Dataverse application still has a complete sample/offline input.

Sample-data generation uses fixed HTTPS CDN catalog entries for explicit
URL/Text media columns and rotates images across visible records. Dataverse
File/Image columns continue to use their native upload path rather than
storing CDN URLs. Every bundled catalog entry carries an explicit content
review note, and entries without that note are skipped rather than assumed
brand-neutral.

For Dataverse-backed applications, offline setup runs after data model
materialization and sample-data seeding. A missing, malformed, or empty
manifest blocks offline setup instead of silently classifying the app as
connector-only.

## Agent and Validation Portability

Leaf mobile agents do not declare the obsolete `sonnet` model alias. The host
selects a supported model unless the caller provides an explicit override.

`validate-mobile-files.js --all-source` validates all TypeScript source under
an application's complete `app/` tree and non-generated `src/` tree, plus root
TypeScript configuration files. Only CLI-owned `src/generated/` is excluded;
a route folder named `app/generated/` remains in scope. Mobile CI covers:

- deterministic preparation and rerun idempotency;
- root-layout import-only, wrapper-only, already-correct, and custom-nesting
  states;
- semantic token and font completeness;
- shared component accessibility and contrast contracts;
- pristine route safe-area and icon rules;
- generated-directory ownership;
- environment no-cache behavior and redacted HTTP diagnostics;
- portable agent frontmatter;
- full template dependency installation, TypeScript compilation, and
  all-source mobile validation.

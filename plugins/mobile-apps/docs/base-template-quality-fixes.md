# Mobile Base Template Quality Contracts

The Mobile Apps plug-in ships a deterministic Expo template contract so a new
application reaches planning and screen generation from a clean,
production-ready baseline. These rules apply to the bundled template and to
`/create-mobile-app`.

## Visual and Runtime Baseline

- The native-host Tamagui factory always exposes semantic surfaces, media,
  accents, text hierarchy, status foreground/background pairs, and a
  `fonts.mono` role in both light and dark themes.
- Shared components use literal-safe semantic tokens, minimum touch targets,
  accessible roles and labels, selected-state semantics, and readable
  on-accent foregrounds.
- The starter home, login, and OAuth callback routes use semantic tokens,
  Ionicons, and route-owned safe-area edges.
- The root layout owns `SafeAreaProvider`, host light/dark theme selection, the
  project Tamagui config, generated schema wiring, and the optional offline
  profile. It does not wrap the router slot in `SafeAreaView`; each rendered
  route owns its visible edges to prevent double insets.
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
5. Verifies that `tsconfig.json` inherits package shims and shared-code aliases
   from `@microsoft/power-apps-native-host/config/tsconfig`.
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

## Lifecycle and Approval Safety

The app instance identity is minted only after `proceed`, so `edit` and `abort`
leave the fresh template unchanged. If a populated `power.config.json` already
targets the approved environment, initialization is verified and skipped
rather than invoking the CLI over an existing config.

Step 3 writes `native-app-plan.md` before Step 5. The preparation gate therefore
allows that approved plan while still rejecting created-app markers:
`memory-bank.md`, `.datamodel-manifest.json`, and generated service files.

## Validation Portability

`validate-mobile-files.js --all-source` validates all TypeScript source under
an application's complete `app/` tree and non-generated `src/` tree, plus root
TypeScript configuration files. Only CLI-owned `src/generated/` is excluded; a
route folder named `app/generated/` remains in scope. Mobile CI covers:

- deterministic preparation and rerun idempotency;
- root-layout import-only, wrapper-only, already-correct, and custom-nesting
  states;
- semantic token and font completeness;
- shared component accessibility and contrast contracts;
- pristine route safe-area and icon rules;
- generated-directory ownership;
- full template dependency installation, TypeScript compilation, and
  all-source mobile validation.

## Phone App Reliability

The phone workflow separates app source checks from Player publication and native
rendering. The following fixes address distinct failure classes; one passing
check is not evidence for the others.

| Symptom | Cause / owner | Resolution and verification |
|---|---|---|
| Sample photo URLs compile but fail to display on a device | Remote-only delivery relied on third-party CDN access at runtime | `materialize-prototype-images.js` bundles approved canonical JPEG/PNG/WebP bytes before screen building. Integrity checks and generated static image bindings preserve existing records. Covered by `prototype-images.test.js`. |
| Photo credits dominate repeated rows and hide decision facts | Generated full attribution was always expanded | `PrototypeImage` supports `creditDisplay="compact"` with creator/license visible and full attribution, change statement and links available through a disclosure. A bounded `aspectRatio` keeps media geometry stable. Loading, failure and link-error callbacks are tested. |
| A valid `bookings/index` tab is rejected, or an invalid `bookings` registration passes | Validation assumed the first URL segment was the navigator child | The navigation validator now derives child names from source files and actual layout boundaries. Both layoutless index routes and nested stacks are tested, including phantom and duplicate-route rejection. |
| A phone workflow references a missing fixture-validation command | Guidance referenced a different creation pipeline | Canonical phone fixtures are normalized with `compile-phone-app-plan.js`; image materialization and generation use the current branch's existing contracts. |
| Type checks run in the plugin or another app directory | Reused terminal or delegated command lost the selected working directory | Shared guidance requires explicit absolute working-directory handoff and matching validator roots. Unknown or truncated output is not a passing gate. |
| A copied npm compiler shim cannot resolve its sibling files | Template/dependency packaging, not a TypeScript diagnostic | The Player demo packager now creates link-free Node launchers targeting the actual copied package entrypoint, preserving CommonJS/ESM behavior, arguments and exit status. A versioned cache prevents reuse of older broken copies. Keep dependency versions intact and use the selected app's compiler with an explicit `--project`. |
| An agent is advertised under a bare name but a qualified dispatch fails | Host-specific naming | Use the exact advertised alias for the selected plugin; if unavailable, follow the same bounded contract in foreground without repeated probes or weaker checks. |
| Phone guidance pushes the screen-builder entry over its context limit | Profile-specific instructions loaded for every screen | The phone contract is a conditionally loaded leaf reference; the entry remains within its existing 180-line gate without weakening ownership or quality checks. |
| A maker reports that an approval was never visible | A pending card can sit below long chat history; receipt evidence does not establish a personal click | Player now keeps a review shortcut above scrolling chat. It scrolls to the current signed card without approving anything or changing modes. Skills still cannot infer auto-approval or a personal click from a receipt alone. |
| Player rejects both root and route-group layouts as one route | Player-owned trusted route normalization | The Player checker now excludes layouts from leaf-route ambiguity checks while checking their default exports and rejecting real duplicate routes. Required layouts and app routes stay intact. |
| Phone activity stays generic while the desktop is working | Existing workflow checkpoints were not forwarded to the phone | The verified VS Code wrapper now mirrors recognized `started` checkpoints as static, deduplicated milestones. No extra agent progress commands, invented percentages or readiness claims are required. |
| Preview failure hides the cause or promises a preview that does not exist | Candidate-check error reporting | Player and the runner receive the sanitized check failure. Generated source remains available for recovery; this is not a published preview or a successful job. |
| VS Code workers report no file or terminal tools | Legacy tool identifiers do not establish VS Code tool availability | The attended bridge supplies workspace-scoped adapters for the same pinned agents using native tool sets, outside application source. Read-only architects receive no editing tools and nested delegation stays disabled. |
| Editing/Teach wiring forces a structural rewrite after the UI is finished | Authoring context, readiness and target requirements arrived too late | The phone screen-shell phase prepares the existing runtime and planned registry without readiness claims. Its returned API/source contract and the bounded phone reference guide real readiness, dirty state, target mounts and child scrolling during normal implementation. |
| A long booking action repeatedly fails a name-based submit check | The static check cannot recognize arbitrary aliases | The phone contract supplies a synchronous ref lock with visible `isPending` state and direct disabled binding. A regression exercises repeated taps and long action bodies; diagnostics describe the supported pattern without weakening the gate. |
| Preview dependency copying reports `ENOBUFS` instead of the filesystem failure | A small synchronous subprocess output buffer hid copy diagnostics | The bridge drains copy stderr asynchronously with bounded retained diagnostics, reports underlying storage/access errors, checks disk headroom and warms dependency images before accepting requests. |
| A generated local app cannot be opened after its first preview fails | Source readiness and successful publication are different outcomes | Player now offers a maker-authorized saved-preview recovery with a fresh operation and source-bound review, retaining the failed job and generated source. No AI rebuild or remote-data operation runs, and publication/native checks remain required. |

### Image delivery checks

Read [sample image guidance](../shared/references/prototype-images.md) for the
approval boundary, limits and full provenance contract. The materializer's
`--check` mode verifies cached files without network access; `generate-prototype.js
--check` also checks generated image bindings. Candidate checks validate bundled
media when the materialization manifest exists.

The download path rejects private DNS, unsafe redirects, credential-bearing URLs,
incorrect response types, excessive bytes/dimensions, source changes and cancelled
jobs. It preserves the canonical fixture authority and existing local data.
Header and checksum validation are not a full image decode or a license audit;
inspect the selected subject and actual native rendering before reporting them
as verified. Bundled images still travel through Metro during development.

### Two core workflows

1. Basic app creation delivers the approved small journey with persistent local
   records, bundled sample photos, usable navigation and checked generated code.
   It does not require Dataverse provisioning to render the first app.
2. Connecting that app to Dataverse requires the separate discovery/schema
   approvals, official generated services and verified connected startup. Keep
   the existing screens, native authentication configuration and local evidence;
   do not silently import sample records or replay an uncertain remote write.

Verification on 2026-09-17 covered installed-template compilation, local
persistence, image delivery, connected startup and the offline cross-repository
skills/Player broker chain. Those core regressions passed. The final full script
run reported 656 passed, zero failed and 51 skipped, including the additional
guard-pattern regression. The design entry stays
within its original 10,000-byte budget through a compact phone-profile reference.
The phone wrapper reads shared instructions before its first section checkpoint;
the profile links intake before planning, preserving declared workflow order.
Skipped checks include shared-component tests needing dependencies installed in
the bundled template and the explicitly configured live Dataverse CLI test.

Player checks also covered dependency packaging, authenticated milestones,
decision placement and readiness errors. The generated app passed the corrected
TypeScript/route gate, and the updated Android Player was rebuilt and installed
without clearing app data. A separately rendered app is not evidence of bridge
publication.

Final local publication acceptance requires a fresh Player operation using the
updated plugin source. Native sign-in and live Dataverse read/write remain
unverified and require a separately selected, authorized environment.

### Completion boundaries

Keep the distinction between a compiled app, a submitted candidate, a published
preview, native rendering and Apply. A terminal Player job needs the supported
new-operation/recovery path. Do not revive it by modifying receipts or publisher
stamps, start a replacement server as an undisclosed fallback, or edit a pinned
plugin image to make its checks pass. Source fixes take effect in a newly selected
plugin build; existing frozen copies and their decisions remain unchanged.

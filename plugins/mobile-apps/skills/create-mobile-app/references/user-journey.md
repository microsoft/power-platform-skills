# User Journey And Stage Outputs

The user enters through `/create-mobile-app`. Dependency installation starts in the background while Stages 1-2 proceed without dependency commands. Stage 3 runs the baseline type-check before editing. Each stage runs all required internal waves and the orchestrator automatically advances after successful validation. The user is interrupted only for required missing information, material unresolved choices, or safety-sensitive mutations.

## Stage 1: Requirements And Implementation Plan

**User input:** provides only business facts the request and workspace do not already establish. Screen graph and capability review remain available but do not block progression.

**Built:** no business feature code. Creates `.stages/mobile-app-plan.md` with the approved brief, Mermaid navigation graph, screen inventory, requirement traceability, technical architecture, domain/repository contracts, capability matrix, Tamagui strategy, integration boundaries, mock scenarios, CLI generation manifest, and delivery waves. Creates `.stages/mobile-app-state.md`.

**Agent tests:** template compatibility, graph completeness, stable requirement/scenario/Screen IDs, typed route parameters, requirement-to-screen traceability, screen-to-repository coverage, form-operation/input-purpose alignment, deterministic mock-state coverage, repeated-task density, locale/content-format and authentication accessibility intent, media-rights constraints, capability availability, connector boundaries, and unchanged app baseline.

**Optional review target:** requirements, screen graph, architecture, data contracts, visual direction, integration plan, and unchanged home-screen baseline.

**Passes forward:** approved requirements and plan, stable screen IDs/routes, acceptance scenarios, repository contracts, mock scenarios, framework decisions, Tamagui strategy, native/connection matrices, Dataverse contract, CLI generation manifest, environment intent, baseline validation, and compatibility snapshot.

## Stage 2: Screen Design

**Optional review target:** the interactive prototype's screens, states, responsive layouts, navigation, media, motion, feedback, and accessibility.

**Built:** no production feature code. Expands `.stages/mobile-app-plan.md` with authoritative build-ready responsive screen contracts and creates the lightweight interactive `.stages/02-screen-design.html` checkpoint for representative compact mobile screens and materially distinct states.

**Agent tests:** screen-to-requirement traceability, exact color/typography token completeness, scan-efficient density, named width/height responsive boundaries, component-map completeness, screen-shell/inset ownership, form/action/input-purpose bindings, state-to-acceptance/mock/HTML traceability, localization, authentication accessibility, licensed/attributed media and alternatives, WCAG 2.2 AA readiness, compact-width HTML interactions and rendering, responsive specification completeness, plus the unchanged app baseline when dependencies are available.

**Optional validation target:** layout task fit, actions, validation, edge states, navigation, and responsive behavior.

**Passes forward:** authoritative dense responsive layouts, stable typed routes, exact visual/typography tokens, named width/height boundaries, component map with props/events/slots/variants, screen-shell/inset matrix, form/action/input-purpose bindings, state/scenario/HTML traceability, localization and authentication contracts, licensed media/assets and alternatives, light/dark/increased-contrast behavior, motion/reduced-motion, WCAG 2.2 AA readiness, acceptance scenarios, and `.stages/02-screen-design.html` as rendered visual evidence. Component Library and App Builder implement from the Markdown contracts and use HTML only for representative visual comparison.

## Stage 3: Component Library

**Optional review target:** reusable React Native components and their visual, interaction, responsive, and accessibility variants.

**Built:** typed, business-agnostic React Native and Tamagui components required by the approved screen designs. No complete feature screens or data workflows are implemented.

**Agent tests:** component contracts and variants, long content, compact and large layout behavior, keyboard behavior, safe areas, accessibility semantics, touch targets, import boundaries, and type-check. No complete-app build or launch runs in this stage.

**Optional validation target:** interactive variants, reusability, visual coherence, and layout coverage.

**Passes forward:** component inventory, typed props/events/variants, theme/token usage, responsive and accessibility contracts, overlay/provider requirements, gallery target, validation, and explicitly deferred screen-specific UI.

## Stage 4: End-To-End App Builder

**Required user trial:** after the complete app passes its web gate, App Builder enables temporary mock-review auth, opens directly to home, provides the web URL and one concrete workflow, and waits before Stage 5.

**Built:** domain models, repository interfaces, deterministic fixtures, mock adapters, one composition root, navigation, and all approved feature screens built on the existing template and reusable component library in waves of at most three related screens.

**Agent tests:** type-check after each wave; then, only after every approved screen and workflow is assembled, the first complete-app web bundle/test and a required `npm run web` render. The agent never launches iOS/Android simulators, dev clients, or native apps. The final gate inspects every route in the web renderer at an iPhone-like compact viewport with simulated system insets, representative increased text, and a wide/tablet viewport. It covers installed `PowerAppsProvider` inputs, host-owned provider preservation, app-owned contexts, typed navigation/deep links, long/empty content, lists, filters/search, forms, media failures, destructive actions, loading/error/mutation feedback, app theme, typography/font readiness and scaling, Material Community Icon usage, motion, keyboard/safe areas, accessibility, and visual reconciliation with Screen Design. An unavailable web render means `blocked`, not complete with an exception or native fallback.

**Optional validation target:** acceptance scenarios, allowed/denied outcomes, record-status differences, empty/error paths, recoverable failures, and form validation.

**Passes forward:** accepted rich mock baseline, stable domain/repository contracts, route inventory, per-screen visual reconciliation and safe-area ownership map, rendered viewport evidence, verified host inputs/provider ownership and app-owned contexts, app theme and typography roles, icon-family evidence, framework capability usage, acceptance evidence, temporary auth-bypass files/pre-preview state, and immutable UX behavior later integrations must preserve.

## Stage 5: Native Capabilities

**Optional device validation:** grant/deny permissions and exercise planned camera, scanner, location, file, sharing, secure-storage, or other supported device workflows.

**Built:** typed native wrappers and approved screen integration, one capability group per wave, with deterministic web fallback and explicit simulated state.

**Agent tests:** package/plugin/host availability, compile/type-check, permission/cancel/restricted/unavailable/error/success states, file/media cleanup, external-app return, platform fallback, and relevant bundle. Real-device results are recorded only when run.

**Optional validation target:** native actions on the target device and denial/cancellation behavior.

**Passes forward:** wrapper APIs, permission/result/fallback contracts, normalized domain values, resource/privacy lifecycle, tested platform level, simulated paths, and device limitations.

## Stage 6: Non-Dataverse Connections

**Required input:** confirms environment/account/connection ownership and explicitly approves the connector mutation summary when tooling cannot establish those values.

**Built:** Power Platform data sources/generated services plus connector adapters behind existing domain interfaces; mock adapters remain selectable.

**Agent tests:** schema generation, type-check, relevant bundle/test, auth/throttling/unavailable/retry behavior, and unaffected mock workflows.

**Optional validation target:** one safe connector-backed action or read plus mock fallback.

**Passes forward:** environment and connection/reference IDs, generated service inventory, connector adapter contracts, tested actions/fields, and unresolved DLP/auth limitations.

## Stage 7: Dataverse Schema

**Required confirmation:** explicitly approves the exact schema mutation summary before tenant mutation.

**Built:** reused/extended/created tables, choices, columns, relationships, and generated Dataverse services, one dependency tier per wave. Screens remain on mock repositories.

**Agent tests:** live schema discovery, idempotency records, schema generation, type-check, and complete mock regression.

**Optional validation target:** created schema in the target environment and a core mock workflow regression check.

**Passes forward:** environment/solution/publisher, logical and entity-set names, metadata IDs, generated services/models, choice/lookup mappings, completed tiers, and partial-resource recovery data.

## Stage 8: Dataverse Adapters And Parity

**Optional review target:** Dataverse mode using the same acceptance scenarios as mock mode.

**Built:** Dataverse repository adapters, generated-to-domain mappers, error translation, restored login/protected-route behavior and pre-preview auth configuration, and one centralized mock/Dataverse composition switch.

**Agent tests:** restored auth loading/login/protected routing, query filters/order/paging, choices/lookups/nullability, create/update payloads, files/images, permission/errors, type-check, relevant bundle/test, and mock-versus-Dataverse parity.

**Optional validation target:** designated Dataverse test records, visible outcomes, and mock-mode fallback.

**Passes forward:** final data-mode configuration, parity evidence, tested records/scenarios, known differences, and deployment readiness. Deployment remains a separate confirmed action.

## Review Rule

Every stage publishes a review target and task, but review is non-blocking and the orchestrator advances automatically. The user may provide feedback at any time; the orchestrator returns to the owning stage and reconciles downstream artifacts. It never asks the user to continue merely because a wave, checkpoint, or stage completed.
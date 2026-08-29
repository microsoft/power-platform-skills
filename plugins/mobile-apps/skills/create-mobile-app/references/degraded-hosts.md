# Foreground Return Mode

Load this file only when the mode cache selects `foreground-return` or the first
real return-only custom-agent dispatch fails because the host cannot route a
custom agent. This is a host execution mode, not a reduced-quality fallback.

The canonical work-order, response, interaction, validation, materialization,
retry, and instrumentation contracts remain
[`return-only-agents.md`](return-only-agents.md).

## Mode Selection

Use exactly two cached modes:

- `parallel-return`: custom-agent dispatch works. Dispatch independent children
  concurrently when supported, or use effective concurrency 1 when only
  sequential custom-agent dispatch is exposed.
- `foreground-return`: custom-agent dispatch itself is unavailable. The
  foreground processes the same role work orders sequentially.

Bind the cache to host ID, runtime/session ID, and plugin version. Invalidate it
when any binding changes or after 30 minutes. Do not infer host mode from an
application-level `blocked`, `needs_context`, `needs_clarification`, malformed
transport, or validator result.

Do not spawn a no-op preflight. Do not repeatedly attempt unavailable custom
dispatch. The first real sealed work order is the capability check on a cache
miss.

## One Work-Order Path

For every role, the foreground builds the same complete sealed work order used
by `parallel-return`:

- same role and semantic instructions;
- same complete inline context;
- same artifact IDs and allowlisted absolute target paths;
- same input fingerprint;
- same response-envelope schema;
- same role validators and materializer;
- same retry and repair limits;
- same pipeline and approval state.

The foreground reasons within that role, emits exactly one response JSON object
to the normal response-capture path, and passes it through
`scripts/agent-return-envelope.js`. It does not directly write the proposed
artifacts and does not load a second inline planning or implementation
specification.

## Planning

Process the existing planning roles in their normal semantic order:

1. `native-app-planner` once on the healthy path;
2. `data-model-architect` after Product Scope is available;
3. foreground Gate 1 and Gate 2 interaction;
4. `screen-planner` graph work order;
5. `screen-planner` specs work order;
6. deterministic foreground plan composition and approval receipt.

The foreground still gathers Dataverse snapshots, performs bounded exact-name
expansion, validates returned contracts, asks users, records approvals, and
persists artifacts. It never replaces missing Product Experience, Product
Scope, data relationships, screen hierarchy, focal points, signature
interactions, media prominence, states, or `forbiddenDefaults` with generic
defaults.

Gated mode retains Gates 1–4. Consolidated mode retains its single review of the
same four sections. Normal foreground conversation is the supported question
and approval path when structured interaction tools are unavailable.

Before yielding for an answer, write `waiting_for_user` interaction state. On
the next user message, attach the answer and resume the same phase and revision;
do not restart planning from the original prompt.

## Screen Building

Compile the same one-screen work orders and process them sequentially in
deterministic wave/target order. Each foreground-produced response still
contains exactly one complete TSX artifact. Pass it through the common parser,
staged screen validator, and atomic materializer.

Sequential mode does not reduce screen count, context, semantic judgment, UX
quality, validation, or repair behavior. Preserve:

- compiled build-pack and per-screen-spec authority;
- typed skeleton and exact generated-service signatures;
- Product Experience, route, native, state, and accessibility context;
- first-viewport hierarchy and primary action;
- trust, media, signature interaction, and forbidden defaults;
- per-wave TypeScript gates;
- route, accessibility, safe-area, clipping, stylistic, and final gates;
- targeted repair of only affected screen work orders.

Successful siblings remain unchanged when another screen needs repair. A
substantive screen block follows the existing foreground stop policy; it does
not change host mode.

## Hard Boundaries

- Children never require filesystem, shell, task, Plan Mode, or structured
  question tools.
- Missing child tools never become product `blocked`.
- Foreground-owned Dataverse, connector, package, generated-service, native,
  validation, and persistence operations retain their existing sequential or
  phase-gated behavior.
- Dataverse and connector mutation are never parallelized.
- Converted child tool-call count is always zero.
- `foreground-return` is not permission to skip or weaken any user gate or
  quality validator.
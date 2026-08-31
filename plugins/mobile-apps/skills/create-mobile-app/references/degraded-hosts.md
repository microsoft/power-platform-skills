# Screen-Builder Channel Recovery

Foreground planning is the normal path on every host. Missing child-agent,
question, plan-mode, filesystem, or shell tools never select an alternate
planning workflow. The foreground owns planning, questions, approvals, shared
files, mutations, validation, and checkpoints.

Load this file only while implementing screens at Step 11.

## Channel selection

Every screen uses the same sealed semantic work order and input fingerprint.
Choose a channel per screen:

1. Use `direct-write` when the host routes the child with Read, Write, and Edit.
2. Use `return-only` when child file tools are unavailable or direct-write
   dispatch fails because of host tool mapping.
3. After a second channel failure for that screen, implement only that screen in
   the foreground from the same work order.

Do not cache one screen's channel failure as a run-wide or host-wide builder
failure. Valid sibling results remain usable.

## Direct-write recovery

Before the wave, capture the changed-file baseline. The child may edit exactly
its pre-created target screen. After the wave, compare the changed set against
the assigned targets.

- Accept an assigned target change only after the screen validators pass.
- Restore an out-of-scope child edit from the pre-wave backup without touching
  valid sibling targets.
- Never permit child edits to layouts, navigation configuration, tokens,
  design-system files, shared components, generated services/models, package or
  configuration files, or another screen.
- A malformed status retries that screen once with exact diagnostics.

## Return-only recovery

The foreground passes one compact inline work order with the assigned build-pack
entry, route/params, typed skeleton, relevant generated signatures, permitted
tokens/signature interfaces, states, test IDs, and accessibility requirements.

The child makes no tool calls and returns one TSX body using the run-scoped
delimiter from the work order. It must not serialize a whole plan or multiple
files. The foreground verifies the delimiter, fingerprint, target, status, and
content before writing the assigned target atomically.

## Bounded statuses

- `DONE`: validate the assigned file and continue.
- `DONE_WITH_CONCERNS`: validate, preserve the file, and aggregate concerns at
  the wave boundary.
- `NEEDS_CONTEXT`: foreground supplies only the named missing fact and retries
  that screen once.
- `BLOCKED`: retry only when exact corrective context exists; otherwise build
  that screen in foreground.
- Malformed output: retry the same work order once, then use foreground for that
  screen.

No child may ask the user, enter/exit plan mode, spawn another agent, install a
package, mutate a connector or Dataverse, start Metro, or change product scope.

## Genuine host limitations

When a host cannot render structured questions or plan mode, use normal
foreground conversation for the same question/approval and persist the pending
interaction before yielding. When browser opening is unavailable, print the
absolute preview path. These are presentation limitations, not degraded product
behavior.
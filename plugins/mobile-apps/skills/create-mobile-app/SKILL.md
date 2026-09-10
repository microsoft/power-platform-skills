---
name: create-mobile-app
description: Use when the user wants to start a new Power Apps mobile app (Expo / React Native / TypeScript, targeting iOS and Android) from scratch.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode
model: opus
---

# Create Power Apps Code App (Native)

Read [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md) first.
This foreground skill owns user questions, approvals, phase transitions, and mutation dispatch.
Agents propose bounded sections or build assigned screens; they never approve their own work.

## Load only the active phase

Read **one phase reference when entering that phase**, not every reference at startup.
Load a linked topic/helper only when its condition applies. On resume, read the memory bank,
the relevant approved plan sections and receipt, then the first incomplete phase.
Do not preload the agent files for phases that have not started.

| Order | Phase / existing steps | Read when active | Exit condition |
|---|---|---|---|
| 1 | Intake (0–2d) | [phase-01-intake.md](references/phase-01-intake.md) | Fresh installed template or confirmed resume; brief + explicit proceed at plan preview |
| 2 | Planning (3) | [phase-02-planning.md](references/phase-02-planning.md) | Experience/information needs precede data; full coverage audit and foreground approvals; valid schema/receipt if required |
| 3 | Scaffold (4–6.7) | [phase-03-scaffold.md](references/phase-03-scaffold.md) | Approved environment, deterministic preparation, init, clean scaffold TypeScript, memory bank |
| 4 | Design (6.75) | [phase-04-design.md](references/phase-04-design.md) | Brand/default design and its preview handoff complete, or explicit `--no-design` |
| 5 | Authentication (7) | [phase-05-auth.md](references/phase-05-auth.md) | Correct environment tenant, client ID wired or explicit auth deferral |
| 6 | Data (8–8.5, then 6.85) | [phase-06-data.md](references/phase-06-data.md) | Verified receipt + fresh reconciliation, sequential data mutation, clean generated-services gate, sample/offline decisions |
| 7 | Integrations (9–10) | [phase-07-integrations.md](references/phase-07-integrations.md) | Native wrappers, approved JS dependencies, host brand wiring, sequential connector generation |
| 8 | Screen shell (10b–10.8) | [phase-08-screens.md](references/phase-08-screens.md) | Route layouts + service snapshot + typed skeletons pass navigation/skeleton gate |
| 9 | Implementation (11–11.4) | [phase-09-build.md](references/phase-09-build.md) | Every screen wave clean, routes checked, minimum product UX review and changed-file validation complete |
| 10 | Launch (12–13) | [phase-10-run.md](references/phase-10-run.md) | Final TypeScript clean, persistent Metro terminal verified, summary + optional debug |

Follow **phase order 1 → 10**. Filenames use zero-padded `phase-01` through `phase-10`
so they sort in execution order; do not sort by the older decimal step numbers.
At phase entry show `Phase N/10 — <name>`; after its exit condition passes, state the
next phase. Record approved skips as skipped and follow the same sequence.
Previous/Next links are navigation aids, not instructions to preload adjacent phases.

Step numbers remain stable for checkpoints and edit-app reuse. **Step 6.85 executes after
Step 8**, not before: offline setup requires the actual Dataverse manifest. A missing
pre-mutation manifest is not evidence that an approved Dataverse app is connector-only.

## Always-on boundaries

- **Fresh-template mode:** the user supplies an installed
  `microsoft/power-platform-skills/plugins/mobile-apps/template#main` folder with `node_modules/expo`.
  Never clone, degit, auto-download, or copy the bundled template into their folder.
  Reject already-created apps unless Step 0 confirms a memory-bank resume; use `/edit-app` for iteration.
- **Plan preview before writes:** until explicit `proceed` at Step 2c, keep brief, environment
  resolution and preferences in memory. No placeholder plan, cache file, planning agent, install or init.
  Discovery shortcuts (`--no-discovery`, richness scoring) do not waive this gate.
- **Foreground approval ownership:** use the host's actually exposed question interface.
  `AskUserQuestion`, `EnterPlanMode`, and `ExitPlanMode` are host-specific names, not guaranteed tools.
  Use plan-mode tools only when exposed; entering/exiting plan mode is not itself a recorded approval.
  Never invent tool calls, treat silence/cancel as approval, or substitute a plain-text question when
  host policy requires a structured question. If approval cannot be captured, STOP with the pending question.
- **No test dispatches:** no no-op `Task` probes or run-wide degraded mode.
  Dispatch real bounded work using the available agent interface and `mobile-app:<agent-name>`.
  If that interface is absent or an actual dispatch reports unavailable/unknown agent, read that
  leaf agent's contract and execute the same bounded work in foreground. This changes execution
  location, never approvals, outputs, evidence or quality gates. Other failures follow the status switch.
- **Mutation ownership:** Step 3 writes planning artifacts only (`native-app-plan.md`,
  `_dm_section.md`, `_screens_section.md`, `.tmp/*`). No app source, package/config, or memory-bank writes.
  Queue concerns until Step 6.7. `prepare-mobile-template.js` alone owns template preparation;
  Power Apps generators alone own `src/generated/`; data-source writes are sequential.
  Foreground owns shared code/layouts; each builder owns only its assigned screen.
- **Dataverse fail-closed:** required plans need verified snapshot evidence and normalized schema
  contract. Only foreground user acceptance creates/advances `.tmp/mobile-plan-status.json`.
  The operation-manifest builder verifies it; it never grants approval or restamps receipts.
  Revisions invalidate affected and dependent approvals; reapprove before mutation.
- **Experience before schema:** shape the job and its information/interaction needs before
  proposing tables or locking routes. All approved screen facts/actions need supported sources
  and outcomes; field overlap is not completeness. Audit detailed specs in the explicit plan,
  including staged edit plans, never graph-only scratch or only related-field annotations.
- **No fake completion:** unsupported native/data capabilities are blockers, not mocks or TODOs.
  Use actual counts, completed milestones and measured elapsed times, not minimum spending targets,
  noun-count screen estimates, invented percentages or promised wall-clock readiness.
- **Safety:** connector-first runtime data; native packages limited to the live template allowlist;
  no secrets or out-of-project writes; explicit confirmation for destructive operations, global
  installs, native builds and deployment. This workflow ends at Metro, never deploys automatically.

## TypeScript Gate Policy — no quality compromise

Run `npx tsc --noEmit` at these boundaries, not after every microscopic edit:

1. **Scaffold gate:** Step 6.6 after preparation, init and dependency verification.
2. **Dataverse/generated-services gate:** after Step 8 schema/service generation.
3. **Navigation/skeleton gate:** after Step 10b/10.8, before builders.
4. **Screen-wave gate:** after each Step 11 wave, before the next wave.
5. **Final gate:** after all code/quality repairs and schema refresh, before Step 12.

Capture full failure output once, group by root cause, batch repairs, then rerun the same gate.
Respect bounded retries and user stop policy; STOP if still failing. Never launch data work from
a broken scaffold, builders from broken dependencies/skeletons, or Metro from a failed final gate.
Changed-file validation and route checks remain required even when TypeScript passes.

## Step 3.0 — Sub-agent return-status switch (canonical)

Use this handler for every proposal, revision and builder return (also reused by `/edit-app`).
Parse the **literal first line**, with no `Status:` prefix, backticks or preamble:

| First line | Foreground action |
|---|---|
| `DONE` | Verify required output artifacts before continuing; this is not user approval |
| `DONE_WITH_CONCERNS: <list>` | Require a non-empty list; surface before advancing and record in memory bank (queue before Step 6.7) |
| `NEEDS_CONTEXT: <missing>` | Supply the missing facts or ask through the foreground question interface; at most 2 clarified retries |
| `BLOCKED: <reason>` | STOP, surface and record the block; never downgrade or silently retry |
| Anything else | `BLOCKED: malformed agent return` |

The planning phase handles the bounded exact-name metadata/proposed-name expansions.
An unavailable dispatch is not a child `BLOCKED` result; only the former permits same-contract
foreground execution. Never bypass a legitimate block by switching execution mode.

## Checkpoints and recovery

Emit telemetry only at the static markers in the **active phase**, following the shared core.
Record successful steps immediately once the memory bank exists. Never mark a phase complete on
partial artifacts. Resume at the first incomplete step after confirming project/environment and
approval integrity; retain pending publication checkpoints until publish succeeds.

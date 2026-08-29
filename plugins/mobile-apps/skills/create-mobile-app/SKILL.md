---
name: create-mobile-app
description: Use when the user wants to start a new Power Apps mobile app (Expo / React Native / TypeScript, targeting iOS and Android) from scratch.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode
model: opus
---

**Shared core: [shared-instructions-core.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions-core.md)** — read first. Load a topic file from the compatibility index only when the active phase requires it.

# Create Power Apps Code App (Native)

Top-level orchestrator for a quality-gated Power Apps native code app. It owns
the user-visible flow, delegates planning to qualified `mobile-app:*` agents,
and routes mutations to dedicated `/add-*` skills.

## Non-negotiable invariants

- Work only in a fresh, installed `expo-app-standalone` template unless a
  valid `memory-bank.md` resume is explicitly approved.
- Step 2c remains the last zero-side-effect exit. Do not write app identity,
  planning artifacts, or project files before `proceed`.
- Use the selected Power Platform environment consistently. Resolve it without
  persistence before approval and persist only after the user proceeds.
- Gates never become optional. TypeScript, route, contract, changed-file, and
  stylistic validators remain required even when execution is faster.
- Dataverse and connector mutations remain sequential because they share
  generated state. Independent native files and screen files may be written in
  parallel.
- Product Experience, Product Scope, Workflow Journey, the approved Dataverse
  contract, and the compiled screen build pack are execution authorities.
  Markdown is the human-readable plan, not a substitute for missing sidecars.
- Converted planning/build agents declare `tools: []`, receive complete sealed
  work orders inline, and return the schema-backed JSON envelope from
  `references/return-only-agents.md`. The foreground owns all side effects,
  questions, approvals, validation, persistence, timing, and resume state.
- Generated files remain owned by the Power Apps CLI/schema generators. Never
  hand-write or reset generated artifacts to make a gate pass.

## TypeScript gate policy

TypeScript is a phase gate, not a per-edit reflex. Every project uses
incremental compiler state from `template/tsconfig.json` at
`.tmp/tsc.tsbuildinfo`; strictness is unchanged.

Required gates:

1. Scaffold: after template preparation, initialization, and dependency checks.
2. Dataverse/services: after data sources and schema generation.
3. Navigation/skeleton: before screen builders launch.
4. Screen wave: after each wave and before the next.
5. Final: before Metro starts.

On failure, capture the full output once, group by root cause, repair in a
batch, and rerun the same gate. Never advance from a broken gate or hide an
approved capability behind mocks/TODOs.

## Progressive workflow

Read only the file for the active phase. When resuming, verify the persisted
pipeline state and artifact revisions before skipping any phase.

| Phase | Steps | Read at phase entry |
|---|---|---|
| Setup and requirements | 0–2d | [`references/phase-0-setup.md`](${CLAUDE_SKILL_DIR}/references/phase-0-setup.md) |
| Planning and Gates 1–2 | 3–3.9 | [`references/phase-3-planning.md`](${CLAUDE_SKILL_DIR}/references/phase-3-planning.md) |
| Scaffold, design, Gates 3–4 | 4–6.75 | [`references/phase-4-scaffold.md`](${CLAUDE_SKILL_DIR}/references/phase-4-scaffold.md) |
| Auth, data, offline, native, connectors | 7–10 | [`references/phase-7-data.md`](${CLAUDE_SKILL_DIR}/references/phase-7-data.md) |
| Navigation, services, shared code, skeletons | 10b–10.8 | [`references/phase-10-navigation.md`](${CLAUDE_SKILL_DIR}/references/phase-10-navigation.md) |
| Screen waves, validation, Metro, summary | 11–13 | [`references/phase-11-screens.md`](${CLAUDE_SKILL_DIR}/references/phase-11-screens.md) |
| Custom-agent dispatch unavailable | on demand | [`references/degraded-hosts.md`](${CLAUDE_SKILL_DIR}/references/degraded-hosts.md) |

## Runtime flags and compatibility

- `--consolidated-review` opts into one review of the same four plan sections
  and interactive preview. If the user objects, reopen only the affected
  section's owning gate and refresh its approval receipt.
- `--gated` explicitly preserves the four sequential approval prompts and is
  the compatibility default until the consolidated path passes the documented
  A/B protocol.
- `--full-discovery`, `--no-discovery`, and `--no-design` retain their existing
  meanings.
- `--refresh` invalidates the planning inventory cache before snapshot work.
- `--builder-concurrency <1-10>` overrides the default screen-builder wave cap.
  `MOBILE_APP_BUILDER_CONCURRENCY` is the non-interactive equivalent.
- `--dataverse-cache-ttl-minutes <positive-number>` overrides the default
  30-minute planning inventory TTL.

## Phase handoff contract

At each phase boundary:

1. Run the phase's required validators.
2. Update `.tmp/pipeline-state.json` with the completed step and current
   artifact revisions using `scripts/mobile-pipeline-state.js`.
3. Append user-visible concerns/blocks to `memory-bank.md`.
4. Read the next phase file only after the current phase is complete.

Never infer completion from source files alone. A resumable phase requires a
valid pipeline-state record whose stored revisions still match the current
artifacts.

## Reference

- [Mobile Apps agent protocol](${CLAUDE_SKILL_DIR}/../../AGENTS.md)
- [Return-only agent orchestration](${CLAUDE_SKILL_DIR}/references/return-only-agents.md)
- [Shared instruction index](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions-core.md)
- [Product experience compiler](${CLAUDE_SKILL_DIR}/../../shared/references/product-experience-compiler.md)
- [A/B quality protocol](${CLAUDE_SKILL_DIR}/../../docs/optimization-quality-protocol.md)

# Return-Only Agent Hardening Handoff

## Scope

- Branch: `optimigates-return-only-agent-hardening`
- Baseline: `da6fbe0d120ac5f29cc13892ccec408a14f7c659`
- Runtime used for repository tests: Node.js `22.23.2`
- Copilot CLI used for host verification: `1.0.82-0`
- Source under test: this branch's `plugins/mobile-apps` files
- Initial host verification used isolated copies of the branch definitions.
  Subsequent local dogfood synchronized the managed plugin copies; those local
  installation settings are not part of the repository commits.

The core change moves execution ownership. Subsequent dogfood hardening repairs
template compatibility and resolves native-capability, connector ownership, and
persistence inputs before Data Model architecture. Product Experience, Product
Scope, Workflow Journey, Dataverse, screen build-pack, approval, navigation,
offline, and native UX artifact shapes retain their existing responsibilities.

## Implementation Commits

1. `eaaddee1` - Register mobile agent roots
2. `e3aac4ca` - Add return-only agent runtime
3. `b2898c46` - Make native planning return-only
4. `bbe5e17a` - Convert planning specialists to return-only
5. `1a54fad5` - Make screen builds return-only
6. `80599f33` - Move offline planning to return-only execution
7. `b382ef6d` - Unify foreground return-only orchestration
8. `3a54ba15` - Document return-only agent verification
9. `9e2e0c40` - Harden mobile create integration
10. `931a4f24` - Resolve architecture inputs before data modeling
11. `e87afa84` - Tighten mobile screen scope heuristics
12. `46852b54` - Limit initial experience preview to three screens

## Execution Contract

All converted production agents explicitly declare `tools: []`:

- `native-app-planner`
- `data-model-architect`
- `screen-planner`
- `screen-builder`
- `offline-profile-architect`

Children receive complete sealed work orders, perform semantic reasoning, and
return exactly one JSON envelope. They do not read, write, execute commands,
ask users, approve sections, mutate environments, or dispatch other agents.

The foreground owns fingerprinting, dispatch, questions, approvals, waiting and
resume state, strict parsing, allowlisting, staged validation, transactional
materialization, rollback, timing, pipeline state, and every external mutation.
Both `parallel-return` and `foreground-return` use the same work orders,
envelopes, validators, retry ledger, and deterministic materialization path.
Native capabilities, connector/system-of-record ownership, and the persistence
boundary are resolved before Data Model dispatch and passed to the architect as
binding inline inputs. This adds no prompt or approval, and final plan heading
order remains unchanged.

Screen scope now uses soft composition bands rather than treating 16-20 routes
as the expected multi-role outcome: focused `3-6`, standard `5-9`, complex
`7-12`, and multi-role `8-14`. Routes above the target or repeated within one
job/composition family require structured hard-boundary reasons and an explicit
composition note. States never justify routes by themselves. The validator
preserves justified native, commit, resumability, role/security, incompatible
composition, and density/usability boundaries, so route reduction cannot force
an overloaded screen merely to hit a count.

Gate 3 now renders exactly three representative primary-journey screens when
available: entry, midpoint/core workflow, and outcome/detail. One- and
two-screen apps render every available screen. `_plan_preview.html` remains the
single create-flow HTML approval artifact; the workflow does not offer a second
post-build preview or run Playwright, route crawling, or React Native Web.

## Host Verification

Production definitions copied from this branch were invoked from an isolated
host fixture. This verifies the exact branch source without changing the
installed marketplace copy. The dual-root manifest registration is preserved
separately by repository contracts and the previously verified discovery test.

### Production Planner

| Host | Result | Invocations | Child tool calls | Measured time |
| --- | --- | ---: | ---: | ---: |
| Copilot CLI | `ready`; strict validation passed | 1 | 0 | 67,995 ms API time |
| VS Code | `ready`; strict envelope passed | 1 | 0 | 94,745 ms wall time |

### Three-Prompt Planner Matrix

| Scenario | CLI | VS Code | CLI API time | VS Code wall time |
| --- | --- | --- | ---: | ---: |
| Gym Equipment Check | `ready` | `ready` | 37,230 ms | 126,138 ms |
| In-flight passenger shop | `ready` | `ready` | 46,974 ms | 105,397 ms |
| Company inventory/IT assets | `ready` | `ready` | 38,111 ms | 102,370 ms |

Every run used one planner invocation, returned the supplied fingerprint and
artifact identity, made zero child tool calls, and produced no file changes.
Across hosts, all six plans preserved the required heading order and both
composition placeholders. They matched on product, users, iOS/Android targets,
primary workflows, entities and fields, native capabilities, connector and
persistence boundaries, and `pending-consolidated-review` approval state.
Connector-only plans consistently described SharePoint or the supplied
connector as the persistence owner, explicitly budgeted Dataverse tables at
zero, and omitted unsupported positive claims about offline operation.

### Converted Child Roles

| Role and path | Copilot CLI | CLI API time | VS Code | VS Code wall time |
| --- | --- | ---: | --- | ---: |
| Data model | `ready` | 15,591 ms | `ready` | 18,245 ms |
| Screen planner | targeted `## Screens` repair reached `ready` | 58,628 + 53,117 ms | bounded context redispatch reached `ready` | 6,381 + 82,832 ms |
| Screen builder | schema-compliant `needs_context`, then `ready` | 5,525 + 54,470 ms | `ready` | 141,444 ms |
| Offline architect | `ready_with_concerns` | 16,756 ms | `ready_with_concerns` | 56,864 ms |

All final role responses passed the common parser and role-specific staged
validators. The first CLI builder probe returned a partial artifact with
`needs_context`; the parser rejected it, the production prompt was tightened to
forbid artifacts for every non-ready status, and the repeated response class
contained zero artifacts. After exact imports, service signatures, field
mappings, route contracts, and connectivity facts were supplied, only that
builder work order was redispatched and it reached `ready`. The CLI screen
planner omitted the required `## Screens` heading; its targeted validator repair
added that heading without regenerating sibling planning artifacts. Static tests
now enforce both rules. The first VS Code screen-planner work order omitted the
exact Workflow Journey JSON schema, semantic requirements, and zero-revision
placeholders. The child returned `needs_context` with no artifacts; the
foreground added only those facts and redispatched the same work-order ID, which
then returned `ready`.

The two offline runs were intentionally accepted as `ready_with_concerns`, not
silently treated as unconditional approval. Both reported that the fixture did
not supply an app name. CLI also reported that byte-level cache size could not
be estimated; VS Code reported that parent-route evidence was insufficient to
choose Related scope over the existing ownership fallback. The foreground must
surface and persist these concerns. `ready_with_concerns` may materialize after
deterministic validation, but the user must explicitly accept the documented
assumption or reject and revise the owning section before mutation. Redispatch is
needed only when that revision supplies changed context or a validator requires
repair. The offline fixture therefore verifies safe concern propagation, not
cross-host identity of an underspecified semantic choice.

CLI values are Copilot's reported model API durations. VS Code values are
foreground dispatch-to-completion wall durations from transcript timestamps.
They are measured independently and should not be compared as equivalent clocks.

## Materialization and Approval Results

- Parallel and sequential response arrival orders materialize identical bytes.
- Duplicate targets, mismatched fingerprints, unapproved paths, symlink targets,
  unknown fields, wrapped JSON, truncated JSON, and partial non-ready responses
  are rejected before final writes.
- Staged validation failure leaves final targets untouched.
- A simulated rename failure restores every preexisting target in the complete
  materialization set before the error returns.
- Targeted repair preserves successful sibling bytes, hashes, and approval state.
- Retry limits are tracked per stable work-order ID, so separate screens have
  independent budgets.
- Missing child tools are rejected as a product-level `blocked` reason.
- Executable runtime tests store `waiting_for_user`, attach the answer, and
  resume the same phase and revision; they also reject approval as a reason to
  redispatch the planner.
- Orchestration contract tests retain `askUser`/`approveSection`, structured and
  normal-chat routing, and both gated and consolidated approval instructions.
- Pending, stale, rejected, missing, or malformed final approval prevents every
  mutation.
- Dataverse and connector mutations remain foreground-owned and sequential.

Approval transitions remain the Phase 4 contract: a yielded question enters
`waiting_for_user`; an answer produces `ready_to_resume` for the same phase and
revision. Approval records the current hashes and permits progress. Rejection
reopens only the owning section, regenerates and validates its dependents, and
requires that section to be presented again. There is no direct
rejected-to-approved shortcut. Stale hashes and missing or malformed receipts
stop before mutation and require a current approval.

### Claim-to-Test Traceability

| Claim | Executable coverage |
| --- | --- |
| Malformed, wrapped, truncated, versioned, unknown-field, wrong-role, wrong-fingerprint, and missing-content rejection | [`agent-return-envelope.test.js`](../scripts/tests/agent-return-envelope.test.js): `rejects malformed, wrapped, truncated, and unknown-version responses` and `rejects wrong roles, fingerprints, missing content, and unknown fields` |
| Target allowlisting, project-root containment, symlink rejection, and concurrent duplicate rejection | [`agent-return-envelope.test.js`](../scripts/tests/agent-return-envelope.test.js): `rejects unapproved and outside-project target paths`, `rejects an existing symbolic-link target`, and `rejects duplicate target paths across concurrent responses` |
| Complete-set and staged validation before writes, deterministic order, rollback, and sibling preservation | [`agent-return-envelope.test.js`](../scripts/tests/agent-return-envelope.test.js): `validates the complete response set before writing any final file`, `staged validation failure leaves existing final content untouched`, `materializes validated artifacts atomically in deterministic target order`, `rename failure rolls back every target in the materialization set`, and targeted-repair/sibling tests |
| Non-ready responses do not materialize partial content | [`agent-return-envelope.test.js`](../scripts/tests/agent-return-envelope.test.js): `foreground CLI validates non-ready status without materializing`; [`return-only-agent-contracts.test.js`](../scripts/tests/return-only-agent-contracts.test.js) enforces empty artifacts for `needs_context` and `blocked` |
| Host-mode caching, same-phase interaction resume, one healthy planner dispatch, bounded per-work-order repair | [`agent-return-runtime.test.js`](../scripts/tests/agent-return-runtime.test.js): execution-mode, interaction-resume, duplicate-planner, and retry-ledger tests |
| Explicit `tools: []`, no child side effects or nested dispatch, strict status behavior | [`return-only-agent-contracts.test.js`](../scripts/tests/return-only-agent-contracts.test.js) |
| Same foreground workflow, complete builder-wave validation, approval ownership, and mutation ordering | [`return-only-orchestration-contracts.test.js`](../scripts/tests/return-only-orchestration-contracts.test.js) |
| Execution mode and zero-tool-call instrumentation | [`planning-timings.test.js`](../scripts/tests/planning-timings.test.js) |

## Repository Validation

Final command:

```bash
POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1 \
  node --test scripts/tests/*.test.js
```

Latest integrated result: 440 tests passed, 0 failed, 0 skipped in 7,170.433 ms.

Real-plan regression checks also passed: the earlier 16-screen ICRC Field
Receiving scope is rejected until its excess routes carry exceptional and
screen-level separation evidence, while the focused two-screen checklist scope
remains valid with non-blocking under-band/cross-reference warnings.

Additional checks passed:

- `node --check` for every new or modified production JavaScript entry point;
- VS Code diagnostics for `plugins/mobile-apps` (no errors);
- `git diff --check`;
- legacy tool-surface and child-owned milestone scan;
- independent final review against the implementation brief (no findings).

## Exact Files Changed

```text
plugins/mobile-apps/.claude-plugin/plugin.json
plugins/mobile-apps/.plugin/plugin.json
plugins/mobile-apps/AGENTS.md
plugins/mobile-apps/agents/data-model-architect.md
plugins/mobile-apps/agents/native-app-planner.md
plugins/mobile-apps/agents/offline-profile-architect.md
plugins/mobile-apps/agents/screen-builder.md
plugins/mobile-apps/agents/screen-planner.md
plugins/mobile-apps/com.github.copilot/agents/.gitkeep
plugins/mobile-apps/docs/return-only-agent-hardening-handoff.md
plugins/mobile-apps/scripts/agent-return-envelope.js
plugins/mobile-apps/scripts/agent-return-runtime.js
plugins/mobile-apps/scripts/bind-return-only-contracts.js
plugins/mobile-apps/scripts/compose-return-only-plan.js
plugins/mobile-apps/scripts/lib/agent-return-envelope.js
plugins/mobile-apps/scripts/lib/agent-return-runtime.js
plugins/mobile-apps/scripts/lib/product-experience-contracts.js
plugins/mobile-apps/scripts/lib/product-scope-rules.js
plugins/mobile-apps/scripts/planning-timings.js
plugins/mobile-apps/scripts/prepare-mobile-template.js
plugins/mobile-apps/scripts/render-product-experience-preview.js
plugins/mobile-apps/scripts/schema-product-scope-contract.json
plugins/mobile-apps/scripts/tests/agent-return-envelope.test.js
plugins/mobile-apps/scripts/tests/agent-return-runtime.test.js
plugins/mobile-apps/scripts/tests/bind-return-only-contracts.test.js
plugins/mobile-apps/scripts/tests/compose-return-only-plan.test.js
plugins/mobile-apps/scripts/tests/dataverse-operation-manifest.test.js
plugins/mobile-apps/scripts/tests/dataverse-planning-snapshot.test.js
plugins/mobile-apps/scripts/tests/fixtures/agents/planner-smoke-test.md
plugins/mobile-apps/scripts/tests/helpers/product-experience-fixtures.js
plugins/mobile-apps/scripts/tests/planning-timings.test.js
plugins/mobile-apps/scripts/tests/prepare-mobile-template.test.js
plugins/mobile-apps/scripts/tests/product-experience-agent-contracts.test.js
plugins/mobile-apps/scripts/tests/product-experience-preview.test.js
plugins/mobile-apps/scripts/tests/product-scope-contract.test.js
plugins/mobile-apps/scripts/tests/return-only-agent-contracts.test.js
plugins/mobile-apps/scripts/tests/return-only-orchestration-contracts.test.js
plugins/mobile-apps/shared/references/product-experience-compiler.md
plugins/mobile-apps/skills/create-mobile-app/SKILL.md
plugins/mobile-apps/skills/create-mobile-app/references/degraded-hosts.md
plugins/mobile-apps/skills/create-mobile-app/references/phase-0-setup.md
plugins/mobile-apps/skills/create-mobile-app/references/phase-10-navigation.md
plugins/mobile-apps/skills/create-mobile-app/references/phase-11-screens.md
plugins/mobile-apps/skills/create-mobile-app/references/phase-3-planning.md
plugins/mobile-apps/skills/create-mobile-app/references/phase-4-scaffold.md
plugins/mobile-apps/skills/create-mobile-app/references/phase-7-data.md
plugins/mobile-apps/skills/create-mobile-app/references/return-only-agents.md
plugins/mobile-apps/skills/design-system/SKILL.md
plugins/mobile-apps/skills/setup-offline-profile/SKILL.md
```

## Remaining Concerns

No known correctness defect remains in the implemented scope. The repository
and source-level host acceptance work is complete; packaged-release sign-off is
still pending a complete installed plug-in run and a human-driven approval
conversation in each host. Host verification intentionally used isolated copies
of the exact branch definitions. The automated suite executes waiting/resume and
mutation guards, while the cross-host runs did not pause for real human approval.
Measured host timings are evidence, not a new duration commitment.

Packaged-release sign-off has these explicit exit criteria:

1. Install a package built from the final branch head in clean Copilot CLI and
  VS Code hosts without copying agent definitions into a workspace.
2. Confirm packaged dual-root discovery, then run the production planner and all
  four specialist roles with zero child tool calls and strict validation.
3. Exercise gated and consolidated approval flows, including normal-chat
  waiting/resume, across the two hosts.
4. Confirm a current approved receipt permits the planned mutation boundary and
  pending, rejected, stale, missing, and malformed states prevent mutation.
5. Rerun the packaged smoke checks and full mobile-app test suite, then retain
  the host logs and approval receipts as release evidence.
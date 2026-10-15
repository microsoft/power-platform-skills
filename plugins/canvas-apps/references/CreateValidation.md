# CREATE Validation

Validate current staged artifacts and actual YAML, not legacy planner headings. This file owns CREATE validation gates; `${PLUGIN_ROOT}/references/CreateConformance.md` owns the inspection, diagnostic tiers, targeted repairs, same-turn progress policy and evidence. EDIT keeps its existing workflow.

## Compile and Repair

Apply conformance's **Compile and repair** and **Same-turn progress policy** during initialization and every screen wave. These procedures also govern resumed work and unavoidable stops. The separate experience/feasibility retry and approval rules remain in `${PLUGIN_ROOT}/references/CreateWorkflow.md`.

## Experience Conformance

After each wave, independently apply conformance to the current files before accepting them. Once all required screens exist, establish a clean candidate with `compile_canvas` and repeat cross-screen conformance. Match current revisions/approval and trace every R/A ID through the implemented experience.

Use the core and applicable CREATE topic modules as the canonical routine checks. Load a bounded legacy specialist body only when conformance's routing table applies. Record decisive evidence and unresolved issues in bindings, not repeated plans or a second QA checklist.

## Final Gate

Before the finalization barrier, verify the coauthoring round trip:

1. Create a fresh empty verification directory outside the app working directory with `Bash`; keep it YAML-only.
2. Call `sync_canvas` into that directory. Inspect its `App.pa.yaml` and every screen listed in current `create-bindings.md`. Require every expected screen and its meaningful visible leaf controls; roots and layout-only containers do not count.
3. If files or controls are absent/stale compared with the authored copy, remove the verification directory, compile again, and retry once in a new empty verification directory. If still stale, stop with `Status: Coauthoring Sync Blocked`; do not claim completion.
4. Remove the verification directory before the final gate. Never synchronize over or copy the snapshot onto the working directory.

This proves returned server state, not rendered behavior. Record the exact immutable `${PLUGIN_ROOT}`, skill version and plugin source revision (or `unavailable`) with decisive evidence in bindings. Never use the app workspace revision as plugin provenance. CREATE has no legacy acceptance artifact or legacy acceptance-validator prerequisite.

Complete all repairs, artifact updates and manual inspection first. No worker may remain running or queued. Every required R/A ID needs code-backed evidence, every planned screen meaningful visible content, and every navigation destination an existing screen. Resolve all diagnostics and blocking issues; build status must match current files and approval must match current experience revisions.

Call `compile_canvas` after the last YAML mutation and all other work, even if an earlier compile was clean. It must be the **final tool call** before the success summary. If it fails, return to conformance's same-turn repair procedure, not a completion claim. If any later tool activity is needed, finish it, wait for all workers, and repeat this gate.

After success, concisely summarize delivered screens/interactions and meaningful compromises. Preserve conformance's runtime-static distinction; do not claim interactions, rendering, durability or app-quality improvement you did not observe.

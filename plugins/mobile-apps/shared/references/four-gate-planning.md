# Four-Gate Planning and Visibility Contract

This is the authoritative user-interaction contract for `/create-mobile-app`.
Planning decisions may be revised inside a gate, but a standard run has exactly
four approval interactions.

## Gate 1 — Requirements and operating mode

Present one grouped view containing:

- confirmed requirements brief;
- target users and platforms;
- environment;
- native capability and connector implications;
- rough table/screen/time estimates.

For a thin prompt, the context-aware feature picker is the Gate 1 interaction;
do not ask a second confirmation. For a rich prompt, show the extracted brief
inside Gate 1. Options are `Approve requirements`, `Edit`, and `Abort`.

## Internal architecture work — no prompt

Before Gate 2:

1. discover Dataverse in the foreground;
2. write a normalized read-only metadata snapshot;
3. infer the data model, native capabilities, connectors, and preliminary
   screen field-read contract;
4. classify every cross-entity field using the resolution ladder in
   `data-performance.md`;
5. produce complete architecture and screen-plan sections;
6. render `mobile-app-plan.html`.

Do not approve an incomplete data model and reopen it after screen planning.

## Gate 2 — Complete architecture

One approval covers:

- reuse/extend/create decisions, credible alternatives, trade-offs,
  assumptions/scope boundaries, and ER diagram;
- relationships, keys, and dependency tiers;
- formatted lookup, bounded chained-fetch, and external-projection-required
  decisions;
- validation of any maker-created computed dependency before reuse;
- native capabilities and connectors;
- risks, deferred requirements, and readiness blockers.

Rejecting Gate 2 regenerates only the affected architecture sections and any
dependent screen field bindings. It does not create a separate projection
addendum prompt.

The Plan HTML ER review editor may be used before approval to add, remove, or
revise draft entities, fields, and relationships. Browser edits never mutate
`native-app-plan.md` or Dataverse. The user must copy or download
`mobile-er-revision.json` and submit it through Gate 2 `Revise`; regenerate the
data model, rationale, cross-entity audit, and dependent screen bindings from
that payload before presenting Gate 2 again.

## Gate 3 — Experience

One approval covers:

- screen graph and navigation;
- per-screen specifications;
- design direction and visual preview;
- loading, empty, and error states;
- accessibility and role-specific actions.

The planner may internally build the graph before detailed specs to avoid
wasted work, but graph and specs are presented together as one user approval.

## Gate 4 — Final implementation confirmation

Immediately before mutation, present:

- included and deferred scope;
- selected environment and solution;
- expected duration;
- sample-data plan;
- deployment/authentication requirements;
- readiness blockers.

Approval starts implementation. No downstream skill may re-ask a decision
already approved in the plan.

Offline profile setup is intentionally outside these four planning approvals.
For Dataverse-backed apps, `/create-mobile-app` asks separately after the data
layer exists whether to invoke `/setup-offline-profile`. The offline skill owns
its own scope review and approval because live table metadata is authoritative.

## Agent capability preflight

The foreground orchestrator owns environment and filesystem discovery. Before
dispatching an agent:

1. verify the agent type is registered;
2. verify every required input file is readable;
3. verify the declared output path is writable when the agent writes;
4. provide a normalized metadata snapshot instead of assuming nested Dataverse
   access;
5. verify the agent's required tool surface from its declared tools;
6. select the documented fallback before dispatch when any requirement fails.

Do not launch an agent merely to learn after several minutes that it cannot
read the workspace, write its output, access Dataverse, or spawn another agent.

| Agent | Required capabilities | Fallback |
|---|---|---|
| `native-app-planner` | Read/write plan artifacts, leaf-agent dispatch | Orchestrator runs Gates 2–3 inline |
| `data-model-architect` | Read snapshot and plan inputs; write `_dm_section.md` | Foreground drafts from the same snapshot |
| `screen-planner` | Read plan/references; write screen section and preview | Foreground drafts from screen templates |
| `screen-builder` | Read/write assigned screen and run validation | Foreground builds that screen; never duplicate completed agent work |

Unknown/malformed agent return status is `BLOCKED`. `NEEDS_CONTEXT` may be
retried twice with the missing input. Do not retry a capability failure with the
same context.

## Progress visibility

Create/update `mobile-app-status.json` with:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-plan-status.js" \
  --project-root "<working_dir>" \
  --phase "architecture" \
  --message "Discovering Dataverse metadata" \
  --state "running" \
  --completed 1 \
  --total 4 \
  --awaiting-input false
```

Update it after meaningful phase/batch boundaries, not every request. Print the
same concise state in the terminal.

## Visual plan preview

Render the authoritative Markdown plan at Gates 2, 3, and 4:

```bash
node "${PLUGIN_ROOT}/scripts/render-mobile-plan.js" \
  --plan "<working_dir>/native-app-plan.md" \
  --status "<working_dir>/mobile-app-status.json" \
  --output "<working_dir>/mobile-app-plan.html"
```

Open/print the same path after each render. The HTML is a review surface, not a
fifth approval. Label it clearly as a plan preview rather than runtime UI.

## Prompt awareness

Immediately before any gate waits:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-plan-status.js" \
  --project-root "<working_dir>" \
  --awaiting-input true \
  --input-prompt "Return to the terminal to approve the architecture."
```

Print `INPUT REQUIRED` prominently. After the response, clear the flag
immediately. When Expo is running, the orchestrator may surface the same status
in the preview, but it must not add another question.

Additional prompts are permitted only for exceptional conditions that cannot be
safely inferred: authentication failure, destructive target conflict, or a
requirements change.

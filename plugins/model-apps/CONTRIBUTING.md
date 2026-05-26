# Contributing to the Model Apps Plugin

How to extend `/genpage` without breaking it. For the architectural overview,
see `docs/architecture.md`. For per-agent behavioral specs, see `AGENTS.md`.

## Setup

```bash
# Clone the repo
git clone https://github.com/microsoft/power-platform-skills.git
cd power-platform-skills

# Test the plugin locally
claude --plugin-dir ./plugins/model-apps

# Run the script + eval test suites (both must be green before PR)
node --test plugins/model-apps/scripts/tests/*.test.js
node --test evals/model-apps/genpage/tests/*.test.js
```

You'll need Node.js (LTS), PAC CLI ≥ 2.7.0, and `az` (Azure CLI) for
entity-creation flows. See `README.md` for installation.

## Common contribution patterns

### Adding a sample

Samples live in `samples/` and are read by `genpage-page-builder` when the
planner picks one as a structural reference. To add one:

1. Create `samples/<N>-<kebab-name>.tsx` (next available number).
2. Make it v2.1-compliant:
   - Single file, `export default GeneratedComponent` at the bottom
   - Destructures `{ dataApi, pageInput }` from `props`
   - Imports types from `./RuntimeTypes` (Dataverse) OR has inline mock data
   - Uses `makeStyles` + `tokens`; no inline styles for static values
   - Uses unsized Fluent icons (`AddRegular`, not `Add24Regular`)
   - No `100vh` / `100vw`; no `<FluentProvider>` wrapper; no
     `createTheme` / `mergeThemes` / `useTheme`
   - Wraps async `dataApi` calls in try/catch (Dataverse pages)
3. Add the sample to the planner's `## Relevant Samples` matching logic if
   it covers a new pattern (e.g., kanban, file upload, drag-and-drop). Edit
   `agents/genpage-planner.md` — search for `## Relevant Samples` in the
   "Sample selection" section.
4. Verify the sample passes Layer 2:
   ```bash
   mkdir -p evals/model-apps/genpage/fixtures/<eval-id>-<slug>/
   cp samples/<N>-<name>.tsx evals/model-apps/genpage/fixtures/<eval-id>-<slug>/page.tsx
   node evals/model-apps/genpage/run-layer-2.js --eval <eval-id>
   ```
5. Update `AGENTS.md`'s file tree (`samples/                           ← Example .tsx files (N samples)` line).
6. Update `references/rules.md` if the sample establishes a new convention.
7. Commit. PR title: `Add sample <N>-<kebab-name>.tsx`.

### Adding a code-gen rule

Rules live in `references/rules.md` and are read by `genpage-page-builder` on
every generation. The rules file is in the hot path — keep additions tight.

1. Decide whether the rule belongs in `rules.md` (always loaded) or in a
   separate conditional reference (e.g., `data-caching.md` is loaded only on
   list/detail patterns).
2. Add the rule under the appropriate `## <Section>` header in `rules.md`,
   using the existing numbered pattern (`### Rule N: ...`).
3. Include a one-line "Why" so the rule survives future trims. The rule body
   should be ≤10 lines unless it absolutely needs more.
4. Encode it as an assertion if possible — add an entry to
   `evals/model-apps/genpage/evals.json` under `common_code_assertions`.
5. Register a check in `evals/model-apps/genpage/lib/assertions-layer-2.js`
   keyed by the exact assertion text. If the check requires AST analysis,
   return `{ status: 'skip', reason: '... requires AST' }` for now.
6. Add a unit test in
   `evals/model-apps/genpage/tests/assertions-layer-2.test.js`.
7. Update at least one fixture in `evals/model-apps/genpage/fixtures/` to
   demonstrate the rule (or update an existing one that already does).
8. Run both layers:
   ```bash
   node evals/model-apps/genpage/run-layer-2.js
   node --test evals/model-apps/genpage/tests/*.test.js
   ```

### Capturing a real /genpage fixture

After running `/genpage` end-to-end against a real Dataverse environment,
capture the result into an eval fixture:

```bash
node plugins/model-apps/scripts/capture-fixture.js \
  --working-dir <path-to-/genpage-working-dir> \
  --eval <id> \
  --slug <kebab-slug>
```

The script copies `*.tsx`, `*.md`, and `RuntimeTypes.ts` into
`evals/model-apps/genpage/fixtures/<eval-id>-<slug>/`, skips `package.json`
and `genpage.d.ts` (Phase 0.5 scaffolding, not agent output), then runs
both Layer 1 and Layer 2 and reports the result.

Use `--force` to overwrite an existing fixture (re-capture after agent
changes). Use `--skip-verify` to capture without running the layers.

A capture is **good to commit** when:
- All `common_workflow_assertions` pass under Layer 1 (per-eval Phase
  expectations may legitimately skip; that's fine)
- All `common_code_assertions` pass under Layer 2
- The runner-emitted JSON includes empty `layer1.failures` and
  `layer2.failures` arrays

If failures show up, add a fixture-local `README.md` explaining what's
known-red and why (see `fixtures/15-memory-game-entity-with-choices/README.md`
for the format).

### Adding an eval

Evals live in `evals/model-apps/genpage/evals.json`. Each tests one
end-to-end scenario. See `evals/model-apps/genpage/EVAL_GUIDE.md` for the
full guide (3-layer model, tiers, fixture types, capture flow). Quick
version:

1. Append a new entry to the `evals` array:
   ```json
   {
     "id": <next>,
     "tier": "smoke" | "full" | "stress",
     "prompt": "<verbatim /genpage prompt>",
     "data": { "question_answers": { ... }, "app_selection": "...", ... },
     "expectations": [ "Phase 1 (Planner): ...", ... ]
   }
   ```
2. Tier guidance:
   - `smoke` (4-5): runs on every PR; pick diverse representatives
   - `full` (~10): runs nightly or pre-release
   - `stress` (3-5): edge cases — collisions, blockers, revision loops
3. Write expectations as exact-text assertions. The Layer 1 runner matches
   by exact string to a check function in `assertions-layer-1.js`.
4. Capture or hand-build a fixture under
   `evals/model-apps/genpage/fixtures/<eval-id>-<slug>/`. See the existing
   fixtures for shape. Both layers must pass against your fixture (or be a
   documented "known red" with a fixture-local README).
5. Update `eval-runbook.md` if the tier counts shift.

### Adding a Web API script

Scripts live in `scripts/` and are invoked by `genpage-entity-builder` (or
directly by the orchestrator in Phase 0.5 / Phase 2a). They use the shared
`scripts/lib/dataverse-auth.js` for auth + HTTP.

1. Create `scripts/<verb>-<noun>.js` (kebab-case verb-noun).
2. Use the shared helpers:
   ```js
   const { getAccessToken, dataverseRequest, parseFlags, emit } =
     require('./lib/dataverse-auth.js');
   ```
3. Parse flags with `parseFlags(process.argv.slice(2), { ... })`. Always
   require `--solution` for entity-creating scripts (`Default` is a valid
   value — never omit). Emit results as a single JSON object on stdout via
   `emit()`.
4. **NEVER `process.exit(1)`** — emit `{ ok: false, blocker, message, ... }`
   and exit 0. The orchestrator gates on the JSON, not the exit code.
5. Add tests in `scripts/tests/<verb>-<noun>.test.js`. Cover: arg parsing,
   payload shape, error messages for missing flags. Use `spawnSync` for
   CLI-level tests; require the module directly for unit tests.
6. Document the script in `AGENTS.md`'s file tree under `scripts/`.
7. Add an invocation example in the relevant agent file
   (`genpage-entity-builder.md` for table/column scripts; `SKILL.md` for
   orchestrator-level scripts like `generate-page-manifest.js`).

### Updating dependency versions

The single source of truth is `scripts/lib/supported-dependencies.js`. The
human-readable doc (`references/supported-dependencies.md`) and the manifest
generator (`scripts/generate-page-manifest.js`) both read from there.

1. Edit `scripts/lib/supported-dependencies.js`. Update `version`; flip
   `confidence` from `compatible` to `pinned` if upstream has confirmed.
2. Update the table in `references/supported-dependencies.md` to match.
3. Run `node --test plugins/model-apps/scripts/tests/generate-page-manifest.test.js`.
4. If a major version bump, bump the plugin's `version` in
   `.claude-plugin/plugin.json` (minor for feature-equivalent runtime bumps;
   major if it breaks generated code).
5. Add a `CHANGELOG.md` entry.

## Plan-document changes

Changes to `references/plan-schema.md` ripple through every other component
that reads the plan. Before changing:

1. List every reader: the orchestrator (SKILL.md), each agent, the Layer 1
   runner (`assertions-layer-1.js → planSection`), maybe the edit flow.
2. Decide whether the change is backward-compatible (add a new optional
   section) or breaking (rename / remove an existing section). Breaking
   changes need a major version bump.
3. Update `plan-schema.md`. Add an example.
4. Update every reader.
5. Update at least one fixture to use the new structure; verify Layer 1
   still passes.

## Style

- TypeScript / JavaScript: 4-space indent in `.tsx` (matches genux runtime
  style), 2-space in `.js` (matches Node convention). Single quotes.
  Semicolons.
- Markdown: 80-column soft wrap on prose; tables are exempt.
- Comments: only when the *why* isn't obvious from the code. No "what"
  comments.
- Filenames: kebab-case for everything (samples, scripts, references).
- Don't add planning/decision/analysis docs to the repo unless explicitly
  asked. Conversation history is enough.

## PR checklist

- [ ] `node --test plugins/model-apps/scripts/tests/*.test.js` passes
- [ ] `node --test evals/model-apps/genpage/tests/*.test.js` passes
- [ ] `node evals/model-apps/genpage/run-layer-1.js` exits 0 on synthetic fixtures
- [ ] `node evals/model-apps/genpage/run-layer-2.js` exits 0 on synthetic fixtures
- [ ] `AGENTS.md` file tree updated if files added/moved
- [ ] `CHANGELOG.md` entry added under the appropriate version section
- [ ] Plugin version bumped in `.claude-plugin/plugin.json` if shipping a release
- [ ] No new dependencies in generated pages unless added to
      `scripts/lib/supported-dependencies.js`
- [ ] Scripts use `spawnSync` or `execFile` for child processes; shell
      invocations are avoided to prevent command injection

## Where to ask

- Repo-level questions: open an issue at https://github.com/microsoft/power-platform-skills/issues
- Plugin-internal questions: ping the maintainers in PR comments
- Generative pages platform questions: see the `references/` doc that
  matches the topic (rules, plan schema, dependencies, etc.) — the docs are
  the authoritative source

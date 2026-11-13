# Skill evaluations

Power Pages has offline [Vally](https://www.npmjs.com/package/@microsoft/vally) suites for `setup-auth` and `create-site`.
Add suites as individual skills are improved rather than requiring coverage for every skill at once.
Other skills and plugins appear in the [evaluation dashboard](https://microsoft.github.io/power-platform-skills/evaluations/) as untested until they have their own measured evidence.
Existing `evals.json` files for other skills are preserved but are not run or counted as measured evidence by this runtime.

The design follows [Agent Skills evaluation guidance](https://agentskills.io/skill-creation/evaluating-skills): realistic tasks, isolated trials, a no-skill baseline, checks against actual output, and human review before trusting automated grades.
[dotnet/skills](https://github.com/dotnet/skills) provides another public example of Vally-based evaluation.

## Local checks

Use Node.js 22.15 or newer from the repository root:

```bash
npm ci --prefix evals/runtime --registry=https://packagefeedproxy.microsoft.io/npm/ --ignore-scripts --no-audit --no-fund
node evals/runtime/node_modules/playwright/cli.js install chromium
node evals/runtime/run.mjs validate
npm test --prefix evals/runtime
```

Linux runners can install browser system dependencies with `install --with-deps chromium`.
The validation workflow runs on Linux, Windows and macOS without model credentials.
Its native CLI test creates real isolated sessions and invokes a skill against a local dummy provider, without requesting model generation.

The manual workflow runs four pinned models at medium reasoning effort:
`claude-opus-5.5`, `claude-sonnet-5.5`, `gpt-6-astra`, and `gpt-6.1-sol`.
These are the current Sonnet and Sol versions verified against the Copilot catalog; explicit versions keep runs attributable.
Sol judges Opus; Opus judges the other three.
The judge must differ from the evaluated model.
Manual dispatch can override the comma-separated model list, judge model, agent effort and judge effort.
Unsupported model/effort choices fail rather than silently falling back.

The runner supports focused debugging with native Actions authentication or `--local-auth` using an existing Copilot authentication environment:

```bash
node evals/runtime/run.mjs run --skill setup-auth --runs 1 --local-auth \
  --model claude-opus-5.5 --judge-model gpt-6.1-sol \
  --reasoning-effort medium --judge-reasoning-effort medium \
  --out evals/reports/auth-review
```

Add `--case <case-name>` to run one pair.
Omit `--skill` to run all available Vally suites; requesting a skill without a suite fails explicitly.
The manual workflow's `all` option selects the same available suites.
Output directories must be new so a partial run cannot overwrite earlier evidence.
Keep local output under ignored `evals/reports/`.
Local authentication does not copy credential files into the trial and is disallowed in Actions.
The workflow uses its native `GITHUB_TOKEN` with `copilot-requests: write`; no PAT secret is required.

## What the trials measure

Each `evals/power-pages/<skill>/eval.yaml` contains several capability tasks and an unrelated dormancy task.
Fixtures are synthetic local inputs.
Hidden `checks/*.json` files describe required output and remain outside the agent workspace.
They check content, parsed structures, preserved input, forbidden output and required relationships rather than file existence alone.

Each pair gets fresh, separate workspaces.
Both arms have the same contained file tools and read-only plugin assets, references and scripts.
Only the treatment can discover and invoke the selected skill.
Baseline resource reads exclude every skill instruction and agent customization file.
Trial order alternates across repeats.

The custom Copilot SDK executor exposes only contained file operations and allowlisted offline render, comparison and source-analysis helpers.
It rejects generic shell, network, MCP, subagent and ambient customization capabilities, and validates the actual native tool and skill catalogs before inference.
Helper subprocesses receive a clean environment and a network-denial preload.
The model service itself still requires Copilot access.

These are offline artifact, analysis and planning tests.
They never connect to a Power Pages environment, authenticate to Dataverse, deploy a site, or claim a live operation succeeded.
They do not measure unrestricted CLI behavior, interactive approval handling, parent-skill routing or production readiness.
An isolated helper skill can pass without proving that its parent would select it.

## Documents and ER diagrams

HTML checks parse the document and its inline JavaScript, then render it in isolated Chromium.
They inspect visible content across tabs, runtime errors and unresolved template values.
HTML artifact contracts check desktop and mobile layout by default.
Planning and report contracts set `"responsive": false`: the approval document's own CSS or table overflow is not a site-quality criterion.
External requests are blocked.
Saved screenshots support human inspection.
The create-site repair plan requires a visible Design section with typography, brand palette, contrast, hero, signature moment and reduced-motion decisions.
Its separate design rubric checks the proposed experience and responsive interaction states against the supplied brief.

## Generated sites

A contract `site` block grades a generated React code site rather than a document.
Trials cannot install packages, so the grader copies the site to a scratch folder and builds it with the runtime's pinned create-site template dependencies.
It type-checks `src` with the pinned TypeScript compiler and the trusted template's options, without emitting files or using the generated TypeScript configuration.
Vite runs in a child process with `configFile: false` and an inline PostCSS config, so agent-authored config files are never executed.
An import outside the template dependencies fails the build, which counts as a site failure.
Each listed route is served with a single-page-app fallback and rendered at 1440px and 390px.
A route fails if it lacks a device-width viewport or a visible `h1`, scrolls horizontally, renders empty, or throws.
Screenshots of every route and width are saved as evidence.
The create-site `repair-site-build` case uses this check, so responsiveness is gated on the site the agent builds, not on its approval plan.

ER checks use Mermaid's parser and renderer.
They compare entities, required attributes and relationship cardinalities against the case contract, including the diagram the report displays rather than trusting a correct fallback string.
Rendered SVGs and label checks expose broken syntax and unreadable diagrams.

Vally's text-only rubric grader receives actual artifact evidence for domain correctness and report quality.
It does not see screenshots or provide a visual-design judgment.
Every required grader must pass; a high prose score cannot compensate for a missing artifact or incorrect ER relationship.
Errors remain distinct from measured failures.

## Calibrate before publishing claims

Start with one skill and one repeat.
Inspect both arms' generated output, screenshots, ER SVGs, grader reasons and `review-index.json`.
Record human feedback locally in that index.
Fix assertions that reject valid alternatives or accept incorrect output, then rerun the same pair.
Add cases from observed user failures and keep some fresh cases outside routine tuning.

The initial cases are authored expectations, not human-calibrated evidence of improvement.
Repeats measure consistency on the same task, not independent task breadth.
Small suites and rubric scores do not establish statistical significance, a general confidence percentage or live deployment reliability.
The dashboard reports observed outcomes and explicit evidence categories.

## Publish evidence

Each matrix job uploads only its sanitized `summary.json`.
It contains case identifiers, verdicts, token counts, model IDs, reasoning efforts, source hashes and workflow provenance.
Raw trajectories, generated artifacts, grader explanations, screenshots and errors remain local and are not uploaded from this public repository.
For human calibration, run in a controlled environment and inspect local evidence; the public workflow artifact is deliberately insufficient for that review.

Agent usage records input, output and cache counters reported by the Copilot SDK.
Missing counters remain unknown.
Judge usage records the counts returned by Vally and the number of judge calls with and without reported usage.
Vally can substitute zero for a missing judge counter, so judge totals are lower bounds.
Cache values may overlap input tokens, and judge cache counts are unavailable.
These counts are not billing figures.

After an evaluation completes, the existing showcase workflow fetches retained summaries from the latest 20 trusted default-branch dispatch runs.
It validates the schema and matches the commit, workflow URL, skill and model to each matrix artifact before building the site's `/evaluations/` page.
Only summaries are copied into the build; artifact content is never executed.
The existing repo-stats report remains in the same Pages deployment.
Evaluation artifacts are retained for up to 90 days.
The model workflow is manually dispatched; PR validation does not call models, and no nightly evaluation is scheduled.

The dashboard selects the latest whole suite per skill, agent model, judge model and both reasoning efforts.
It never fills missing trials from an older run or pools different model/effort combinations.
Older summaries without effort metadata remain readable and are labelled unreported.
Changes to plugin content, the suite's fixtures or checks, or the evaluation runtime invalidate matching source evidence.
Expired artifacts and unmeasured skills remain explicitly unavailable.
The token view uses all retained summaries in the publication window, including older results, and groups usage by each skill evaluation's UTC start date and by plugin.
Multiple per-skill artifacts from one matrix run count as one linked workflow run.

To preview local summaries:

```bash
node site/build.js --eval-results evals/reports/auth-review
```

No example scores ship as measured results.

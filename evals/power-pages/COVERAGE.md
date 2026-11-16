# Power Pages slimming evaluations

The rollout scope is the 19 Power Pages skills whose `SKILL.md` exceeded 500 lines at `198d91b94abc29fcd59962d6202b454274500411`.
This is a fixed inventory, not a changing test of file length.
The suites measure requested outcomes and bounded behavior; a smaller file is not a passing grade.
All prompts, fixtures and hidden checks live outside the plugin, so the same suite can run against original and revised instructions.
No skill instruction files are changed by these evaluations.

## Coverage

Every suite includes an unrelated local arithmetic task for dormancy.
Counts below include that task.
`setup-auth` and `create-site` retain their existing suites unchanged.
Legacy `evals.json` files remain untouched; their relevant scenarios informed the new suites, but the runtime still does not execute or count those legacy files.

| Skill | Cases | Outcome coverage |
| --- | ---: | --- |
| setup-auth | 5 | Invitation/local sign-in, external redirects/contact mapping, self-profile least privilege, mock UI versus server authorization |
| create-site | 6 | Plan repair, generated-site build, native template review, Arabic design, unsupported server-rendered stack |
| add-server-logic | 6 | Executed sum and provider endpoints with frontend calls; Dataverse response alternatives; enablement consent; unknown provider contract |
| deploy-pipeline | 4 | Stage/package/settings preflight, failed run, ambiguous stage |
| add-localization | 5 | Arabic/RTL and interpolation, Angular static boundary, existing runtime resources, translator-owned blank Vue values |
| plan-alm | 4 | Manual promotion sequence, stale approval, cancelled deferral review |
| ensure-pipelines-host | 4 | Bound custom-host reuse, multiple unbound hosts, no-host tenant consent |
| audit-permissions | 4 | Anonymous/global and wildcard exposure, incomplete/403 evidence, own-record read-only preservation |
| setup-solution | 4 | Publisher/website/component proposal, identity mismatch, existing components |
| add-ai-webapi | 6 | List scope/trigger choice, record summary proposal, missing prerequisites, embedded error under HTTP 200, cancellation |
| test-site | 4 | Captured platform/connector responses and redirects, API failure despite healthy pages, no live URL |
| integrate-webapi | 4 | Own-record SPA service proposal, preserved native Liquid bindings, unknown entity-set metadata |
| add-cloud-flow | 4 | Existing flow/role/client proposal, incompatible trigger, association reuse |
| setup-pipeline | 4 | Staging/production order, missing host, existing stage reuse |
| import-solution | 4 | Managed-package preflight, wrong package/downgrade, failed asynchronous import |
| integrate-backend | 4 | Server-enforced transaction routing, ordinary table-read routing, external credential boundary |
| edit-site | 4 | Localized native content preservation, stale source approval, already-applied narrow edit |
| deploy-site | 4 | SPA environment mismatch/build preflight, existing Standard-site upload routing, blocked JavaScript remediation |
| configure-env-variables | 4 | Stage-specific values and secret exclusions, Standard-model boundary, already-linked reuse |

These are 84 authored cases, not 84 measured successes.
Most remote-lifecycle cases deliberately produce plans, diagnoses or no-ops from synthetic exports.
They cannot establish successful authentication, deployment, environment mutation, flow execution, live testing or production security.
The server checker exercises the supplied local JavaScript service interface, not a framework-mounted screen or a real Power Pages host.
Its varied provider values catch static demo substitutions; its explicit test adapter does not validate live provider/SDK compatibility.
The Dataverse case accepts raw passthrough, wrapped passthrough or normalized responses when the proposed handler and client agree.
No historical sampled output is treated as the only valid public contract.

## Establish a baseline now

Install the pinned runtime and Chromium using the commands in [the evaluation README](../README.md).
Fetch any source revisions you intend to compare; the runner never fetches or changes a branch.
Use explicit available model IDs and fixed reasoning efforts.
The placeholders below must be replaced with actual model IDs, not `auto`.

```bash
node evals/runtime/run.mjs validate

node evals/runtime/run.mjs compare --skill add-server-logic \
  --case validated-sum-endpoint --runs 1 \
  --before 198d91b94abc29fcd59962d6202b454274500411 \
  --after 198d91b94abc29fcd59962d6202b454274500411 \
  --model <agent-model-id> --judge-model <different-judge-model-id> \
  --reasoning-effort medium --judge-reasoning-effort medium --local-auth \
  --out evals/reports/server-baseline
```

The same-ref run is a calibration and variability check, not an instruction improvement.
It makes four agent trials per case/repeat: before with and without the skill, then after with and without the skill.
Judge calls are additional.
Remove `--case` only after inspecting a focused run.
Do not launch every skill/model combination merely to establish that the harness works.

The existing two-arm mode remains available:

```bash
node evals/runtime/run.mjs run --skill add-server-logic \
  --case validated-sum-endpoint --runs 1 --local-auth \
  --model <agent-model-id> --judge-model <different-judge-model-id> \
  --reasoning-effort medium --judge-reasoning-effort medium \
  --out evals/reports/server-current-checkout
```

`run` evaluates the current plugin tree, including any local changes.
For attributable revision evidence, prefer `compare`, which reads immutable Git objects.

## Compare a later revision

Run the same `compare` command with `--before` fixed to the baseline commit and `--after` set to the revised commit.
Use a new output directory and keep the case selection, repeats, models and efforts fixed.
The runner reads both complete plugin snapshots from Git without checkout, hooks, filters or line-ending conversion.
It keeps cases, fixture bytes, graders, runtime and capability allowlist from this evaluation checkout for both revisions.
Read-only plugin references, scripts and templates come from their respective source snapshots.
Keep unrelated plugin changes out of the selected revisions when attributing a difference specifically to slimming.

The local `comparison.json` records exact source commits, plugin/skill/suite/runtime SHA-256 hashes, main-file bytes/lines, and a paired-input digest over resolved prompts, fixture bytes/destinations and settings.
Each arm retains the ordinary sanitized summary plus private trajectories, generated artifacts, grader reasons and review index.
The summary's source commit identifies the evaluated revision; the runtime hash identifies the evaluation implementation.
A partial/interrupted comparison remains incomplete.
The command exits with code 2 for incomplete/error evidence, code 1 for a measured candidate with-skill failure, or code 0 when candidate with-skill trials pass.
An expected no-skill control failure alone does not fail the command.
Comparison manifests and private evidence are local-only; revision comparisons are not wired into the public dashboard or manual CI dispatch.

The before arm runs before the after arm, so service drift and run-order effects remain possible.
Within each revision, the existing with-skill/no-skill order alternates across repeats.
A single pair or repeat is not evidence of statistical significance.
Changing models, fixture/check hashes or runtime invalidates an across-run comparison.

## Read behavior and efficiency separately

`comparison.json` lists paired statuses and regressions, with errors distinct from measured failures.
Its capability pass rate uses only with-skill capability trials: passed divided by passed plus failed.
Expected/measured/error counts accompany the rate; missing/error trials must not disappear from the interpretation.
Dormancy and no-skill controls remain separate paired records rather than inflating capability success.

Main-file bytes/lines measure file size only.
Model input/output and reported cache counters, judge counters, and elapsed time remain in each arm's summaries.
Missing model usage remains `null`, never zero or an estimated saving.
Paired token/time deltas are unknown when either side is unknown.
Explicit reference exposure is available only through private read records and review-index byte totals; automatic skill/context exposure is not fully observable.
Reading a smaller main file while loading more references can cost more overall.
Do not claim lower total tokens from file-size changes or partial read bytes.

Inspect both arms' actual outputs, screenshots where present, failing assertions and judge explanations.
Record human feedback in each arm's `review-index.json`.
Calibrate false positives and negatives before publishing a behavioral-preservation or efficiency claim.
The arithmetic dormancy probe is intentionally narrow; it does not measure broad routing accuracy.

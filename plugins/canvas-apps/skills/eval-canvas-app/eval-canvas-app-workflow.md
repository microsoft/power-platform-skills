# EvalCanvasApp Workflow

Run the governed AppGen functional scenarios for one Power Apps Canvas App through `power-platform-evals`, retain its canonical evidence and Product report, and publish structured metrics to the OneDS-backed Kusto stream. Run the packaged runner on a Microsoft Dev Box or another Windows-based environment with `pwsh` and Edge; it uses Win32 process APIs.

## Phase 1: Resolve inputs

1. Extract an HTTPS Power Apps URL from `$ARGUMENTS`. It must use a supported maker or player host beginning with `make.` or `apps.` and may identify the app with `appId`, `app-id`, or a `/play/e/<envId>/a/<appId>` path. The environment may come from `envId`, `environmentId`, `/e/<envId>/canvas`, or the player path. The runner preserves the supplied cloud suffix and maps between the corresponding `make.*` and `apps.*` hosts.
2. Extract the Q prompt ID, such as `Q1` or `Q15`, when it is present.
3. Extract an optional Power Apps user UPN when the user requests a specific account. Require the full UPN rather than guessing a domain from an alias. Never request a password or authentication token.
4. If the app URL is missing, ask for it.
5. If the prompt ID is missing, ask which Q prompt generated the app. Functional grading requires the authored scenarios for that prompt; do not silently run the ungraded universal coverage fallback.
6. Resolve the `power-platform-evals` checkout from a path supplied by the user or from
   `POWER_PLATFORM_EVALS_REPO`. If neither is available, ask for the checkout path.
7. Confirm `FOUNDRY_EVAL_ENDPOINT` is available and Azure CLI is signed in for that Foundry resource. Both are required by the native AppGen evaluator.
8. Confirm `PPEVAL_APPGEN_ONEDS_INSTRUMENTATION_KEY` is available. It is required to publish eval metrics to the Kusto-backed stream and must never be printed.
9. The runner uses a persistent browser profile at `<power-platform-evals>/.auth/browser-use-profile` by default. If a user UPN is supplied, derive a filesystem-safe user-specific profile path under `<power-platform-evals>/.auth/`, pass it with `-BrowserUserDataDir`, pass the UPN with `-LoginHint`, and use isolated Chromium with `-BrowserChannel ""`. This prevents Edge Windows SSO from silently selecting a different cached account. If authentication is required, complete it in the browser opened by the runner; do not bypass or suppress authentication failures.

## Phase 2: Run the packaged eval

Run:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File "${PLUGIN_ROOT}/skills/eval-canvas-app/scripts/run-functional-eval.ps1" \
  -PpevalRepoPath "<resolved power-platform-evals path>" \
  -AppUrl "<published app URL>" \
  -PromptId "<Q prompt ID>" \
  -Concurrency 1 \
  -SessionConcurrency 1 \
  <optional: -BrowserUserDataDir "<power-platform-evals>/.auth/browser-use-profile-<safe-user>" -BrowserChannel "" -LoginHint "<full user UPN>"> \
  -PublishToKusto
```

The runner opens the selected app in Canvas Studio, prepares a stable F5 preview and CDP target, creates `single-app-batch.json`, and runs the native `appgen:integration:central-native` integration from the current `power-platform-evals` branch. The generated batch uses the Canvas Studio maker host as its CDP ownership boundary while the summary retains the source and normalized player URLs. Do not replace the batch `app_url` with the player URL: the worker rejects that host mismatch as `browser_target_ownership_failed`. The runner resolves `Q1` to `full`, other Initial50 prompts to `q<number>-full`, and `_powerfx` prompt IDs to their matching Power Fx eval sets. The artifact bundle retains the canonical ppeval store, Product `report.html` and `report-data.json`, diagnostics, and OneDS publication status.

Do not substitute an `app-studio-evals` checkout or invoke its CLI. Scenario definitions, selection, execution, report projection, and OneDS publication must all come from `power-platform-evals`.

## Phase 3: Return the result

Report:

1. Source URL, normalized player URL, app ID, environment ID, and prompt ID
2. `power-platform-evals` branch and resolved eval set
3. Exit code
4. Artifact directory
5. Log and summary paths
6. Run ID, `report.html`, and `report-data.json` paths, when available
7. Kusto publication exit code and log path
8. The first actionable error when the eval or publication fails

Do not describe a coverage-only result as a functional grade.

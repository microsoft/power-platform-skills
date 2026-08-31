# Run Functional Eval Workflow

This skill runs the native AppGen integration from the current branch of `power-platform-evals` and stores a PM-friendly artifact bundle.

## Phase 1: Resolve inputs

1. Read user arguments and decide values for:

- power-platform-evals repo path, supplied explicitly or through
  `POWER_PLATFORM_EVALS_REPO`
- Canvas App URL containing app ID and environment ID
- Q prompt ID used to select the governed AppGen eval set
- optional full user UPN when the eval must run as a specific Power Apps account
- concurrency values (default: 1 and 1)

2. If neither a repository path nor `POWER_PLATFORM_EVALS_REPO` is available, ask for
   the checkout path.
3. Confirm `FOUNDRY_EVAL_ENDPOINT` is available and Azure CLI is signed in for that resource.
4. If the user supplies only an account alias, ask for the full UPN. Never request a password or authentication token.
5. If an input is missing or unclear, ask one concise clarification question.

## Phase 2: Run the packaged function

Execute this command with Bash:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File "${PLUGIN_ROOT}/skills/run-functional-eval/run-functional-eval.ps1" \
  -PpevalRepoPath "<resolved repo path>" \
  -AppUrl "<published app URL>" \
  -PromptId "<Q prompt ID>" \
  -Concurrency 1 \
  -SessionConcurrency 1 \
  <optional: -BrowserUserDataDir "<repo>/.auth/browser-use-profile-<safe-user>" -BrowserChannel "" -LoginHint "<full user UPN>">
```

Notes:

- The script captures full command output into an artifact log file.
- It prepares a Canvas Studio preview, runs `appgen:integration:central-native`, and retains the canonical ppeval store and Product report.
- When a user UPN is supplied, use a filesystem-safe user-specific profile and isolated Chromium so Edge Windows SSO cannot select another cached account.
- The generated batch deliberately uses the Canvas Studio maker host as the CDP ownership boundary. Using the player host there causes `browser_target_ownership_failed`.
- It writes a JSON summary with run ID, eval set, report path, exit code, branch, and timestamps.
- The script prints ARTIFACT_PATH, SUMMARY_FILE, and LOG_FILE at the end. Keep those values.

## Phase 3: Return a PM-ready summary

Respond with:

1. Branch used
2. Command executed
3. Artifact folder path
4. Log path
5. Summary file path
6. Run id and report path (if discovered)
7. Exit code

If the command fails, still return the artifact paths and tell the user where to inspect details.

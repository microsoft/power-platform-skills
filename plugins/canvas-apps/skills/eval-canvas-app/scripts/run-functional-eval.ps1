param(
    [string]$PpevalRepoPath = $env:POWER_PLATFORM_EVALS_REPO,
    [string]$AppUrl,
    [string]$PromptId,
    [string]$EvalSet,
    [string]$EvalModel = "gpt-5.2",
    [int]$Concurrency = 1,
    [int]$SessionConcurrency = 1,
    [int]$BrowserStartupTimeoutSeconds = 180,
    [int]$CdpPort = 9222,
    [string]$BrowserChannel = "msedge",
    [string]$BrowserUserDataDir,
    [string]$LoginHint,
    [switch]$PublishToKusto,
    [string]$PublishEnvironment = "local",
    [string]$BuildNumber,
    [string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The eval-canvas-app runner currently supports Windows only (requires Edge/Win32 process APIs)."
}

function Get-CanvasAppUrlDetails {
    param([Uri]$Uri)

    $query = @{}
    foreach ($part in $Uri.Query.TrimStart("?").Split("&", [StringSplitOptions]::RemoveEmptyEntries)) {
        $pair = $part.Split("=", 2)
        $name = [Uri]::UnescapeDataString($pair[0].Replace("+", " "))
        $value = if ($pair.Count -eq 2) {
            [Uri]::UnescapeDataString($pair[1].Replace("+", " "))
        } else {
            ""
        }
        $query[$name] = $value
    }

    $appId = $query["appId"]
    if ([string]::IsNullOrWhiteSpace($appId)) {
        $appId = $query["app-id"]
    }
    if (-not [string]::IsNullOrWhiteSpace($appId) -and $appId.Contains("/")) {
        $appId = $appId.TrimEnd("/").Split("/")[-1]
    }

    $environmentId = $query["envId"]
    if ([string]::IsNullOrWhiteSpace($environmentId)) {
        $environmentId = $query["environmentId"]
    }

    $playerPath = [regex]::Match(
        $Uri.AbsolutePath,
        "(?i)/play/e/(?<environment>[^/]+)/a/(?<app>[^/]+)"
    )
    if ($playerPath.Success) {
        if ([string]::IsNullOrWhiteSpace($environmentId)) {
            $environmentId = [Uri]::UnescapeDataString($playerPath.Groups["environment"].Value)
        }
        if ([string]::IsNullOrWhiteSpace($appId)) {
            $appId = [Uri]::UnescapeDataString($playerPath.Groups["app"].Value)
        }
    }

    if ([string]::IsNullOrWhiteSpace($environmentId)) {
        $makerPath = [regex]::Match($Uri.AbsolutePath, "(?i)/e/(?<environment>[^/]+)/canvas")
        if ($makerPath.Success) {
            $environmentId = [Uri]::UnescapeDataString($makerPath.Groups["environment"].Value)
        }
    }

    if ([string]::IsNullOrWhiteSpace($appId) -or
        [string]::IsNullOrWhiteSpace($environmentId)) {
        throw "AppUrl must include both appId and envId. Supported forms include appId/envId query parameters, maker URLs with app-id and /e/<envId>/canvas, and /play/e/<envId>/a/<appId> player paths."
    }

    $isTestEnvironment = $Uri.Host -match "(?i)(^|\.)test(\.|$)"
    $playerHost = if ($isTestEnvironment) {
        "apps.test.powerapps.com"
    } else {
        "apps.powerapps.com"
    }
    $makerBaseUrl = if ($isTestEnvironment) {
        "https://make.test.powerapps.com"
    } else {
        "https://make.powerapps.com"
    }

    return [ordered]@{
        app_id = $appId
        environment_id = $environmentId
        maker_base_url = $makerBaseUrl
        player_url = "https://$playerHost/play/e/$([Uri]::EscapeDataString($environmentId))/a/$([Uri]::EscapeDataString($appId))"
    }
}

function Resolve-AppGenEvalSet {
    param(
        [string]$ResolvedPromptId,
        [string]$ExplicitEvalSet
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitEvalSet)) {
        return $ExplicitEvalSet
    }
    if ($ResolvedPromptId -ieq "SMOKE") {
        return "smoke"
    }
    if ($ResolvedPromptId -ieq "Q1") {
        return "full"
    }
    if ($ResolvedPromptId -match "(?i)^Q(?<number>[0-9]+)_powerfx$") {
        return "q$($Matches.number)-powerfx"
    }
    if ($ResolvedPromptId -match "(?i)^Q(?<number>[0-9]+)$") {
        return "q$($Matches.number)-full"
    }
    throw "Cannot infer an AppGen eval set for PromptId '$ResolvedPromptId'. Pass EvalSet explicitly."
}

function Test-CdpEndpoint {
    param([int]$Port)

    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:$Port/json/version" `
            -Method Get `
            -TimeoutSec 2 `
            -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Stop-ProcessTree {
    param([int]$RootProcessId)

    $processes = @(Get-CimInstance Win32_Process)
    $childrenByParent = @{}
    foreach ($process in $processes) {
        $parentId = [int]$process.ParentProcessId
        if (-not $childrenByParent.ContainsKey($parentId)) {
            $childrenByParent[$parentId] = [System.Collections.Generic.List[int]]::new()
        }
        $childrenByParent[$parentId].Add([int]$process.ProcessId)
    }

    $pending = [System.Collections.Generic.Stack[int]]::new()
    $ordered = [System.Collections.Generic.List[int]]::new()
    $pending.Push($RootProcessId)
    while ($pending.Count -gt 0) {
        $processId = $pending.Pop()
        $ordered.Add($processId)
        if ($childrenByParent.ContainsKey($processId)) {
            foreach ($childId in $childrenByParent[$processId]) {
                $pending.Push($childId)
            }
        }
    }

    for ($index = $ordered.Count - 1; $index -ge 0; $index--) {
        Stop-Process -Id $ordered[$index] -ErrorAction SilentlyContinue
    }
}

function ConvertTo-ProcessArgument {
    param([object]$Value)

    $text = [string]$Value
    return '"' + $text.Replace('"', '\"') + '"'
}

function ConvertTo-PowerShellLiteral {
    param([object]$Value)

    $text = [string]$Value
    return "'" + $text.Replace("'", "''") + "'"
}

function ConvertTo-PpevalRelativePath {
    param(
        [string]$Root,
        [string]$Path
    )

    $relative = [IO.Path]::GetRelativePath($Root, [IO.Path]::GetFullPath($Path))
    if ($relative -eq ".." -or $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)")) {
        throw "ppeval paths must remain under its repository root: $Path"
    }
    return $relative.Replace([IO.Path]::DirectorySeparatorChar, "/")
}

if ([string]::IsNullOrWhiteSpace($AppUrl)) {
    throw "AppUrl is required."
}
if ([string]::IsNullOrWhiteSpace($PpevalRepoPath)) {
    throw "PpevalRepoPath is required. Pass it explicitly or set POWER_PLATFORM_EVALS_REPO."
}
if ([string]::IsNullOrWhiteSpace($PromptId)) {
    throw "PromptId is required so ppeval can select the governed AppGen scenarios."
}
if ($PromptId -notmatch "^[A-Za-z0-9_-]+$") {
    throw "PromptId may contain only letters, numbers, underscores, and hyphens."
}
if ($SessionConcurrency -ne 1) {
    throw "SessionConcurrency must be 1 because this runner prepares exactly one CDP browser session."
}

$parsedAppUrl = $null
if (-not [Uri]::TryCreate($AppUrl, [UriKind]::Absolute, [ref]$parsedAppUrl) -or
    $parsedAppUrl.Scheme -ne "https") {
    throw "AppUrl must be an absolute HTTPS URL."
}

$resolvedRepoPath = (Resolve-Path -LiteralPath $PpevalRepoPath).Path
$integrationManifest = Join-Path $resolvedRepoPath "src/ppeval/integrations/appgen/integration.toml"
if (-not (Test-Path -LiteralPath $integrationManifest)) {
    throw "Expected the AppGen integration under ppeval repo path: $resolvedRepoPath"
}
if ([string]::IsNullOrWhiteSpace($env:FOUNDRY_EVAL_ENDPOINT)) {
    throw "FOUNDRY_EVAL_ENDPOINT is required by the native AppGen evaluator."
}
if ($PublishToKusto.IsPresent -and
    [string]::IsNullOrWhiteSpace($env:PPEVAL_APPGEN_ONEDS_INSTRUMENTATION_KEY)) {
    throw "PPEVAL_APPGEN_ONEDS_INSTRUMENTATION_KEY is required when PublishToKusto is enabled."
}

$appUrlDetails = Get-CanvasAppUrlDetails -Uri $parsedAppUrl
$resolvedEvalSet = Resolve-AppGenEvalSet `
    -ResolvedPromptId $PromptId `
    -ExplicitEvalSet $EvalSet

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    # ppeval records all command paths relative to its stated repository root, so the retained
    # artifact bundle must live under that root rather than beside the installed plugin.
    $OutputRoot = Join-Path $resolvedRepoPath "out/functional-eval"
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if ([string]::IsNullOrWhiteSpace($BrowserUserDataDir)) {
    $BrowserUserDataDir = Join-Path $resolvedRepoPath ".auth/browser-use-profile"
}

$timestamp = Get-Date -Format "yyyyMMddTHHmmss"
$artifactDir = Join-Path $OutputRoot $timestamp
$diagnosticsDir = Join-Path $artifactDir "diagnostics"
$outputDir = Join-Path $artifactDir "output"
$storeRoot = Join-Path $artifactDir "store"
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) "ppeval-appgen-staging/$timestamp"
$batchPath = Join-Path $artifactDir "single-app-batch.json"
$logPath = Join-Path $artifactDir "functional-eval.log"
$summaryPath = Join-Path $artifactDir "summary.json"
$readmePath = Join-Path $artifactDir "README.md"
$commandPath = Join-Path $artifactDir "command.txt"
$studioLogPath = Join-Path $artifactDir "canvas-studio.log"
$studioErrorPath = Join-Path $artifactDir "canvas-studio-error.log"
$publishLogPath = Join-Path $artifactDir "publish-report.log"
$telemetryStatusPath = Join-Path $artifactDir "telemetry-status.json"
New-Item -ItemType Directory -Path $diagnosticsDir, $outputDir, $storeRoot, $stagingRoot -Force |
    Out-Null
New-Item -ItemType Directory -Path $BrowserUserDataDir -Force | Out-Null

$batch = [ordered]@{
    identity = [ordered]@{
        source_system = "canvas_url"
        app_format_mode = "node"
        model = $null
        source_config = [ordered]@{
            scenario_runner = [ordered]@{
                agent_model = $EvalModel
                judge_model = $EvalModel
            }
            visual_quality = [ordered]@{
                model = $EvalModel
            }
        }
    }
    eval_pipeline = @("scenario_runner_eval")
    apps = @(
        [ordered]@{
            # The worker treats this host as its CDP ownership boundary. The prepared target is
            # Canvas Studio on the maker host even when the caller supplied a published player URL.
            app_url = $appUrlDetails.maker_base_url
            app_id = $appUrlDetails.app_id
            prompt_id = $PromptId
        }
    )
}
$batch | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath $batchPath -Encoding utf8

$branch = "unknown"
try {
    $branch = (git -C $resolvedRepoPath rev-parse --abbrev-ref HEAD).Trim()
} catch {
    $branch = "unknown"
}

$command = @(
    "uv", "run", "--project", $resolvedRepoPath, "--extra", "appgen",
    "ppeval", "run",
    "--integration", "appgen:integration:central-native",
    "--suite", "appgen",
    "--eval-set", $resolvedEvalSet,
    "--batch", (ConvertTo-PpevalRelativePath -Root $resolvedRepoPath -Path $batchPath),
    "--concurrency", $Concurrency,
    "--session-concurrency", $SessionConcurrency,
    "--staging-root", $stagingRoot,
    "--store-root", (ConvertTo-PpevalRelativePath -Root $resolvedRepoPath -Path $storeRoot),
    "--output-dir", (ConvertTo-PpevalRelativePath -Root $resolvedRepoPath -Path $outputDir),
    "--output", "json"
)
$commandDisplay = "& " + (($command | ForEach-Object { ConvertTo-PowerShellLiteral $_ }) -join " ")
Set-Content -LiteralPath $commandPath -Value $commandDisplay -NoNewline -Encoding utf8

$studioArgs = @(
    "run", "--project", $resolvedRepoPath, "--extra", "appgen",
    "python", "-u", "-m", "pipelines.appgen.scripts.canvas_studio",
    "--environment-id", $appUrlDetails.environment_id,
    "--maker-base-url", $appUrlDetails.maker_base_url,
    "--action", "edit",
    "--app-id", $appUrlDetails.app_id,
    "--user-data-dir", $BrowserUserDataDir,
    "--channel", $BrowserChannel,
    "--keep-open",
    "--remote-debugging-port", $CdpPort,
    "--load-timeout-ms", ($BrowserStartupTimeoutSeconds * 1000),
    "--welcome-timeout-ms", ($BrowserStartupTimeoutSeconds * 1000)
)
if (-not [string]::IsNullOrWhiteSpace($LoginHint)) {
    $studioArgs += @("--login-hint", $LoginHint)
}

$startedAt = (Get-Date).ToString("o")
$exitCode = 1
$publishExitCode = $null
$failureReason = $null
$runId = $null
$reportPath = $null
$reportDataPath = $null
$runPath = $null
$studioProcess = $null
$originalCdpUrls = $env:APP_STUDIO_EVALS_BROWSER_USE_CDP_URLS
$originalTargetIds = $env:APP_STUDIO_EVALS_BROWSER_TARGET_IDS
$originalAzureTokenCredentials = $env:AZURE_TOKEN_CREDENTIALS
$originalPromptId = $env:PROMPT_ID
$originalPythonDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE = "1"

try {
    if (Test-CdpEndpoint -Port $CdpPort) {
        throw "CDP port $CdpPort is already in use. Close the prior evaluation browser or choose another CdpPort."
    }

    $studioProcess = Start-Process `
        -FilePath "uv" `
        -ArgumentList ($studioArgs | ForEach-Object { ConvertTo-ProcessArgument $_ }) `
        -WorkingDirectory $resolvedRepoPath `
        -PassThru `
        -RedirectStandardOutput $studioLogPath `
        -RedirectStandardError $studioErrorPath

    $deadline = (Get-Date).AddSeconds($BrowserStartupTimeoutSeconds)
    do {
        if ($studioProcess.HasExited) {
            $studioError = if (Test-Path -LiteralPath $studioErrorPath) {
                Get-Content -LiteralPath $studioErrorPath -Raw
            } else {
                ""
            }
            throw "Canvas Studio exited before exposing CDP. $studioError"
        }
        if (Test-CdpEndpoint -Port $CdpPort) {
            break
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    if (-not (Test-CdpEndpoint -Port $CdpPort)) {
        throw "Timed out waiting for Canvas Studio CDP readiness."
    }

    do {
        $targets = @(
            Invoke-RestMethod `
                -Uri "http://127.0.0.1:$CdpPort/json/list" `
                -Method Get `
                -TimeoutSec 5 `
                -ErrorAction Stop
        )
        $canvasTargets = @(
            $targets | Where-Object {
                $_.url -is [string] -and
                $_.url.IndexOf("/canvas", [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
        )
        if ($canvasTargets.Count -gt 0) {
            break
        }
        if ($studioProcess.HasExited) {
            throw "Canvas Studio exited before exposing its Canvas page."
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    if ($canvasTargets.Count -eq 0) {
        throw "Timed out waiting for the Canvas Studio CDP target."
    }

    Push-Location $resolvedRepoPath
    try {
        $prepareOutput = & uv run --project $resolvedRepoPath --extra appgen `
            python -m pipelines.appgen.scripts.prepare_cdp_session `
            --endpoint "http://127.0.0.1:$CdpPort" `
            --diagnostics-dir $diagnosticsDir `
            --timeout-seconds $BrowserStartupTimeoutSeconds 2>&1
        $prepareExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $prepareOutput | Tee-Object -FilePath $logPath
    if ($prepareExitCode -ne 0) {
        throw "Canvas preview preparation failed with exit code $prepareExitCode."
    }

    $targetMatch = [regex]::Match(
        ($prepareOutput -join [Environment]::NewLine),
        "CdpTargetIds;issecret=true\](?<id>[^\r\n]+)"
    )
    if (-not $targetMatch.Success) {
        throw "Canvas preview preparation did not return a CDP target id."
    }

    $env:APP_STUDIO_EVALS_BROWSER_USE_CDP_URLS = "http://127.0.0.1:$CdpPort"
    $env:APP_STUDIO_EVALS_BROWSER_TARGET_IDS = $targetMatch.Groups["id"].Value.Trim()
    $env:AZURE_TOKEN_CREDENTIALS = "AzureCliCredential"

    $oneDsInstrumentationKey = $env:PPEVAL_APPGEN_ONEDS_INSTRUMENTATION_KEY
    Remove-Item Env:PPEVAL_APPGEN_ONEDS_INSTRUMENTATION_KEY -ErrorAction SilentlyContinue
    Push-Location $resolvedRepoPath
    try {
        $commandExe = $command[0]
        $commandArgs = $command[1..($command.Count - 1)]
        & $commandExe @commandArgs 2>&1 |
            Tee-Object -FilePath $logPath -Append
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $env:PPEVAL_APPGEN_ONEDS_INSTRUMENTATION_KEY = $oneDsInstrumentationKey
    }

    $reports = @(Get-ChildItem -LiteralPath $outputDir -Filter "report-data.json" -Recurse)
    if ($reports.Count -eq 1) {
        $reportDataPath = $reports[0].FullName
        $runPath = $reports[0].Directory.FullName
        $candidateReport = Join-Path $runPath "report.html"
        if (Test-Path -LiteralPath $candidateReport) {
            $reportPath = $candidateReport
        }
        $reportData = Get-Content -LiteralPath $reportDataPath -Raw | ConvertFrom-Json
        $runId = $reportData.run.run_id
    } elseif ($reports.Count -gt 1) {
        throw "ppeval produced more than one report-data.json under $outputDir."
    }

    if ($PublishToKusto.IsPresent) {
        if (-not $reportDataPath) {
            $publishExitCode = 1
            "Cannot publish to Kusto because report-data.json was not produced." |
                Set-Content -LiteralPath $publishLogPath -Encoding utf8
        } else {
            if ([string]::IsNullOrWhiteSpace($BuildNumber)) {
                $BuildNumber = $runId
            }
            $env:PROMPT_ID = $PromptId
            $productSummaryPath = Join-Path $runPath "summary.json"
            if (-not (Test-Path -LiteralPath $productSummaryPath)) {
                $publishExitCode = 1
                '{"reason":"incomplete_product_projection","status":"skipped"}' |
                    Set-Content -LiteralPath $telemetryStatusPath -Encoding utf8
                "Cannot publish to Kusto because the Product projection is incomplete." |
                    Set-Content -LiteralPath $publishLogPath -Encoding utf8
            } else {
                Push-Location $resolvedRepoPath
                try {
                    & uv run --project $resolvedRepoPath --extra appgen `
                        python -m pipelines.appgen.scripts.publish_report `
                        --report-data $reportDataPath `
                        --environment $PublishEnvironment `
                        --build-number $BuildNumber `
                        --status-file $telemetryStatusPath 2>&1 |
                        Tee-Object -FilePath $publishLogPath
                    $publishExitCode = $LASTEXITCODE
                } finally {
                    Pop-Location
                }
            }
        }
    }
} catch {
    $failureReason = $_.Exception.Message
    $exitCode = 5
    "ERROR: $failureReason" | Tee-Object -FilePath $logPath -Append
} finally {
    if ($studioProcess -and -not $studioProcess.HasExited) {
        Stop-ProcessTree -RootProcessId $studioProcess.Id
    }
    if ($null -eq $originalCdpUrls) {
        Remove-Item Env:APP_STUDIO_EVALS_BROWSER_USE_CDP_URLS -ErrorAction SilentlyContinue
    } else {
        $env:APP_STUDIO_EVALS_BROWSER_USE_CDP_URLS = $originalCdpUrls
    }
    if ($null -eq $originalTargetIds) {
        Remove-Item Env:APP_STUDIO_EVALS_BROWSER_TARGET_IDS -ErrorAction SilentlyContinue
    } else {
        $env:APP_STUDIO_EVALS_BROWSER_TARGET_IDS = $originalTargetIds
    }
    if ($null -eq $originalAzureTokenCredentials) {
        Remove-Item Env:AZURE_TOKEN_CREDENTIALS -ErrorAction SilentlyContinue
    } else {
        $env:AZURE_TOKEN_CREDENTIALS = $originalAzureTokenCredentials
    }
    if ($null -eq $originalPromptId) {
        Remove-Item Env:PROMPT_ID -ErrorAction SilentlyContinue
    } else {
        $env:PROMPT_ID = $originalPromptId
    }
    if ($null -eq $originalPythonDontWriteBytecode) {
        Remove-Item Env:PYTHONDONTWRITEBYTECODE -ErrorAction SilentlyContinue
    } else {
        $env:PYTHONDONTWRITEBYTECODE = $originalPythonDontWriteBytecode
    }
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}

$endedAt = (Get-Date).ToString("o")
$finalExitCode = if ($exitCode -ne 0) {
    $exitCode
} elseif ($publishExitCode -ne $null -and $publishExitCode -ne 0) {
    $publishExitCode
} else {
    0
}

$summary = [ordered]@{
    branch = $branch
    ppeval_repo_path = $resolvedRepoPath
    batch_path = $batchPath
    app_url = $AppUrl
    player_url = $appUrlDetails.player_url
    app_id = $appUrlDetails.app_id
    environment_id = $appUrlDetails.environment_id
    prompt_id = $PromptId
    eval_set = $resolvedEvalSet
    command = $commandDisplay
    started_at = $startedAt
    ended_at = $endedAt
    eval_exit_code = $exitCode
    publish_exit_code = $publishExitCode
    exit_code = $finalExitCode
    failure_reason = $failureReason
    run_id = $runId
    run_path = $runPath
    report_path = $reportPath
    report_data_path = $reportDataPath
    kusto_publish_log = $(if ($PublishToKusto.IsPresent) { $publishLogPath } else { $null })
    artifact_path = $artifactDir
    log_file = $logPath
    command_file = $commandPath
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8

$readme = @"
# Functional Eval Artifact

- branch: $branch
- repo: $resolvedRepoPath
- batch: $batchPath
- app_url: $AppUrl
- player_url: $($appUrlDetails.player_url)
- app_id: $($appUrlDetails.app_id)
- environment_id: $($appUrlDetails.environment_id)
- prompt_id: $PromptId
- eval_set: $resolvedEvalSet
- command: $commandDisplay
- started_at: $startedAt
- ended_at: $endedAt
- eval_exit_code: $exitCode
- publish_exit_code: $publishExitCode
- exit_code: $finalExitCode
- run_id: $runId
- run_path: $runPath
- report_path: $reportPath
- report_data_path: $reportDataPath

## Files

- summary.json: machine-readable run metadata
- functional-eval.log: preview preparation and ppeval output
- canvas-studio.log: Canvas Studio session output
- canvas-studio-error.log: Canvas Studio session errors
- command.txt: exact ppeval command
- single-app-batch.json: generated native AppGen batch
- output: ppeval Product report view
- store: canonical ppeval evidence
- publish-report.log: OneDS/Kusto publication output when requested
- telemetry-status.json: OneDS publication disposition when requested
"@
Set-Content -LiteralPath $readmePath -Value $readme -Encoding utf8

Write-Host "ARTIFACT_PATH=$artifactDir"
Write-Host "SUMMARY_FILE=$summaryPath"
Write-Host "LOG_FILE=$logPath"
if ($runId) { Write-Host "RUN_ID=$runId" }
if ($reportPath) { Write-Host "REPORT_PATH=$reportPath" }
if ($reportDataPath) { Write-Host "REPORT_DATA_PATH=$reportDataPath" }
if ($PublishToKusto.IsPresent) {
    Write-Host "KUSTO_PUBLISH_EXIT_CODE=$publishExitCode"
    Write-Host "KUSTO_PUBLISH_LOG=$publishLogPath"
}

exit $finalExitCode

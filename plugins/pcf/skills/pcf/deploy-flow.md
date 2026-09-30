# /pcf deploy flow

Deployment writes to an environment. Obtain explicit consent before the write: environment origin, solution unique name or publisher prefix, and acknowledgement that `pac pcf push` publishes all pending customizations. PCF packaging and Dataverse solution ALM are documented by Microsoft Learn at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/import-custom-controls and https://learn.microsoft.com/en-us/power-platform/alm/.

## Push for development verification

Preconditions:

- `pcf-gates.js` is green for the target hosts.
- Auth passed with `check-auth.js --env <envUrl> --require-pac`.
- The target is safe to write.
- Consent is recorded.

Run:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-push.js" --project <dir> --env <url> (--solution <uniqueName> | --publisher-prefix <p>) [--incremental] [--verbosity minimal|normal|detailed|diagnostic] [--allow-dev-bundle] [--no-verify]
```

Hints:

- Prefer `--solution` for repeatable ALM. Use `--publisher-prefix` only when intentionally registering outside a known solution.
- Omit `--allow-dev-bundle` unless diagnosing a local-only development build.
- Omit `--no-verify` unless another verification step immediately follows.

## Import succeeded but old version runs

If push/import succeeds but the old bundle still loads, check manifest version, solution version, publish state and browser cache. Bump the manifest `version` before each deploy; release packages also bump the solution `a.b.c.d` version. Publish the form/app customizations and hard refresh the browser. Same-version byte refresh was inconclusive in this release, so do not rely on it.

## Release packaging

Use development push for rapid validation; use a managed solution package for release.

Component-only package:

```powershell
pac solution init --publisher-name <PublisherName> --publisher-prefix <prefix>
pac solution add-reference --path <pcf-project-dir>
dotnet build -c Release -p:SolutionPackageType=Managed
```

Component plus bindings: add forms/views/apps that carry the bindings to the same solution before export/import. A component-only solution registers the control but does not place it on forms or Pages.

## Pipeline examples

The full example pipelines live in:

- [`../../pipelines/github-actions.yml`](../../pipelines/github-actions.yml)
- [`../../pipelines/azure-devops.yml`](../../pipelines/azure-devops.yml)

Do not duplicate those files in this flow. Use them as adaptable examples with these stages:

1. Install Power Platform tooling first (`microsoft/powerplatform-actions/actions-install@v1` in GitHub Actions or `PowerPlatformToolInstaller@2` in Azure DevOps).
2. Build the PCF project.
3. Run tests/gates.
4. Pack the managed solution.
5. Publish the solution artifact.
6. Import the artifact into the target environment.

Short excerpt only:

```yaml
# GitHub Actions: install tools before build/test/pack/import.
- uses: microsoft/powerplatform-actions/actions-install@v1
```

```yaml
# Azure DevOps: install tools before build/test/pack/import.
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.tool-installer.PowerPlatformToolInstaller@2
```

Microsoft documents Power Platform GitHub Actions at https://learn.microsoft.com/en-us/power-platform/alm/devops-github-actions and Power Platform Build Tools at https://learn.microsoft.com/en-us/power-platform/alm/devops-build-tools. The import stage needs the user's own service connection or credentials stored in the pipeline's secret store; never commit credentials or tenant-specific values in the pipeline YAML.

## After deploy

Run `verify-pcf.js` from `bind-flow.md` or the intent form. Record the highest evidence level reached and say `runtime-not-checked` if no browser/site journey was observed.

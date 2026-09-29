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

## GitHub Actions example to adapt

Microsoft documents Power Platform GitHub Actions and available solution actions at https://learn.microsoft.com/en-us/power-platform/alm/devops-github-actions and https://learn.microsoft.com/en-us/power-platform/alm/devops-github-available-actions. Store secrets in GitHub encrypted secrets, not in YAML.

```yaml
name: pcf-solution
on: [workflow_dispatch]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Power Platform tools
        uses: microsoft/powerplatform-actions/actions-install@v1
      - name: Build managed solution
        shell: pwsh
        run: |
          pac solution init --publisher-name Contoso --publisher-prefix contoso
          pac solution add-reference --path .\controls\StarRating
          dotnet build -c Release -p:SolutionPackageType=Managed
      - name: Import managed solution
        uses: microsoft/powerplatform-actions/import-solution@v1
        with:
          environment-url: ${{ secrets.DATAVERSE_URL }}
          app-id: ${{ secrets.POWERPLATFORM_APP_ID }}
          client-secret: ${{ secrets.POWERPLATFORM_CLIENT_SECRET }}
          tenant-id: ${{ secrets.POWERPLATFORM_TENANT_ID }}
          solution-file: bin\Release\Contoso.zip
      - name: Publish customizations
        uses: microsoft/powerplatform-actions/publish-solution@v1
        with:
          environment-url: ${{ secrets.DATAVERSE_URL }}
          app-id: ${{ secrets.POWERPLATFORM_APP_ID }}
          client-secret: ${{ secrets.POWERPLATFORM_CLIENT_SECRET }}
          tenant-id: ${{ secrets.POWERPLATFORM_TENANT_ID }}
```

## Azure DevOps example to adapt

Microsoft documents Power Platform Build Tools and task names at https://learn.microsoft.com/en-us/power-platform/alm/devops-build-tools and https://learn.microsoft.com/en-us/power-platform/alm/devops-build-tool-tasks. Store credentials in Azure DevOps service connections or secret variables.

```yaml
trigger: none
pool:
  vmImage: windows-latest
steps:
- checkout: self
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.tool-installer.PowerPlatformToolInstaller@2
  displayName: Power Platform Tool Installer
  inputs:
    AddToolsToPath: true
- pwsh: |
    pac solution init --publisher-name Contoso --publisher-prefix contoso
    pac solution add-reference --path .\controls\StarRating
    dotnet build -c Release -p:SolutionPackageType=Managed
  displayName: Build managed solution
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.import-solution.PowerPlatformImportSolution@2
  displayName: Import managed solution
  inputs:
    authenticationType: PowerPlatformSPN
    PowerPlatformSPN: Dataverse service connection
    SolutionInputFile: $(Build.SourcesDirectory)\bin\Release\Contoso.zip
    AsyncOperation: true
    PublishWorkflows: false
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.publish-customizations.PowerPlatformPublishCustomizations@2
  displayName: Publish customizations
  inputs:
    authenticationType: PowerPlatformSPN
    PowerPlatformSPN: Dataverse service connection
```

## After deploy

Run `verify-pcf.js` from `bind-flow.md` or the intent form. Record the highest evidence level reached and say `runtime-not-checked` if no browser/site journey was observed.

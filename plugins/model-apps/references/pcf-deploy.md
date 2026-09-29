# PCF deployment reference

Use this reference with `/pcf` deploy flow. Microsoft Learn covers PCF import and solution ALM at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/import-custom-controls and https://learn.microsoft.com/en-us/power-platform/alm/.

## Push vs release package

| Path | Use for | Writes | Notes |
| --- | --- | --- | --- |
| `pcf-push.js` | Developer verification in a safe environment | Registers the control and publishes all pending customizations | Requires consent for env origin, solution/prefix and publish-all side effect. |
| Managed solution package | Test/prod release | Imports the solution package | Use pipeline secrets/service connections and explicit solution versions. |

Development push:

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-push.js" --project <dir> --env <url> (--solution <uniqueName> | --publisher-prefix <p>) [--incremental] [--verbosity minimal|normal|detailed|diagnostic] [--allow-dev-bundle] [--no-verify]
```

`pcf-push.js` wraps `pac pcf push --environment`; the skill obtains consent because `pac pcf push` publishes all pending customizations in the environment.

## Versions and cache busting

- PCF manifest versions are `x.y.z` and identify the control bundle.
- Solution versions are `a.b.c.d` and identify the package.
- Bump the manifest before each deploy and bump the solution before release import.
- If old code still runs: publish the target form/app, verify the registered and bound versions, hard refresh the browser, and confirm the user is on the intended form/app.

## Managed vs unmanaged

Use unmanaged solutions in development and managed packages for downstream release. Do not directly edit managed controls/forms in target environments; update the source solution and import a new managed version.

## Publisher prefix consistency

The registered control name includes publisher prefix plus namespace and constructor. Use a consistent solution publisher across environments. Changing prefixes creates a distinct control and existing bindings will not automatically follow it.

## Packaging commands

```powershell
pac solution init --publisher-name <PublisherName> --publisher-prefix <prefix>
pac solution add-reference --path <pcf-project-dir>
dotnet build -c Release -p:SolutionPackageType=Managed
```

For component-only packages, only the control travels. For component plus bindings, include the forms/views/apps that own the bindings in the solution. Microsoft Learn solution ALM guidance applies: https://learn.microsoft.com/en-us/power-platform/alm/solution-concepts-alm.

## GitHub Actions example

Power Platform GitHub Actions are documented at https://learn.microsoft.com/en-us/power-platform/alm/devops-github-actions and the available actions at https://learn.microsoft.com/en-us/power-platform/alm/devops-github-available-actions. Adapt this example and keep secrets in GitHub encrypted secrets.

```yaml
name: deploy-pcf-solution
on: [workflow_dispatch]
jobs:
  deploy:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: microsoft/powerplatform-actions/actions-install@v1
      - name: Build solution
        shell: pwsh
        run: |
          pac solution init --publisher-name Contoso --publisher-prefix contoso
          pac solution add-reference --path .\pcf\StarRating
          dotnet build -c Release -p:SolutionPackageType=Managed
      - uses: microsoft/powerplatform-actions/import-solution@v1
        with:
          environment-url: ${{ secrets.DATAVERSE_URL }}
          app-id: ${{ secrets.POWERPLATFORM_APP_ID }}
          client-secret: ${{ secrets.POWERPLATFORM_CLIENT_SECRET }}
          tenant-id: ${{ secrets.POWERPLATFORM_TENANT_ID }}
          solution-file: bin\Release\Contoso.zip
      - uses: microsoft/powerplatform-actions/publish-solution@v1
        with:
          environment-url: ${{ secrets.DATAVERSE_URL }}
          app-id: ${{ secrets.POWERPLATFORM_APP_ID }}
          client-secret: ${{ secrets.POWERPLATFORM_CLIENT_SECRET }}
          tenant-id: ${{ secrets.POWERPLATFORM_TENANT_ID }}
```

## Azure DevOps example

Power Platform Build Tools are documented at https://learn.microsoft.com/en-us/power-platform/alm/devops-build-tools and task names at https://learn.microsoft.com/en-us/power-platform/alm/devops-build-tool-tasks. Adapt this example and keep credentials in service connections or secret variables.

```yaml
pool:
  vmImage: windows-latest
steps:
- checkout: self
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.tool-installer.PowerPlatformToolInstaller@2
  inputs:
    AddToolsToPath: true
- pwsh: |
    pac solution init --publisher-name Contoso --publisher-prefix contoso
    pac solution add-reference --path .\pcf\StarRating
    dotnet build -c Release -p:SolutionPackageType=Managed
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.import-solution.PowerPlatformImportSolution@2
  inputs:
    authenticationType: PowerPlatformSPN
    PowerPlatformSPN: Dataverse service connection
    SolutionInputFile: $(Build.SourcesDirectory)\bin\Release\Contoso.zip
    AsyncOperation: true
- task: microsoft-IsvExpTools.PowerPlatform-BuildTools.publish-customizations.PowerPlatformPublishCustomizations@2
  inputs:
    authenticationType: PowerPlatformSPN
    PowerPlatformSPN: Dataverse service connection
```

## Verification after release

Run `verify-pcf.js`, then browser smoke where possible. Inventory where-used output is registered solution dependencies only — not proof of Liquid or text references; an empty result is not "safe to delete".

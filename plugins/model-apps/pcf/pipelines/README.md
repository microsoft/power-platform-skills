# PCF pipeline examples

These examples show one way to adapt a generated `/model-apps:pcf` control to CI/CD. Copy the file that matches your CI system into your own repository and adjust paths, solution names, publisher details, and artifact names.

## GitHub Actions

`github-actions.yml` uses the public GitHub Actions for Microsoft Power Platform. Store environment details in repository variables and credentials in GitHub Secrets. The import step is gated to `workflow_dispatch` and expects a Dataverse URL such as `https://contoso.crm.dynamics.com` plus service-principal secrets.

## Azure DevOps

`azure-devops.yml` uses Microsoft Power Platform Build Tools v2. Create a Power Platform service connection in the project, then replace `Dataverse service connection` with that connection name before enabling import.

Both examples keep build, test, managed solution packaging, artifact publishing, and import as distinct steps so you can remove or secure the import stage without changing the build verification. Never put tenant, application, or secret values inline; use your pipeline secret store or service connection.

---
title: Plan and deploy ALM for Power Pages SPA code sites
description: Learn how to close the ALM loop for Power Pages SPA code sites by combining PAC CLI code-site download and upload commands with Dataverse solutions and Power Platform Pipelines.
author: microsoft
date: 08/14/2026
ms.topic: how-to
ms.custom: template-how-to
ms.author: <author-alias>
ms.reviewer: <reviewer-alias>
---

# Plan and deploy ALM for Power Pages SPA code sites

> [!NOTE]
> This article is a draft for review. Do not publish until product, engineering, and documentation review are complete.

Power Pages code sites let makers build static single-page applications (SPAs) with frameworks such as React, Angular, Vue, and Astro, and host them in Power Pages. Application lifecycle management (ALM) for these sites requires two connected deployment paths:

- **The SPA source and compiled assets**, which are managed in source control and synchronized with Power Pages by using Power Platform CLI (PAC CLI) code-site commands.
- **The Power Platform configuration**, such as the website record, site settings, web files, web roles, table permissions, environment variables, cloud flows, connection references, and Dataverse tables, which are packaged and promoted through Dataverse solutions.

A complete ALM loop uses both paths. PAC CLI download and upload commands keep the local SPA project and development site synchronized. Dataverse solutions and Power Platform Pipelines promote the site configuration and dependencies through test, staging, and production.

## Supported site types

This guidance applies to Power Pages **code sites** built with static SPA frameworks.

| Framework | Typical build output |
| --- | --- |
| React with Vite | `dist` |
| Vue with Vite | `dist` |
| Angular | `dist/<site-name>/browser` |
| Astro | `dist` |

Server-rendered application frameworks, such as Next.js, Nuxt, Remix, and SvelteKit, are outside the scope of this draft.

## Prerequisites

Before you start, make sure you have:

- A Power Pages code-site project with a `powerpages.config.json` file.
- The site downloaded or deployed at least once so that `.powerpages-site` contains the Power Pages site identity.
- Power Platform CLI installed and authenticated to the development environment.
- Node.js and the package manager required by the SPA project.
- Azure CLI installed and signed in if your ALM process uses Azure resources, such as Key Vault for secret environment variables.
- Target Power Platform environments for test, staging, and production.
- A Dataverse solution strategy for the site and any related Dataverse tables, cloud flows, connection references, and environment variables.
- For Power Platform Pipelines, a pipeline host environment with the Pipelines package installed.

## ALM concepts for SPA code sites

A Power Pages SPA deployment has more than one artifact.

| Artifact | Source of truth | Deployment mechanism |
| --- | --- | --- |
| SPA source code | Source control | Pull request, branch, and build process |
| Compiled SPA assets | Local build output referenced by `powerpages.config.json` | `pac pages upload-code-site --rootPath "."` to the development site |
| Power Pages site metadata | Dataverse records in the development environment | Dataverse solution export/import or Power Platform Pipelines |
| Environment-specific values | Environment variables and deployment settings | Per-stage deployment settings in pipeline or import flow |
| Secrets | Approved secret store, such as Key Vault | Secret-type environment variable references |

The key ALM principle is: **build and upload the SPA to the development Power Pages site first, then solutionize the updated site so the solution carries the current site metadata and web file records forward.**

## Recommended end-to-end ALM loop

Use the following loop for each release:

1. **Download the current code site from development** when starting from an existing site or reconciling changes made outside source control.
1. **Develop and test the SPA locally**.
1. **Build the SPA** by using the framework's build command.
1. **Upload the compiled SPA to the development Power Pages site** with PAC CLI.
1. **Verify the development site** after upload.
1. **Create or update the Dataverse solution** so it includes the latest Power Pages site components and dependencies.
1. **Classify and configure environment-specific values** by using environment variables and deployment settings.
1. **Deploy the solution** to test, staging, and production by using Power Platform Pipelines or manual export/import.
1. **Activate and validate the target site**, including authentication, Web API calls, environment variables, cloud flows, and runtime browser checks.

This closes the ALM loop because the code-site upload updates the development site's Power Pages records, and the solution deployment promotes those updated records and dependencies to the target environments.

## Use PAC CLI to synchronize the code site

PAC CLI code-site commands are used for the development-site synchronization part of ALM. They do not replace solution deployment. They prepare and update the source environment so the solution contains the correct site state.

### Download a code site

Use the download command when you need to create or refresh the local project from a Power Pages code site in an environment.

```bash
pac pages download-code-site --path "." --webSiteId "<website-record-id>"
```

Use `pac pages download-code-site --help` to confirm the exact option names for your installed PAC CLI version.

The download command is useful when:

- A maker created or changed the site in Power Pages and you need to bring it into source control.
- You need to recover `powerpages.config.json` and `.powerpages-site` metadata for an existing code site.
- You want to compare the local project with the current development-site state before a release.

After download, commit the source project and configuration files that should be tracked. Do not commit generated secrets or environment-specific local files.

### Build the SPA

Before uploading, build the SPA. The PAC CLI upload reads the compiled output from the `compiledPath` configured in `powerpages.config.json`.

```bash
npm install
npm run build
```

Confirm that the build output folder exists and is not empty. Common build output folders include `dist`, `build`, and Angular's `dist/<site-name>/browser`.

### Upload the code site to development

Upload the compiled SPA to the development Power Pages site.

```bash
pac pages upload-code-site --rootPath "."
```

This command uploads the compiled site from the `compiledPath` defined in `powerpages.config.json`. Run the command from the project root that contains `powerpages.config.json`.

Use this command after each release-ready SPA build so the development site's Power Pages web file records represent the version you intend to promote.

> [!IMPORTANT]
> `pac pages upload-code-site` updates the code site in the environment you are connected to. Confirm the active PAC CLI environment before upload. Uploading to the wrong environment can overwrite the wrong development site.

## How PAC CLI upload and solution deployment work together

PAC CLI upload and Dataverse solution deployment serve different parts of the same ALM process.

1. The SPA build produces static files.
1. `pac pages upload-code-site --rootPath "."` uploads those files to the development Power Pages site.
1. Power Pages stores the uploaded content and site metadata as Dataverse records.
1. The ALM solution includes the website record, site language records, Power Pages components, site settings, web files, table permissions, tables, environment variable definitions, cloud flows, and connection references.
1. Exporting the solution or running a Power Platform Pipeline packages those Dataverse records into a deployment artifact.
1. Importing or deploying the solution installs those records into the target environment.
1. Target activation and post-deployment validation confirm the site is reachable and runtime dependencies are configured.

This sequence ensures the target environment receives the version of the site that was uploaded and validated in development, instead of an older site state that happened to be present when the solution was last assembled.

## Understand what belongs in the solution

For reliable deployment, include all Power Pages and Dataverse components that the site needs at runtime. At minimum, include:

- The website record.
- Site language records.
- Power Pages subcomponents, such as web pages, web files, web roles, site settings, content snippets, templates, table permissions, and publishing states.
- Environment variable definitions used by site settings or runtime configuration.
- Dataverse tables and columns used by the site's Web API calls.
- Cloud flows and their connection references, if the site calls flows.
- Related security roles, if applicable.

> [!IMPORTANT]
> Do not assume that adding the website record automatically adds every dependent Power Pages component. Validate that site languages, subcomponents, table permissions, environment variables, and connection references are included before exporting or deploying.

## Plan the promotion strategy

Document the source environment, target environments, solution name, and deployment path.

| Decision | Recommendation |
| --- | --- |
| Development environment | Use an unmanaged solution for active development. |
| Test, staging, and production | Use managed solutions unless you intentionally need target-side edits. |
| Environment-specific settings | Use environment variables or deployment settings instead of hard-coded site setting values. |
| Secret values | Use secret-type environment variables backed by Key Vault references or another approved secret-management pattern. |
| Large sites | Consider splitting the solution if the site has many web files, tables, flows, or environment variables. |
| Production deployment | Require an explicit approval before deployment. |

A plan should identify:

- The site name and source environment.
- The solution or solutions that carry the site.
- The PAC CLI profile and environment used for download and upload.
- The `compiledPath` in `powerpages.config.json`.
- Whether any live site components are missing from the solution.
- Which site settings are safe to keep as-is.
- Which authentication, identity-provider, API, or feature-flag settings should become environment variables.
- Whether target environments require different values.
- Whether deployments should use Power Platform Pipelines or manual export/import.

## Create or update the solution

Create a publisher and an unmanaged solution in the development environment, then add the site components to the solution.

When you update an existing site, re-check the live site inventory after uploading the latest SPA. Components can be added after the first solution setup, for example by enabling authentication, adding Web API table permissions, creating cloud flows, or adding environment variables. If those components are not added to the solution, the import can succeed while the site fails at runtime.

Recommended validation before export or deployment:

- Confirm the solution exists in the source environment.
- Confirm it is unmanaged in the source environment.
- Compare the live site inventory with the solution contents.
- Add missing Power Pages components, site languages, table permissions, tables, flows, environment variable definitions, and connection references.
- Increment the solution version before creating a deployment artifact.

## Classify site settings

Review site settings before packaging the site. Treat settings differently based on whether they are environment-specific or sensitive.

| Setting type | Recommended ALM handling |
| --- | --- |
| Regular presentation or feature settings | Keep in the solution as normal site settings when the same value is valid in every environment. |
| Authentication or identity-provider settings with environment-specific values | Link to string environment variables and provide values per target environment. |
| Credential-style settings, such as client secrets, passwords, API keys, and app keys | Link to secret environment variables and provide target values through an approved secret reference. |
| Authentication settings with no development value | Include the setting record and configure the value in each target environment after deployment. |

> [!WARNING]
> Do not ship development credentials, client secrets, passwords, API keys, or production-only values in a solution zip. Use environment variables and per-stage deployment settings for values that differ by environment.

## Use Power Platform Pipelines

Power Platform Pipelines is the recommended deployment path for governed promotion across environments.

### Set up the pipeline

A pipeline setup should:

1. Identify the source development environment.
1. Identify the pipeline host environment.
1. Register the source and target deployment environments.
1. Create the deployment pipeline.
1. Create stages for each target environment, such as Test, Staging, and Production.
1. Configure approvals for sensitive stages, especially Production.
1. Save pipeline metadata so future deployments can reuse the same pipeline and stages.

### Deploy through the pipeline

For each deployment:

1. Confirm the latest SPA was built and uploaded to the development site with `pac pages upload-code-site --rootPath "."`.
1. Confirm the solution was synchronized after that upload.
1. Select the target stage.
1. Validate the package.
1. Review warnings, missing dependencies, managed/unmanaged conflicts, connection reference issues, and environment variable gaps.
1. Provide deployment settings for the selected stage.
1. Confirm the final deployment action.
1. Start the deployment and monitor until it reaches a terminal state.
1. If the run waits for approval, approve it in Power Platform and continue monitoring.
1. Verify the target environment after deployment.

When deployment settings are needed, provide them as stage-specific values. Configure environment variable values and connection references for Staging separately from Production.

> [!IMPORTANT]
> Validate secret environment variable references before deployment. A malformed Key Vault reference can fail the import after the deployment has already waited in the pipeline queue.

## Manual export and import

Use manual export and import when you do not need a full pipeline or when you are preparing a one-time deployment.

### Export from development

Before export:

1. Confirm the latest SPA build was uploaded to the development site.
1. Confirm the solution contains the latest site components.
1. Resolve any missing dependencies.
1. Increment the solution version.
1. Choose the export type.

Use **managed** export for staging and production unless you have a specific reason to allow target-side customization. Use **unmanaged** export only for development-to-development moves or other advanced scenarios where target edits are expected.

### Import to a target environment

Before import:

1. Confirm the target environment.
1. Check whether the target already has the solution installed.
1. Compare the zip version with the installed target version.
1. Prefer staged import when you want to detect missing dependencies before committing the import.
1. Configure environment variable values and connection references.
1. Decide whether to overwrite unmanaged customizations.

After import:

- Confirm the expected solution version is installed.
- Review component-level warnings or failures.
- Set or verify environment variable values.
- Register cloud flows with the Power Pages site if required.
- Activate the site if it is not yet activated in the target environment.
- Test the site URL and key runtime paths.

## Versioning guidance

Use a four-part Dataverse solution version, such as `1.0.0.0`.

Recommended practices:

- Increment the version before every exported or pipeline-deployed artifact.
- Ensure the deployment artifact version is greater than the version already deployed to the target stage.
- Do not reuse the same version for different deployment artifacts.
- Record the version deployed to each environment.
- Record which source-control commit and SPA build were uploaded before the solution artifact was created.

Version accuracy is especially important for managed solutions because upgrades and rollback planning depend on consistent version history.

## Post-deployment validation

After deployment, validate the target site before considering the release complete.

Checklist:

- The solution is installed at the expected version.
- The Power Pages site is activated and has a reachable URL.
- The SPA loads without missing web files.
- Authentication and sign-in flows work in the target environment.
- Dataverse Web API calls succeed with the expected table permissions.
- Environment variable values are present and correct.
- Secret references resolve correctly.
- Cloud flows are registered with the site and can be invoked.
- Browser console and network traces do not show blocking runtime errors.

## Troubleshooting

| Symptom | Likely cause | Suggested action |
| --- | --- | --- |
| Upload reports no files or an empty upload | The SPA was not built, or `compiledPath` points to the wrong folder. | Run the build command and verify the compiled output path in `powerpages.config.json`. |
| Target site shows an older SPA | The solution was exported or deployed before the latest `pac pages upload-code-site` ran in development. | Rebuild, upload to development, sync the solution, increment the version, and redeploy. |
| Imported site does not render correctly | Site language records or Power Pages subcomponents are missing from the solution. | Re-sync solution contents from the source site and redeploy. |
| Web API calls return 404 | Required Dataverse tables or columns were not included in the solution. | Add table components and redeploy. |
| Web API calls return permission errors | Table permissions, web roles, or authentication settings are missing or incorrect. | Add or fix table permissions and verify web role assignment. |
| Pipeline validation reports missing dependencies | Connection references, flows, tables, or environment variables are missing. | Add missing dependencies to the solution or configure deployment settings. |
| Target uses development values | Site settings were shipped as plain values instead of environment-specific values. | Convert the setting to an environment variable and provide target values. |
| Secret environment variable deployment fails | The secret reference format is invalid or the target cannot resolve the secret. | Use a valid Key Vault secret identifier or approved resource ID format and verify access. |
| Cloud flows are present but not available to the site | Flows were imported but not registered with the target Power Pages site. | Register the flows in Power Pages Management after import. |

## Related documentation

- [Create a Power Pages code site](https://learn.microsoft.com/power-pages/configure/create-code-sites)
- [Power Platform CLI for Power Pages](https://learn.microsoft.com/power-platform/developer/cli/reference/pages)
- [Solution concepts for ALM](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm)
- [Pipelines in Power Platform](https://learn.microsoft.com/power-platform/alm/pipelines)
- [Environment variables overview](https://learn.microsoft.com/power-apps/maker/data-platform/environmentvariables)

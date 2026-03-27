# Troubleshooting Guide

Common errors and solutions for the Power Platform Pipelines plugin.

## Authentication Errors

### 401 Unauthorized
**Cause:** Azure CLI token is expired or invalid.
**Solution:**
1. Run `az login` to re-authenticate.
2. Verify the correct account is active: `az account show`.
3. Ensure the signed-in user has access to the Dataverse environment.

### 403 Forbidden
**Cause:** The authenticated user lacks required permissions.
**Solution:**
1. The user needs **System Administrator** or **Deployment Pipeline Administrator** security role on the pipeline host environment.
2. Check role assignment in the Power Platform Admin Center.
3. For delegated deployments, ensure the user also has permissions on the target environment.

### Token Acquisition Failed
**Cause:** Azure CLI is not installed or not authenticated.
**Solution:**
1. Install Azure CLI: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli
2. Run `az login` and sign in with your organizational account.
3. Verify: `az account get-access-token --resource "https://yourorg.crm.dynamics.com"`

## Environment Errors

### Environment Not Found
**Error:** `"The environment with ID '<guid>' was not found."`
**Cause:** The environment ID does not match any Power Platform environment.
**Solution:**
1. Run `pac env list` to see available environments.
2. Verify the environment GUID is correct (copy from Power Platform Admin Center).
3. Ensure the environment is not disabled or deleted.

### Environment Already Registered
**Error:** `"A deployment environment with this environment ID already exists."`
**Cause:** The environment has already been registered in the pipeline host.
**Solution:**
1. Query existing registrations:
   ```
   GET deploymentenvironments?$filter=environmentid eq '<guid>'
   ```
2. Use the existing registration ID instead of creating a new one.

### Environment URL Mismatch
**Error:** Scripts cannot determine the environment URL.
**Solution:**
1. Ensure `pac auth create --environment <url>` has been run.
2. Verify with `pac env who` — the Environment URL should be displayed.
3. Pass `--envUrl` explicitly to scripts if auto-detection fails.

## Pipeline Errors

### Pipeline Already Exists
**Error:** `"A record with the name '<name>' already exists."`
**Cause:** Pipeline names must be unique within the host environment.
**Solution:**
1. Choose a different pipeline name.
2. Or query existing pipelines: `GET deploymentpipelines?$filter=name eq '<name>'`

### Pipeline Not Found
**Error:** `"The deployment pipeline with ID '<guid>' was not found."`
**Solution:**
1. Run `/list-pipelines` to see available pipelines.
2. Verify the pipeline ID is correct.
3. Ensure the pipeline is active (statecode = 0).

## Deployment Errors

### Validation Errors
**Error:** `"Solution validation failed."` during `ValidatePackageAsync`.
**Cause:** The solution has issues that prevent deployment.
**Solution:**
1. Run Solution Checker on the solution in the development environment.
2. Check for missing dependencies in the solution.
3. Ensure all required environment variables have values in the target.
4. Verify all connection references are configured in the target.

### Missing Dependencies
**Error:** `"The following solution components are missing dependencies: ..."`
**Cause:** The target environment is missing components that the solution depends on.
**Solution:**
1. Deploy dependent solutions to the target environment first.
2. Check the solution's dependency list in the development environment.
3. Consider creating a solution layering strategy.

### Deployment Failed — Import Error
**Error:** Stage run status = `200000002` (Failed).
**Cause:** The managed solution import failed in the target environment.
**Solution:**
1. Check the stage run details for the specific error message.
2. Common causes:
   - Schema conflicts with existing customizations
   - Missing required components
   - Data type mismatches
   - Plugin registration conflicts
3. Review the import log in the target environment:
   - Settings → Solutions → Import History

### Deployment Timeout
**Error:** `"pollTimedOut": true` in check-deployment-status output.
**Cause:** The deployment took longer than the `--maxWait` period.
**Solution:**
1. The deployment may still be running. Check again with `/pipeline-status <stageRunId>`.
2. Large solutions or slow target environments can take 10+ minutes.
3. Increase `--maxWait` for large deployments.

## Environment Variable Issues

### Environment Variables Not Resolved
**Error:** Environment variables show default values instead of target-specific values.
**Cause:** Environment variable current values are not set in the target environment.
**Solution:**
1. Before deploying, ensure all environment variables have current values in the target environment.
2. Environment variable values are not carried over from the source — they must be configured per-environment.
3. Use the Power Platform Admin Center or Dataverse API to set values.

## Connection Reference Issues

### Connection References Not Configured
**Error:** Flows fail to activate after deployment because connection references are not bound.
**Cause:** Connection references in managed solutions need to be linked to connections in the target environment.
**Solution:**
1. Create the required connections in the target environment before deploying.
2. After deployment, bind connection references to the appropriate connections.
3. Consider using deployment settings files to automate this.

## Script Errors

### Script Exit Code 1
**Cause:** A script encountered a fatal error (no auth, invalid args, network failure).
**Solution:**
1. Check the JSON error message in stderr.
2. Verify all required arguments are provided.
3. Check network connectivity to the Dataverse environment.

### "Cannot find module" Error
**Cause:** Script is not run from the correct directory or `pipeline-helpers.js` is missing.
**Solution:**
1. Verify the plugin directory structure is intact.
2. Run scripts using the full path: `node "${CLAUDE_PLUGIN_ROOT}/scripts/<script>.js"`

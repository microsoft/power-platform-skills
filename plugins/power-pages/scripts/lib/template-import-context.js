'use strict';

const { getEnvironmentUrl, getAuthToken } = require('./validation-helpers');

function resolveTemplateImportContext(deps = {}) {
  const resolveEnv = deps.getEnvironmentUrl || getEnvironmentUrl;
  const resolveToken = deps.getAuthToken || getAuthToken;
  const environmentUrl = resolveEnv();
  if (!environmentUrl) {
    return { ok: false, error: 'PAC CLI is not authenticated to a Dataverse environment. Run `pac auth create --environment <url>` first.' };
  }
  const token = resolveToken(environmentUrl);
  if (!token) {
    return { ok: false, environmentUrl, error: 'Azure CLI token unavailable. Run `az login` first.' };
  }
  // Token availability is checked here, but the credential stays in-process.
  // Each authenticated helper reacquires it rather than exposing it in JSON,
  // shell history, process listings, or subagent prompts.
  return { ok: true, environmentUrl };
}

module.exports = { resolveTemplateImportContext };

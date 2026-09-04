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
  return { ok: true, environmentUrl, token };
}

module.exports = { resolveTemplateImportContext };

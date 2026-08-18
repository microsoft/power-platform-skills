'use strict';

const { CredentialError, getGoogleAccessToken } = require('./credentials');
const { sendFcm } = require('./fcm');
const { RequestError, loadPolicy, validateRequest } = require('./policy');

function json(status, body) {
  return {
    status,
    jsonBody: body,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
  };
}

function safeFailure(error) {
  if (error instanceof RequestError) {
    return json(400, {
      ok: false,
      error: { code: error.code, field: error.field },
    });
  }
  if (error instanceof CredentialError) {
    return json(502, {
      ok: false,
      error: { code: error.code },
    });
  }
  return json(500, {
    ok: false,
    error: { code: 'INTERNAL_ERROR' },
  });
}

async function handleSend(request, context, options = {}) {
  try {
    const input = await request.json();
    const policy = (options.loadPolicy || loadPolicy)(options.env || process.env);
    const validated = validateRequest(input, policy);
    const accessToken = await (options.getGoogleAccessToken || getGoogleAccessToken)({
      env: options.env || process.env,
      firebaseProjectId: policy.firebaseProjectId,
      dependencies: options.dependencies,
    });
    const result = await (options.sendFcm || sendFcm)({
      accessToken,
      firebaseProjectId: policy.firebaseProjectId,
      request: validated,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    });
    if (!result.ok) {
      const status = result.error.retryable ? 503 : 502;
      return json(status, { ok: false, error: result.error });
    }
    return json(200, {
      ok: true,
      validateOnly: validated.validateOnly,
      providerMessageId: result.providerMessageId,
    });
  } catch (error) {
    // Azure/App Service authentication rejects unauthorized callers before this
    // handler. Deliberately avoid context.log/error: exceptions may contain
    // Key Vault, Google, token, or HTTP details that must never reach logs.
    return safeFailure(error);
  }
}

module.exports = {
  handleSend,
  json,
  safeFailure,
};

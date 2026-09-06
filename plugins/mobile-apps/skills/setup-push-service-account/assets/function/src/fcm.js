'use strict';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_PROVIDER_ID = 500;

function buildFcmRequest(request) {
  return {
    message: {
      topic: request.topic,
      notification: {
        title: request.title,
        body: request.body,
      },
      data: {
        schemaVersion: request.schemaVersion,
        destination: request.destination,
        params: request.params,
      },
    },
    validate_only: request.validateOnly,
  };
}

function errorForStatus(status) {
  if (status === 400) return { code: 'FCM_INVALID_REQUEST', retryable: false };
  if (status === 401) return { code: 'GOOGLE_AUTH_FAILED', retryable: false };
  if (status === 403) return { code: 'FCM_FORBIDDEN', retryable: false };
  if (RETRYABLE_STATUS.has(status)) return { code: 'FCM_TRANSIENT', retryable: true };
  return { code: 'FCM_REQUEST_FAILED', retryable: false };
}

function safeProviderId(value) {
  if (typeof value !== 'string') return null;
  return value.slice(0, MAX_PROVIDER_ID).replace(/[^A-Za-z0-9_./:-]/g, '');
}

async function sendFcm({
  accessToken,
  fetchImpl = globalThis.fetch,
  firebaseProjectId,
  request,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/messages:send`;
  const body = JSON.stringify(buildFcmRequest(request));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        return { ok: false, error: { code: 'FCM_TRANSIENT', retryable: true } };
      }
      await sleep(100 * (2 ** (attempt - 1)));
      continue;
    }

    if (response.ok) {
      let parsed = {};
      try {
        parsed = await response.json();
      } catch {
        // FCM success bodies are JSON, but success does not depend on logging it.
      }
      return { ok: true, providerMessageId: safeProviderId(parsed.name) };
    }

    const mapped = errorForStatus(response.status);
    if (!mapped.retryable || attempt === MAX_ATTEMPTS) {
      return { ok: false, error: mapped };
    }
    await sleep(100 * (2 ** (attempt - 1)));
  }

  return { ok: false, error: { code: 'FCM_TRANSIENT', retryable: true } };
}

module.exports = {
  MAX_ATTEMPTS,
  buildFcmRequest,
  errorForStatus,
  safeProviderId,
  sendFcm,
};

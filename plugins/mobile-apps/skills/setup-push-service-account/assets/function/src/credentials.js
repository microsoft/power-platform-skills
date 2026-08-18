'use strict';

let cachedClient;
const KEY_VAULT_URL = /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/?$/i;
const SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;

class CredentialError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function validateServiceAccount(value, firebaseProjectId) {
  if (
    !value
    || value.type !== 'service_account'
    || value.project_id !== firebaseProjectId
    || typeof value.client_email !== 'string'
    || !value.client_email.endsWith('.iam.gserviceaccount.com')
    || typeof value.private_key !== 'string'
    || !value.private_key.includes('PRIVATE KEY')
  ) {
    throw new Error('Service-account secret does not match the configured Firebase project.');
  }
  return {
    email: value.client_email,
    key: value.private_key,
  };
}

async function getGoogleAccessToken({
  env = process.env,
  dependencies,
  firebaseProjectId,
}) {
  if (
    !KEY_VAULT_URL.test(env.KEY_VAULT_URL || '')
    || !SECRET_NAME.test(env.FIREBASE_SERVICE_ACCOUNT_SECRET_NAME || '')
  ) {
    throw new CredentialError('KEY_VAULT_CONFIGURATION_INVALID');
  }
  if (!cachedClient) {
    const { DefaultAzureCredential, SecretClient, JWT } = dependencies;
    let secret;
    try {
      const credential = new DefaultAzureCredential();
      const secretClient = new SecretClient(env.KEY_VAULT_URL, credential, {
        retryOptions: { maxRetries: 2 },
      });
      secret = await secretClient.getSecret(env.FIREBASE_SERVICE_ACCOUNT_SECRET_NAME);
    } catch {
      throw new CredentialError('KEY_VAULT_UNAVAILABLE');
    }
    try {
      const parsed = JSON.parse(secret.value);
      const account = validateServiceAccount(parsed, firebaseProjectId);
      cachedClient = new JWT({
        email: account.email,
        key: account.key,
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      });
    } catch {
      throw new CredentialError('FIREBASE_CREDENTIAL_INVALID');
    }
  }
  try {
    const result = await cachedClient.getAccessToken();
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('Missing access token.');
    return token;
  } catch {
    throw new CredentialError('GOOGLE_AUTH_FAILED');
  }
}

function resetCredentialCache() {
  cachedClient = undefined;
}

module.exports = {
  CredentialError,
  getGoogleAccessToken,
  resetCredentialCache,
  validateServiceAccount,
};

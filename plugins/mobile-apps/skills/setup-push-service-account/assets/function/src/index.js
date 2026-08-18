'use strict';

const { app } = require('@azure/functions');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const { JWT } = require('google-auth-library');
const { handleSend } = require('./handler');

app.http('sendFcm', {
  methods: ['POST'],
  // Easy Auth performs Entra authentication before the Node worker. Function
  // keys are intentionally disabled so callers cannot bypass the app-level
  // audience and allowed-application policy with a shared host secret.
  authLevel: 'anonymous',
  route: 'send',
  handler: (request, context) => handleSend(request, context, {
    dependencies: {
      DefaultAzureCredential,
      SecretClient,
      JWT,
    },
  }),
});

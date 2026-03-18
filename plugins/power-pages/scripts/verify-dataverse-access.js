#!/usr/bin/env node

// Verifies Dataverse API access by obtaining an Azure CLI token and calling WhoAmI.
// Usage: node verify-dataverse-access.js <environmentUrl>
// Outputs JSON: { "token": "...", "userId": "...", "organizationId": "...", "tenantId": "..." }
// Exit 0 on success, exit 1 on failure (error message on stderr).

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

async function main() {
  const envUrl = process.argv[2];
  if (!envUrl) {
    process.stderr.write('Usage: node verify-dataverse-access.js <environmentUrl>\n');
    process.exit(1);
  }

  const token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  const res = await makeRequest({
    url: `${envUrl}/api/data/v9.2/WhoAmI`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  if (res.error) {
    process.stderr.write(`API request failed: ${res.error}\n`);
    process.exit(1);
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    process.stderr.write(`Authentication failed (${res.statusCode}). Token may be expired — run \`az login\` again.\n`);
    process.exit(1);
  }

  if (res.statusCode !== 200) {
    process.stderr.write(`Unexpected response (${res.statusCode}): ${res.body}\n`);
    process.exit(1);
  }

  const data = JSON.parse(res.body);
  // Extract tenantId from JWT token payload
  let tenantId = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    tenantId = payload.tid || null;
  } catch {}
  console.log(JSON.stringify({
    token,
    userId: data.UserId,
    organizationId: data.OrganizationId,
    tenantId,
  }));
}

main();

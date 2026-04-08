#!/usr/bin/env node

// Creates a cloud flow consumer metadata YAML file for Power Pages code sites.
//
// Field naming follows PAPortalCommon.cs ConvertToReadableJson (git format):
//   - adx_* scalar fields have the "adx_" prefix stripped
//   - adx_cloudflowconsumerid → id  (primary key)
//   - adx_name → name  (set to the flow's display name, not a slug)
//   - adx_processid → processid
//   - adx_flowapiurl → flowapiurl
//   - adx_flowtriggerurl → flowtriggerurl
//   - adx_metadata → metadata
//   - adx_websiteid is NOT written — not required for code sites
//   - M2M relationship adx_CloudFlowConsumer_adx_webrole kept as-is
//   - statecode/statuscode defaults omitted
//   - Empty string values written as ''
//   - Fields sorted alphabetically
//
// Usage:
//   node create-cloud-flow-metadata.js \
//     --fileSlug <slug>       used for the filename only
//     --flowName <string>     flow display name → written as the "name" field
//     --flowId <uuid>         workflow entity ID → "processid"
//     --flowTriggerUrl <url>  trigger callback URL (blank until deployed)
//     --flowApiUrl <url>      /_api/cloudflow/v1.0/trigger/<id>
//     --webRoleIds <csv>      comma-separated web role UUIDs
//     [--metadata <string>]   optional metadata string
//
// Output (JSON to stdout):
//   { "id": "<uuid>", "filePath": "<path>" }
//
// Exits with code 1 on validation errors (messages to stderr).

const fs = require('fs');
const path = require('path');
const generateUuid = require(path.join(__dirname, '..', '..', '..', 'scripts', 'generate-uuid'));

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const projectRoot   = getArg('projectRoot');
const fileSlug      = getArg('fileSlug')?.trim() || null;
const flowName      = getArg('flowName')?.trim() || null;
const flowId        = getArg('flowId')?.trim() || null;
const flowTriggerUrl = getArg('flowTriggerUrl')?.trim() ?? '';
const flowApiUrl    = getArg('flowApiUrl')?.trim() ?? '';
const webRoleIdsRaw = getArg('webRoleIds');
const metadata      = getArg('metadata')?.trim() ?? '';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!projectRoot || !fileSlug || !flowName || !flowId || !webRoleIdsRaw) {
  process.stderr.write(
    'Usage: node create-cloud-flow-metadata.js --projectRoot <path> --fileSlug <slug> ' +
    '--flowName <string> --flowId <uuid> --flowTriggerUrl <url> --flowApiUrl <url> ' +
    '--webRoleIds <csv> [--metadata <string>]\n'
  );
  process.exit(1);
}

// Validate fileSlug: lowercase, hyphenated, max 50 chars (per SKILL.md contract)
if (!/^[a-z0-9][a-z0-9-]*$/.test(fileSlug)) {
  process.stderr.write(
    `Error: --fileSlug must be lowercase alphanumeric with hyphens only (no leading hyphen). Got: "${fileSlug}"\n`
  );
  process.exit(1);
}
if (fileSlug.length > 50) {
  process.stderr.write(
    `Error: --fileSlug must be at most 50 characters. Got ${fileSlug.length} characters.\n`
  );
  process.exit(1);
}

if (!UUID_REGEX.test(flowId)) {
  process.stderr.write(`Error: --flowId must be a valid UUID. Got: "${flowId}"\n`);
  process.exit(1);
}

const webRoleIds = webRoleIdsRaw.split(',').map(id => id.trim()).filter(Boolean);
if (webRoleIds.length === 0) {
  process.stderr.write('Error: --webRoleIds must contain at least one UUID\n');
  process.exit(1);
}

for (const roleId of webRoleIds) {
  if (!UUID_REGEX.test(roleId)) {
    process.stderr.write(`Error: Invalid UUID in --webRoleIds: "${roleId}"\n`);
    process.exit(1);
  }
}

const cloudFlowDir = path.join(projectRoot, '.powerpages-site', 'cloud-flow-consumer');
if (!fs.existsSync(cloudFlowDir)) {
  fs.mkdirSync(cloudFlowDir, { recursive: true });
}

const fileName = `${fileSlug}.cloudflowconsumer.yml`;
const filePath = path.join(cloudFlowDir, fileName);

if (fs.existsSync(filePath)) {
  process.stderr.write(`Error: Cloud flow consumer metadata file already exists at ${filePath}\n`);
  process.exit(1);
}

const uuid = generateUuid();

// Serialize a string value safely for YAML: always single-quote, escaping internal single quotes.
// Rejects newlines since single-quoted YAML scalars cannot span lines without breaking structure.
function yamlStr(val) {
  if (/[\r\n]/.test(val)) {
    process.stderr.write(`Error: Value contains newline characters which are not supported in single-line YAML fields: "${val.slice(0, 50)}..."\n`);
    process.exit(1);
  }
  return "'" + val.replace(/'/g, "''") + "'";
}

// Fields sorted alphabetically, matching PAPortalCommon.cs ConvertToReadableJson output.
// websiteid is intentionally omitted — not required for code sites.
const yamlLines = [
  'adx_CloudFlowConsumer_adx_webrole:',
  ...webRoleIds.map(id => `  - ${id}`),
  `flowapiurl: ${yamlStr(flowApiUrl)}`,
  `flowtriggerurl: ${yamlStr(flowTriggerUrl)}`,
  `id: ${uuid}`,
  `metadata: ${yamlStr(metadata)}`,
  `name: ${yamlStr(flowName)}`,
  `processid: ${flowId}`,
  '',
];

fs.writeFileSync(filePath, yamlLines.join('\n'), 'utf8');
process.stdout.write(JSON.stringify({ id: uuid, filePath }));

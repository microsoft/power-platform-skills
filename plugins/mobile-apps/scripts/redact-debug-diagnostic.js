'use strict';

const os = require('node:os');
const path = require('node:path');

const MAX_OUTPUT_LENGTH = 4096;
const headerPattern = /^(\s*)(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|client-secret|x-ms-token[^:]*):[^\r\n]*$/gim;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const querySecretPattern = /([?&](?:sig|se|sp|sv|code|token|access_token|refresh_token|id_token|client_secret)=)[^&#\s]+/gi;
const assignedSecretPattern = /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|api[_-]?key|accountkey|sharedaccesskey)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const guidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const providerSecretPattern = /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b/g;
const residualPattern = /\bBearer\s+(?!\[REDACTED_SECRET\])\S+|\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|[?&](?:sig|token|access_token|refresh_token|id_token|client_secret)=(?!\[REDACTED_SECRET\])[^&#\s]+/i;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redact(input, workingDir) {
  let output = String(input);
  const resolvedWorkingDir = workingDir ? path.resolve(workingDir) : process.cwd();
  const homeDir = os.homedir();

  output = output.replace(new RegExp(`${escapeRegExp(resolvedWorkingDir)}[/\\\\]?`, 'g'), '');
  if (homeDir && path.resolve(homeDir) !== resolvedWorkingDir) {
    output = output.replace(new RegExp(`${escapeRegExp(path.resolve(homeDir))}[/\\\\][^\\s:()]+`, 'g'), '[REDACTED_PATH]');
  }

  output = output
    .replace(headerPattern, '$1$2: [REDACTED_HEADER]')
    .replace(bearerPattern, 'Bearer [REDACTED_SECRET]')
    .replace(jwtPattern, '[REDACTED_SECRET]')
    .replace(querySecretPattern, '$1[REDACTED_SECRET]')
    .replace(assignedSecretPattern, '$1[REDACTED_SECRET]')
    .replace(providerSecretPattern, '[REDACTED_SECRET]')
    .replace(emailPattern, '[REDACTED_EMAIL]')
    .replace(guidPattern, '[REDACTED_ID]');

  if (residualPattern.test(output)) {
    return '[REDACTION_BLOCKED: diagnostic omitted]';
  }

  if (output.length > MAX_OUTPUT_LENGTH) {
    output = `${output.slice(0, MAX_OUTPUT_LENGTH)}\n[TRUNCATED]`;
  }

  return output;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  process.stdout.write(redact(input, argumentValue('--working-dir')));
});

module.exports = { redact };

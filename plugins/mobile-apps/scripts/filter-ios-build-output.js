#!/usr/bin/env node

'use strict';

const readline = require('node:readline');

const MAX_LINES = 80;
const SECRET_ASSIGNMENT =
  /\b(token|password|passwd|secret|authorization|private[_ -]?key|certificate[_ -]?password)\b(\s*[:=]\s*)(\S+)/gi;
const BEARER = /\bBearer\s+\S+/gi;
const SIGNING_ASSIGNMENT =
  /\b(CODE_SIGN_IDENTITY|EXPANDED_CODE_SIGN_IDENTITY(?:_NAME)?|CODE_SIGN_KEYCHAIN|DEVELOPMENT_TEAM|(?:EXPANDED_)?PROVISIONING_PROFILE(?:_SPECIFIER)?|KEYCHAIN_(?:PATH|NAME)|OTHER_CODE_SIGN_FLAGS)\b(?:\[[^\]]+\])?(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|.*)$/i;
const SIGNING_METADATA =
  /\b(signing identity(?: hash)?|certificate(?: identity| hash)?|sha-?1 hash|provisioning profile(?: specifier| name| uuid)?|keychain(?: path| name)?)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^;]*)/gi;
const PROFILE_MATCH =
  /(\bprovisioning profiles? matching\s+)(?:"[^"]*"|'[^']*'|[^.;]+)(?=[.;]|$)/gi;
const PROFILE_WITH_UUID =
  /(\bprovisioning profile(?:\s+(?:specifier|name))?\s+)(?:"[^"]*"|'[^']*'|[^.;,]*?)\s*\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/gi;
const QUOTED_PROFILE =
  /(\bprovisioning profile(?:\s+(?:specifier|name))?\s+)(?:"[^"]*"|'[^']*')/gi;
const PROFILE_IN_SENTENCE =
  /(\b(?:using|selected|selecting|resolved|matched)\s+provisioning profile(?:\s+(?:named|specifier))?\s+)(?:"[^"]*"|'[^']*'|[^.;,]+)(?=\s*(?:[.;,]|$))/gi;
// Xcode can place a user-defined profile name directly before a descriptive failure,
// e.g. `Provisioning profile Contoso Internal doesn't include signing certificate`.
// Require that exact signing-certificate grammar so unrelated prose mentioning profiles
// is not treated as sensitive signing metadata.
const PROFILE_SIGNING_CERTIFICATE_FAILURE =
  /(\bprovisioning profile\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:[^\s.;,"']+\s+)+[^\s.;,"']+?)(?=\s+(?:doesn't|doesn’t|does not)\s+include\s+signing certificate\b)/gi;
const DESCRIBED_PROFILE =
  /(\bprovisioning profile\s+)(?!is\b|was\b|could\b|has\b|does\b|cannot\b)([^.;,]+?)(?=\s+(?:is|was|could|has|does|cannot|can't)\b)/gi;
// Descriptive keychain failures have no delimiter between the sensitive display name
// and the safe diagnosis, e.g. `The keychain Work Signing is unavailable`. Unquoted
// names must contain at least two words; this avoids redacting ordinary single words in
// sentences such as `The keychain service is unavailable`.
const DESCRIPTIVE_KEYCHAIN_FAILURE =
  /(\b(?:the\s+)?keychain\s+)(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:[^\s.;,"']+\s+)+[^\s.;,"']+?)(?=\s+(?:could not be found|is unavailable)\b)/gi;
const KEYCHAIN_CONTEXT_VALUE =
  /(\b(?:specified\s+)?keychain(?:\s+(?:path|name))?(?:\s+could not be found)?\s*(?::|=|\bis\b|\bnamed\b)\s*)(?:"[^"]*"|'[^']*'|[^;,.]+)/gi;
// Xcode emits both absolute paths and bare names in otherwise useful diagnostics, e.g.
// `error: The specified keychain could not be found: /Users/.../login.keychain-db`.
// Match the artifact itself rather than the whole line so the actionable error survives.
const KEYCHAIN_ARTIFACT =
  /"(?:[^"\r\n]*[\\/])?[^"\\/\r\n]*\.keychain(?:-db)?"|'(?:[^'\r\n]*[\\/])?[^'\\/\r\n]*\.keychain(?:-db)?'|(?:~|\/|[A-Z]:[\\/])[^"' \t\r\n;,)]+\.keychain(?:-db)?|\b[A-Z0-9_.-]+\.keychain(?:-db)?\b/gi;
const NAMED_SIGNING_IDENTITY =
  /\b(Apple (?:Development|Distribution)|iPhone (?:Developer|Distribution)|Developer ID Application):\s*[^"',;]+(?:\s+\([A-Z0-9]{10}\))?/gi;
const PROVISIONING_PROFILE_PATH =
  /(?:\/|\\)[^"'\s]*Provisioning Profiles(?:\/|\\)[0-9a-f-]{36}\.mobileprovision/gi;
const SIGNING_COMMAND =
  /\b(?:codesign|xcodebuild|security|productPackagingUtility)\b.*(?:--sign\b|-s\s+\S|--keychain\b|find-(?:identity|certificate)\b|(?:list|default|unlock)-keychain\b|-provisioningprofile\b|CODE_SIGN_IDENTITY\s*=|DEVELOPMENT_TEAM\s*=|PROVISIONING_PROFILE(?:_SPECIFIER)?\s*=)/i;
const FIND_IDENTITY_OUTPUT =
  /^\s*\d+\)\s+[0-9A-F]{40}\s+"[^"]+"|^\s*\d+\s+valid identities found\b/i;

function redact(line) {
  let result = line
    .replace(BEARER, '******')
    .replace(SECRET_ASSIGNMENT, (_match, name, separator) => `${name}${separator}******`);
  result = result.replace(
    SIGNING_ASSIGNMENT,
    (_match, name, separator) => `${name}${separator}******`,
  );
  result = result.replace(
    SIGNING_METADATA,
    (_match, name, separator) => `${name}${separator}******`,
  );
  return result
    .replace(PROFILE_MATCH, '$1******')
    .replace(PROFILE_WITH_UUID, '$1******')
    .replace(QUOTED_PROFILE, '$1******')
    .replace(PROFILE_IN_SENTENCE, '$1******')
    .replace(PROFILE_SIGNING_CERTIFICATE_FAILURE, '$1******')
    .replace(DESCRIBED_PROFILE, '$1******')
    .replace(DESCRIPTIVE_KEYCHAIN_FAILURE, '$1******')
    .replace(NAMED_SIGNING_IDENTITY, '$1: ******')
    .replace(PROVISIONING_PROFILE_PATH, '/******.mobileprovision')
    .replace(KEYCHAIN_ARTIFACT, '******')
    .replace(KEYCHAIN_CONTEXT_VALUE, '$1******');
}

function sanitize(line) {
  if (SIGNING_COMMAND.test(line) || FIND_IDENTITY_OUTPUT.test(line)) return null;
  return redact(line);
}

function bounded(lines, limit = MAX_LINES) {
  const safe = [];
  for (const line of lines) {
    const sanitized = sanitize(line);
    if (sanitized !== null) safe.push(sanitized);
    if (safe.length > limit) safe.shift();
  }
  return safe;
}

function main(input = process.stdin, output = process.stdout) {
  const ring = [];
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  reader.on('line', (line) => {
    const sanitized = sanitize(line);
    if (sanitized === null) return;
    ring.push(sanitized);
    if (ring.length > MAX_LINES) ring.shift();
  });
  reader.on('close', () => {
    if (ring.length > 0) output.write(`${ring.join('\n')}\n`);
  });
}

if (require.main === module) main();

module.exports = {
  bounded,
  redact,
  sanitize,
};

#!/usr/bin/env node

// Generates a canonical environmentvariabledefinition schema name from a
// site-setting name. Single source of truth so setup-solution and
// configure-env-variables (and any future skill that creates env var
// definitions from site settings) emit the SAME schema name for a given
// (publisherPrefix, settingName) input — required because setup-solution
// creates the definition and configure-env-variables / deploy-pipeline must
// reference it by the exact same schema name later.
//
// Canonical rule:
//   schemaName = `${publisherPrefix}_${sanitizedSettingName}`
//   sanitizedSettingName = settingName.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()
//
//   - Replace any non-alphanumeric character with `_` (covers `/`, `-`, ` `,
//     `.`, etc. that may appear in mspp_sitesettings names).
//   - Lowercase the result so `Authentication/.../LocalLoginEnabled` and
//     `authentication/.../localloginenabled` produce the same schema name.
//   - Collapse runs of underscores so `Foo//Bar` doesn't become `foo___bar`.
//   - Trim leading/trailing underscores after the prefix join.
//
// Usage as a CLI:
//   node generate-env-var-schema-name.js \
//     --publisherPrefix ids \
//     --settingName "Authentication/Registration/LocalLoginEnabled"
//   → {"schemaName":"ids_authentication_registration_localloginenabled","sanitized":"authentication_registration_localloginenabled"}
//
// As a module (typical):
//   const { generateSchemaName } = require('./generate-env-var-schema-name');
//   generateSchemaName({ settingName, publisherPrefix })
//     → { schemaName, sanitized }

'use strict';

function sanitize(settingName) {
  if (typeof settingName !== 'string' || settingName.length === 0) {
    throw new Error('settingName must be a non-empty string');
  }
  // Replace any non-alphanumeric with `_`, collapse runs of `_`, trim ends.
  const replaced = settingName.replace(/[^A-Za-z0-9]+/g, '_');
  const trimmed = replaced.replace(/^_+|_+$/g, '');
  return trimmed.toLowerCase();
}

function generateSchemaName({ settingName, publisherPrefix } = {}) {
  if (typeof publisherPrefix !== 'string' || publisherPrefix.length === 0) {
    throw new Error('publisherPrefix must be a non-empty string');
  }
  // Publisher prefixes in Dataverse are typically 2–8 lowercase chars; defend
  // against callers passing the whole `prefix_` form by stripping a trailing _.
  const prefix = publisherPrefix.toLowerCase().replace(/_+$/g, '');
  const sanitized = sanitize(settingName);
  if (sanitized.length === 0) {
    throw new Error(`settingName "${settingName}" sanitized to an empty string — cannot build schema name`);
  }
  return {
    schemaName: `${prefix}_${sanitized}`,
    sanitized,
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { settingName: null, publisherPrefix: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settingName' && args[i + 1]) out.settingName = args[++i];
    else if (args[i] === '--publisherPrefix' && args[i + 1]) out.publisherPrefix = args[++i];
  }
  return out;
}

if (require.main === module) {
  const { settingName, publisherPrefix } = parseArgs(process.argv);
  try {
    const result = generateSchemaName({ settingName, publisherPrefix });
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  generateSchemaName,
  sanitize,
};

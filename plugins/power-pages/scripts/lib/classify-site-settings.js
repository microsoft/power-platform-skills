#!/usr/bin/env node

// Classifies Power Pages site settings (mspp_sitesettings rows) into buckets
// that drive setup-solution's per-setting handling and plan-alm's Phase 1
// summary + risks list. Single source of truth for the credential-detection
// regex + the bulk auto-classify regex pair (Secret-vs-String defaults inside
// the credential bucket).
//
// Usage as a CLI (rare — most callers require this module):
//   echo '[{"name":"Authentication/.../ClientSecret","value":"xxx"},...]' \
//     | node classify-site-settings.js
//
//   Output: { keepAsIs:[], authNoValue:[], promoteToEnvVar:[], credentialNeedsDecision:[] }
//
// As a module (typical usage):
//   const { classify, bulkClassify, autoClassifyCredential,
//           CREDENTIAL_REGEX, AUTH_PREFIX_REGEX,
//           CREDENTIAL_SECRET_REGEX, CREDENTIAL_STRING_REGEX } = require('./classify-site-settings');
//
//   bulkClassify([{name, value}, ...])
//     → { keepAsIs: [...], authNoValue: [...], promoteToEnvVar: [...], credentialNeedsDecision: [...] }
//
//   classify({name, value})
//     → { tier: 'credential' | 'authValue' | 'authNoValue' | 'keepAsIs' }
//
//   autoClassifyCredential(name)
//     → { default: 'secret' | 'string', reason: string }
//
// Tier definitions (mirror plan-alm Phase 1 Step 7):
//   - Tier 1 ('credential', → bucket 'credentialNeedsDecision'):
//       Name matches CREDENTIAL_REGEX. setup-solution Phase 5.4.C runs the
//       bulk-with-override prompt against this bucket — auto-classify by
//       name (default), all-Secret, all-String, skip-all, or pick-per-credential.
//   - Tier 2a ('authValue', → bucket 'promoteToEnvVar'):
//       Name matches AUTH_PREFIX_REGEX (and not credential), AND value is
//       non-empty. setup-solution Phase 5.4.A asks which to back with env vars.
//   - Tier 2b ('authNoValue', → bucket 'authNoValue'):
//       Name matches AUTH_PREFIX_REGEX (and not credential), AND value is
//       null/empty. Setup-solution adds these to the solution as-is with a
//       note that the user must set the value in each target env.
//   - Tier 3 ('keepAsIs', → bucket 'keepAsIs'):
//       Everything else. Added to the solution unchanged.
//
// Auto-classify regex (used by setup-solution Phase 5.4.C.1 to default each
// credentialNeedsDecision setting to Secret or String env var):
//   - CREDENTIAL_SECRET_REGEX: name contains Secret/Password/ApiKey/AppKey
//     → recommend Secret env var (Key Vault per stage)
//   - CREDENTIAL_STRING_REGEX: name contains Id/ConsumerKey AND not Secret
//     → recommend String env var (plain text per stage)
//   - Anything not matching either → fallback to Secret (defensive — credential
//     names are sensitive by default).

'use strict';

const CREDENTIAL_REGEX = /ConsumerKey|ConsumerSecret|ClientId|ClientSecret|AppSecret|AppKey|ApiKey|Password/i;
const AUTH_PREFIX_REGEX = /^(Authentication\/|AzureAD\/)/i;
const CREDENTIAL_SECRET_REGEX = /Secret|Password|ApiKey|AppKey/i;
const CREDENTIAL_STRING_REGEX = /Id|ConsumerKey/i;

function isNonEmpty(value) {
  if (value == null) return false;
  if (typeof value !== 'string') return Boolean(value);
  return value.trim().length > 0;
}

// Classify a single setting. Returns one of four tiers.
function classify(setting) {
  if (!setting || typeof setting.name !== 'string') {
    throw new Error('classify(setting): setting.name must be a string');
  }
  const name = setting.name;
  const value = setting.value;

  if (CREDENTIAL_REGEX.test(name)) {
    return { tier: 'credential' };
  }
  if (AUTH_PREFIX_REGEX.test(name)) {
    return { tier: isNonEmpty(value) ? 'authValue' : 'authNoValue' };
  }
  return { tier: 'keepAsIs' };
}

// Apply classify() to an array; return the four-bucket shape that plan-alm
// SITE_SETTINGS_DATA + setup-solution preloadedSettings expect.
function bulkClassify(settings) {
  if (!Array.isArray(settings)) {
    throw new Error('bulkClassify(settings): settings must be an array');
  }
  const out = {
    keepAsIs: [],
    authNoValue: [],
    promoteToEnvVar: [],
    credentialNeedsDecision: [],
  };
  for (const s of settings) {
    if (!s || typeof s.name !== 'string') continue;
    const { tier } = classify(s);
    switch (tier) {
      case 'credential':
        out.credentialNeedsDecision.push({ name: s.name, value: s.value ?? null });
        break;
      case 'authValue':
        out.promoteToEnvVar.push({ name: s.name, value: s.value ?? null });
        break;
      case 'authNoValue':
        out.authNoValue.push({ name: s.name });
        break;
      case 'keepAsIs':
      default:
        out.keepAsIs.push({ name: s.name });
        break;
    }
  }
  return out;
}

// For a given credential-style setting name, recommend Secret-typed vs
// String-typed env var. Used by setup-solution Phase 5.4.C.1 to pre-classify
// before the bulk prompt; the user can override via Option 5 (per-credential).
function autoClassifyCredential(name) {
  if (typeof name !== 'string') {
    throw new Error('autoClassifyCredential(name): name must be a string');
  }
  if (CREDENTIAL_SECRET_REGEX.test(name)) {
    return {
      default: 'secret',
      reason: 'Name matches Secret/Password/ApiKey/AppKey — defaults to Secret env var (Key Vault per stage).',
    };
  }
  if (CREDENTIAL_STRING_REGEX.test(name)) {
    return {
      default: 'string',
      reason: 'Name matches Id/ConsumerKey (and not Secret) — defaults to String env var (plain text per stage).',
    };
  }
  return {
    default: 'secret',
    reason: 'Name did not match Secret or String pattern — defaults to Secret env var (defensive — credentials are sensitive by default).',
  };
}

if (require.main === module) {
  // CLI mode: read stdin as JSON array, write classification to stdout.
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('end', () => {
    try {
      const settings = JSON.parse(buf);
      const result = bulkClassify(settings);
      console.log(JSON.stringify(result));
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
  });
}

module.exports = {
  classify,
  bulkClassify,
  autoClassifyCredential,
  CREDENTIAL_REGEX,
  AUTH_PREFIX_REGEX,
  CREDENTIAL_SECRET_REGEX,
  CREDENTIAL_STRING_REGEX,
};

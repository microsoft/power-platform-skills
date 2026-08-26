#!/usr/bin/env node

// Validates Power Pages code site generation output.
// Runs as a PostToolUse(Skill) hook to verify the site was properly created.

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findPath } = require('../../../scripts/lib/validation-helpers');
const { detectFramework } = require('../../../scripts/lib/framework-detection');
const {
  resolveLocale,
  resolveSiteLanguageContext,
} = require('../../../scripts/lib/localization-config');
const {
  auditBidirectionalReadiness,
} = require('../../../scripts/lib/bidirectional-readiness');

function validateSite(cwd, input = {}) {
  const configPath = findPath(cwd, 'powerpages.config.json');
  if (!configPath) approve(); // Not a Power Pages project, skip

  const projectRoot = path.dirname(configPath);
  const errors = [];
  const expectedLanguage = input.expectedSiteLanguage;

  // 1. Required files
  for (const file of ['package.json', '.gitignore', 'powerpages.config.json']) {
    if (!fs.existsSync(path.join(projectRoot, file))) {
      errors.push(`Missing required file: ${file}`);
    }
  }

  // 2. powerpages.config.json fields
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.$schema) errors.push('powerpages.config.json: missing $schema');
    if (!config.compiledPath) errors.push('powerpages.config.json: missing compiledPath');
    if (!config.siteName) errors.push('powerpages.config.json: missing siteName');
    if (!config.defaultLandingPage) errors.push('powerpages.config.json: missing defaultLandingPage');
  } catch {
    errors.push('powerpages.config.json: invalid JSON');
  }

  // 3. package.json has build script
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (!pkg.scripts || !pkg.scripts.build) errors.push('package.json: missing "build" script');
    if (!pkg.scripts || !pkg.scripts.dev) errors.push('package.json: missing "dev" script');
  } catch {}

  // 4. Unreplaced placeholders in source files
  const dirsToCheck = [path.join(projectRoot, 'src')];
  const rootFiles = ['index.html'].map(f => path.join(projectRoot, f));

  const placeholders = [];
  for (const dir of dirsToCheck) {
    if (fs.existsSync(dir)) placeholders.push(...findPlaceholders(dir));
  }
  for (const file of rootFiles) {
    if (fs.existsSync(file)) placeholders.push(...findPlaceholdersInFile(file));
  }
  if (placeholders.length > 0) {
    errors.push('Unreplaced placeholders found:\n  ' + placeholders.slice(0, 5).join('\n  '));
    if (placeholders.length > 5) {
      errors.push(`  ...and ${placeholders.length - 5} more`);
    }
  }

  // 5. Git repository initialized
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    errors.push('Git repository not initialized');
  }

  // 6. Source directory exists with content
  if (!fs.existsSync(path.join(projectRoot, 'src'))) {
    errors.push('Missing src/ directory');
  }

  // 7. The root document is the persisted source of truth for single-site language.
  const framework = detectFramework(projectRoot);
  if (!framework.framework || framework.ambiguous) {
    errors.push('Unable to determine one supported framework for language validation');
  } else {
    const siteLanguage = resolveSiteLanguageContext(projectRoot, framework.framework);
    if (!siteLanguage.detected) {
      const expected = siteLanguage.expectedSources?.length
        ? ` Expected: ${siteLanguage.expectedSources.join(', ')}.`
        : '';
      if (siteLanguage.reason === 'document-not-found') {
        errors.push(`Root document was not found.${expected}`);
      } else if (siteLanguage.reason === 'html-root-not-found') {
        errors.push(`Root html element was not found in the discovered document.${expected}`);
      } else if (siteLanguage.reason === 'document-ambiguous' ||
          siteLanguage.reason === 'document-configuration-invalid') {
        errors.push(
          `Root document configuration is invalid:\n  ${siteLanguage.conflicts.join('\n  ')}`
        );
      } else {
        errors.push(`Document language could not be determined.${expected}`);
      }
    } else if (!siteLanguage.valid) {
      errors.push(`Document language is invalid:\n  ${siteLanguage.conflicts.join('\n  ')}`);
    } else if (expectedLanguage !== undefined) {
      const expectedLocale = resolveLocale(expectedLanguage?.locale);
      const expectedDirection = expectedLanguage?.direction;
      if (!expectedLocale.valid || !['ltr', 'rtl'].includes(expectedDirection)) {
        errors.push(
          'Expected site language is invalid: provide a valid locale and ltr or rtl direction'
        );
      } else if (expectedDirection !== expectedLocale.direction) {
        errors.push(
          `Expected site direction "${expectedDirection}" does not match ` +
          `${expectedLocale.locale}, which resolves to "${expectedLocale.direction}"`
        );
      } else {
        const source = siteLanguage.source || 'site language configuration';
        if (siteLanguage.locale !== expectedLocale.locale) {
          errors.push(
            `${source} uses locale "${siteLanguage.locale}", but the approved site locale is ` +
            `"${expectedLocale.locale}"`
          );
        }
        if (siteLanguage.direction !== expectedDirection) {
          errors.push(
            `${source} uses direction "${siteLanguage.direction}", but the approved site ` +
            `direction is "${expectedDirection}"`
          );
        }
      }
    }
  }

  // 8. New sites must be structurally safe for either writing direction. The
  // audit blocks only deterministic defects; geometry that may be intentionally
  // physical remains a review finding for the create-site browser pass.
  const bidiAudit = auditBidirectionalReadiness(projectRoot);
  for (const finding of bidiAudit.findings.filter((item) => item.severity === 'error')) {
    errors.push(
      `Bidirectional readiness ${finding.file}:${finding.line} ` +
      `[${finding.rule}]: ${finding.message}`
    );
  }

  if (errors.length > 0) {
    block('Power Pages site validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
}

const PLACEHOLDER_RE = /__[A-Z][A-Z_]{2,}__/;

function findPlaceholdersInFile(filePath) {
  const results = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (PLACEHOLDER_RE.test(lines[i])) {
        results.push(`${path.basename(filePath)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  } catch {}
  return results;
}

function findPlaceholders(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        results.push(...findPlaceholders(fullPath));
      } else if (entry.isFile()) {
        results.push(...findPlaceholdersInFile(fullPath));
      }
    }
  } catch {}
  return results;
}

function parseExpectedLanguageArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--expectedLocale', '--expectedDirection'].includes(option)) {
      return { valid: false };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || values[option] !== undefined) {
      return { valid: false };
    }
    values[option] = value;
    index += 1;
  }

  if (!values['--expectedLocale'] || !values['--expectedDirection']) {
    return { valid: false };
  }
  return {
    valid: true,
    expectedSiteLanguage: {
      locale: values['--expectedLocale'],
      direction: values['--expectedDirection'],
    },
  };
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length) {
  const parsed = parseExpectedLanguageArgs(cliArgs);
  if (!parsed.valid) {
    block(
      'Usage: validate-site.js --expectedLocale <canonical-bcp47-tag> ' +
      '--expectedDirection <ltr|rtl>'
    );
  }
  validateSite(process.cwd(), parsed);
} else {
  runValidation(validateSite);
}

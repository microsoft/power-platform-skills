#!/usr/bin/env node

// Validates either a generated SPA site or a PAC-downloaded non-SPA site.
// The PostToolUse hook uses structural checks; the non-SPA workflow also passes the
// expected website record ID and optional Bootstrap major before creating the Git baseline.

const fs = require('fs');
const path = require('path');
const {
  approve,
  block,
  runValidation,
  findProjectRoot,
  UUID_REGEX,
} = require('../../../scripts/lib/validation-helpers');
const { detectFramework } = require('../../../scripts/lib/framework-detection');
const { inspectSite } = require('../../../scripts/lib/non-spa-site-style-context');
const {
  normalizeBootstrapVersion,
  parseBootstrapVersionArgs,
} = require('../../../scripts/lib/site-templates');
const {
  resolveLocale,
  resolveSiteLanguageContext,
} = require('../../../scripts/lib/localization-config');

const PLACEHOLDER_RE = /__[A-Z][A-Z_]{2,}__/;
const DECLARATIVE_COMPONENT_DIRS = new Set([
  'ad-placements',
  'advanced-forms',
  'basic-forms',
  'bot-consumers',
  'cloud-flow-definitions',
  'content-snippets',
  'lists',
  'page-templates',
  'poll-placements',
  'publishing-state-transition-rules',
  'site-settings',
  'table-permissions',
  'web-files',
  'web-link-sets',
  'web-pages',
  'web-roles',
  'web-templates',
]);

function findPlaceholdersInFile(filePath) {
  const results = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (PLACEHOLDER_RE.test(lines[index])) {
        results.push(`${path.basename(filePath)}:${index + 1}: ${lines[index].trim()}`);
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

function validateCodeProject(projectRoot, expectedLanguage) {
  const errors = [];
  const configPath = path.join(projectRoot, 'powerpages.config.json');
  const framework = detectFramework(projectRoot);

  for (const file of ['package.json', '.gitignore', 'powerpages.config.json']) {
    if (!fs.existsSync(path.join(projectRoot, file))) {
      errors.push(`Missing required file: ${file}`);
    }
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.$schema) errors.push('powerpages.config.json: missing $schema');
    if (!config.compiledPath) errors.push('powerpages.config.json: missing compiledPath');
    if (!config.siteName) errors.push('powerpages.config.json: missing siteName');
    if (!config.defaultLandingPage) {
      errors.push('powerpages.config.json: missing defaultLandingPage');
    }
    if (framework.framework === 'astro' && !framework.ambiguous) {
      if (config.framework?.name !== 'astro') {
        errors.push('powerpages.config.json: Astro sites require framework.name "astro"');
      }
      if (config.framework?.options?.buildFormat !== 'directory') {
        errors.push(
          'powerpages.config.json: Astro sites require ' +
          'framework.options.buildFormat "directory"',
        );
      }
    }
  } catch {
    errors.push('powerpages.config.json: invalid JSON');
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (!pkg.scripts || !pkg.scripts.build) errors.push('package.json: missing "build" script');
    if (!pkg.scripts || !pkg.scripts.dev) errors.push('package.json: missing "dev" script');
  } catch {}

  const placeholders = [];
  const sourceDir = path.join(projectRoot, 'src');
  if (fs.existsSync(sourceDir)) placeholders.push(...findPlaceholders(sourceDir));
  const indexPath = path.join(projectRoot, 'index.html');
  if (fs.existsSync(indexPath)) placeholders.push(...findPlaceholdersInFile(indexPath));
  if (placeholders.length > 0) {
    errors.push(`Unreplaced placeholders found:\n  ${placeholders.slice(0, 5).join('\n  ')}`);
    if (placeholders.length > 5) {
      errors.push(`  ...and ${placeholders.length - 5} more`);
    }
  }

  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    errors.push('Git repository not initialized');
  }
  if (!fs.existsSync(sourceDir)) errors.push('Missing src/ directory');

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
      } else if (
        siteLanguage.reason === 'document-ambiguous' ||
        siteLanguage.reason === 'document-configuration-invalid'
      ) {
        errors.push(
          `Root document configuration is invalid:\n  ${siteLanguage.conflicts.join('\n  ')}`,
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
          'Expected site language is invalid: provide a valid locale and ltr or rtl direction',
        );
      } else if (expectedDirection !== expectedLocale.direction) {
        errors.push(
          `Expected site direction "${expectedDirection}" does not match ` +
          `${expectedLocale.locale}, which resolves to "${expectedLocale.direction}"`,
        );
      } else {
        const source = siteLanguage.source || 'site language configuration';
        if (siteLanguage.locale !== expectedLocale.locale) {
          errors.push(
            `${source} uses locale "${siteLanguage.locale}", but the approved site locale is ` +
            `"${expectedLocale.locale}"`,
          );
        }
        if (siteLanguage.direction !== expectedDirection) {
          errors.push(
            `${source} uses direction "${siteLanguage.direction}", but the approved site ` +
            `direction is "${expectedDirection}"`,
          );
        }
      }
    }
  }

  return errors;
}

function readWebsiteIdentity(websitePath) {
  const raw = fs.readFileSync(websitePath, 'utf8');
  // PAC exports use either "id: <guid>" or "adx_websiteid: <guid>".
  // Read only top-level identity keys, never an indented block's sample value;
  // conflicting aliases must not select whichever website happens to come first.
  const matches = [...raw.matchAll(/^(?:\uFEFF)?(id|adx_websiteid)[ \t]*:[ \t]*(.*?)[ \t]*$/gim)];
  const ids = matches.map((match) => {
    let id = match[2].replace(/\s+#.*$/, '').trim();
    if (
      (id.startsWith('"') && id.endsWith('"')) ||
      (id.startsWith("'") && id.endsWith("'"))
    ) {
      id = id.slice(1, -1);
    }
    return id;
  });
  const duplicateKey = new Set(matches.map((match) => match[1].toLowerCase())).size !== matches.length;
  const consistent = ids.length > 0 && ids.every((id) => id.toLowerCase() === ids[0].toLowerCase());
  return { raw, id: !duplicateKey && consistent ? ids[0] : null };
}

function listNonSpaAssetFiles(siteDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(?:ya?ml|html?|css|js|liquid)$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  // A direct-root download can also contain project documentation. Count only known
  // PAC component directories so docs/current-plan.html cannot make an empty site valid.
  for (const entry of fs.readdirSync(siteDir, { withFileTypes: true })) {
    if (entry.isDirectory() && DECLARATIVE_COMPONENT_DIRS.has(entry.name)) {
      walk(path.join(siteDir, entry.name));
    }
  }
  return files;
}

function validateNonSpaProject(
  projectRoot,
  { expectedWebsiteRecordId = null, expectedBootstrapMajor = null, skipGit = false } = {},
) {
  const errors = [];
  // Create-site stores its download under `.powerpages-site`, while users who download
  // manually can open the PAC site root itself. Both layouts carry the same non-SPA
  // markers, so validate the selected site rather than requiring one wrapper directory.
  const nestedSiteDir = path.join(projectRoot, '.powerpages-site');
  const siteDir = fs.existsSync(nestedSiteDir) ? nestedSiteDir : projectRoot;
  const displayPrefix = siteDir === projectRoot ? '' : '.powerpages-site/';
  const portalConfigDir = path.join(siteDir, '.portalconfig');
  const websitePath = path.join(siteDir, 'website.yml');

  if (!fs.existsSync(portalConfigDir) || !fs.statSync(portalConfigDir).isDirectory()) {
    errors.push(`Missing non-SPA marker: ${displayPrefix}.portalconfig/`);
  }
  if (!fs.existsSync(websitePath) || fs.statSync(websitePath).size === 0) {
    errors.push(`Missing or empty identity file: ${displayPrefix}website.yml`);
  } else {
    const identity = readWebsiteIdentity(websitePath);
    if (!identity.id || !UUID_REGEX.test(identity.id)) {
      errors.push(`${displayPrefix}website.yml: missing, invalid or conflicting id/adx_websiteid`);
    } else if (
      expectedWebsiteRecordId &&
      identity.id.toLowerCase() !== expectedWebsiteRecordId.toLowerCase()
    ) {
      errors.push(
        `${displayPrefix}website.yml id ${identity.id} does not match created website ` +
          `${expectedWebsiteRecordId}`,
      );
    }
  }

  try {
    if (fs.existsSync(siteDir) && listNonSpaAssetFiles(siteDir).length === 0) {
      errors.push('Downloaded non-SPA tree contains no site assets beyond identity metadata');
    }
  } catch (error) {
    errors.push(`Could not inspect non-SPA site assets: ${error.message}`);
  }

  if (expectedBootstrapMajor !== null) {
    try {
      const expected = normalizeBootstrapVersion(expectedBootstrapMajor);
      // Inspect the same selected download as the structural/identity checks.
      // The shared inspector requires asset evidence and reconciles settings with
      // it; an Enhanced model or Site/BootstrapV5Enabled alone is not proof.
      const { bootstrap } = inspectSite(siteDir);
      if (!bootstrap.major || !bootstrap.evidence.some((entry) => entry.kind === 'asset')) {
        errors.push(
          `Could not verify expected Bootstrap ${expected}: downloaded Bootstrap asset evidence ` +
          'is missing, conflicting, or unsupported.',
        );
      } else if (bootstrap.major !== expected) {
        errors.push(`Downloaded site uses Bootstrap ${bootstrap.major}; expected Bootstrap ${expected}.`);
      }
    } catch (error) {
      errors.push(`Could not verify downloaded Bootstrap version: ${error.message}`);
    }
  }

  if (!skipGit && !fs.existsSync(path.join(projectRoot, '.git'))) {
    errors.push('Git repository not initialized');
  }

  return errors;
}

function validateProject(projectRoot, options = {}) {
  const missingProject = () => ({
    siteType: null,
    errors: options.expectedBootstrapMajor == null
      ? [] : ['Cannot verify Bootstrap without a non-SPA Power Pages project.'],
  });
  if (!projectRoot) return missingProject();
  if (fs.existsSync(path.join(projectRoot, 'powerpages.config.json'))) {
    const errors = validateCodeProject(projectRoot, options.expectedSiteLanguage);
    if (options.expectedBootstrapMajor != null) {
      errors.push('--bootstrapVersion is only supported for non-SPA sites, not SPA sites.');
    }
    return { siteType: 'spa', errors };
  }
  if (
    fs.existsSync(path.join(projectRoot, '.powerpages-site')) ||
    (
      fs.existsSync(path.join(projectRoot, '.portalconfig')) &&
      fs.existsSync(path.join(projectRoot, 'website.yml'))
    )
  ) {
    return {
      siteType: 'non-spa',
      errors: validateNonSpaProject(projectRoot, options),
    };
  }
  return missingProject();
}

function parseArgs(argv) {
  const args = {};
  const bootstrapVersion = parseBootstrapVersionArgs(argv);
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    }
  }
  if (bootstrapVersion !== undefined) args.bootstrapVersion = bootstrapVersion;
  return args;
}

function siteTypeLabel(siteType) {
  if (siteType === 'spa') return 'SPA site';
  if (siteType === 'non-spa') return 'non-SPA site';
  return 'site';
}

function validationMessage(result) {
  return `Power Pages ${siteTypeLabel(result.siteType)} validation failed:\n- ${result.errors.join('\n- ')}`;
}

function runHook() {
  runValidation((cwd, input) => {
    const projectRoot = findProjectRoot(cwd);
    const result = validateProject(projectRoot, {
      expectedSiteLanguage: input?.expectedSiteLanguage,
    });
    if (result.errors.length > 0) block(validationMessage(result));
    approve();
  });
}

function runDirect() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const allowedArgs = new Set([
      'projectRoot',
      'websiteRecordId',
      'bootstrapVersion',
      'bootstrap-version',
      'skipGit',
      'expectedLocale',
      'expectedDirection',
    ]);
    const languageArgsComplete = Boolean(args.expectedLocale) === Boolean(args.expectedDirection);
    if (
      Object.keys(args).some((key) => !allowedArgs.has(key)) ||
      !languageArgsComplete
    ) {
      throw new Error(
        'Usage: validate-site.js [--projectRoot <path>] [--websiteRecordId <guid>] ' +
        '[--bootstrapVersion <3|5>] [--skipGit true] ' +
        '[--expectedLocale <canonical-bcp47-tag> --expectedDirection <ltr|rtl>]',
      );
    }
    const cwd = process.cwd();
    const directSite = fs.existsSync(path.join(cwd, '.portalconfig')) &&
      fs.existsSync(path.join(cwd, 'website.yml'));
    const projectRoot = args.projectRoot
      ? path.resolve(args.projectRoot)
      : directSite ? cwd : findProjectRoot(cwd);
    const result = validateProject(projectRoot, {
      expectedWebsiteRecordId: args.websiteRecordId || null,
      expectedBootstrapMajor: args.bootstrapVersion ?? null,
      skipGit: args.skipGit === 'true',
      expectedSiteLanguage: args.expectedLocale
        ? { locale: args.expectedLocale, direction: args.expectedDirection }
        : undefined,
    });
    if (!result.siteType) {
      process.stderr.write('No Power Pages project found.\n');
      process.exitCode = 2;
    } else if (result.errors.length > 0) {
      process.stderr.write(`${validationMessage(result)}\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write(`Power Pages ${siteTypeLabel(result.siteType)} validation passed.\n`);
    }
  } catch (error) {
    process.stderr.write(`${validationMessage({ errors: [error.message] })}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  if (process.argv.slice(2).length > 0) runDirect();
  else runHook();
}

module.exports = {
  findPlaceholdersInFile,
  findPlaceholders,
  readWebsiteIdentity,
  listNonSpaAssetFiles,
  validateCodeProject,
  validateNonSpaProject,
  validateProject,
  parseArgs,
};

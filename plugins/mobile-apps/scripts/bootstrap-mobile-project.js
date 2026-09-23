#!/usr/bin/env node

/**
 * bootstrap-mobile-project.js — materialize a new mobile app folder from the
 * template snapshot bundled inside this plugin.
 *
 * `/create-mobile-app` used to require the user to run
 * `npx degit microsoft/power-platform-skills/plugins/mobile-apps/template#main <dir>`
 * plus `npm install` before the skill could be invoked. The plugin already ships
 * that exact snapshot at `<plugin>/template`, and it is the only template shape
 * `prepare-mobile-template.js` is asserted against, so copying the bundled copy
 * removes the prerequisite without introducing version skew between the skill
 * and the template it prepares. It also works offline and behind a proxy.
 *
 * This script only decides *where* the app goes and copies files. Dependency
 * installation is owned by `install-dependencies.js` so the skill can overlap it
 * with requirements discovery and planning.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REQUIRED_FILES } = require('./prepare-mobile-template');

// Entries that routinely exist in a folder a user just made for a new app and that
// carry no project content, so finding one must not make the folder look occupied.
// `git init` before scaffolding is common, and Finder writes `.DS_Store` the moment
// the folder is opened on macOS.
const IGNORABLE_ENTRIES = new Set([
  '.git',
  '.gitkeep',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

// Never copied out of the bundled snapshot. CI installs dependencies directly in
// `plugins/mobile-apps/template` (see .github/workflows/mobile-apps-script-tests.yml),
// and a maintainer checkout can accumulate Expo/Metro caches there, so a plain
// recursive copy would drag a large machine-specific tree into every new app.
const EXCLUDED_FROM_COPY = new Set(['node_modules', '.expo', '.powernative', '.tmp']);

// Markers proving the folder is an app this plugin already created. This set is
// deliberately wider than `assertFreshTemplate`'s: bootstrap runs before planning,
// so `native-app-plan.md` is still a created-app marker here, whereas at Step 5 the
// approved plan has legitimately been written into the folder already.
const CREATED_APP_MARKERS = [
  'memory-bank.md',
  'native-app-plan.md',
  '.datamodel-manifest.json',
];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function actionable(message) {
  // Exit code 2 marks a refusal the user can act on (wrong folder, existing app)
  // as opposed to an unexpected crash, so the skill can branch on it.
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function hasGeneratedServices(projectRoot) {
  const generatedServices = path.join(projectRoot, 'src', 'generated', 'services');
  return fs.existsSync(generatedServices)
    && fs.readdirSync(generatedServices).some((name) => name.endsWith('.ts'));
}

/**
 * Classify a candidate app folder. Returns one of:
 *   missing         — does not exist yet; safe to create and copy into
 *   empty           — exists with no meaningful content; safe to copy into
 *   template        — already a fresh template (the pre-existing manual flow)
 *   created-app     — an app this plugin already created; never a create target
 *   occupied        — has unrelated content; never a create target
 *   not-a-directory — a file already uses that path
 */
function classifyTarget(targetDir) {
  const resolved = path.resolve(targetDir);

  if (!fs.existsSync(resolved)) {
    return { state: 'missing', targetDir: resolved };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { state: 'not-a-directory', targetDir: resolved };
  }

  const entries = fs.readdirSync(resolved).filter((name) => !IGNORABLE_ENTRIES.has(name));
  if (entries.length === 0) {
    return { state: 'empty', targetDir: resolved };
  }

  const createdMarkers = CREATED_APP_MARKERS
    .filter((relativePath) => fs.existsSync(path.join(resolved, relativePath)));
  if (hasGeneratedServices(resolved)) {
    createdMarkers.push('src/generated/services/*.ts');
  }
  if (createdMarkers.length > 0) {
    return { state: 'created-app', targetDir: resolved, createdMarkers };
  }

  const missingTemplateFiles = REQUIRED_FILES
    .filter((relativePath) => !fs.existsSync(path.join(resolved, relativePath)));
  if (missingTemplateFiles.length === 0) {
    return { state: 'template', targetDir: resolved };
  }

  return { state: 'occupied', targetDir: resolved, missingTemplateFiles, entries: entries.sort() };
}

function assertBundledTemplate(templateRoot) {
  const missing = REQUIRED_FILES
    .filter((relativePath) => !fs.existsSync(path.join(templateRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(
      `Bundled template snapshot at ${templateRoot} is incomplete; missing: ${missing.join(', ')}. `
      + 'Reinstall or update the mobile-app plugin.',
    );
  }
}

function copyTemplate(templateRoot, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];

  const walk = (relativeDir) => {
    const sourceDir = path.join(templateRoot, relativeDir);
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (relativeDir === '' && EXCLUDED_FROM_COPY.has(entry.name)) continue;

      const relativePath = path.join(relativeDir, entry.name);
      const destination = path.join(targetDir, relativePath);

      if (entry.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        walk(relativePath);
        continue;
      }
      // The snapshot ships plain files only; anything else (symlink, socket) means the
      // plugin install is not intact and must not be silently reproduced in a user app.
      if (!entry.isFile()) {
        throw new Error(`Unsupported entry in bundled template: ${toPosix(relativePath)}`);
      }

      // COPYFILE_EXCL makes "never overwrite" an OS-enforced guarantee rather than a
      // check that could race with anything else writing into the folder.
      fs.copyFileSync(
        path.join(sourceDir, entry.name),
        destination,
        fs.constants.COPYFILE_EXCL,
      );
      copied.push(toPosix(relativePath));
    }
  };

  walk('');
  return copied.sort();
}

/**
 * Decide the app folder without asking the caller to branch:
 * an explicit `--working-dir` always wins; otherwise the current folder is reused
 * when it is already a fresh template (the manual degit flow), and a new
 * `<parentDir>/<slug>` folder is used in every other case.
 */
function resolveTargetDir({ workingDir, parentDir, slug }) {
  if (workingDir) return path.resolve(workingDir);

  const parent = path.resolve(parentDir || process.cwd());
  if (!slug) {
    throw new Error('--slug is required when --working-dir is not provided');
  }
  // The caller derives the slug from a user-supplied display name. Keep it a single
  // folder name so a name like "../etc" cannot relocate the new app outside the folder
  // the user ran the skill in; an explicit --working-dir remains the way to say "here".
  if (slug !== path.basename(slug) || slug === '.' || slug === '..') {
    throw new Error(`--slug must be a single folder name, not a path: ${slug}`);
  }
  return classifyTarget(parent).state === 'template' ? parent : path.join(parent, slug);
}

function bootstrapMobileProject(options) {
  const templateRoot = path.resolve(
    options.templateRoot || path.join(__dirname, '..', 'template'),
  );
  assertBundledTemplate(templateRoot);

  const targetDir = resolveTargetDir(options);
  const classification = classifyTarget(targetDir);

  switch (classification.state) {
    case 'template':
      // The manual `degit` + `npm install` flow still works; nothing to copy.
      return {
        targetDir,
        state: 'existing-template',
        templateSource: 'existing',
        copiedFiles: [],
        dependenciesInstalled: fs.existsSync(path.join(targetDir, 'node_modules', 'expo')),
      };

    case 'missing':
    case 'empty':
      break;

    case 'created-app':
      throw actionable(
        `${targetDir} already contains an app created by this plugin `
        + `(${classification.createdMarkers.join(', ')}). `
        + 'Use /edit-app to change it, or choose a different app name for a new app.',
      );

    case 'not-a-directory':
      throw actionable(`${targetDir} exists and is not a directory.`);

    default:
      throw actionable(
        `${targetDir} is not empty and is not a Power Apps mobile template `
        + `(missing ${classification.missingTemplateFiles.join(', ')}). `
        + 'Choose an empty or new folder for a new app.',
      );
  }

  const copiedFiles = copyTemplate(templateRoot, targetDir);
  return {
    targetDir,
    state: 'created',
    templateSource: 'bundled',
    copiedFiles,
    dependenciesInstalled: false,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--working-dir') options.workingDir = argv[++index];
    else if (argument === '--parent-dir') options.parentDir = argv[++index];
    else if (argument === '--slug') options.slug = argv[++index];
    else if (argument === '--template-root') options.templateRoot = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.workingDir && !options.slug) {
    throw new Error('Provide --working-dir <path>, or --slug <slug> with an optional --parent-dir');
  }
  return options;
}

if (require.main === module) {
  try {
    const result = bootstrapMobileProject(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode || 1);
  }
}

module.exports = {
  CREATED_APP_MARKERS,
  EXCLUDED_FROM_COPY,
  IGNORABLE_ENTRIES,
  assertBundledTemplate,
  bootstrapMobileProject,
  classifyTarget,
  copyTemplate,
  resolveTargetDir,
};

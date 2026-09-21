#!/usr/bin/env node

/**
 * Validates that every plugin's `hooks/hooks.json` carries only keys the host's
 * hook loader recognises.
 *
 * WHY: Claude Code validates `hooks.json` against a CLOSED schema and prints a
 * warning for any key it does not know:
 *
 *     model-apps: hooks.json: unknown key "_comment" ignored
 *
 * That line appears at EVERY session start, for every user of the plugin, and
 * reads as a plugin misconfiguration. The hooks themselves still work — the key
 * really is ignored — so nothing fails, no test catches it, and the noise
 * survives indefinitely. Two of the eight plugins shipped a `_comment` key
 * holding documentation prose (model-apps, mobile-apps); see issues #555 / #558.
 *
 * The prose is worth keeping, so it moved to `plugins/<plugin>/hooks/README.md`,
 * which has no schema at all. This check exists because a JSON file is exactly
 * where the next contributor will reach for a comment: JSON has no comment
 * syntax, `_comment` is the usual workaround, and the cost of getting it wrong
 * is invisible in review and only shows up in somebody else's terminal.
 *
 * Allowed top-level keys:
 *   - `hooks`       (required)   the event -> matcher -> command tree the loader reads.
 *   - `description` (optional)   a recognised, ignored-by-design documentation field.
 * Anything else fails, naming the file, the key, and where the prose should go.
 *
 * Scope: repo-wide over `plugins/<plugin>/hooks/hooks.json`. Unlike the
 * model-apps-scoped environment scan, there is no pre-existing violation
 * elsewhere to grandfather — canvas-apps already uses `description` and
 * power-pages ships `hooks` alone — so every plugin can be held to this today.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// `hooks` is what the loader actually executes; `description` is a documented,
// deliberately-ignored field several plugin ecosystems accept. Keep this list
// tight: the whole point is that an unrecognised key is a user-visible warning,
// so widening it without checking the host's schema re-creates the bug.
const ALLOWED_TOP_LEVEL_KEYS = new Set(['hooks', 'description']);

function toPosix(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

// Returns the list of problems with ONE parsed manifest. Pure and exported so the
// test can exercise the rule without writing files to disk.
function checkManifest(manifest, relPath) {
  const problems = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    problems.push(`${relPath}: expected a JSON object at the top level`);
    return problems;
  }

  for (const key of Object.keys(manifest)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(key)) continue;
    problems.push(
      `${relPath}: unknown top-level key "${key}". The host prints ` +
        `'hooks.json: unknown key "${key}" ignored' at every session start. ` +
        `Move prose to plugins/<plugin>/hooks/README.md.`
    );
  }

  if (!Object.prototype.hasOwnProperty.call(manifest, 'hooks')) {
    problems.push(`${relPath}: missing the required "hooks" key`);
  }

  return problems;
}

// Probe the canonical path per plugin rather than walking the tree: a hooks
// manifest is only loaded from plugins/<plugin>/hooks/hooks.json, so a file of
// that name anywhere else is not a manifest and must not be held to this schema.
function findHookManifests() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PLUGINS_DIR, entry.name, 'hooks', 'hooks.json'))
    .filter((filePath) => fs.existsSync(filePath));
}

function main() {
  const errors = [];
  const files = findHookManifests();

  for (const filePath of files) {
    const relPath = toPosix(path.relative(ROOT, filePath));
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      // A manifest that does not parse cannot load any hook at all, so this is a
      // shippable defect in its own right — fail rather than skip.
      errors.push(`${relPath}: could not parse JSON (${err.message})`);
      continue;
    }
    errors.push(...checkManifest(manifest, relPath));
  }

  if (errors.length > 0) {
    console.log('Plugin hooks.json validation failed:');
    for (const error of errors) console.log(`- ${error}`);
    console.log(
      `\nAllowed top-level keys: ${[...ALLOWED_TOP_LEVEL_KEYS].join(', ')}. ` +
        'JSON has no comment syntax — document the hooks in hooks/README.md instead.'
    );
    process.exit(1);
  }

  console.log(`All ${files.length} plugin hooks.json manifest(s) use only recognised top-level keys.`);
}

if (require.main === module) {
  main();
}

module.exports = { checkManifest, findHookManifests, ALLOWED_TOP_LEVEL_KEYS };

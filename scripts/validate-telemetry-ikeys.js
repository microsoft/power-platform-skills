#!/usr/bin/env node

/**
 * Validates that no two plugins share a telemetry instrumentation key or
 * event_stream_name.
 *
 * WHY: Plugins adopt the shared 1DS telemetry by copying the routing-agnostic
 * library, but each plugin must provision its OWN ikey.json (its own
 * instrumentation key(s), collector routing, and event_stream_name). The most
 * common adoption mistake is lifting an existing adopter's ikey.json wholesale
 * (e.g. copying power-pages' file), which silently mis-attributes the new
 * plugin's events to the other plugin's Kusto stream and pollutes it. Docs warn
 * against this (see the root AGENTS.md "Shared Telemetry" section), but only a
 * deterministic CI check can actually prevent the copy-paste collision. This
 * script turns that prose invariant into an enforced one: a PR that reuses
 * another plugin's key or stream name fails.
 *
 * ikey.json comes in two shapes, both of which are inspected here:
 *   Tier 1 (flat):    { "instrumentationKey": "...", "collector_url": "...", "event_stream_name": "..." }
 *   Tier 2 (regions): { "regions": { "us": { "instrumentation_key": "...", "collector_url": "..." }, ... }, "event_stream_name": "..." }
 * A single plugin legitimately reuses one key across regions (power-pages shares
 * one key for us/eu), so keys are de-duplicated PER PLUGIN — only reuse across
 * two different plugins is an error.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// Directories that never contain a real, provisioned plugin ikey.json and would
// only slow the walk (installed deps, VCS internals).
const SKIP_DIRS = new Set(['node_modules', '.git']);

// Placeholder values shipped by the shared template (shared/telemetry/ikey.json):
// every region key is "PLACEHOLDER_REPLACE_BEFORE_SHIPPING" and the stream name
// is "PluginEventStreamPlaceholder". A freshly-adopted, not-yet-provisioned
// plugin legitimately still carries these, so they must never count as a
// cross-plugin collision. Empty strings are also unprovisioned placeholders.
//
// Match ONLY the known template sentinels (and angle-bracket template strings
// like "<your 1DS instrumentation key>" from the README's Tier 1 example), not
// any string merely containing the substring "placeholder". A broad substring
// test would silently skip a legitimate key or event_stream_name that happened
// to include that word, letting a real cross-plugin collision slip through.
const TEMPLATE_SENTINELS = new Set([
  'PLACEHOLDER_REPLACE_BEFORE_SHIPPING', // shared/telemetry/ikey.json region keys
  'PluginEventStreamPlaceholder', // shared/telemetry/ikey.json event_stream_name
]);

function isPlaceholder(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (TEMPLATE_SENTINELS.has(trimmed)) return true;
  // Angle-bracket template strings copied verbatim from the docs, e.g.
  // "<your 1DS instrumentation key>" or "<region>".
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  return false;
}

function toPosix(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

// Recursively collect every file named `ikey.json` under plugins/. A recursive
// walk (rather than probing only the canonical
// plugins/<plugin>/scripts/lib/telemetry/ikey.json path) is defense-in-depth:
// it also catches a stray ikey.json dropped anywhere in a plugin tree by an
// over-broad copy of another plugin's telemetry directory.
function findIkeyFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...findIkeyFiles(path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name === 'ikey.json') {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// The plugin a file belongs to is the first path segment under plugins/, e.g.
// plugins/power-pages/scripts/lib/telemetry/ikey.json -> "power-pages".
function pluginNameForFile(filePath) {
  const rel = toPosix(path.relative(PLUGINS_DIR, filePath));
  return rel.split('/')[0];
}

// Pull every provisioned instrumentation key out of one parsed ikey.json,
// tagging each with a human-readable context so collision output can point at
// the exact region ("regions.us") or the flat key ("instrumentationKey").
function extractKeys(config) {
  const keys = [];

  if (typeof config.instrumentationKey === 'string') {
    keys.push({ value: config.instrumentationKey, context: 'instrumentationKey' });
  }

  if (config.regions && typeof config.regions === 'object') {
    for (const [region, entry] of Object.entries(config.regions)) {
      if (entry && typeof entry.instrumentation_key === 'string') {
        keys.push({ value: entry.instrumentation_key, context: `regions.${region}` });
      }
    }
  }

  return keys.filter((k) => !isPlaceholder(k.value));
}

const errors = [];

// key/stream value -> Map<pluginName, Set<"relativePath (context)">>. Using a
// Map keyed by plugin lets us treat intra-plugin reuse (same key across regions)
// as fine while flagging the same value appearing under two different plugins.
const keyOwners = new Map();
const streamOwners = new Map();

function record(owners, value, pluginName, location) {
  if (!owners.has(value)) owners.set(value, new Map());
  const byPlugin = owners.get(value);
  if (!byPlugin.has(pluginName)) byPlugin.set(pluginName, new Set());
  byPlugin.get(pluginName).add(location);
}

for (const filePath of findIkeyFiles(PLUGINS_DIR)) {
  const relPath = toPosix(path.relative(ROOT, filePath));
  const pluginName = pluginNameForFile(filePath);

  let config;
  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    // A malformed ikey.json is itself a shippable defect (it would break the
    // dispatcher at runtime), so fail deterministically rather than skip it.
    errors.push(`${relPath}: could not parse JSON (${err.message})`);
    continue;
  }

  for (const { value, context } of extractKeys(config)) {
    record(keyOwners, value, pluginName, `${relPath} (${context})`);
  }

  if (!isPlaceholder(config.event_stream_name)) {
    record(streamOwners, config.event_stream_name, pluginName, `${relPath} (event_stream_name)`);
  }
}

function collectCollisions(owners, label, redact) {
  for (const [value, byPlugin] of owners) {
    if (byPlugin.size < 2) continue; // reused within a single plugin is allowed

    const locations = [];
    for (const [pluginName, where] of byPlugin) {
      locations.push(`    ${pluginName}: ${[...where].sort().join(', ')}`);
    }
    const shown = redact ? redact(value) : value;
    errors.push(
      `${label} '${shown}' is shared across ${byPlugin.size} plugins:\n` +
        locations.sort().join('\n')
    );
  }
}

// Redact the instrumentation key in output. It is a committed value (not a
// secret per se), but there is no reason to reprint the full key in CI logs when
// a stable prefix already identifies which key collided.
function redactKey(value) {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

collectCollisions(keyOwners, 'Instrumentation key', redactKey);
collectCollisions(streamOwners, 'event_stream_name', null);

if (errors.length > 0) {
  console.log('Telemetry ikey.json validation failed:');
  for (const error of errors) {
    console.log(`- ${error}`);
  }
  console.log(
    '\nEach plugin must provision its own instrumentation key(s) and event_stream_name. ' +
      'Do not copy another plugin\'s ikey.json; start from the placeholder shared/telemetry/ikey.json.'
  );
  process.exit(1);
}

console.log('All plugin telemetry instrumentation keys and event stream names are unique.');

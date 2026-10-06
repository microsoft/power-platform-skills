'use strict';

/**
 * render-template.js — render an HTML artifact from a template plus data.
 *
 * Ported from the power-pages plugin's `scripts/lib/render-template.js`. Marketplace
 * installs copy one plugin directory, so cross-plugin `require` is impossible and each
 * adopting plugin keeps a physical copy - the same rule the shared skills and telemetry
 * libraries follow. Keep the encoder in step with that sibling.
 *
 * **Deliberate deviation from the sibling:** power-pages refuses to overwrite an existing
 * output file ("the caller must choose a unique name"), because its plans are point-in-time
 * documents. The mobile run plan is the opposite - one living document re-rendered at every
 * step boundary so the user can watch progress - so overwrite is opt-in via `allowOverwrite`.
 * It stays OFF by default so a one-shot artifact cannot silently clobber a previous run.
 *
 * Placeholders carry their own encoding context because one source value can legitimately
 * appear in both HTML and JavaScript:
 *   __NAME__        bare        -> HTML text for strings, JSON for structured values
 *   __HTML_NAME__   HTML text
 *   __ATTR_NAME__   HTML attribute
 *   __JSON_NAME__   JSON inside <script> (script-close sequences neutralised)
 *   __RAW_NAME__    trusted, code-owned markup only - never user or CLI data
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER_RE = /__(?:(HTML|ATTR|JSON|RAW)_)?([A-Z][A-Z0-9_]*)__/g;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function serializeJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('Template values in JSON contexts must be JSON-serializable');
  }
  // HTML parses a script end tag before it parses JavaScript or JSON content, so a string
  // containing "</script>" would end the block early. Neutralise those characters.
  // U+2028/U+2029 are valid JSON but terminate a JavaScript line, so a JSON blob containing
  // one would break the <script> it is embedded in. Built via char code because writing the
  // literal separator into a regex source is itself a syntax hazard.
  const LINE_SEPARATORS = new RegExp('[\\u2028\\u2029]', 'g');
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(LINE_SEPARATORS, (ch) => (ch === '\u2028' ? '\\u2028' : '\\u2029'));
}

function renderValue(value, context) {
  if (context === 'RAW') return String(value);
  if (context === 'ATTR') return escapeHtmlAttribute(value);
  if (context === 'JSON') return serializeJson(value);
  return escapeHtml(value);
}

function renderTemplate({
  templatePath,
  outputPath,
  dataObject,
  requiredKeys = [],
  allowOverwrite = false,
}) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  if (!dataObject || typeof dataObject !== 'object') {
    throw new Error('dataObject is required');
  }

  const missing = requiredKeys.filter((key) => !(key in dataObject));
  if (missing.length > 0) {
    throw new Error(`Missing required keys: ${missing.join(', ')}`);
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  const data = { ...dataObject, CSP_NONCE: crypto.randomBytes(16).toString('base64') };

  // Collected from the template while it is being filled, never by scanning the output. The
  // output also holds the substituted data, and plan data can legitimately contain
  // placeholder-shaped text - React Native's `__DEV__` flag in a note, say. Scanning the output
  // reported that as an unreplaced placeholder and failed the write, and because the value was
  // already saved in the plan state, every later write failed with it.
  const unreplaced = new Set();
  const result = template.replace(PLACEHOLDER_RE, (placeholder, explicitContext, key) => {
    if (!(key in data)) {
      unreplaced.add(placeholder);
      return placeholder;
    }
    const context = explicitContext || (typeof data[key] === 'string' ? 'HTML' : 'JSON');
    return renderValue(data[key], context);
  });

  if (unreplaced.size > 0) {
    throw new Error(`Unreplaced placeholders: ${[...unreplaced].join(', ')}`);
  }

  if (!allowOverwrite && fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite ${outputPath}; pass allowOverwrite for living documents.`);
  }

  return publishAtomic(outputPath, result);
}

// Windows will not replace a file that another process holds open without delete sharing - a
// browser reading the plan as it reloads, or an antivirus scanner inspecting the file just
// written - and reports it as EPERM, EACCES or EBUSY. The hold lasts milliseconds, so retry for
// up to about a second instead of dropping the update. graceful-fs retries renames on win32 for
// the same reason: https://github.com/isaacs/node-graceful-fs/blob/main/polyfills.js
// A POSIX rename replaces an open file atomically and never takes the retry.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 20;
const RENAME_BACKOFF_MS = 50;

/**
 * Write a file so a reader never sees it half-written: the content goes to a sibling temporary
 * file, which is then renamed over the target. A reader opens either the previous file or the
 * next one.
 */
function publishAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, content, 'utf8');
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temporary, filePath);
      return filePath;
    } catch (error) {
      if (!RENAME_RETRY_CODES.has(error.code) || attempt >= RENAME_ATTEMPTS) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      // A synchronous pause: this runs inside a short-lived CLI with nothing else to schedule.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS);
    }
  }
}

module.exports = {
  PLACEHOLDER_RE,
  escapeHtml,
  escapeHtmlAttribute,
  publishAtomic,
  renderTemplate,
  renderValue,
  serializeJson,
};

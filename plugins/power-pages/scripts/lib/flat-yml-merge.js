'use strict';

// Helpers for selectively merging a Power Pages **flat `.sitesetting.yml`** as a real
// 3-way text file. A site setting (type 9) serializes its whole component to ONE flat
// yml that mixes system-managed metadata (componentid/websiteid/name) with a single
// editable `value:` line. Because the metadata is IDENTICAL on the env, ADO, and base
// sides (it's the same component), git auto-merges those lines and ONLY the `value:`
// line ever conflicts — so merging the whole yml is safe (a GUID is never hand-merged).
//
// These helpers (a) READ the editable `value:` scalar out of a yml — used to compare
// env vs branch and to verify the pulled result — and (b) WRITE a new `value:` back
// into a yml while preserving every other line — used to synthesize the OURS side of
// the staged merge from the environment's value.

// Top-level `value:` line (the editable site-setting field).
const VALUE_LINE = /^value:[ \t]*(.*)$/m;

/**
 * Read the `value:` scalar out of a `.sitesetting.yml`, unquoted.
 * @param {string} yml
 * @returns {string|null} the value, or null when there is no `value:` line.
 */
function extractYamlValue(yml) {
  const m = String(yml == null ? '' : yml).match(VALUE_LINE);
  if (!m) return null;
  return unquoteYamlScalar(m[1].trim());
}

/** Undo single/double quoting on a single-line yaml scalar. */
function unquoteYamlScalar(s) {
  if (s == null) return s;
  const t = String(s);
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  return t;
}

/**
 * Serialize a single-line scalar for a yaml `value:`. Plain (unquoted) when safe —
 * which matches how Dataverse Git writes ordinary scalars (DENY, 500, SAMEORIGIN) —
 * otherwise single-quoted (internal single quotes doubled) so the yml stays valid.
 * NOTE: only single-line values are supported here; callers route multi-line values
 * to keep/accept instead (see resolveUnits).
 * @param {*} v
 * @returns {string}
 */
function yamlScalar(v) {
  const s = String(v == null ? '' : v);
  const needsQuote = s === '' ||
    /[:#[\]{}&*!|>'"%@`,]/.test(s) ||
    /^[\s?-]/.test(s) || /\s$/.test(s) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s);
  return needsQuote ? `'${s.replace(/'/g, "''")}'` : s;
}

/**
 * Replace the `value:` line of a yml with a new value, preserving every other line.
 * A function replacer is used so `$` in the value is never treated as a backreference.
 * @param {string} yml   the original yml (metadata + value)
 * @param {*} value      the new scalar value
 * @returns {string}
 */
function substituteYamlValue(yml, value) {
  const line = `value: ${yamlScalar(value)}`;
  const s = String(yml == null ? '' : yml);
  if (VALUE_LINE.test(s)) return s.replace(VALUE_LINE, () => line);
  // No value line (shouldn't happen for a site setting) → append one.
  const trimmed = s.replace(/\s*$/, '');
  return (trimmed ? trimmed + '\n' : '') + line + '\n';
}

/**
 * Is this conflict roster entry / merge unit a flat-YML site setting?
 * Recognized via an explicit flag (flatYml / format), the numeric type 9, or the
 * `.sitesetting.yml` path suffix.
 * @param {object} u
 * @returns {boolean}
 */
function isFlatYmlUnit(u) {
  if (!u) return false;
  if (u.flatYml === true || u.format === 'flat-yml') return true;
  if (u.type === 9 || u.type === '9') return true;
  const p = u.adoPath || u.path || '';
  return /\.sitesetting\.yml$/i.test(String(p));
}

module.exports = { extractYamlValue, substituteYamlValue, yamlScalar, unquoteYamlScalar, isFlatYmlUnit };

'use strict';

// Rule sources are intentionally separated:
// - The public PAC CLI reference documents the character rules for `pac pcf init`
//   namespace/control-name/publisher-prefix inputs.
//   See: https://learn.microsoft.com/power-platform/developer/cli/reference/pcf
// - Additional safeguards: not on the Learn page; `pac pcf init` refuses these
//   at run time, so we fail earlier with a clearer message. That includes the
//   75-character namespace+control-name limit and JavaScript reserved-word
//   constructor names.
const MAX_NAMESPACE_AND_CONTROL_LENGTH = 75;
const MAX_SOLUTION_UNIQUE_NAME_LENGTH = 65;

const JS_RESERVED_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const NAMESPACE_ALLOWED = "Allowed: letters, digits, and '.' with non-empty segments that do not start with a digit.";
const NAMESPACE_LENGTH_ALLOWED = `Allowed: namespace plus control name must be at most ${MAX_NAMESPACE_AND_CONTROL_LENGTH} characters.`;
const CONTROL_ALLOWED = 'Allowed: letters and digits, starting with a letter.';
const CONTROL_RESERVED_ALLOWED = 'Allowed: letters and digits, starting with a letter, and not a JavaScript reserved word.';
const PREFIX_ALLOWED = 'Allowed: letters and digits, starting with a letter, not starting with "mscrm", and 2 to 8 characters.';
const VERSION_ALLOWED = 'Allowed: digits in x.y.z format.';
const SOLUTION_UNIQUE_NAME_ALLOWED = `Allowed: letters, digits, and underscores, starting with a letter or underscore, at most ${MAX_SOLUTION_UNIQUE_NAME_LENGTH} characters.`;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function validateNamespace(namespace, controlName = '') {
  const ns = asString(namespace);
  const name = asString(controlName);

  if ((ns.length + name.length) > MAX_NAMESPACE_AND_CONTROL_LENGTH) {
    return `Additional safeguard: pac pcf init rejects namespace plus control name values longer than ${MAX_NAMESPACE_AND_CONTROL_LENGTH} characters at run time. ${NAMESPACE_LENGTH_ALLOWED}`;
  }

  if (ns.length === 0) {
    return `Namespace is required. ${NAMESPACE_ALLOWED}`;
  }

  if (!/^[A-Za-z0-9.]+$/.test(ns)) {
    return `Namespace contains characters other than letters, digits, and '.'. ${NAMESPACE_ALLOWED}`;
  }

  if (ns.startsWith('.') || ns.endsWith('.')) {
    return `Namespace must not start or end with '.'. ${NAMESPACE_ALLOWED}`;
  }

  if (ns.includes('..')) {
    return `Namespace must not contain empty segments. ${NAMESPACE_ALLOWED}`;
  }

  for (const segment of ns.split('.')) {
    if (/^\d/.test(segment)) {
      return `Namespace segment "${segment}" must not start with a digit. ${NAMESPACE_ALLOWED}`;
    }
  }

  return null;
}

function validateControlName(name, namespace = '') {
  const controlName = asString(name);
  const ns = asString(namespace);

  if ((ns.length + controlName.length) > MAX_NAMESPACE_AND_CONTROL_LENGTH) {
    return `Additional safeguard: pac pcf init rejects namespace plus control name values longer than ${MAX_NAMESPACE_AND_CONTROL_LENGTH} characters at run time. ${NAMESPACE_LENGTH_ALLOWED}`;
  }

  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(controlName)) {
    return `Control name must start with a letter and contain only letters and digits. ${CONTROL_ALLOWED}`;
  }

  if (JS_RESERVED_WORDS.has(controlName)) {
    return `Additional safeguard: pac pcf init rejects JavaScript reserved word control names at run time; "${controlName}" is reserved. ${CONTROL_RESERVED_ALLOWED}`;
  }

  return null;
}

function validatePublisherPrefix(prefix) {
  const p = asString(prefix);

  if (!/^[A-Za-z][A-Za-z0-9]{1,7}$/.test(p)) {
    return `Publisher prefix must be 2 to 8 characters, start with a letter, and contain only letters and digits. ${PREFIX_ALLOWED}`;
  }

  if (/^mscrm/i.test(p)) {
    return `Publisher prefix must not start with "mscrm". ${PREFIX_ALLOWED}`;
  }

  return null;
}

function validateVersion(version) {
  const v = asString(version);

  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    return `Version must be three dot-separated numeric parts. ${VERSION_ALLOWED}`;
  }

  return null;
}

function validateSolutionUniqueName(name) {
  const value = asString(name);

  // Dataverse exposes solution.uniquename as the solution identity used by PAC and caps it at 65
  // characters. The character allow-list also keeps the value shell-safe for the Windows pac.cmd
  // path, where `pac` must run through cmd.exe.
  // See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/solution#uniquename
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return `Solution unique name must start with a letter or underscore and contain only letters, digits, and underscores. ${SOLUTION_UNIQUE_NAME_ALLOWED}`;
  }

  if (value.length > MAX_SOLUTION_UNIQUE_NAME_LENGTH) {
    return `Solution unique name must be at most ${MAX_SOLUTION_UNIQUE_NAME_LENGTH} characters. ${SOLUTION_UNIQUE_NAME_ALLOWED}`;
  }

  return null;
}

function orgControlName(prefix, namespace, constructor) {
  return `${prefix}_${namespace}.${constructor}`;
}

// Parse raw org control names shaped as:
//   contoso_Contoso.Controls.StarRating
//     -> { prefix: 'contoso', namespace: 'Contoso.Controls', constructor: 'StarRating' }
// Split at the first underscore because publisher prefixes cannot contain `_`; split
// at the last dot because namespaces can contain dots. Return null when there is no
// `_`, no `.`, or any parsed part would be empty.
function parseOrgControlName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const underscore = value.indexOf('_');
  const dot = value.lastIndexOf('.');
  if (underscore <= 0 || dot <= underscore + 1 || dot === value.length - 1) {
    return null;
  }

  return {
    prefix: value.slice(0, underscore),
    namespace: value.slice(underscore + 1, dot),
    constructor: value.slice(dot + 1),
  };
}

function bumpPatch(version) {
  const parts = version.split('.');
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
}

module.exports = {
  validateNamespace,
  validateControlName,
  validatePublisherPrefix,
  validateSolutionUniqueName,
  validateVersion,
  orgControlName,
  parseOrgControlName,
  bumpPatch,
};

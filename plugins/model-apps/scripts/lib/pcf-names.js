'use strict';

const MAX_NAMESPACE_AND_CONTROL_LENGTH = 75;

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

const NAMESPACE_ALLOWED = "Allowed: letters, digits, and '.' with non-empty segments that do not start with a digit; namespace plus control name must be at most 75 characters.";
const CONTROL_ALLOWED = 'Allowed: letters and digits, starting with a letter, and not a JavaScript reserved word.';
const PREFIX_ALLOWED = 'Allowed: letters and digits, starting with a letter, not starting with "mscrm", and 2 to 8 characters.';
const VERSION_ALLOWED = 'Allowed: digits in x.y.z format.';

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function validateNamespace(namespace, controlName = '') {
  const ns = asString(namespace);
  const name = asString(controlName);

  // These PCF naming rules mirror the public `pac pcf init` / `pac pcf push`
  // CLI contract. Keeping the combined namespace + control-name guard here means
  // later scripts can validate values before they reach PAC, a manifest, or
  // scaffolded project files.
  // See: https://learn.microsoft.com/power-platform/developer/cli/reference/pcf
  if ((ns.length + name.length) > MAX_NAMESPACE_AND_CONTROL_LENGTH) {
    return `Namespace plus control name must be at most ${MAX_NAMESPACE_AND_CONTROL_LENGTH} characters. ${NAMESPACE_ALLOWED}`;
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
    return `Control name plus namespace must be at most ${MAX_NAMESPACE_AND_CONTROL_LENGTH} characters. ${CONTROL_ALLOWED}`;
  }

  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(controlName)) {
    return `Control name must start with a letter and contain only letters and digits. ${CONTROL_ALLOWED}`;
  }

  if (JS_RESERVED_WORDS.has(controlName)) {
    return `Control name "${controlName}" is a JavaScript reserved word. ${CONTROL_ALLOWED}`;
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

function orgControlName(prefix, namespace, constructor) {
  return `${prefix}_${namespace}.${constructor}`;
}

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
  validateVersion,
  orgControlName,
  parseOrgControlName,
  bumpPatch,
};

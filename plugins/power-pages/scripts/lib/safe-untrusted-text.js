'use strict';

const UNSAFE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_CONTROL_GLOBAL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeUntrustedText(value, maxChars = 200) {
  const text = String(value ?? '');
  const bounded = text.length > maxChars
    ? `${text.slice(0, maxChars)}...`
    : text;
  return bounded.replace(
    UNSAFE_CONTROL_GLOBAL_PATTERN,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function quoteUntrustedText(value, maxChars = 200) {
  return JSON.stringify(sanitizeUntrustedText(value, maxChars));
}

function isSafeBoundedText(value, maxChars) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !UNSAFE_CONTROL_PATTERN.test(value);
}

module.exports = {
  isSafeBoundedText,
  quoteUntrustedText,
  sanitizeUntrustedText,
};

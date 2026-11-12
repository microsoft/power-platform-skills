"use strict";

// Placeholder. The spec allowlist already restricts payload fields to values
// that cannot contain PII. This module exists as a documented seam for a
// future regex-based pass if the allowlist ever needs to carry user strings.

function scrub(value) {
  return value;
}

module.exports = { scrub };

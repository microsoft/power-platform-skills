#!/usr/bin/env node

// Generates a random UUID v4.
// Output: a UUID string like "778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444"
// Self-contained — no external dependencies required.
//
// Can be used as a CLI tool (node generate-uuid.js) or as a module:
//   const generateUuid = require('./generate-uuid');
//   const uuid = generateUuid();

const { randomBytes } = require('crypto');

function generateUuid() {
  const bytes = randomBytes(16);
  // Set version (4) and variant (RFC 4122) bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

module.exports = generateUuid;

// When run directly as a CLI tool, output the UUID to stdout
if (require.main === module) {
  process.stdout.write(generateUuid());
}

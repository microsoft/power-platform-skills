#!/usr/bin/env node

// Base64-encodes a solution zip file for use in Dataverse OData request bodies.
// Handles large files by reading in chunks and encoding with Node.js built-ins.
//
// Usage:
//   node encode-solution-file.js --zipPath "/path/to/solution.zip"
//
// Output (JSON to stdout):
//   { "encoded": "<base64 string>", "fileSizeBytes": 12345, "fileName": "solution.zip" }
//   { "error": "..." }   — when the file is missing or cannot be read

const fs = require('fs');
const path = require('path');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function parseArgs(argv) {
  const args = {};
  const idx = argv.indexOf('--zipPath');
  if (idx !== -1 && idx + 1 < argv.length) {
    args.zipPath = argv[idx + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.zipPath) {
  output({ error: 'Missing required argument: --zipPath' });
}

const resolvedPath = path.resolve(args.zipPath);

if (!fs.existsSync(resolvedPath)) {
  output({ error: `File not found: ${resolvedPath}` });
}

const stat = fs.statSync(resolvedPath);
if (!stat.isFile()) {
  output({ error: `Path is not a file: ${resolvedPath}` });
}

if (stat.size === 0) {
  output({ error: `File is empty: ${resolvedPath}` });
}

try {
  // Read entire file as Buffer and encode to base64
  // Node.js handles this efficiently for files up to ~100MB
  const buffer = fs.readFileSync(resolvedPath);
  const encoded = buffer.toString('base64');

  output({
    encoded,
    fileSizeBytes: stat.size,
    fileName: path.basename(resolvedPath),
  });
} catch (err) {
  output({ error: `Failed to read file: ${err.message}` });
}

#!/usr/bin/env node

// Validates that new web role YAML files were created in .powerpages-site/web-roles/.
// Runs as a Stop hook to verify the skill produced output.

const fs = require('fs');
const path = require('path');

// Exit 0 = success (allow). Exit 2 = blocking error (stderr is fed back to Claude).
const approve = () => { process.exit(0); };
const block = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};

let inputData = '';
process.stdin.on('data', chunk => (inputData += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    const cwd = input.cwd;

    if (!cwd) approve();

    const webRolesDir = findWebRolesDir(cwd);
    if (!webRolesDir) approve(); // No .powerpages-site found — not a web roles session

    const files = fs.readdirSync(webRolesDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    if (files.length === 0) {
      block('Web roles validation failed:\n- No web role YAML files found in .powerpages-site/web-roles/');
    }

    const errors = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(webRolesDir, file), 'utf8');

      // Validate required fields
      if (!content.includes('id:')) {
        errors.push(`${file}: missing "id" field`);
      }
      if (!content.includes('name:')) {
        errors.push(`${file}: missing "name" field`);
      }

      // Validate UUID format in id field
      const idMatch = content.match(/^id:\s*(.+)$/m);
      if (idMatch) {
        const id = idMatch[1].trim();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
          errors.push(`${file}: invalid UUID format in "id" field: ${id}`);
        }
      }
    }

    if (errors.length > 0) {
      block('Web roles validation failed:\n- ' + errors.join('\n- '));
    }

    approve();
  } catch {
    // Don't block on script errors
    approve();
  }
});

function findWebRolesDir(dir) {
  // Check direct path
  const direct = path.join(dir, '.powerpages-site', 'web-roles');
  if (fs.existsSync(direct)) return direct;

  // Check one level of subdirectories
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, '.powerpages-site', 'web-roles');
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

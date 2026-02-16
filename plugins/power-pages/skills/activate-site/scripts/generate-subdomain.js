#!/usr/bin/env node

// Generates a random subdomain suggestion for Power Pages site activation.
// Outputs format: site-a3f2b1 (6 hex chars = 16.7M combinations)

const crypto = require('crypto');
const hex = crypto.randomBytes(3).toString('hex');
process.stdout.write(`site-${hex}`);

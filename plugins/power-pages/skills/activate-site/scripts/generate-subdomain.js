#!/usr/bin/env node

// Generates a random subdomain suggestion for Power Pages site activation.
// Mirrors Power Pages Studio logic: Math.random().toString(36) for base-36 suffix.
// Outputs format: site-uc8f3 (5 base-36 chars: 0-9 + a-z)

const suffix = Math.random().toString(36).slice(2, 7);
process.stdout.write(`site-${suffix}`);

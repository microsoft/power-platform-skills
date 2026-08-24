#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const FORBIDDEN_KEY = /(?:email|user|password|2fa|otp|session|cookie|token|secret|credential)/i;
const MAX_AGE_MS = 60 * 60 * 1000;

function forbidden(value, key = '$') {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbidden(item, `${key}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([name, child]) => [
      ...(FORBIDDEN_KEY.test(name) ? [`${key}.${name}`] : []),
      ...forbidden(child, `${key}.${name}`),
    ]);
  }
  return typeof value === 'string' && EMAIL.test(value) ? [key] : [];
}

function validate(document, { expectedTeam, expectedBundle, now = new Date() }) {
  const issues = [];
  if (document?.version !== 1 || document?.status !== 'ready') issues.push('invalid-envelope');
  if (!TEAM_ID.test(document?.teamId || '') || document.teamId !== expectedTeam) issues.push('team-mismatch');
  if (!BUNDLE_ID.test(document?.bundleId || '') || document.bundleId !== expectedBundle) issues.push('bundle-mismatch');
  if (document?.authentication?.method !== 'interactive-apple-id'
      || document?.authentication?.teamMembership !== 'verified') issues.push('authentication-unproven');
  for (const permission of ['certificates', 'identifiers', 'profiles']) {
    if (document?.permissions?.[permission] !== true) issues.push(`${permission}-permission-unproven`);
  }
  if (document?.agreements?.status !== 'clear') issues.push('agreements-blocking');
  if (!['present', 'missing'].includes(document?.identifier?.status)) issues.push('identifier-status-invalid');
  if (document?.proof?.verifier !== 'apple-fastlane-preflight'
      || document?.proof?.verifierVersion !== '1.0.0') issues.push('proof-verifier-invalid');
  const verifiedAt = Date.parse(document?.proof?.verifiedAt);
  const validUntil = Date.parse(document?.proof?.validUntil);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(validUntil)
      || validUntil <= verifiedAt || validUntil - verifiedAt > MAX_AGE_MS
      || now.getTime() > validUntil || verifiedAt > now.getTime() + 5 * 60 * 1000) {
    issues.push('proof-window-invalid');
  }
  if (forbidden(document).length > 0) issues.push('sensitive-content-forbidden');
  return [...new Set(issues)];
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  const args = { projectRoot: process.cwd(), file: 'apple-ios-preflight.json' };
  const names = {
    '--project-root': 'projectRoot',
    '--file': 'file',
    '--expected-team': 'expectedTeam',
    '--expected-bundle': 'expectedBundle',
    '--now': 'now',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = names[argv[index]];
    if (!name || !argv[index + 1]) throw new Error('Invalid arguments.');
    args[name] = argv[index + 1];
    index += 1;
  }
  if (!TEAM_ID.test(args.expectedTeam || '') || !BUNDLE_ID.test(args.expectedBundle || '')) {
    throw new Error('Expected identity is required.');
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const requestedRoot = path.resolve(args.projectRoot);
    const rootStat = fs.lstatSync(requestedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Unsafe root.');
    const root = fs.realpathSync(requestedRoot);
    const file = path.resolve(root, args.file);
    if (!isWithin(file, root)) throw new Error('Unsafe file.');
    let cursor = root;
    for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Unsafe file.');
    }
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    const issues = validate(document, {
      expectedTeam: args.expectedTeam,
      expectedBundle: args.expectedBundle,
      now: args.now ? new Date(args.now) : new Date(),
    });
    process.stdout.write(`${JSON.stringify({
      status: issues.length === 0 ? 'valid' : 'invalid',
      teamId: document.teamId,
      bundleId: document.bundleId,
      identifierStatus: document.identifier?.status,
      issues,
    }, null, 2)}\n`);
    return issues.length === 0 ? 0 : 2;
  } catch {
    process.stdout.write('{"status":"error","issues":["unable-to-validate-preflight"]}\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { forbidden, main, validate };

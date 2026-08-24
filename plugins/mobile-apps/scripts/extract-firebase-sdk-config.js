#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  firstUnexpectedCredentialText,
  firstUnsafeScalarText,
} = require('./lib/mcp-result-safety');

const MAX_INPUT_BYTES = 1024 * 1024;
const EXPECTED_FILENAMES = Object.freeze({
  android: 'google-services.json',
  ios: 'GoogleService-Info.plist',
});

class SafeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function issue(code, field, message) {
  return { code, field, message };
}

function parseArgs(argv, cwd = process.cwd()) {
  const parsed = {
    projectRoot: cwd,
    platform: null,
    input: null,
    output: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg !== '--project-root' && arg !== '--platform' && arg !== '--input' && arg !== '--output') {
      throw new SafeError('unknown-argument', `Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new SafeError('missing-argument-value', `${arg} requires a value.`);
    }
    if (arg === '--project-root') parsed.projectRoot = value;
    else if (arg === '--platform') parsed.platform = value.toLowerCase();
    else if (arg === '--input') parsed.input = value;
    else parsed.output = value;
    index += 1;
  }

  if (!parsed.help) {
    if (!parsed.platform || !parsed.output) {
      throw new SafeError(
        'missing-required-argument',
        'Missing platform or output path.',
      );
    }
    if (!Object.prototype.hasOwnProperty.call(EXPECTED_FILENAMES, parsed.platform)) {
      throw new SafeError('unsupported-platform', '--platform must be android or ios.');
    }
  }
  return parsed;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveProjectRoot(projectRootArg) {
  const requested = path.resolve(projectRootArg);
  let stat;
  try {
    stat = fs.statSync(requested);
  } catch {
    throw new SafeError('project-root-not-found', 'Project root does not exist.');
  }
  if (!stat.isDirectory()) {
    throw new SafeError('project-root-not-directory', 'Project root must be a directory.');
  }
  return fs.realpathSync(requested);
}

function resolveInputPath(projectRoot, inputArg) {
  const requested = path.resolve(projectRoot, inputArg);
  if (!isWithinRoot(requested, projectRoot)) {
    throw new SafeError('input-outside-project-root', 'Input file must be inside project root.');
  }
  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch {
    throw new SafeError('input-not-found', 'Input file does not exist.');
  }
  if (stat.isSymbolicLink()) {
    throw new SafeError('input-symbolic-link', 'Input file must not be a symbolic link.');
  }
  if (!stat.isFile()) {
    throw new SafeError('input-not-file', 'Input path must be a regular file.');
  }
  const resolved = fs.realpathSync(requested);
  if (!isWithinRoot(resolved, projectRoot)) {
    throw new SafeError('input-outside-project-root', 'Input file must be inside project root.');
  }
  return resolved;
}

function resolveOutputPath(projectRoot, outputArg) {
  const requested = path.resolve(projectRoot, outputArg);
  if (!isWithinRoot(requested, projectRoot)) {
    throw new SafeError('output-outside-project-root', 'Output file must be inside project root.');
  }
  const parent = path.dirname(requested);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    throw new SafeError('output-parent-not-found', 'Output file parent directory does not exist.');
  }
  if (parentStat.isSymbolicLink()) {
    throw new SafeError('output-parent-symbolic-link', 'Output file parent directory must not be a symbolic link.');
  }
  if (!parentStat.isDirectory()) {
    throw new SafeError('output-parent-not-directory', 'Output file parent must be a directory.');
  }
  const realParent = fs.realpathSync(parent);
  if (!isWithinRoot(realParent, projectRoot)) {
    throw new SafeError('output-outside-project-root', 'Output file must be inside project root.');
  }
  try {
    const existing = fs.lstatSync(requested);
    if (existing.isSymbolicLink()) {
      throw new SafeError('output-symbolic-link', 'Output file must not be a symbolic link.');
    }
    if (!existing.isFile()) {
      throw new SafeError('output-not-file', 'Output path must be a regular file.');
    }
    const resolved = fs.realpathSync(requested);
    if (!isWithinRoot(resolved, projectRoot)) {
      throw new SafeError('output-outside-project-root', 'Output file must be inside project root.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return requested;
}

async function readStdin(stream) {
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      throw new SafeError('input-too-large', `MCP output exceeds ${MAX_INPUT_BYTES} bytes.`);
    }
  }
  if (input.trim() === '') {
    throw new SafeError('input-empty', 'Expected Firebase MCP output on stdin.');
  }
  return input;
}

function readFileText(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_INPUT_BYTES) {
    throw new SafeError('input-too-large', `MCP output exceeds ${MAX_INPUT_BYTES} bytes.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function extractFirebaseSdkConfig(raw, platform) {
  const match = raw.match(
    /^\s*SDK config content for `([^`\r\n]+)`:\s*\r?\n\r?\n```(?:[A-Za-z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```\s*$/,
  );
  if (!match) {
    throw new SafeError(
      'sdk-config-wrapper-invalid',
      'Firebase SDK config output must match the documented fenced wrapper exactly.',
    );
  }
  const filename = match[1];
  const expectedFilename = EXPECTED_FILENAMES[platform];
  const unsafeFilename = firstUnsafeScalarText(filename, { context: 'Firebase SDK config filename' });
  if (unsafeFilename) throw new SafeError(unsafeFilename.code, unsafeFilename.message);
  if (filename !== expectedFilename) {
    throw new SafeError(
      'sdk-config-filename-mismatch',
      `Expected ${expectedFilename} but MCP returned ${filename}.`,
    );
  }
  const content = match[2];
  const credentialFinding = firstUnexpectedCredentialText(content, {
    context: `Firebase SDK config content for ${filename}`,
  });
  if (credentialFinding) {
    throw new SafeError(credentialFinding.code, credentialFinding.message);
  }
  return { filename, content };
}

function usage() {
  return [
    'Usage: node extract-firebase-sdk-config.js --project-root <path>',
    '  --platform <android|ios> --output <project-local-path> [--input <project-local-path>]',
    '',
    'Reads the exact raw Firebase MCP get_sdk_config text from --input or stdin,',
    'validates the documented wrapper, and writes only the fenced config file contents.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), stdin = process.stdin, cwd = process.cwd()) {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }

    const projectRoot = resolveProjectRoot(args.projectRoot);
    const outputPath = resolveOutputPath(projectRoot, args.output);
    let raw;
    let source;
    if (args.input) {
      const inputPath = resolveInputPath(projectRoot, args.input);
      raw = readFileText(inputPath);
      source = { kind: 'file', path: path.relative(projectRoot, inputPath).split(path.sep).join('/') };
    } else {
      raw = await readStdin(stdin);
      source = { kind: 'stdin' };
    }
    const extracted = extractFirebaseSdkConfig(raw, args.platform);
    fs.writeFileSync(outputPath, extracted.content);
    process.stdout.write(`${JSON.stringify({
      status: 'ready',
      platform: args.platform,
      filename: extracted.filename,
      output: path.relative(projectRoot, outputPath).split(path.sep).join('/'),
      source,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof SafeError
      ? error
      : new SafeError('unexpected-error', 'Unable to extract Firebase SDK config.');
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      issues: [issue(safe.code, 'input', safe.message)],
    }, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  EXPECTED_FILENAMES,
  extractFirebaseSdkConfig,
  isWithinRoot,
  main,
  parseArgs,
};

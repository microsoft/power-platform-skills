'use strict';

const pathKey = (name) => String(name || '').replace(/\\/g, '/');
const fileName = (name) => pathKey(name).split('/').at(-1);
const isGuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function artifactText(fixture, name) {
  const key = pathKey(name);
  const value = fixture.artifacts?.[key] ?? fixture.files?.find((file) => file.name === key)?.content;
  if (typeof value !== 'string') throw new Error(`missing artifact ${key || '(no path)'}`);
  return value;
}

function artifactJson(fixture, name) {
  try { return JSON.parse(artifactText(fixture, name).replace(/^\uFEFF/, '')); } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
}

function commandInfo(call) {
  // Current evidence may keep argv directly. The fallback only tokenizes recorded command TEXT;
  // it never expands variables, evaluates quotes or executes a shell. Maker text must be in files,
  // so the current transport does not need a shell parser for arbitrary prompt/name contents.
  const tokens = call.argv || (String(call.command || '').match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [])
    .map((token) => /^["']/.test(token) ? token.slice(1, -1) : token);
  const flags = {};
  const positional = [];
  const problems = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(tokens[i]);
    if (!match) { positional.push(tokens[i]); continue; }
    const name = match[1];
    if (Object.hasOwn(flags, name)) problems.push(`duplicate --${name}`);
    flags[name] = match[2] !== undefined ? match[2]
      : tokens[i + 1] && !tokens[i + 1].startsWith('--') ? tokens[++i] : true;
  }
  return { flags, positional, problems };
}

function gradeEvidence(check, fixture) {
  try {
    const problems = check(fixture);
    return problems.length ? { status: 'fail', reason: problems[0] } : { status: 'pass', reason: '' };
  } catch (error) {
    // Missing/malformed evidence is an eval FAILURE, never a success-shaped skip.
    return { status: 'fail', reason: error.message };
  }
}

module.exports = { pathKey, fileName, isGuid, artifactText, artifactJson, commandInfo, gradeEvidence };

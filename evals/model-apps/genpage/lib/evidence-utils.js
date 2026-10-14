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

// Recorded command text as tokens. A token is a "double-quoted" or 'single-quoted' run, which loses
// its quotes, or a run of other text up to a space or a quote; a quote with no partner is dropped.
//
// One join: a quoted run right after a `--flag=` token is that flag's value. The shell passes
// `--env='https://contoso.crm.dynamics.com'` to the script as the ONE argument
// `--env=https://contoso.crm.dynamics.com`; as two tokens, the URL was the first positional argument,
// so the graders took it for the verb and missed the write after it (`apps.js --env='…' create`).
// Nothing else is joined, though a shell would join more: a log writes the command inside markdown
// backticks (`node … --app-id '…'`), and the closing backtick right after a quoted value is no part
// of that value.
function tokenize(text) {
  const tokens = [];
  let end = -1;
  for (const match of text.matchAll(/"[^"]*"|'[^']*'|[^\s"']+/g)) {
    const quoted = /^["']/.test(match[0]);
    const value = quoted ? match[0].slice(1, -1) : match[0];
    if (quoted && match.index === end && /^--[\w-]+=$/.test(tokens.at(-1))) tokens[tokens.length - 1] += value;
    else tokens.push(value);
    end = match.index + match[0].length;
  }
  return tokens;
}

function commandInfo(call) {
  // Current evidence may keep argv directly. The fallback only tokenizes recorded command TEXT;
  // it never expands variables, evaluates quotes or executes a shell. Maker text must be in files,
  // so the current transport does not need a shell parser for arbitrary prompt/name contents.
  const tokens = call.argv || tokenize(String(call.command || ''));
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

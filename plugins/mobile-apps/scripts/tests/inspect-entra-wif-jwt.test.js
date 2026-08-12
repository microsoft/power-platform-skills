'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectToken } = require('../inspect-entra-wif-jwt');

const SCRIPT = path.join(__dirname, '..', 'inspect-entra-wif-jwt.js');
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.unsigned`;
}

function run(token, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: token,
    encoding: 'utf8',
  });
}

test('reports observed v1 claims and removes the provider issuer trailing slash', () => {
  const token = jwt({
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: 'api://push-sender',
    appid: CLIENT,
  });

  assert.deepStrictEqual(inspectToken(token), {
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: 'api://push-sender',
    selectedAppClaim: 'appid',
    googleProviderIssuer: `https://sts.windows.net/${TENANT}`,
    appid: CLIENT,
  });
});

test('selects azp when that is the app identity claim actually present', () => {
  const result = inspectToken(jwt({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: 'api://push-sender',
    azp: CLIENT,
  }));

  assert.strictEqual(result.selectedAppClaim, 'azp');
  assert.strictEqual(result.azp, CLIENT);
  assert.strictEqual(result.appid, undefined);
});

test('deterministically prefers appid when both claims are present', () => {
  const result = inspectToken(jwt({
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: 'api://push-sender',
    appid: CLIENT,
    azp: 'ffffffff-1111-2222-3333-444444444444',
  }));

  assert.strictEqual(result.selectedAppClaim, 'appid');
});

test('fails when neither app identity claim exists without echoing the token', () => {
  const token = jwt({
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: 'api://push-sender',
    secret_marker: 'DO_NOT_ECHO_THIS_TOKEN',
  });
  const result = run(token);

  assert.strictEqual(result.status, 1);
  assert.strictEqual(result.stdout, '');
  assert.match(result.stderr, /must contain appid or azp/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stderr, /DO_NOT_ECHO_THIS_TOKEN/);
});

test('rejects argv input and does not echo it', () => {
  const unexpectedArg = 'DO_NOT_ECHO_ARGV_INPUT';
  const result = run('', [unexpectedArg]);

  assert.strictEqual(result.status, 1);
  assert.strictEqual(result.stdout, '');
  assert.match(result.stderr, /argv is not allowed/);
  assert.doesNotMatch(result.stderr, /DO_NOT_ECHO_ARGV_INPUT/);
});

test('rejects malformed sts issuer paths instead of rewriting authorities', () => {
  assert.throws(
    () => inspectToken(jwt({
      iss: `https://sts.windows.net/${TENANT}/v2.0/`,
      aud: 'api://push-sender',
      appid: CLIENT,
    })),
    /exactly one tenant GUID/,
  );
});

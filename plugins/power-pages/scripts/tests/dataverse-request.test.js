'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, doRequest } = require('../dataverse-request');

test('parseArgs reads large request bodies from --bodyFile', () => {
  const result = parseArgs([
    'https://org.crm.dynamics.com/',
    'post',
    'ImportSolutionAsync',
    '--bodyFile',
    '/tmp/body.json',
    '--include-headers',
  ], {
    fs: {
      readFileSync: (filePath, encoding) => {
        assert.equal(filePath, '/tmp/body.json');
        assert.equal(encoding, 'utf8');
        return '{"CustomizationFile":"large"}';
      },
    },
  });

  assert.deepEqual(result, {
    envUrl: 'https://org.crm.dynamics.com',
    method: 'POST',
    apiPath: 'ImportSolutionAsync',
    body: '{"CustomizationFile":"large"}',
    includeHeaders: true,
  });
});

test('parseArgs rejects ambiguous inline and file bodies', () => {
  assert.deepEqual(parseArgs([
    'https://org.crm.dynamics.com',
    'POST',
    'ImportSolutionAsync',
    '--body',
    '{}',
    '--bodyFile',
    '/tmp/body.json',
  ]), { error: 'Use either --body or --bodyFile, not both.' });
});

test('doRequest sends parsed file body as JSON payload', async () => {
  const response = await doRequest(
    'https://org.crm.dynamics.com',
    'POST',
    'ImportSolutionAsync',
    '{"CustomizationFile":"large"}',
    'token',
    true,
    async (request) => {
      assert.equal(request.url, 'https://org.crm.dynamics.com/api/data/v9.2/ImportSolutionAsync');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.Authorization, 'Bearer token');
      assert.equal(request.headers['Content-Type'], 'application/json');
      assert.equal(request.body, '{"CustomizationFile":"large"}');
      assert.equal(request.includeHeaders, true);
      return { statusCode: 202, body: '{"ok":true}', headers: { location: 'async-url' } };
    },
  );

  assert.deepEqual(response, { statusCode: 202, body: '{"ok":true}', headers: { location: 'async-url' } });
});

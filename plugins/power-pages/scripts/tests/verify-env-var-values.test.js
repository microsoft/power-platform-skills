'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const helpers = require('../lib/validation-helpers');
const {
  verifyEnvVarValues,
  verifyOne,
  readSettingsFile,
  dedupeBySchemaName,
  odataString,
} = require('../lib/verify-env-var-values');

// Mock makeRequest so tests don't talk to a real Dataverse env.
// Each test installs its own handler keyed off the URL/query.
function withMockedRequests(t, handler) {
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (opts) => {
    calls.push(opts);
    return handler(opts, calls.length);
  };
  t.after(() => {
    helpers.makeRequest = orig;
  });
  return calls;
}

function odataResponse(rows) {
  return { statusCode: 200, body: JSON.stringify({ value: rows }) };
}

function odataError(statusCode, message) {
  return { statusCode, body: JSON.stringify({ error: { message } }) };
}

// Helper: build a route map { '/api/data/...' → response } so each test reads
// like a table of fixtures rather than nested switch statements.
function routeHandler(routes) {
  return async (opts) => {
    for (const [pattern, response] of Object.entries(routes)) {
      if (opts.url.includes(pattern)) {
        return typeof response === 'function' ? response(opts) : response;
      }
    }
    return { statusCode: 404, body: JSON.stringify({ error: { message: 'no route' } }) };
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure-function tests (no network)
// ──────────────────────────────────────────────────────────────────────────────

test('odataString escapes single quotes per OData spec', () => {
  assert.equal(odataString('foo'), 'foo');
  assert.equal(odataString("foo's bar"), "foo''s bar");
  assert.equal(odataString("'"), "''");
});

test('dedupeBySchemaName keeps the first occurrence of each schema name', () => {
  const out = dedupeBySchemaName([
    { schemaName: 'a', value: '1' },
    { schemaName: 'b', value: '2' },
    { schemaName: 'a', value: '3' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].value, '1');
  assert.equal(out[1].schemaName, 'b');
});

test('dedupeBySchemaName drops entries with falsy schemaName', () => {
  const out = dedupeBySchemaName([
    { schemaName: '', value: '1' },
    { schemaName: 'a', value: '2' },
    { schemaName: null, value: '3' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].schemaName, 'a');
});

test('readSettingsFile reads top-level EnvironmentVariables shape', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      EnvironmentVariables: [
        { SchemaName: 'foo_a', Value: 'a-value' },
        { SchemaName: 'foo_b', Value: 'b-value' },
      ],
    })
  );
  const entries = readSettingsFile(file);
  assert.deepEqual(entries, [
    { schemaName: 'foo_a', value: 'a-value' },
    { schemaName: 'foo_b', value: 'b-value' },
  ]);
});

test('readSettingsFile filters Stages[] by stageLabel (case-insensitive)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      Stages: [
        {
          Name: 'Staging',
          EnvironmentVariables: [{ SchemaName: 'foo_a', Value: 'staging-a' }],
        },
        {
          Name: 'Production',
          EnvironmentVariables: [
            { SchemaName: 'foo_a', Value: 'prod-a' },
            { SchemaName: 'foo_b', Value: 'prod-b' },
          ],
        },
      ],
    })
  );
  const stagingEntries = readSettingsFile(file, 'staging');
  assert.deepEqual(stagingEntries, [{ schemaName: 'foo_a', value: 'staging-a' }]);
  const prodEntries = readSettingsFile(file, 'Production');
  assert.equal(prodEntries.length, 2);
  assert.equal(prodEntries[1].value, 'prod-b');
});

test('readSettingsFile with no stageLabel flattens Stages[]', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      Stages: [
        { Name: 'Staging', EnvironmentVariables: [{ SchemaName: 'foo_a', Value: 'staging-a' }] },
        { Name: 'Production', EnvironmentVariables: [{ SchemaName: 'foo_b', Value: 'prod-b' }] },
      ],
    })
  );
  const entries = readSettingsFile(file);
  // Both stages flattened, deduped by schema name (first wins)
  assert.equal(entries.length, 2);
  assert.equal(entries[0].schemaName, 'foo_a');
  assert.equal(entries[1].schemaName, 'foo_b');
});

test('readSettingsFile throws on missing file', () => {
  assert.throws(() => readSettingsFile('/tmp/nonexistent-deployment-settings.json'));
});

test('readSettingsFile throws on invalid JSON', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'deployment-settings.json');
  fs.writeFileSync(file, '{ not valid json');
  assert.throws(() => readSettingsFile(file));
});

// ──────────────────────────────────────────────────────────────────────────────
// verifyOne — single-schema Dataverse query semantics
// ──────────────────────────────────────────────────────────────────────────────

test('verifyOne returns "landed" when both definition and value exist', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a', type: 100000000 },
      ]),
      'environmentvariablevalues': odataResponse([
        { environmentvariablevalueid: 'val-1', value: 'expected-value' },
      ]),
    })
  );
  const r = await verifyOne('https://target/', 'tok', 'foo_a');
  assert.equal(r.status, 'landed');
  assert.equal(r.definitionId, 'def-1');
  assert.equal(r.valueId, 'val-1');
  assert.equal(r.value, 'expected-value');
});

test('verifyOne returns "missing-definition" when schema name not found', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([]),
    })
  );
  const r = await verifyOne('https://target/', 'tok', 'foo_a');
  assert.equal(r.status, 'missing-definition');
  assert.equal(r.definitionId, null);
});

test('verifyOne returns "missing-value-record" when definition exists but no value row', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a' },
      ]),
      'environmentvariablevalues': odataResponse([]),
    })
  );
  const r = await verifyOne('https://target/', 'tok', 'foo_a');
  assert.equal(r.status, 'missing-value-record');
  assert.equal(r.definitionId, 'def-1');
  assert.equal(r.valueId, null);
});

test('verifyOne returns "value-mismatch" when expectedValue does not match landed value', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a' },
      ]),
      'environmentvariablevalues': odataResponse([
        { environmentvariablevalueid: 'val-1', value: 'actual-value' },
      ]),
    })
  );
  const r = await verifyOne('https://target/', 'tok', 'foo_a', 'expected-other-value');
  assert.equal(r.status, 'value-mismatch');
  assert.equal(r.value, 'actual-value');
  assert.equal(r.expected, 'expected-other-value');
});

test('verifyOne returns "landed" when expectedValue matches', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a' },
      ]),
      'environmentvariablevalues': odataResponse([
        { environmentvariablevalueid: 'val-1', value: 'same-value' },
      ]),
    })
  );
  const r = await verifyOne('https://target/', 'tok', 'foo_a', 'same-value');
  assert.equal(r.status, 'landed');
  assert.equal(r.expected, 'same-value');
});

test('verifyOne returns "query-error" when definition lookup fails', async (t) => {
  withMockedRequests(t, async () => odataError(403, 'Forbidden'));
  const r = await verifyOne('https://target/', 'tok', 'foo_a');
  assert.equal(r.status, 'query-error');
  assert.ok(r.error);
});

// ──────────────────────────────────────────────────────────────────────────────
// verifyEnvVarValues — multi-schema aggregation
// ──────────────────────────────────────────────────────────────────────────────

test('verifyEnvVarValues throws when envUrl missing', async () => {
  await assert.rejects(
    verifyEnvVarValues({ schemaNames: ['foo_a'] }),
    /envUrl is required/
  );
});

test('verifyEnvVarValues throws when schemaNames is empty', async () => {
  await assert.rejects(
    verifyEnvVarValues({ envUrl: 'https://target/', schemaNames: [] }),
    /non-empty array/
  );
});

test('verifyEnvVarValues aggregates a mixed result (1 landed, 1 missing-value, 1 missing-def)', async (t) => {
  // Each schema does 2 calls in sequence (def, value). Track which schema by
  // counting calls — schema 0 = calls 1+2, schema 1 = calls 3+4, schema 2 = call 5.
  withMockedRequests(t, async (opts, callNum) => {
    // schema "foo_landed" → both succeed
    if (callNum === 1) {
      return odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_landed' },
      ]);
    }
    if (callNum === 2) {
      return odataResponse([{ environmentvariablevalueid: 'val-1', value: 'v1' }]);
    }
    // schema "foo_missing_value" → def exists, no value
    if (callNum === 3) {
      return odataResponse([
        { environmentvariabledefinitionid: 'def-2', schemaname: 'foo_missing_value' },
      ]);
    }
    if (callNum === 4) {
      return odataResponse([]);
    }
    // schema "foo_missing_def" → def doesn't exist (short-circuits, no value call)
    if (callNum === 5) {
      return odataResponse([]);
    }
    return odataResponse([]);
  });

  const result = await verifyEnvVarValues({
    envUrl: 'https://target/',
    token: 'tok',
    schemaNames: ['foo_landed', 'foo_missing_value', 'foo_missing_def'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.landed, 1);
  assert.equal(result.summary.missing, 2); // missing-value + missing-definition
  assert.equal(result.summary.mismatched, 0);
  assert.equal(result.summary.error, 0);

  assert.equal(result.results[0].status, 'landed');
  assert.equal(result.results[1].status, 'missing-value-record');
  assert.equal(result.results[2].status, 'missing-definition');
});

test('verifyEnvVarValues populates summary.mismatched when expectedValues used', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a' },
      ]),
      'environmentvariablevalues': odataResponse([
        { environmentvariablevalueid: 'val-1', value: 'actual' },
      ]),
    })
  );
  const result = await verifyEnvVarValues({
    envUrl: 'https://target/',
    token: 'tok',
    schemaNames: ['foo_a'],
    expectedValuesMap: { foo_a: 'expected-different' },
  });
  assert.equal(result.summary.mismatched, 1);
  assert.equal(result.summary.landed, 0);
  assert.equal(result.results[0].status, 'value-mismatch');
});

test('verifyEnvVarValues includes stageLabel in target block when provided', async (t) => {
  withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a' },
      ]),
      'environmentvariablevalues': odataResponse([
        { environmentvariablevalueid: 'val-1', value: 'v' },
      ]),
    })
  );
  const result = await verifyEnvVarValues({
    envUrl: 'https://target/',
    token: 'tok',
    schemaNames: ['foo_a'],
    stageLabel: 'Production',
  });
  assert.equal(result.target.stageLabel, 'Production');
});

test("verifyEnvVarValues handles schema names with single quotes (OData escape)", async (t) => {
  // Defensive: schema names shouldn't have quotes in practice, but if a user
  // coins a slug that survives validation, the OData literal must escape.
  const calls = withMockedRequests(
    t,
    routeHandler({
      'environmentvariabledefinitions': odataResponse([]),
    })
  );
  await verifyEnvVarValues({
    envUrl: 'https://target/',
    token: 'tok',
    schemaNames: ["foo's_special"],
  });
  // The URL passed to makeRequest should have a doubled single-quote.
  assert.ok(calls[0].url.includes("foo''s_special"));
});

test('verifyEnvVarValues records query-error per schema without aborting the run', async (t) => {
  withMockedRequests(t, async (opts, callNum) => {
    // First schema: lookup succeeds but value query 403s.
    if (callNum === 1) {
      return odataResponse([
        { environmentvariabledefinitionid: 'def-1', schemaname: 'foo_a' },
      ]);
    }
    if (callNum === 2) {
      return odataError(403, 'Forbidden');
    }
    // Second schema: both succeed.
    if (callNum === 3) {
      return odataResponse([
        { environmentvariabledefinitionid: 'def-2', schemaname: 'foo_b' },
      ]);
    }
    if (callNum === 4) {
      return odataResponse([{ environmentvariablevalueid: 'val-2', value: 'v2' }]);
    }
    return odataResponse([]);
  });
  const result = await verifyEnvVarValues({
    envUrl: 'https://target/',
    token: 'tok',
    schemaNames: ['foo_a', 'foo_b'],
  });
  assert.equal(result.summary.error, 1);
  assert.equal(result.summary.landed, 1);
  assert.equal(result.results[0].status, 'query-error');
  assert.equal(result.results[1].status, 'landed');
});

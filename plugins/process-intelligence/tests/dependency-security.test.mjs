// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import uri from 'fast-uri';

test('oversized collections are rejected before parsing their elements', () => {
  const cases = [
    { schema: item => z.array(item).max(1), input: [1, 2], valid: [1] },
    { schema: item => z.set(item).max(1), input: new Set([1, 2]), valid: new Set([1]) },
    {
      schema: item => z.map(z.string(), item).max(1),
      input: new Map([['a', 1], ['b', 2]]),
      valid: new Map([['a', 1]]),
    },
  ];

  for (const { schema, input, valid } of cases) {
    let parsed = 0;
    const collection = schema(z.number().transform(value => {
      parsed += 1;
      return value;
    }));

    assert.equal(collection.safeParse(input).success, false);
    assert.equal(parsed, 0, 'size limits must run before element validation allocates results');
    assert.equal(collection.safeParse(valid).success, true);
    assert.equal(parsed, 1);
  }
});

test('percent-encoded schemes cannot become valid HTTP schemes', () => {
  for (const input of ['h%74tps://example.com', '%68ttps://example.com']) {
    assert.ok(uri.parse(input).error, input);
  }
  const valid = uri.parse('https://example.com');
  assert.equal(valid.error, undefined);
  assert.equal(valid.scheme, 'https');
});

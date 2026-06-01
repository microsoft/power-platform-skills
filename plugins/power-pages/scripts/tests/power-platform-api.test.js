const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCliArgs,
  parseTimeoutMs,
  hasErrorCode,
  isFeatureUnsupported,
  pollUntil,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
} = require('../lib/power-platform-api');

test('parseCliArgs reads value flags', () => {
  const out = parseCliArgs(['node', 'script', '--portalId', 'abc', '--name', 'foo']);
  assert.equal(out.portalId, 'abc');
  assert.equal(out.name, 'foo');
});

test('parseCliArgs treats a flag with no value as a boolean', () => {
  const out = parseCliArgs(['node', 'script', '--once', '--portalId', 'abc']);
  assert.equal(out.once, true);
  assert.equal(out.portalId, 'abc');
});

test('parseCliArgs treats a flag followed by another flag as a boolean', () => {
  const out = parseCliArgs(['node', 'script', '--reinstall', '--name', 'x']);
  assert.equal(out.reinstall, true);
  assert.equal(out.name, 'x');
});

test('parseCliArgs ignores positional arguments', () => {
  const out = parseCliArgs(['node', 'script', 'positional', '--name', 'x', 'tail']);
  assert.equal(out.name, 'x');
  assert.equal(out.positional, undefined);
});

test('parseTimeoutMs uses default when value is undefined', () => {
  assert.equal(parseTimeoutMs(undefined, 15), 15 * 60 * 1000);
});

test('parseTimeoutMs accepts a numeric string', () => {
  assert.equal(parseTimeoutMs('30', 15), 30 * 60 * 1000);
});

test('parseTimeoutMs accepts a number', () => {
  assert.equal(parseTimeoutMs(45, 15), 45 * 60 * 1000);
});

// parseTimeoutMs calls fail() → process.exit(1) on rejection. The helper
// intercepts both so the test process does not actually terminate, restores
// them in finally, and returns the captured exit code + stderr.
function runRejectingValue(value) {
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write;
  let exitCode = null;
  let stderr = '';
  process.exit = (code) => {
    exitCode = code;
    throw new Error('__exit__');
  };
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    assert.throws(() => parseTimeoutMs(value, 15), /__exit__/);
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }
  return { exitCode, stderr };
}

for (const value of ['abc', '0', '-1', '-0.5', 'NaN', '']) {
  test(`parseTimeoutMs exits the process on invalid value ${JSON.stringify(value)}`, () => {
    const { exitCode, stderr } = runRejectingValue(value);
    assert.equal(exitCode, 1);
    assert.match(stderr, /Invalid --timeoutMinutes/);
  });
}

test('hasErrorCode matches any status when the error code matches', () => {
  assert.equal(
    hasErrorCode({ statusCode: 409, error: { code: 'B003' } }, 'B003'),
    true
  );
  assert.equal(
    hasErrorCode({ statusCode: 400, error: { code: 'B022' } }, 'B022', 'B023'),
    true
  );
  assert.equal(
    hasErrorCode({ statusCode: 500, error: { code: 'B022' } }, 'B022'),
    true,
    'status is ignored; only the code is matched'
  );
});

test('hasErrorCode returns false when no code matches', () => {
  assert.equal(
    hasErrorCode({ statusCode: 400, error: { code: 'OTHER' } }, 'B022', 'B023'),
    false
  );
  assert.equal(hasErrorCode({ statusCode: 200, error: undefined }, 'B022'), false);
});

test('isFeatureUnsupported matches the documented error codes', () => {
  assert.equal(
    isFeatureUnsupported({ statusCode: 400, error: { code: 'B022' } }, 'B022', 'B023'),
    true
  );
  assert.equal(
    isFeatureUnsupported({ statusCode: 400, error: { code: 'B023' } }, 'B022', 'B023'),
    true
  );
});

test('isFeatureUnsupported falls back to the message regex on 400', () => {
  assert.equal(
    isFeatureUnsupported(
      { statusCode: 400, error: { code: 'OTHER', message: 'feature not supported in region' } },
      'B022',
      'B023'
    ),
    true
  );
});

test('isFeatureUnsupported does not match the message fallback on non-400 responses', () => {
  assert.equal(
    isFeatureUnsupported(
      { statusCode: 500, error: { code: 'OTHER', message: 'feature not supported' } },
      'B022'
    ),
    false
  );
});

test('exposes the documented polling defaults', () => {
  // Pinned so a silent change to either constant is caught.
  assert.equal(DEFAULT_POLL_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 5000);
});

// Stubs global.setTimeout so the sleep between attempts completes instantly
// while still capturing the delay the caller requested. The original is
// restored in finally so an assertion failure cannot leak the stub.
function captureSleepDelays(fn) {
  const originalSetTimeout = global.setTimeout;
  const captured = [];
  global.setTimeout = (cb, ms) => {
    captured.push(ms);
    return originalSetTimeout(cb, 0);
  };
  return Promise.resolve()
    .then(() => fn(captured))
    .finally(() => {
      global.setTimeout = originalSetTimeout;
    });
}

test('pollUntil applies DEFAULT_POLL_INTERVAL_MS when intervalMs is omitted', async () => {
  let isDoneCalls = 0;
  const captured = [];
  await captureSleepDelays(async (delays) => {
    const result = await pollUntil({
      fetchStatus: async () => ({ ok: true, body: 'pending' }),
      isDone: () => ++isDoneCalls >= 3,
      timeoutMs: 60_000,
    });
    captured.push(...delays);
    assert.equal(result.ok, true);
    assert.equal(result.body, 'pending');
    assert.equal(result.attempts, 3);
  });

  // Three attempts → exactly two sleep calls between them.
  assert.equal(captured.length, 2);
  for (const delay of captured) {
    assert.equal(delay, DEFAULT_POLL_INTERVAL_MS);
  }
});

test('pollUntil honors a caller-supplied intervalMs', async () => {
  const customInterval = 1234;
  let isDoneCalls = 0;
  const captured = [];
  await captureSleepDelays(async (delays) => {
    await pollUntil({
      fetchStatus: async () => ({ ok: true, body: 'pending' }),
      isDone: () => ++isDoneCalls >= 2,
      timeoutMs: 60_000,
      intervalMs: customInterval,
    });
    captured.push(...delays);
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0], customInterval);
});

test('pollUntil returns ok=true when isDone matches on first attempt', async () => {
  const result = await pollUntil({
    fetchStatus: async () => ({ ok: true, body: 'done' }),
    isDone: (status) => status === 'done',
    timeoutMs: 1000,
    intervalMs: 10,
  });
  assert.equal(result.ok, true);
  assert.equal(result.body, 'done');
  assert.equal(result.attempts, 1);
});

test('pollUntil polls until isDone returns true', async () => {
  const responses = ['pending', 'pending', 'done'];
  let i = 0;
  const result = await pollUntil({
    fetchStatus: async () => ({ ok: true, body: responses[i++] }),
    isDone: (status) => status === 'done',
    timeoutMs: 1000,
    intervalMs: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test('pollUntil returns timeout when isDone never matches', async () => {
  const result = await pollUntil({
    fetchStatus: async () => ({ ok: true, body: 'pending' }),
    isDone: () => false,
    timeoutMs: 30,
    intervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.ok(result.attempts >= 1);
});

test('pollUntil short-circuits on a fetchStatus error', async () => {
  let isDoneCalls = 0;
  const result = await pollUntil({
    fetchStatus: async () => ({ ok: false, error: 'service unavailable' }),
    isDone: () => {
      isDoneCalls += 1;
      return true;
    },
    timeoutMs: 1000,
    intervalMs: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'service unavailable');
  // Short-circuit MUST fire before isDone is evaluated, on the first fetch.
  assert.equal(result.attempts, 1);
  assert.equal(isDoneCalls, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderEnvTable,
  renderEnvMarkdown,
  resolveDefaultEnvId,
  CURRENT_TAG,
  CURRENT_MARK,
} = require('../../skills/manage-governance/scripts/render-env-table');

const SAMPLE = [
  { displayName: 'Automation_runtimeenv', envId: '00476f13-5245-e3c1-a4a4-2fb76ad3ac49' },
  { displayName: 'Sachin_july_20', envId: '1cf29f7b-04db-e4a6-aeda-74d99b256f85' },
  { displayName: 'Sachin-preprod-July', envId: '2a0887a0-6366-ef59-9992-118cfcd2fa2b' },
];

function lines(str) {
  return str.split('\n');
}

test('renders a bordered box with header and one row per env', () => {
  const out = renderEnvTable(SAMPLE);
  const l = lines(out);
  // top border + header + header-sep + 3 rows + bottom border = 7 lines
  assert.equal(l.length, 7);
  assert.match(l[0], /^\+-+\+-+\+-+\+-+\+$/);
  assert.match(l[l.length - 1], /^\+-+\+-+\+-+\+-+\+$/);
  assert.ok(l[1].includes('Environment Name'));
  assert.ok(l[1].includes('Environment ID'));
});

test('every rendered line has identical visible width (aligned columns)', () => {
  const out = renderEnvTable(SAMPLE, { currentEnvId: '2a0887a0-6366-ef59-9992-118cfcd2fa2b' });
  const widths = new Set(lines(out).map((s) => s.length));
  assert.equal(widths.size, 1, 'all lines must share one width');
});

test('output is ASCII-only (no wide glyphs that break alignment)', () => {
  const out = renderEnvTable(SAMPLE, { currentEnvId: '2a0887a0-6366-ef59-9992-118cfcd2fa2b' });
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x00-\x7F\n]*$/.test(out), 'table must contain only ASCII characters');
});

test('flags the current selection row with the marker and tag', () => {
  const current = '2a0887a0-6366-ef59-9992-118cfcd2fa2b';
  const out = renderEnvTable(SAMPLE, { currentEnvId: current });
  const row = lines(out).find((s) => s.includes('Sachin-preprod-July'));
  assert.ok(row.includes(CURRENT_MARK), 'current row shows the marker');
  assert.ok(row.includes(CURRENT_TAG), 'current row shows the CURRENT SELECTION tag');
});

test('no current selection → no marker/tag anywhere', () => {
  const out = renderEnvTable(SAMPLE);
  assert.ok(!out.includes(CURRENT_TAG));
});

test('exactly one row is tagged as current', () => {
  const out = renderEnvTable(SAMPLE, { currentEnvId: '1cf29f7b-04db-e4a6-aeda-74d99b256f85' });
  const tagged = lines(out).filter((s) => s.includes(CURRENT_TAG));
  assert.equal(tagged.length, 1);
  assert.ok(tagged[0].includes('Sachin_july_20'));
});

test('row numbers are 1-based and sequential', () => {
  const out = renderEnvTable(SAMPLE);
  const body = lines(out).slice(3, -1);
  assert.match(body[0], /^\|\s*1\s*\|/);
  assert.match(body[1], /^\|\s*2\s*\|/);
  assert.match(body[2], /^\|\s*3\s*\|/);
});

test('handles empty env list without throwing', () => {
  const out = renderEnvTable([]);
  assert.ok(out.includes('Environment Name'));
});

test('unknown currentEnvId tags nothing', () => {
  const out = renderEnvTable(SAMPLE, { currentEnvId: 'does-not-exist' });
  assert.ok(!out.includes(CURRENT_TAG));
});

test('missing displayName falls back to (unnamed)', () => {
  const out = renderEnvTable([{ envId: 'abc' }]);
  assert.ok(out.includes('(unnamed)'));
});

// --- renderEnvMarkdown (GitHub-flavored Markdown table for chat surfaces) ---

test('markdown: emits header + separator + one row per env', () => {
  const out = renderEnvMarkdown(SAMPLE);
  const l = lines(out);
  // header + separator + 3 rows = 5 lines
  assert.equal(l.length, 5);
  assert.equal(l[0], '| # | Selected | Environment Name | Environment ID |');
  assert.equal(l[1], '|---|---|---|---|');
  assert.ok(l[2].includes('Automation_runtimeenv'));
});

test('markdown: row numbers are 1-based and sequential', () => {
  const out = renderEnvMarkdown(SAMPLE);
  const body = lines(out).slice(2);
  assert.match(body[0], /^\|\s*1\s*\|/);
  assert.match(body[1], /^\|\s*2\s*\|/);
  assert.match(body[2], /^\|\s*3\s*\|/);
});

test('markdown: flags exactly the current selection row in the Selected column', () => {
  const out = renderEnvMarkdown(SAMPLE, {
    currentEnvId: '2a0887a0-6366-ef59-9992-118cfcd2fa2b',
  });
  const tagged = lines(out).filter((s) => s.includes('selected earlier'));
  assert.equal(tagged.length, 1);
  assert.ok(tagged[0].includes('Sachin-preprod-July'));
});

test('markdown: no current selection → no "selected earlier" marker', () => {
  const out = renderEnvMarkdown(SAMPLE);
  assert.ok(!out.includes('selected earlier'));
});

test('markdown: escapes pipe characters in env display names', () => {
  // A literal '|' in a name would prematurely close the Markdown cell — it must
  // be escaped so the table structure survives user-controlled env names.
  const out = renderEnvMarkdown([{ displayName: 'a|b', envId: 'x' }]);
  assert.ok(out.includes('a\\|b'), 'pipe must be backslash-escaped');
});

test('markdown: missing displayName falls back to (unnamed)', () => {
  const out = renderEnvMarkdown([{ envId: 'abc' }]);
  assert.ok(out.includes('(unnamed)'));
});

// --- resolveDefaultEnvId (auto-flag the tenant-default env, no extra lookup) ---

test('resolveDefaultEnvId: returns the env whose type is "Default"', () => {
  const envs = [
    { envId: 'a', type: 'Production' },
    { envId: 'b', type: 'Default' },
  ];
  assert.equal(resolveDefaultEnvId(envs), 'b');
});

test('resolveDefaultEnvId: matches type case-insensitively', () => {
  // Casing has varied across CLI versions ("Default" vs "default").
  const envs = [{ envId: 'a', type: 'default' }];
  assert.equal(resolveDefaultEnvId(envs), 'a');
});

test('resolveDefaultEnvId: returns null when no default env is present', () => {
  const envs = [{ envId: 'a', type: 'Production' }];
  assert.equal(resolveDefaultEnvId(envs), null);
});

test('resolveDefaultEnvId: tolerates non-array / empty input', () => {
  assert.equal(resolveDefaultEnvId(null), null);
  assert.equal(resolveDefaultEnvId([]), null);
});

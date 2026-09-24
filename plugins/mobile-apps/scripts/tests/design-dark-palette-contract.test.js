'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const integration = read('skills/design-system/references/tamagui-integration.md');
const design = read('skills/design-system/SKILL.md');
const refresh = read('skills/design-system/references/refresh-flow.md');
const schema = read('skills/design-system/references/design-system-schema.md');
const create = read('skills/create-mobile-app/SKILL.md');
const branch = integration.slice(
  integration.indexOf('## Approved dark palette (conditional)'),
  integration.indexOf('## Restored dark state'),
);
const history = refresh.slice(refresh.indexOf('## Snapshot contract'), refresh.indexOf('## Allowed dimensions'));
const rollback = refresh.slice(refresh.indexOf('### `/design-system --rollback'));

// These contracts check workflow instructions and documented snippets, not history execution or native rendering.

test('direct design entry uses the authoritative shared routing preflight', () => {
  const entry = design.slice(design.indexOf('**Entry routing:**'), design.indexOf('Source of truth'));
  assert.match(entry, /\[App feature entry points\]\(\.\.\/\.\.\/shared\/shared-instructions\.md#app-feature-entry-points\)/);
  assert.match(entry, /preflight before the workflow below/);
});

test('custom dark artifacts have one named export and a complete non-literal color contract', () => {
  assert.match(branch, /export const darkTokens =/);
  assert.match(branch, /satisfies \{ color: \{ \[K in keyof BrandTokens\['color'\]\]: string \} \}/);
  for (const key of ['bg', 'surface', 'primary', 'accent', 'text', 'textMuted', 'border',
    'statusSuccess', 'statusWarning', 'statusDanger', 'statusInfo']) {
    assert.match(branch, new RegExp(`\\b${key}: '\\{\\{approved-dark-`));
  }
  assert.match(branch, /import \{ darkTokens \} from '\.\/brand\/tokens\.dark'/);
  assert.match(branch, /Missing files, missing exports\/keys, or unresolved placeholder values block/);
  assert.match(design, /Write `brand\/tokens\.dark\.ts` using the named `darkTokens` export/);
});

test('ordinary brand integration keeps its prior defaults without requiring a dark file', () => {
  const base = integration.slice(integration.indexOf('## Brand Import'), integration.indexOf('## Approved dark palette'));
  assert.doesNotMatch(base, /tokens\.dark/);
  assert.match(base, /defaultConfig\.themes\.dark/);
  assert.match(base, /accent: brandTokens\.color\.accent/);
  assert.match(branch, /keep the Brand Import example above unchanged and do not import a nonexistent\ndark file/);
  assert.match(branch, /unapproved file's presence alone does not authorize wiring it/);
});

test('both creation and edit apply custom-dark wiring before using the resolved provider theme', () => {
  const edit = read('skills/edit-app/SKILL.md');
  assert.match(create, /\*\*Approved dark palette\*\* branch first: import `darkTokens`/);
  assert.match(create, /derive `appDarkTheme` from\n`darkTokens\.color`/);
  assert.match(edit, /\*\*Approved dark\n\s+palette\*\* branch: wire `darkTokens\.color` into `appDarkTheme`/);
  assert.match(edit, /provider's `brandedDarkTheme`/);
  assert.match(integration, /darkTheme=\{brandedDarkTheme\}/);
});

test('history instructions capture dark presence and approval before any mutation', () => {
  assert.match(history, /refresh, reskin, `--add-dark-mode`, changing or\nremoving a custom dark palette, and rollback/);
  assert.match(history, /After approval and \*\*before the\nfirst write or deletion\*\*, including drift resolution/);
  for (const member of ['<id>.md', '<id>.tokens.ts', '<id>.tokens.dark.ts', '<id>.state.json']) {
    assert.ok(history.includes(`| \`${member}\` |`), `Missing snapshot member: ${member}`);
  }
  assert.match(history, /Exact current `brand\/tokens\.dark\.ts`, only when present/);
  assert.match(history, /Never derive this copy from the light palette/);
  const examples = [...history.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  assert.deepEqual(examples, [
    { darkTokens: 'present', darkPalette: 'approved' },
    { darkTokens: 'absent', darkPalette: 'default' },
  ]);
  assert.match(history, /Presence is not approval/);
  assert.match(history, /"darkTokens": "present", "darkPalette": "default"/);
  assert.match(history, /failed or incomplete\nbackup blocks the change/);
  assert.match(history, /Keep the pre-write snapshot unchanged afterward/);
  assert.match(refresh, /Cancellation leaves both artifacts unchanged and preserves the dark artifact's\npresence, contents, and approved selection/);
});

test('rollback instructions restore exact saved dark contents when both versions have a palette', () => {
  const action = /^\s*\| present \| present \| (.+) \|$/m.exec(rollback)?.[1];
  assert.ok(action, 'Expected the present-to-present rollback instruction');
  assert.match(action, /Replace `brand\/tokens\.dark\.ts` with the exact saved target contents/);
  assert.match(action, /Do not regenerate from light tokens or keep the newer dark values/);
  assert.match(rollback, /\| absent \| present \| Restore `brand\/tokens\.dark\.ts` from the exact saved target contents/);
  const confirmation = rollback.indexOf('Obtain confirmation before any write');
  const backup = rollback.indexOf('Snapshot current state to `.history/`');
  const restore = rollback.indexOf('Restore the approved spec and saved light tokens exactly');
  assert.ok(confirmation >= 0 && confirmation < backup && backup < restore);
  assert.match(rollback, /verify the safety backup before any restore or deletion/);
});

test('rollback instructions remove only an approved target-absent dark artifact', () => {
  const action = /^\s*\| present \| absent \| (.+) \|$/m.exec(rollback)?.[1];
  assert.ok(action, 'Expected the present-to-absent rollback instruction');
  assert.match(action, /Remove only the current `brand\/tokens\.dark\.ts`/);
  assert.match(action, /after explicit approval of that removal and a verified safety backup/);
  assert.match(action, /Do not delete any unrelated files/);
  assert.match(rollback, /\| absent \| absent \| Leave `brand\/tokens\.dark\.ts` absent; do not generate or import it/);
  assert.match(history, /Legacy snapshots without `\.state\.json` have \*\*unknown\*\*, not absent, dark state/);
  assert.match(history, /do not infer\npermission to delete a dark file from a missing history member/);
  assert.match(history, /without its saved payload blocks rollback rather than\nre-deriving colors/);
});

test('refresh and read-only history instructions preserve the no-dark default', () => {
  assert.match(refresh, /If absent and default dark is selected → keep it absent; no dark file is required/);
  assert.match(refresh, /dark-only change does not rewrite light tokens/);
  assert.match(refresh, /If dark state is not in scope, leave `brand\/tokens\.dark\.ts` unchanged when\n\s+present and absent when absent/);
  assert.match(refresh, /Default dark mode still works without it/);
  assert.match(refresh, /Removing a custom palette deletes only `brand\/tokens\.dark\.ts` after the\n\s+explicit removal approval and verified safety snapshot/);
  assert.match(refresh, /including `brand\/tokens\.dark\.ts` contents or its creation\/removal/);
  assert.match(refresh, /`--history` and `--diff` are\nread-only; do not materialize missing artifacts/);
  assert.match(refresh, /prune only the oldest snapshot's known\nmembers together/);
});

test('restored approved state drives both runtime dark branches and the provider', () => {
  const restored = integration.slice(
    integration.indexOf('## Restored dark state'),
    integration.indexOf('## Root Provider Wiring'),
  );
  assert.match(rollback, /Return the restored approved selection to the owner/);
  assert.match(rollback, /reapply\n\s+\[Tamagui integration\]\(\.\/tamagui-integration\.md#restored-dark-state\)/);
  assert.match(restored, /Do not choose a branch from the\nmere presence of `brand\/tokens\.dark\.ts` or the abandoned newer plan/);
  assert.match(restored, /`appDarkTheme` consumes\n\s+the restored `darkTokens\.color`, not the previous palette/);
  assert.match(restored, /remove only stale\n\s+`tokens\.dark` imports and custom-dark overrides/);
  assert.match(restored, /unchanged Brand Import default dark declaration, retaining Config v5\n\s+dark surfaces\/text/);
  assert.match(restored, /Do not import or\n\s+create an absent dark file/);
  assert.match(restored, /rebuild `brandedDarkTheme` from the same resolved\n\s+`appDarkTheme`/);
  assert.match(rollback, /Artifact-only\n\s+rollback reports this outstanding runtime work/);
});

test('schema and creation guidance defer to the authoritative default and approved-custom branches', () => {
  assert.match(schema, /tokens\.dark\.ts\s+← optional approved custom-dark palette/);
  assert.match(schema, /`brand\/tokens\.dark\.ts` is optional, not a prerequisite for default dark mode/);
  assert.match(schema, /\[snapshot contract\]\(\.\/refresh-flow\.md#snapshot-contract\)/);
  for (const anchor of ['brand-import', 'approved-dark-palette-conditional', 'root-provider-wiring']) {
    assert.ok(schema.includes(`./tamagui-integration.md#${anchor}`), `Missing integration branch: ${anchor}`);
  }
  assert.match(schema, /After rollback, choose the\n\s+branch from the restored approved state/);
  assert.doesNotMatch(schema, /export const appDarkTheme|createPowerAppsTamaguiConfig\(/);
  const explanation = create.slice(
    create.indexOf('Without an approved custom dark palette, the exported dark app theme'),
    create.indexOf('### Step 10 — Add connectors'),
  );
  assert.match(explanation, /Without an approved custom dark palette/);
  assert.match(explanation, /Config v5 dark surfaces and text/);
  assert.match(explanation, /With an approved custom dark palette, `appDarkTheme` instead resolves the full\n`darkTokens\.color` palette, including its surfaces and text/);
  assert.doesNotMatch(create, /The generated schema has one brand palette, so the exported dark app theme/);
  assert.match(integration, /This default dark branch keeps Config v5/);
  assert.match(integration, /When custom dark is approved, apply the conditional branch below instead/);
});

test('generation and dark-mode writes use the same pre-write snapshot contract', () => {
  const generation = design.slice(
    design.indexOf('## Sub-step 4 —'),
    design.indexOf('## Sub-step 5 —'),
  );
  assert.match(generation, /After approval and before the first write/);
  assert.match(generation, /refresh-flow\.md#snapshot-contract/);
  assert.match(generation, /optional `brand\/tokens\.dark\.ts` and explicit absence/);
  const dark = design.slice(
    design.indexOf('## Dark mode —'),
    design.indexOf('## Version history'),
  );
  assert.match(dark, /After approval, capture the pre-write \[snapshot contract\]/);
  assert.ok(dark.indexOf('capture the pre-write') < dark.indexOf('4. Write'));
  assert.match(dark, /7\. Retain the pre-write snapshot/);
  assert.doesNotMatch(dark, /7\. Snapshot \+ history/);
});

test('generation records complete history once without a legacy post-write snapshot', () => {
  const generation = design.slice(
    design.indexOf('## Sub-step 4 —'),
    design.indexOf('## Sub-step 5 —'),
  );
  const completion = generation.slice(generation.indexOf('**History completion:**'));
  assert.match(completion, /If a pre-write snapshot was captured, retain it unchanged/);
  assert.match(completion, /Do not create a\n\s+second post-write `-initial` snapshot/);
  assert.match(completion, /Only for first-time generation with no prior brand state/);
  assert.match(completion, /record one complete\n\s+approved initial snapshot after generation/);
  assert.match(completion, /light tokens, optional dark-token payload, and explicit presence\/approval\n\s+state/);
  assert.match(completion, /Verify every expected member before reporting success/);
  assert.match(completion, /failed or incomplete\n\s+snapshot is a visible failure/);
  assert.doesNotMatch(generation, /cp brand\/design-system\.md|2>\/dev\/null|\|\| true/);
});

test('the conditional example forwards approved dark surfaces and text to provider values', () => {
  const theme = /export const appDarkTheme = (withPowerAppsSemanticAliases\([\s\S]*?\n\));/.exec(branch)?.[1];
  const provider = /const brandedDarkTheme: ThemeTokens = (\{[\s\S]*?\n\});/.exec(integration)?.[1];
  assert.ok(theme, 'Expected the concrete conditional dark-theme declaration');
  assert.ok(provider, 'Expected the concrete host provider mapping');
  const colors = { bg: '#121212', surface: '#202020', text: '#eeeeee', accent: '#77aaff' };
  let calls = 0;
  const result = vm.runInNewContext(
    `const appDarkTheme = ${theme}; const brandedDarkTheme = ${provider}; brandedDarkTheme;`,
    {
      darkTokens: { color: colors },
      defaultConfig: { themes: { dark: { baseline: true } } },
      hostDarkTheme: { preservedHostValue: 'keep' },
      // Stub host color resolution; this tests the documented data path, not host implementation.
      withPowerAppsSemanticAliases: (base, palette) => {
        calls += 1;
        assert.equal(base.baseline, true);
        assert.equal(palette, colors);
        return {
          surface0: palette.bg,
          surface1: palette.surface,
          text0: palette.text,
          accentBase: palette.accent,
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.surface0, colors.bg);
  assert.equal(result.surface1, colors.surface);
  assert.equal(result.text0, colors.text);
  assert.equal(result.accentBase, colors.accent);
  assert.equal(result.preservedHostValue, 'keep');
});

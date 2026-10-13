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
const inputs = read('skills/design-system/references/input-modes.md');
const schema = read('skills/design-system/references/design-system-schema.md');
const create = read('skills/create-mobile-app/SKILL.md');
const branch = integration.slice(
  integration.indexOf('## Approved dark palette (conditional)'),
  integration.indexOf('## Restored dark state'),
);
const history = refresh.slice(refresh.indexOf('## Snapshot contract'), refresh.indexOf('## Allowed dimensions'));
const rollback = refresh.slice(refresh.indexOf('### `/design-system --rollback'));
const prewrite = design.slice(
  design.indexOf('## Sub-step 3.5 —'),
  design.indexOf('## Sub-step 4 —'),
);
const generation = design.slice(
  design.indexOf('## Sub-step 4 —'),
  design.indexOf('## Sub-step 5 —'),
);
const confirmation = design.slice(
  design.indexOf('## Sub-step 6 —'),
  design.indexOf('## Sub-step 6.5 —'),
);

function inOrder(text, ...instructions) {
  let previous = -1;
  for (const instruction of instructions) {
    const position = text.indexOf(instruction);
    assert.ok(position > previous, `Missing or out-of-order instruction: ${instruction}`);
    previous = position;
  }
}

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
  assert.match(prewrite, /After approval and before the first write or deletion/);
  assert.match(prewrite, /refresh-flow\.md#snapshot-contract/);
  assert.match(prewrite, /optional `brand\/tokens\.dark\.ts` and explicit absence/);
  assert.match(generation, /write only the candidate approved in Sub-step 3\.5, after its verified\npre-write backup/);
  const dark = design.slice(
    design.indexOf('## Dark mode —'),
    design.indexOf('## Version history'),
  );
  assert.match(dark, /After approval, capture the pre-write \[snapshot contract\]/);
  assert.ok(dark.indexOf('capture the pre-write') < dark.indexOf('4. Write'));
  assert.match(dark, /7\. Retain the pre-write snapshot/);
  assert.doesNotMatch(dark, /7\. Snapshot \+ history/);
});

test('full-design rerun instructions approve the concrete delta and verify backup before writing', () => {
  const paths = design.slice(design.indexOf('**Branches:**'), design.indexOf('**On ANY input failure'));
  for (const option of ['a', 'b']) {
    const line = paths.split('\n').find((value) => value.startsWith(`- **(${option})**`));
    assert.ok(line, `Missing full-design branch (${option})`);
    assert.match(line, /Sub-step 3\.5 before Sub-steps 4–7/);
  }
  inOrder(prewrite,
    '1. Prepare the complete candidate without live writes.',
    'before/after delta: palette values, typography, component/density/negative',
    '2. Obtain explicit approval of that concrete delta',
    '4. After approval and before the first write or deletion',
    'Verify every',
    'expected backup member; a failed or incomplete backup blocks all live writes.',
    '5. Apply only the approved candidate',
  );
  inOrder(design, '## Sub-step 3.5 —', '## Sub-step 4 —', '## Sub-step 5 —', '## Sub-step 6 —');
  assert.match(prewrite, /refresh-flow\.md#step-5--update-the-spec/);
  assert.match(confirmation, /review of the already approved delta, not the first\nauthorization to write/);
});

test('rerun approval reuses only matching current owner scope without duplicate prompts', () => {
  assert.match(prewrite, /owner's matching approved scope \*\*without another prompt\*\*/);
  assert.match(prewrite, /owner,\n\s+absolute working directory, implementation phase \(or explicitly delegated\n\s+design gate\), and exact proposed changes must match/);
  assert.match(prewrite, /A cost choice, style\n\s+pick, input flag, stale Design record, or orchestration marker alone is not\n\s+approval/);
  assert.match(prewrite, /Changed or missing caller scope\n\s+returns `NEEDS_CONTEXT` to the owner/);
  assert.match(confirmation, /continue without another confirmation prompt/);
  assert.match(prewrite, /If the candidate or\n\s+current baseline changes after approval, return to this boundary/);
});

test('cancelled or ambiguous rerun approval forbids live writes, snapshots, and approval records', () => {
  const cancelled = prewrite.slice(prewrite.indexOf('3. Cancellation'), prewrite.indexOf('4. After approval'));
  assert.match(cancelled, /Cancellation, dismissal, silence, or an ambiguous answer means \*\*no live\n\s+writes\*\*: stop or clarify/);
  assert.match(cancelled, /Do not create a history snapshot, overwrite spec,\n\s+tokens, galleries\/previews, persist pending memory-bank notes, change the\n\s+approved dark selection/);
  assert.match(cancelled, /or report the candidate as applied\/locked/);
  assert.match(design, /Keep `visual_companion: <yes\|no\|skip>` pending/);
  assert.match(design, /Keep selection\/rejection notes pending on reruns/);
  assert.match(design, /do not repair drift during detection/);
  assert.match(prewrite, /scope, preserve its exact contents, presence\/absence, and approved selection/);
  assert.match(prewrite, /default dark never requires creating a dark file/);
});

test('minimal defaults, brand previews, and imported specs cannot bypass the rerun write boundary', () => {
  const paths = design.slice(design.indexOf('**Branches:**'), design.indexOf('**On ANY input failure'));
  assert.match(paths, /\*\*\(c\) Brand preview\*\*[^\n]*Sub-step 3\.5 before applying it/);
  assert.match(paths, /\*\*\(c\) Apply defaults \/ \(d\)[\s\S]*\*\*Minimal Sub-step 4\*\*[^\n]*Sub-step 3\.5 before writing it/);
  assert.match(paths, /prior full design exists[^\n]*concrete token delta and corresponding spec-section updates together, or preserve both unchanged/);
  assert.match(paths, /Cancellation or missing approval never authorizes a write/);
  assert.doesNotMatch(paths, /Never return DONE without writing/);
  const passthrough = paths.slice(paths.indexOf('**`--design-spec` passthrough:**'));
  inOrder(passthrough, 'without copying into `brand/`', 'Run Sub-step 3.5', 'apply only the', 'continue to Sub-steps 5–7');
  const importMode = inputs.slice(inputs.indexOf('### `--design-spec'), inputs.indexOf('### `--stylesheet'));
  inOrder(importMode, 'without copying into brand/', "Sub-step 3.5's approval + backup boundary", 'Apply the approved replacement');
  assert.doesNotMatch(inputs, /SKIP Sub-steps 3 AND 4|skips Sub-steps 3\+4/);
});

test('planning and partial prior state cannot fall through to first-time writes', () => {
  const setup = design.slice(design.indexOf('**Write boundary (all paths):**'), design.indexOf('## Sub-step 1 —'));
  assert.match(setup, /`--plan-only` or a planning-phase handoff returns\nonly a proposal; do not write brand artifacts, previews, history, or memory-bank/);
  assert.match(setup, /existing spec, light or\ndark token file, gallery, history, or record of a previously applied design makes\nthis a rerun/);
  assert.match(setup, /A new creation plan alone is not prior\nbrand state/);
  assert.match(setup, /first-time drafts generated in this invocation remain drafts during\nedit\/regeneration/);
  assert.match(setup, /Every generation\/reskin rerun uses \*\*Sub-step 3\.5\*\* before its first live write/);
  assert.match(setup, /Dedicated refresh,\ndark-mode, and rollback commands retain their own equivalent approval\/backup\nflows; do not add a second gate/);
  assert.match(prewrite, /Partial or unknown prior state is not first-time generation/);
  assert.match(prewrite, /stop and resolve it with the owner rather\n\s+than inventing an initial snapshot/);
});

test('edits and regeneration reapprove new deltas before replacing an existing design', () => {
  const edits = confirmation.slice(confirmation.indexOf('**On [edit X]:**'), confirmation.indexOf('**On [confirm]:**'));
  inOrder(edits, 'without live writes', 'return to Sub-step 3.5', 'verified backup before updating anything', 'Apply only that approved section');
  assert.match(edits, /An earlier approval does not cover changed values or expanded scope/);
  const regeneration = confirmation.slice(confirmation.indexOf('**On [regenerate]:**'), confirmation.indexOf('**On [skip'));
  assert.match(regeneration, /new direction invalidates\nthe previous candidate approval/);
  assert.match(regeneration, /reruns must pass Sub-step 3\.5 again before any\nreplacement/);
  assert.match(regeneration, /First-time regenerated drafts still wait for confirmation/);
});

test('first-time generation records complete history only after confirmation, never for drafts', () => {
  const completion = confirmation.slice(confirmation.indexOf('**History completion (after confirmation):**'));
  inOrder(design, '## Sub-step 4 —', '## Sub-step 5 —', '## Sub-step 6 —',
    '**On [confirm]:**', '**History completion (after confirmation):**', '## Sub-step 6.5 —');
  assert.match(generation, /History completion occurs after confirmation in Sub-step 6, not here/);
  assert.match(confirmation, /In either approved case, complete history below before continuing to Sub-step 6\.5/);
  assert.doesNotMatch(generation, /\*\*History completion|record one complete|approved initial snapshot/);
  assert.match(prewrite, /Do not create an approved initial snapshot before that confirmation/);
  assert.match(completion, /If a pre-write snapshot was captured, retain it unchanged/);
  assert.match(completion, /Do not create a\n\s+second post-write `-initial` snapshot/);
  assert.match(completion, /Only for first-time generation with no prior brand state/);
  assert.match(completion, /record one complete\n\s+approved initial snapshot after generation/);
  assert.match(completion, /after generation \*\*and explicit confirmation\*\* of\n\s+that candidate/);
  assert.match(completion, /light tokens, optional dark-token payload, and explicit presence\/approval\n\s+state/);
  assert.match(completion, /Verify every expected member before reporting success/);
  assert.match(completion, /failed or incomplete\n\s+snapshot is a visible failure/);
  assert.match(confirmation, /as draft, without\nan approved initial snapshot or a locked-design record/);
  assert.match(confirmation, /cancel, dismissal, silence, or ambiguity[\s\S]*without further writes, history creation, or approval\/lock/);
  assert.match(history, /after generation and explicit confirmation of that\ncandidate/);
  assert.match(history, /never before confirmation\nor for an unconfirmed draft/);
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

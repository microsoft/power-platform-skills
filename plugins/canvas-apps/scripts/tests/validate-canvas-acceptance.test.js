// Integration tests for scripts/validate-canvas-acceptance.cs.
//
// The validator is a pure static analyzer: given a canvas-app workspace (App.pa.yaml,
// plan, acceptance evidence) and the plugin root, it either exits 0 (PASS) or non-zero
// with one ERROR line per failed contract. It needs NO live coauthoring session, so it
// runs unchanged in CI. These tests drive it against a committed Receive/Issue fixture
// to lock in the directional-mutation contract (the P0 "reversed sign" regression).
//
// Two machine-specific values cannot be committed literally — the absolute workspace
// path (used by the plan's Dispatch target) and the absolute plugin root (used by the
// acceptance `Plugin root:` metadata). The fixture stores them as `{{WORKSPACE}}` and
// `{{PLUGIN_ROOT}}` placeholders in `*.template.md`; each test materializes a run under
// `.work/` (git-ignored), substitutes the real paths, and invokes the validator there.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const testsDir = __dirname;
const pluginRoot = path.resolve(testsDir, '..', '..');
const validator = path.join(pluginRoot, 'scripts', 'validate-canvas-acceptance.cs');
const fixtureDir = path.join(testsDir, 'fixtures', 'receive-issue');
const compoundFixtureDir = path.join(testsDir, 'fixtures', 'receive-issue-compound');
// Negative-space fixture embedding two runtime-fatal defects the "directionally correct"
// evidence otherwise satisfies: a phantom LookUp key (`... .Selected.ID & " ID"`) and dead
// staging variables (`varReceipt*` seeded to 0 and never written from an input). The validator
// must report both defects. Individual tests repair the key or add live OnChange assignments
// to prove each rule independently instead of allowing one failure to mask the other.
const staleStagingFixtureDir = path.join(testsDir, 'fixtures', 'receive-issue-stale-staging');
const workRoot = path.join(testsDir, '.work');

// The valid issue mutation subtracts the amount from the old value (`old - amount`).
// Swapping the operands to `amount - old` keeps a '-' in the formula — which the old
// "operator appears anywhere" check accepted — while reversing the real direction, so it
// is the precise negative case the hardened binding must reject.
const CORRECT_ISSUE_ARITHMETIC = 'varOldQuantity - varAmount';
const REVERSED_ISSUE_ARITHMETIC = 'varAmount - varOldQuantity';

// The reviewer's repro: keep the *expected-value* preview correct
// (`Set(varExpectedQuantity, varOldQuantity - varAmount)`) but reverse only the actual Patch
// write's persisted value (`{Quantity: varOldQuantity - varAmount}` -> `+`). A whole-formula
// scan still finds a correct `old - amount` (in the preview) and wrongly PASSES; the hardened
// check isolates the Patch write and must FAIL this, because the persisted direction is wrong.
const CORRECT_ISSUE_PATCH_WRITE = '{Quantity: varOldQuantity - varAmount}';
const REVERSED_ISSUE_PATCH_WRITE = '{Quantity: varOldQuantity + varAmount}';
const PHANTOM_RECORD_ID = 'drpMngAdjustItem.Selected.ID & " ID"';
const LIVE_RECORD_ID = 'drpMngAdjustItem.Selected.ID';
const RECEIVE_STALE_WRITE = '{Quantity: varReceiptOldQuantity + varReceiptAmount}))';
const ISSUE_STALE_WRITE = '{Quantity: varReceiptOldQuantity - varReceiptAmount}))';
const LATE_STAGING_ASSIGNMENTS =
    '; Set(varReceiptOldQuantity, drpMngAdjustItem.Selected.Quantity)' +
    '; Set(varReceiptAmount, Value(numMngAdjustAmount.Text))';

function materialize(
    caseName,
    {
        reverseIssue = false,
        reverseIssuePatchOnly = false,
        repairPhantomKey = false,
        wireStagingOnChange = false,
        wireStagingAfterPatch = false,
        sourceDir = fixtureDir,
    } = {}) {
    const workspace = path.join(workRoot, caseName);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });

    // App.pa.yaml and Screen1.pa.yaml are copied verbatim (they contain no placeholders);
    // the two Markdown artifacts are templated with the run-specific absolute paths.
    let appYaml = fs.readFileSync(path.join(sourceDir, 'App.pa.yaml'), 'utf8');
    let screenYaml = fs.readFileSync(path.join(sourceDir, 'Screen1.pa.yaml'), 'utf8');
    let plan = fs.readFileSync(path.join(sourceDir, 'canvas-app-plan.template.md'), 'utf8');
    let acceptance = fs.readFileSync(path.join(sourceDir, 'canvas-app-acceptance.template.md'), 'utf8');

    plan = plan.split('{{WORKSPACE}}').join(workspace);
    acceptance = acceptance.split('{{PLUGIN_ROOT}}').join(pluginRoot);

    if (reverseIssue) {
        // Reverse the sign in BOTH the YAML (so the binding still matches the app exactly
        // and only the directional check fires) and the acceptance issue-mutation cell.
        screenYaml = screenYaml.split(CORRECT_ISSUE_ARITHMETIC).join(REVERSED_ISSUE_ARITHMETIC);
        acceptance = acceptance.split(CORRECT_ISSUE_ARITHMETIC).join(REVERSED_ISSUE_ARITHMETIC);
    }

    if (reverseIssuePatchOnly) {
        // Reverse ONLY the Patch write (persisted value), leaving the expected-value preview
        // `Set(varExpectedQuantity, varOldQuantity - varAmount)` intact. Apply to both the YAML
        // and the acceptance cell so the binding still matches the app and only the directional
        // Patch-write check fires.
        screenYaml = screenYaml.split(CORRECT_ISSUE_PATCH_WRITE).join(REVERSED_ISSUE_PATCH_WRITE);
        acceptance = acceptance.split(CORRECT_ISSUE_PATCH_WRITE).join(REVERSED_ISSUE_PATCH_WRITE);
    }

    if (repairPhantomKey) {
        screenYaml = screenYaml.split(PHANTOM_RECORD_ID).join(LIVE_RECORD_ID);
        acceptance = acceptance.split(PHANTOM_RECORD_ID).join(LIVE_RECORD_ID);
    }

    if (wireStagingOnChange) {
        screenYaml = screenYaml.replace(
            '                    Items: =colInventory',
            '                    Items: =colInventory\n' +
            '                    OnChange: =Set(varReceiptOldQuantity, drpMngAdjustItem.Selected.Quantity)');
        screenYaml = screenYaml.replace(
            '                    Format: =TextFormat.Number',
            '                    Format: =TextFormat.Number\n' +
            '                    OnChange: =Set(varReceiptAmount, Value(numMngAdjustAmount.Text))');
    }

    if (wireStagingAfterPatch) {
        for (const mutationTail of [RECEIVE_STALE_WRITE, ISSUE_STALE_WRITE]) {
            screenYaml = screenYaml.split(mutationTail).join(mutationTail + LATE_STAGING_ASSIGNMENTS);
            acceptance = acceptance.split(mutationTail).join(mutationTail + LATE_STAGING_ASSIGNMENTS);
        }
    }

    fs.writeFileSync(path.join(workspace, 'App.pa.yaml'), appYaml);
    fs.writeFileSync(path.join(workspace, 'Screen1.pa.yaml'), screenYaml);
    fs.writeFileSync(path.join(workspace, 'canvas-app-plan.md'), plan);
    fs.writeFileSync(path.join(workspace, 'canvas-app-acceptance.md'), acceptance);
    return workspace;
}

function runValidator(workspace) {
    const result = spawnSync(
        'dotnet',
        ['run', '--file', validator, '--', workspace, pluginRoot],
        { encoding: 'utf8' });
    if (result.error) {
        throw result.error;
    }

    return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));

test('accepts a correctly-signed Receive/Issue workspace', () => {
    const workspace = materialize('receive-issue-pass');
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /PASS:/);
});

test('rejects a reversed-sign Issue mutation (directional contract)', () => {
    const workspace = materialize('receive-issue-reversed', { reverseIssue: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected a reversed-sign issue mutation to fail validation');
    // The failure must be the directional binding specifically — not an unrelated error —
    // to prove the hardened check is what caught the reversed arithmetic.
    assert.match(stderr, /issue mutation must apply '-'/);
});

test('rejects a reversed-sign Issue Patch write even when the expected-value preview is correct', () => {
    // Reviewer's repro: expected-value preview stays `varOldQuantity - varAmount` (correct),
    // only the actual Patch write flips to `+`. A whole-formula scan would still find a correct
    // `old - amount` in the preview and wrongly PASS; the hardened check must isolate the Patch
    // write and FAIL. This is the "correct-looking receipt math, wrong persisted value" pattern.
    const workspace = materialize('receive-issue-reversed-patch', { reverseIssuePatchOnly: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected a reversed-sign Patch write to fail validation');
    // The failure must name the Patch write specifically, proving the check binds the operator to
    // the persisted value and not to the still-correct expected-value preview.
    assert.match(stderr, /issue mutation must apply '-'[^\n]*in its Patch write/);
});

test('accepts a same-record compound-sequence Receive/Issue workspace', () => {
    // Static scope only: this asserts the compound fixture's final YAML and evidence artifacts
    // pass the same file-based validator (correct +/- arithmetic, blank-operation gate, stable
    // selected-record ID, canonical observer, five receipt bindings). The compound fixture reads
    // each operation's old value from the canonical source
    // (`LookUp(colInventory, ID = cmbAdjustItem.Selected.ID).Quantity`) and documents the
    // `Qty 10 -> Receive 3 -> 13 -> Issue 2 -> 11` sequence in a `## Compound Sequence Evidence`
    // table. The validator does NOT execute the app, so it cannot prove that at runtime the
    // second operation truly reads the mutated 13 (not a stale 10) or that the submit button
    // becomes clickable — that stays the live browser evaluation's job. This test only locks in
    // that the compound fixture and its extra evidence table remain validator-clean.
    const workspace = materialize('receive-issue-compound-pass', { sourceDir: compoundFixtureDir });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /PASS:/);
});

test('rejects both a phantom LookUp key and dead staging variables', () => {
    // This fixture is directionally correct (Patch writes `old + amount` / `old - amount`,
    // expected-value preview agrees, selected-record expression carries a stable ID, observer
    // reads the canonical source), so it satisfies every prior contract. It embeds two
    // runtime-fatal defects:
    //   1. Phantom LookUp key — the Patch target is
    //      `LookUp(colInventory, ID = drpMngAdjustItem.Selected.ID & " ID")`; the literal
    //      ` & " ID"` suffix guarantees LookUp returns Blank() so no record is ever patched.
    //   2. Dead/stale staging variables — `varReceiptOldQuantity`/`varReceiptAmount` are seeded
    //      to 0 in App.OnStart and NEVER written from `numMngAdjustAmount`/`drpMngAdjustItem`
    //      (no OnChange, no inline `.Value`/`.Selected` read at mutation time), so every
    //      adjustment computes against 0 instead of the typed amount.
    // Both defects are independently machine-enforced, once per direction and operand.
    const workspace = materialize('receive-issue-stale-staging-fail', { sourceDir: staleStagingFixtureDir });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, `expected FAIL but validator exited 0.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stderr, /receive mutation uses a transformed record-identity key/);
    assert.match(stderr, /issue mutation uses a transformed record-identity key/);
    assert.match(stderr, /receive old operand 'varReceiptOldQuantity' is a dead staging variable/);
    assert.match(stderr, /receive amount operand 'varReceiptAmount' is a dead staging variable/);
    assert.match(stderr, /issue old operand 'varReceiptOldQuantity' is a dead staging variable/);
    assert.match(stderr, /issue amount operand 'varReceiptAmount' is a dead staging variable/);
    const errorLines = stderr.split('\n').filter((line) => line.startsWith('ERROR:'));
    assert.strictEqual(errorLines.length, 6, `expected two key and four liveness errors, got:\n${stderr}`);
});

test('rejects dead staging variables when the selected-record key is valid', () => {
    const workspace = materialize(
        'receive-issue-dead-staging-only',
        { sourceDir: staleStagingFixtureDir, repairPhantomKey: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, `expected FAIL but validator exited 0.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /transformed record-identity key/);
    assert.match(stderr, /receive old operand 'varReceiptOldQuantity' is a dead staging variable/);
    assert.match(stderr, /receive amount operand 'varReceiptAmount' is a dead staging variable/);
    assert.match(stderr, /issue old operand 'varReceiptOldQuantity' is a dead staging variable/);
    assert.match(stderr, /issue amount operand 'varReceiptAmount' is a dead staging variable/);
    const errorLines = stderr.split('\n').filter((line) => line.startsWith('ERROR:'));
    assert.strictEqual(errorLines.length, 4, `expected exactly four liveness errors, got:\n${stderr}`);
});

test('accepts staging variables written from live control OnChange formulas', () => {
    const workspace = materialize(
        'receive-issue-live-onchange',
        {
            sourceDir: staleStagingFixtureDir,
            repairPhantomKey: true,
            wireStagingOnChange: true,
        });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /PASS:/);
});

test('rejects staging assignments that occur only after Patch', () => {
    const workspace = materialize(
        'receive-issue-late-staging',
        {
            sourceDir: staleStagingFixtureDir,
            repairPhantomKey: true,
            wireStagingAfterPatch: true,
        });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, `expected FAIL but validator exited 0.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stderr, /receive old operand 'varReceiptOldQuantity' is a dead staging variable/);
    assert.match(stderr, /receive amount operand 'varReceiptAmount' is a dead staging variable/);
    assert.match(stderr, /issue old operand 'varReceiptOldQuantity' is a dead staging variable/);
    assert.match(stderr, /issue amount operand 'varReceiptAmount' is a dead staging variable/);
});

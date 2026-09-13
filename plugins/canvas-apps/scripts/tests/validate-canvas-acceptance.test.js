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
const RECEIVE_ACTION_BINDING =
    '`btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount}))`';
const ISSUE_ACTION_BINDING =
    '`btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount}))`';
const RECEIVE_ACTION_FORMULA = RECEIVE_ACTION_BINDING.slice('`btnReceive.OnSelect: '.length, -1);
const ISSUE_ACTION_FORMULA = ISSUE_ACTION_BINDING.slice('`btnIssue.OnSelect: '.length, -1);
const SHARED_SWITCH =
    'Switch(varOperation, "Receive", varOldQuantity + varAmount, "Issue", varOldQuantity - varAmount)';
const REVERSED_SHARED_SWITCH =
    'Switch(varOperation, "Receive", varOldQuantity - varAmount, "Issue", varOldQuantity + varAmount)';
const SHARED_APPLY_FORMULA =
    `=Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, ${SHARED_SWITCH}); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: ${SHARED_SWITCH}}))`;
const SHARED_APPLY_BINDING = `\`btnApply.OnSelect: ${SHARED_APPLY_FORMULA}\``;

function replaceAllRequired(value, expected, replacement, label) {
    assert.ok(value.includes(expected), `fixture transformation could not find ${label}: ${expected}`);
    return value.split(expected).join(replacement);
}

function replaceOnceRequired(value, expected, replacement, label) {
    const first = value.indexOf(expected);
    assert.notStrictEqual(first, -1, `fixture transformation could not find ${label}: ${expected}`);
    assert.strictEqual(
        value.indexOf(expected, first + expected.length),
        -1,
        `fixture transformation expected exactly one ${label}`);
    return value.replace(expected, replacement);
}

function replaceFirstRequired(value, expected, replacement, label) {
    assert.ok(value.includes(expected), `fixture transformation could not find ${label}: ${expected}`);
    return value.replace(expected, replacement);
}

function readFixture(file) {
    const raw = fs.readFileSync(file, 'utf8');
    return {
        eol: raw.includes('\r\n') ? '\r\n' : '\n',
        text: raw.replace(/\r\n/g, '\n'),
    };
}

function writeFixture(file, fixture) {
    const output = fixture.eol === '\n'
        ? fixture.text
        : fixture.text.replace(/\n/g, fixture.eol);
    fs.writeFileSync(file, output);
}

function materialize(
    caseName,
    {
        reverseIssue = false,
        reverseIssuePatchOnly = false,
        repairPhantomKey = false,
        wireStagingOnChange = false,
        wireStagingAfterPatch = false,
        contradictReceiveActionBinding = false,
        sharedApplyFlow = false,
        sharedSelectorMutates = false,
        omitSharedMutationBinding = false,
        reverseSharedBranches = false,
        mismatchedSharedVariables = false,
        mismatchedSharedOwner = false,
        mutationDoesNotConsumeOperation = false,
        mismatchedSharedGate = false,
        operationLiteralSuffix = false,
        unrelatedOperationLiteral = false,
        dropdownSelector = false,
        quoteYamlFormulas = false,
        blockYamlFormula = false,
        blockYamlKeepTrailingNewline = false,
        actionBindingLineBreak = false,
        misleadingApplyDirect = false,
        orphanApplyGate = false,
        labeledReceiptValues = false,
        ambiguousReceiptValue = false,
        selectorReceiptAssignment = false,
        sharedActionHandlerOnly = false,
        dropdownDirectShared = false,
        updateContextSelectors = false,
        sharedIfBranches = false,
        ambiguousSharedDispatch = false,
        mutatingSelectorFunction = null,
        selectGateRouting = false,
        unrelatedGateMutation = false,
        requiredRecordScalar = null,
        mixedTopology = false,
        multiFieldPatch = false,
        ambiguousMultiFieldPatch = false,
        contextStagingOnChange = false,
        contextStagingAfterPatch = false,
        q8RuntimeGaps = false,
        selectedEvidenceMismatch = false,
        explicitSelectedId = false,
        modernAmount = false,
        modernAmountDefaultZero = false,
        stagedAmountMinOne = false,
        operationPostSuccessReset = false,
        compoundSelectionMismatch = false,
        omitOperationAllowEmpty = false,
        omitSelectionDefault = false,
        listBoxSelection = false,
        directWithoutOperationState = false,
        customRecordKey = false,
        transformedCustomRecordKey = false,
        wrappedGalleryItems = false,
        twoSpaceScreenIndent = false,
        amountInvalidPolarity = false,
        sourceDir = fixtureDir,
    } = {}) {
    const workspace = path.join(workRoot, caseName);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });

    // App.pa.yaml and Screen1.pa.yaml are copied verbatim (they contain no placeholders);
    // the two Markdown artifacts are templated with the run-specific absolute paths.
    const appFixture = readFixture(path.join(sourceDir, 'App.pa.yaml'));
    const screenFixture = readFixture(path.join(sourceDir, 'Screen1.pa.yaml'));
    const planFixture = readFixture(path.join(sourceDir, 'canvas-app-plan.template.md'));
    const acceptanceFixture = readFixture(path.join(sourceDir, 'canvas-app-acceptance.template.md'));
    let appYaml = appFixture.text;
    let screenYaml = screenFixture.text;
    let plan = planFixture.text;
    let acceptance = acceptanceFixture.text;

    plan = plan.split('{{WORKSPACE}}').join(workspace);
    acceptance = acceptance.split('{{PLUGIN_ROOT}}').join(pluginRoot);
    screenYaml = replaceFirstRequired(
        screenYaml,
        '                    AllowEmptySelection: =true\n' +
        '                    DefaultSelectedItems: =[]',
        '                    DefaultSelectedItems: =[]',
        'docs-compliant ComboBox empty-selection properties');

    if (reverseIssue) {
        // Reverse the sign in BOTH the YAML (so the binding still matches the app exactly
        // and only the directional check fires) and the acceptance issue-mutation cell.
        screenYaml = replaceAllRequired(
            screenYaml, CORRECT_ISSUE_ARITHMETIC, REVERSED_ISSUE_ARITHMETIC, 'Issue arithmetic in YAML');
        acceptance = replaceAllRequired(
            acceptance, CORRECT_ISSUE_ARITHMETIC, REVERSED_ISSUE_ARITHMETIC, 'Issue arithmetic evidence');
    }

    if (reverseIssuePatchOnly) {
        // Reverse ONLY the Patch write (persisted value), leaving the expected-value preview
        // `Set(varExpectedQuantity, varOldQuantity - varAmount)` intact. Apply to both the YAML
        // and the acceptance cell so the binding still matches the app and only the directional
        // Patch-write check fires.
        screenYaml = replaceAllRequired(
            screenYaml, CORRECT_ISSUE_PATCH_WRITE, REVERSED_ISSUE_PATCH_WRITE, 'Issue Patch write in YAML');
        acceptance = replaceAllRequired(
            acceptance, CORRECT_ISSUE_PATCH_WRITE, REVERSED_ISSUE_PATCH_WRITE, 'Issue Patch write evidence');
    }

    if (repairPhantomKey) {
        screenYaml = replaceAllRequired(
            screenYaml, PHANTOM_RECORD_ID, LIVE_RECORD_ID, 'phantom record ID in YAML');
        acceptance = replaceAllRequired(
            acceptance, PHANTOM_RECORD_ID, LIVE_RECORD_ID, 'phantom record ID evidence');
    }

    if (contextStagingOnChange || contextStagingAfterPatch) {
        for (const [stale, context] of [
            ['varReceiptOldQuantity', 'locOldQuantity'],
            ['varReceiptAmount', 'locAmount'],
        ]) {
            appYaml = replaceAllRequired(appYaml, stale, context, `${stale} App context name`);
            screenYaml = replaceAllRequired(screenYaml, stale, context, `${stale} YAML context name`);
            acceptance = replaceAllRequired(
                acceptance, stale, context, `${stale} evidence context name`);
        }

        if (contextStagingOnChange) {
            screenYaml = replaceFirstRequired(
                screenYaml,
                '                    Items: =colInventory',
                '                    Items: =colInventory\n' +
                '                    OnChange: =UpdateContext({locOldQuantity: drpMngAdjustItem.Selected.Quantity})',
                'context selected-record assignment');
            screenYaml = replaceOnceRequired(
                screenYaml,
                '                    Format: =TextFormat.Number',
                '                    Format: =TextFormat.Number\n' +
                '                    OnChange: =UpdateContext({locAmount: Value(numMngAdjustAmount.Text)})',
                'context amount assignment');
        }

        if (contextStagingAfterPatch) {
            const assignments =
                '; UpdateContext({locOldQuantity: drpMngAdjustItem.Selected.Quantity, ' +
                'locAmount: Value(numMngAdjustAmount.Text)})';
            for (const tail of [
                '{Quantity: locOldQuantity + locAmount}))',
                '{Quantity: locOldQuantity - locAmount}))',
            ]) {
                screenYaml = replaceAllRequired(
                    screenYaml, tail, tail + assignments, 'late context assignment YAML');
                acceptance = replaceAllRequired(
                    acceptance, tail, tail + assignments, 'late context assignment evidence');
            }
        }
    }

    if (wireStagingOnChange) {
        // The selected-record combo box is the first of two controls bound to colInventory.
        screenYaml = replaceFirstRequired(
            screenYaml,
            '                    Items: =colInventory',
            '                    Items: =colInventory\n' +
            '                    OnChange: =Set(varReceiptOldQuantity, drpMngAdjustItem.Selected.Quantity)',
            'selected-record Items binding');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    Format: =TextFormat.Number',
            '                    Format: =TextFormat.Number\n' +
            '                    OnChange: =Set(varReceiptAmount, Value(numMngAdjustAmount.Text))',
            'amount Format binding');
    }

    if (wireStagingAfterPatch) {
        for (const mutationTail of [RECEIVE_STALE_WRITE, ISSUE_STALE_WRITE]) {
            screenYaml = replaceAllRequired(
                screenYaml, mutationTail, mutationTail + LATE_STAGING_ASSIGNMENTS, 'stale Patch write in YAML');
            acceptance = replaceAllRequired(
                acceptance, mutationTail, mutationTail + LATE_STAGING_ASSIGNMENTS, 'stale Patch write evidence');
        }
    }

    if (contradictReceiveActionBinding) {
        const claimedBinding = '`btnReceive.OnSelect: =Set(varOperation, "Receive")`';
        acceptance = replaceOnceRequired(
            acceptance,
            `| Receive | btnReceive | ${RECEIVE_ACTION_BINDING} |`,
            `| Receive | btnReceive | ${claimedBinding} |`,
            'Receive Action Contract row');
    }

    if (sharedApplyFlow) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - btnReceive:',
            '            - btnApply:\n' +
            '                Control: Classic/Button\n' +
            '                Properties:\n' +
            '                    DisplayMode: =If(IsBlank(varOperation) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)\n' +
            `                    OnSelect: ${SHARED_APPLY_FORMULA}\n` +
            '            - btnReceive:',
            'shared Apply control');

        const mutatingReceiveSelectorBinding = RECEIVE_ACTION_BINDING.replace(
            '=Set(varLastOperation, "Receive")',
            '=Set(varOperation, "Receive"); Set(varLastOperation, "Receive")');
        const receiveSelectorBinding = sharedSelectorMutates
            ? mutatingReceiveSelectorBinding
            : '`btnReceive.OnSelect: =Set(varOperation, "Receive")`';
        const issueSelectorBinding = '`btnIssue.OnSelect: =Set(varOperation, "Issue")`';
        if (!sharedSelectorMutates) {
            screenYaml = replaceOnceRequired(
                screenYaml,
                '                    DisplayMode: =If(IsBlank(drpOperation.Selected.Value) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)\n' +
                `                    OnSelect: ${RECEIVE_ACTION_FORMULA}`,
                '                    OnSelect: =Set(varOperation, "Receive")',
                'Receive selector YAML');
        } else {
            screenYaml = replaceOnceRequired(
                screenYaml,
                `                    OnSelect: ${RECEIVE_ACTION_FORMULA}`,
                `                    OnSelect: ${mutatingReceiveSelectorBinding.slice(
                    '`btnReceive.OnSelect: '.length, -1)}`,
                'mutating Receive selector YAML');
        }
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    DisplayMode: =If(IsBlank(drpOperation.Selected.Value) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)\n' +
            `                    OnSelect: ${ISSUE_ACTION_FORMULA}`,
            '                    OnSelect: =Set(varOperation, "Issue")',
            'Issue selector YAML');

        acceptance = replaceOnceRequired(
            acceptance,
            `| Receive | btnReceive | ${RECEIVE_ACTION_BINDING} |`,
            `| Receive | btnReceive + btnApply | ${receiveSelectorBinding}<br>${SHARED_APPLY_BINDING} |`,
            'Receive shared Action Contract row');
        acceptance = replaceOnceRequired(
            acceptance,
            `| Issue   | btnIssue   | ${ISSUE_ACTION_BINDING} |`,
            `| Issue   | btnIssue + btnApply | ${issueSelectorBinding}<br>${SHARED_APPLY_BINDING} |`,
            'Issue shared Action Contract row');
        assert.ok(
            acceptance.includes('Screen1.OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)'),
            'shared fixture must retain exact blank operation evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)',
            '            OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            'shared operation reset YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'Screen1.OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)',
            'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            'shared operation reset evidence');
        acceptance = replaceOnceRequired(
            acceptance,
            'btnReceive.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            'btnApply.DisplayMode: =If(IsBlank(varOperation) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            'shared Apply gate evidence');
        if (!sharedSelectorMutates) {
            acceptance = replaceOnceRequired(
                acceptance,
                RECEIVE_ACTION_BINDING.slice(1, -1),
                SHARED_APPLY_BINDING.slice(1, -1),
                'Receive directional mutation evidence');
        }
        acceptance = replaceOnceRequired(
            acceptance,
            ISSUE_ACTION_BINDING.slice(1, -1),
            SHARED_APPLY_BINDING.slice(1, -1),
            'Issue directional mutation evidence');
        acceptance = replaceOnceRequired(
            acceptance,
            'operation=lblReceiptOperation.Text: =varLastOperation',
            'operation=lblReceiptOperation.Text: =varOperation',
            'shared operation receipt evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    Text: =varLastOperation',
            '                    Text: =varOperation',
            'shared operation receipt YAML');

        if (reverseSharedBranches) {
            screenYaml = replaceAllRequired(
                screenYaml, SHARED_SWITCH, REVERSED_SHARED_SWITCH, 'shared Switch branches in YAML');
            acceptance = replaceAllRequired(
                acceptance, SHARED_SWITCH, REVERSED_SHARED_SWITCH, 'shared Switch branch evidence');
        }

        if (omitSharedMutationBinding) {
            acceptance = replaceAllRequired(
                acceptance,
                `<br>${SHARED_APPLY_BINDING}`,
                '',
                'shared mutation binding in Action Contract');
        }

        if (mismatchedSharedVariables) {
            screenYaml = replaceOnceRequired(
                screenYaml,
                '                    OnSelect: =Set(varOperation, "Issue")',
                '                    OnSelect: =Set(varIssueOperation, "Issue")',
                'Issue selector variable in YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                '`btnIssue.OnSelect: =Set(varOperation, "Issue")`',
                '`btnIssue.OnSelect: =Set(varIssueOperation, "Issue")`',
                'Issue selector variable evidence');
        }

        if (mismatchedSharedOwner) {
            screenYaml = replaceOnceRequired(
                screenYaml,
                '            - btnReceive:',
                '            - btnCommitAdjustment:\n' +
                '                Control: Classic/Button\n' +
                '                Properties:\n' +
                '                    DisplayMode: =If(IsBlank(varOperation) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)\n' +
                `                    OnSelect: ${SHARED_APPLY_FORMULA}\n` +
                '            - btnReceive:',
                'second shared mutation owner YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                '`btnIssue.OnSelect: =Set(varOperation, "Issue")`<br>' +
                SHARED_APPLY_BINDING,
                '`btnIssue.OnSelect: =Set(varOperation, "Issue")`<br>' +
                SHARED_APPLY_BINDING.replace('btnApply', 'btnCommitAdjustment'),
                'Issue mutation owner evidence');
        }

        if (mutationDoesNotConsumeOperation) {
            const disconnectedFormula = SHARED_APPLY_FORMULA.replaceAll(
                'varOperation',
                'varMutationMode');
            screenYaml = replaceAllRequired(
                screenYaml, SHARED_APPLY_FORMULA, disconnectedFormula, 'disconnected mutation YAML');
            acceptance = replaceAllRequired(
                acceptance, SHARED_APPLY_FORMULA, disconnectedFormula, 'disconnected mutation evidence');
        }

        if (mismatchedSharedGate) {
            screenYaml = replaceOnceRequired(
                screenYaml,
                'DisplayMode: =If(IsBlank(varOperation)',
                'DisplayMode: =If(IsBlank(varGateOperation)',
                'shared gate variable in YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                'btnApply.DisplayMode: =If(IsBlank(varOperation)',
                'btnApply.DisplayMode: =If(IsBlank(varGateOperation)',
                'shared gate variable evidence');
        }

        if (operationLiteralSuffix) {
            for (const [literal, replacement] of [
                ['"Receive"', '"Receive inventory"'],
                ['"Issue"', '"Issue inventory"'],
            ]) {
                screenYaml = replaceAllRequired(
                    screenYaml, literal, replacement, `${literal} operation literal in YAML`);
                acceptance = replaceAllRequired(
                    acceptance, literal, replacement, `${literal} operation literal evidence`);
            }
        }

        if (unrelatedOperationLiteral) {
            screenYaml = replaceOnceRequired(
                screenYaml,
                '                    OnSelect: =Set(varOperation, "Receive")',
                '                    OnSelect: =Set(varOperation, "Inbound")',
                'unrelated Receive selector literal in YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                '`btnReceive.OnSelect: =Set(varOperation, "Receive")`',
                '`btnReceive.OnSelect: =Set(varOperation, "Inbound")`',
                'unrelated Receive selector literal evidence');
        }

        if (dropdownSelector) {
            const dropdownEvent = '`drpOperation.OnChange: =Set(varOperation, Self.Selected.Value)`';
            const dropdownItems = '`drpOperation.Items: =["Receive", "Issue"]`';
            screenYaml = replaceOnceRequired(
                screenYaml,
                '                    Items: =["Receive", "Issue"]',
                '                    Items: =["Receive", "Issue"]\n' +
                '                    OnChange: =Set(varOperation, Self.Selected.Value)',
                'dropdown selector YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                '`btnReceive.OnSelect: =Set(varOperation, "Receive")`',
                `${dropdownEvent}<br>${dropdownItems}`,
                'Receive dropdown selector evidence');
            acceptance = replaceOnceRequired(
                acceptance,
                '`btnIssue.OnSelect: =Set(varOperation, "Issue")`',
                `${dropdownEvent}<br>${dropdownItems}`,
                'Issue dropdown selector evidence');
        }

        if (selectorReceiptAssignment) {
            for (const direction of ['Receive', 'Issue']) {
                screenYaml = replaceOnceRequired(
                    screenYaml,
                    `OnSelect: =Set(varOperation, "${direction}")`,
                    `OnSelect: =Set(varOperation, "${direction}"); Set(varReceiptAction, "${direction}")`,
                    `${direction} selector receipt assignment in YAML`);
                acceptance = replaceOnceRequired(
                    acceptance,
                    `OnSelect: =Set(varOperation, "${direction}")\``,
                    `OnSelect: =Set(varOperation, "${direction}"); Set(varReceiptAction, "${direction}")\``,
                    `${direction} selector receipt assignment evidence`);
            }
        }

        if (sharedActionHandlerOnly || dropdownDirectShared || updateContextSelectors || mixedTopology) {
            for (const direction of ['Receive', 'Issue']) {
                acceptance = replaceOnceRequired(
                    acceptance,
                    `\`btn${direction}.OnSelect: =Set(varOperation, "${direction}")\`<br>`,
                    '',
                    `${direction} selector omission from Action Contract`);
            }
        }

        if (updateContextSelectors) {
            for (const direction of ['Receive', 'Issue']) {
                screenYaml = replaceOnceRequired(
                    screenYaml,
                    `OnSelect: =Set(varOperation, "${direction}")`,
                    `OnSelect: =UpdateContext({varOperation: "${direction}"})`,
                    `${direction} UpdateContext selector YAML`);
            }
        }

        if (dropdownDirectShared) {
            for (const direction of ['Receive', 'Issue']) {
                screenYaml = replaceOnceRequired(
                    screenYaml,
                    `                    OnSelect: =Set(varOperation, "${direction}")`,
                    '',
                    `${direction} Set selector removal`);
            }
            screenYaml = replaceOnceRequired(
                screenYaml,
                '            OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
                '            OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)',
                'dropdown operation reset YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
                'Screen1.OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)',
                'dropdown operation reset evidence');
            screenYaml = replaceAllRequired(
                screenYaml,
                'varOperation',
                'drpOperation.Selected.Value',
                'dropdown-direct operation source in YAML');
            acceptance = replaceAllRequired(
                acceptance,
                'varOperation',
                'drpOperation.Selected.Value',
                'dropdown-direct operation source evidence');
        }

        if (sharedIfBranches) {
            const sharedIf =
                'If(varOperation = "Receive", varOldQuantity + varAmount, ' +
                'varOperation = "Issue", varOldQuantity - varAmount)';
            screenYaml = replaceAllRequired(
                screenYaml, SHARED_SWITCH, sharedIf, 'guarded If branches in YAML');
            acceptance = replaceAllRequired(
                acceptance, SHARED_SWITCH, sharedIf, 'guarded If branch evidence');
        }

        if (ambiguousSharedDispatch) {
            const ambiguous =
                `(${SHARED_SWITCH}) + 0 * (${SHARED_SWITCH})`;
            screenYaml = replaceAllRequired(
                screenYaml, SHARED_SWITCH, ambiguous, 'ambiguous shared dispatch in YAML');
            acceptance = replaceAllRequired(
                acceptance, SHARED_SWITCH, ambiguous, 'ambiguous shared dispatch evidence');
        }

        if (mixedTopology) {
            const mixedSharedBinding = reverseSharedBranches
                ? SHARED_APPLY_BINDING.replaceAll(SHARED_SWITCH, REVERSED_SHARED_SWITCH)
                : SHARED_APPLY_BINDING;
            screenYaml = replaceOnceRequired(
                screenYaml,
                '                    OnSelect: =Set(varOperation, "Issue")',
                `                    OnSelect: ${ISSUE_ACTION_FORMULA}`,
                'mixed direct Issue YAML');
            acceptance = replaceOnceRequired(
                acceptance,
                `| Issue   | btnIssue + btnApply | ${mixedSharedBinding} |`,
                `| Issue   | btnIssue | ${ISSUE_ACTION_BINDING} |`,
                'mixed direct Issue Action Contract');
            acceptance = replaceOnceRequired(
                acceptance,
                ` | ${mixedSharedBinding.slice(1, -1)} | galInventory.Items: =colInventory |`,
                ` | ${ISSUE_ACTION_BINDING.slice(1, -1)} | galInventory.Items: =colInventory |`,
                'mixed direct Issue mutation evidence');
        }

        if (mutatingSelectorFunction) {
            const mutations = {
                ClearCollect: 'ClearCollect(colScratch, {Value: 1})',
                Clear: 'Clear(colScratch)',
                Update: 'Update(colScratch, First(colScratch), {Value: 2})',
                Relate: 'Relate(ThisItem.Children, First(colScratch))',
                Unrelate: 'Unrelate(ThisItem.Children, First(colScratch))',
            };
            const mutation = mutations[mutatingSelectorFunction];
            assert.ok(mutation, `missing selector mutation fixture for ${mutatingSelectorFunction}`);
            screenYaml = replaceOnceRequired(
                screenYaml,
                'OnSelect: =Set(varOperation, "Receive")',
                `OnSelect: =Set(varOperation, "Receive"); ${mutation}`,
                `${mutatingSelectorFunction} selector YAML`);
            acceptance = replaceOnceRequired(
                acceptance,
                'OnSelect: =Set(varOperation, "Receive")`',
                `OnSelect: =Set(varOperation, "Receive"); ${mutation}\``,
                `${mutatingSelectorFunction} selector evidence`);
        }
    }

    if (quoteYamlFormulas) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            `                    OnSelect: ${RECEIVE_ACTION_FORMULA}`,
            `                    OnSelect: '${RECEIVE_ACTION_FORMULA}'`,
            'single-quoted Receive YAML formula');
        screenYaml = replaceOnceRequired(
            screenYaml,
            `                    OnSelect: ${ISSUE_ACTION_FORMULA}`,
            `                    OnSelect: ${JSON.stringify(ISSUE_ACTION_FORMULA)}`,
            'double-quoted Issue YAML formula');
    }

    if (blockYamlFormula) {
        const literalMarker = blockYamlKeepTrailingNewline ? '|' : '|-';
        const foldedMarker = blockYamlKeepTrailingNewline ? '>' : '>-';
        const receiveBlockFormula = blockYamlKeepTrailingNewline
            ? RECEIVE_ACTION_FORMULA.replace(
                '; Set(varOldQuantity',
                ';\n\n                        Set(varOldQuantity')
            : RECEIVE_ACTION_FORMULA;
        screenYaml = replaceOnceRequired(
            screenYaml,
            `                    OnSelect: ${RECEIVE_ACTION_FORMULA}`,
            `                    OnSelect: ${literalMarker}\n` +
            `                        ${receiveBlockFormula}`,
            'literal block Receive YAML formula');
        screenYaml = replaceOnceRequired(
            screenYaml,
            `                    OnSelect: ${ISSUE_ACTION_FORMULA}`,
            `                    OnSelect: ${foldedMarker}\n` +
            `                        ${ISSUE_ACTION_FORMULA}`,
            'folded block Issue YAML formula');
    }

    if (actionBindingLineBreak) {
        acceptance = replaceOnceRequired(
            acceptance,
            `| Receive | btnReceive | ${RECEIVE_ACTION_BINDING} |`,
            `| Receive | btnReceive | ${RECEIVE_ACTION_BINDING.replace(
                '; Set(varOldQuantity',
                ';<br>Set(varOldQuantity')} |`,
            'Action Contract formula line break');
    }

    if (misleadingApplyDirect) {
        screenYaml = replaceAllRequired(
            screenYaml, 'btnReceive', 'btnReceiveApply', 'Apply-named direct control in YAML');
        acceptance = replaceAllRequired(
            acceptance, 'btnReceive', 'btnReceiveApply', 'Apply-named direct control evidence');
    }

    if (orphanApplyGate) {
        const orphanGate =
            '=If(IsBlank(varOperation) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)';
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - btnReceive:',
            '            - btnApply:\n' +
            '                Control: Classic/Button\n' +
            '                Properties:\n' +
            `                    DisplayMode: ${orphanGate}\n` +
            '            - btnReceive:',
            'orphan Apply gate YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'btnReceive.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            `btnApply.DisplayMode: ${orphanGate.replace('||', '\\|\\|')}`,
            'orphan Apply gate evidence');
    }

    if (labeledReceiptValues || ambiguousReceiptValue) {
        const oldFormula = ambiguousReceiptValue
            ? '=varOldQuantity & varAmount'
            : '="Old quantity: " & varOldQuantity';
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    Text: =varOldQuantity',
            `                    Text: ${oldFormula}`,
            'old receipt label YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'old=lblReceiptOld.Text: =varOldQuantity',
            `old=lblReceiptOld.Text: ${oldFormula}`,
            'old receipt label evidence');
    }

    if (labeledReceiptValues) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    Text: =varAmount',
            '                    Text: ="Amount: " & Text(varAmount, "0")',
            'amount receipt label YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'amount=lblReceiptAmount.Text: =varAmount',
            'amount=lblReceiptAmount.Text: ="Amount: " & Text(varAmount, "0")',
            'amount receipt label evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    Text: =varLastMutation.Quantity',
            '                    Text: ="Actual: " & Text(varLastMutation.Quantity)',
            'actual receipt label YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'actual=lblReceiptActual.Text: =varLastMutation.Quantity',
            'actual=lblReceiptActual.Text: ="Actual: " & Text(varLastMutation.Quantity)',
            'actual receipt label evidence');
    }

    if (selectGateRouting) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - btnReceive:',
            '            - btnRouteMutation:\n' +
            '                Control: Classic/Button\n' +
            '                Properties:\n' +
            '                    DisplayMode: =If(IsBlank(drpOperation.Selected.Value) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)\n' +
            '                    OnSelect: =Select(btnReceive)\n' +
            '            - btnReceive:',
            'Select gate route YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'btnReceive.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            'btnRouteMutation.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            'Select gate route evidence');
    }

    if (unrelatedGateMutation) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - btnReceive:',
            '            - btnUnrelatedMutation:\n' +
            '                Control: Classic/Button\n' +
            '                Properties:\n' +
            '                    DisplayMode: =If(IsBlank(drpOperation.Selected.Value) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)\n' +
            '                    OnSelect: =Clear(colScratch)\n' +
            '            - btnReceive:',
            'unrelated gated mutation YAML');
        acceptance = replaceOnceRequired(
            acceptance,
            'btnReceive.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            'btnUnrelatedMutation.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \\|\\| IsBlank(cmbAdjustItem.Selected.ID) \\|\\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)',
            'unrelated gated mutation evidence');
    }

    if (requiredRecordScalar) {
        const scalar = requiredRecordScalar === 'quoted'
            ? '"=ThisItem.Quantity"'
            : '|-\n                        =ThisItem.Quantity';
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - galInventory:',
            '            - lblRequiredQuantity:\n' +
            '                Control: Classic/Label\n' +
            '                Properties:\n' +
            `                    Text: ${scalar}\n` +
            '            - galInventory:',
            'required record field YAML');
        plan +=
            '\n## Required Record Fields\n\n' +
            '| Field | Screen | Control | Formula | Source Field | Notes |\n' +
            '| ----- | ------ | ------- | ------- | ------------ | ----- |\n' +
            '| Quantity | Screen1 | lblRequiredQuantity | Text | Quantity | visible |\n';
        acceptance +=
            '\n## Required Record Field Evidence\n\n' +
            '| Field | Control | Formula | Record hierarchy | Visibility/layout | Result |\n' +
            '| ----- | ------- | ------- | ---------------- | ----------------- | ------ |\n' +
            '| Quantity | lblRequiredQuantity | Text: =ThisItem.Quantity | gallery row | visible | PASS |\n';
    }

    if (multiFieldPatch || ambiguousMultiFieldPatch) {
        for (const expression of [
            'varOldQuantity + varAmount',
            'varOldQuantity - varAmount',
        ]) {
            const extra = ambiguousMultiFieldPatch
                ? `, Delta: ${expression}`
                : ', Notes: "adjusted"';
            screenYaml = replaceAllRequired(
                screenYaml,
                `{Quantity: ${expression}}`,
                `{Quantity: ${expression}${extra}}`,
                `${expression} multi-field Patch YAML`);
            acceptance = replaceAllRequired(
                acceptance,
                `{Quantity: ${expression}}`,
                `{Quantity: ${expression}${extra}}`,
                `${expression} multi-field Patch evidence`);
        }
    }

    if (explicitSelectedId) {
        screenYaml = replaceAllRequired(
            screenYaml,
            'cmbAdjustItem.Selected.Quantity',
            'LookUp(colInventory, ID = varSelectedInventoryId).Quantity',
            'selected quantity lookup');
        acceptance = replaceAllRequired(
            acceptance,
            'cmbAdjustItem.Selected.Quantity',
            'LookUp(colInventory, ID = varSelectedInventoryId).Quantity',
            'selected quantity lookup evidence');
        screenYaml = replaceAllRequired(
            screenYaml,
            'cmbAdjustItem.Selected.ID',
            'varSelectedInventoryId',
            'selected ID YAML');
        acceptance = replaceAllRequired(
            acceptance,
            'cmbAdjustItem.Selected.ID',
            'varSelectedInventoryId',
            'selected ID evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            '            OnVisible: =Set(varOperation, Blank()); Set(varSelectedInventoryId, Blank())',
            'selected ID entry reset');
        acceptance = replaceOnceRequired(
            acceptance,
            'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            'Screen1.OnVisible: =Set(varOperation, Blank()); Set(varSelectedInventoryId, Blank())',
            'selected ID reset evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - drpOperation:',
            '            - btnSelectInventory:\n' +
            '                Control: Classic/Button\n' +
            '                Properties:\n' +
            '                    OnSelect: =Set(varSelectedInventoryId, ThisItem.ID)\n' +
            '            - drpOperation:',
            'reachable selected ID event');
    }

    if (modernAmount || modernAmountDefaultZero || stagedAmountMinOne || q8RuntimeGaps) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - txtAmount:\n' +
            '                Control: Classic/TextInput\n' +
            '                Properties:\n' +
            '                    Format: =TextFormat.Number',
            '            - numAdjustAmount:\n' +
            '                Control: ModernNumberInput\n' +
            '                Properties:\n' +
            '                    Default: =Blank()\n' +
            `                    Min: =${q8RuntimeGaps || stagedAmountMinOne ? '1' : '0'}`,
            'modern amount control');
        screenYaml = replaceAllRequired(
            screenYaml, 'Value(txtAmount.Text)', 'numAdjustAmount.Value', 'modern amount YAML');
        acceptance = replaceAllRequired(
            acceptance, 'Value(txtAmount.Text)', 'numAdjustAmount.Value', 'modern amount evidence');
    }

    if (modernAmount || modernAmountDefaultZero || stagedAmountMinOne) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            '            OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem); Reset(numAdjustAmount)',
            'modern amount entry reset');
        acceptance = replaceOnceRequired(
            acceptance,
            'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem); Reset(numAdjustAmount)',
            'modern amount reset evidence');
    }

    if (modernAmountDefaultZero) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - numAdjustAmount:\n' +
            '                Control: ModernNumberInput\n' +
            '                Properties:\n' +
            '                    Default: =Blank()',
            '            - numAdjustAmount:\n' +
            '                Control: ModernNumberInput\n' +
            '                Properties:\n' +
            '                    Default: =0',
            'zero amount default');
    }

    if (stagedAmountMinOne) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    Min: =1',
            '                    Min: =1\n' +
            '                    OnChange: =Set(varAmount, Self.Value)',
            'staged amount event');
        screenYaml = replaceAllRequired(
            screenYaml, 'Set(varAmount, numAdjustAmount.Value); ', '', 'inline amount staging YAML');
        acceptance = replaceAllRequired(
            acceptance, 'Set(varAmount, numAdjustAmount.Value); ', '', 'inline amount staging evidence');
    }

    if (operationPostSuccessReset) {
        const resetFormula = SHARED_APPLY_FORMULA + '; Set(varOperation, Blank())';
        screenYaml = replaceAllRequired(
            screenYaml, SHARED_APPLY_FORMULA, resetFormula, 'post-success operation reset YAML');
        acceptance = replaceAllRequired(
            acceptance, SHARED_APPLY_FORMULA, resetFormula, 'post-success operation reset evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)\n',
            '            OnVisible: =Reset(cmbAdjustItem)\n',
            'screen operation reset removal');
        acceptance = replaceOnceRequired(
            acceptance,
            'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(cmbAdjustItem)',
            `btnApply.OnSelect: ${resetFormula}`,
            'post-success blank-operation binding');
    }

    if (q8RuntimeGaps) {
        appYaml = replaceOnceRequired(
            appYaml,
            '        StartScreen: =Screen1',
            '        StartScreen: =Screen1\n' +
            '        OnStart: =ClearCollect(colInventory, {ID: "INV-001", Quantity: 10}); ' +
            'Set(varOperation, Blank()); Set(varSelectedInventoryId, "INV-001")',
            'Q8 App.OnStart state');
        screenYaml = replaceAllRequired(
            screenYaml, 'cmbAdjustItem', 'galAdjustItems', 'Q8 gallery selection YAML');
        acceptance = replaceAllRequired(
            acceptance, 'cmbAdjustItem', 'galAdjustItems', 'Q8 gallery selection evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            'Control: Classic/ComboBox',
            'Control: Gallery',
            'Q8 gallery control');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            OnVisible: =Set(varOperation, Blank()); Reset(galAdjustItems)\n',
            '',
            'Q8 missing screen reset');
        acceptance = replaceOnceRequired(
            acceptance,
            'Screen1.OnVisible: =Set(varOperation, Blank()); Reset(galAdjustItems)',
            'numAdjustAmount.Default: =Blank()',
            'Q8 unrelated blank-operation evidence');
    }

    if (selectedEvidenceMismatch) {
        acceptance = replaceOnceRequired(
            acceptance,
            '| Receive/Issue | galAdjustItems.Selected.ID |',
            '| Receive/Issue | varSelectedInventoryId |',
            'mismatched selected-record declaration');
    }

    if (compoundSelectionMismatch) {
        acceptance = replaceOnceRequired(
            acceptance,
            '| Receive/Issue | cmbAdjustItem.Selected.ID | Qty 10 -> Receive 3 -> 13 -> Issue 2 -> 11 |',
            '| Receive/Issue | varOtherSelectedId | Qty 10 -> Receive 3 -> 13 -> Issue 2 -> 11 |',
            'mismatched compound selected-record source');
    }

    if (omitOperationAllowEmpty) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            - drpOperation:\n' +
            '                Control: Classic/DropDown\n' +
            '                Properties:\n' +
            '                    AllowEmptySelection: =true\n',
            '            - drpOperation:\n' +
            '                Control: Classic/DropDown\n' +
            '                Properties:\n',
            'operation AllowEmptySelection');
    }

    if (omitSelectionDefault) {
        screenYaml = replaceOnceRequired(
            screenYaml,
            '                    DefaultSelectedItems: =[]\n',
            '',
            'selection DefaultSelectedItems');
    }

    if (listBoxSelection) {
        screenYaml = replaceOnceRequired(
            screenYaml, 'Control: Classic/ComboBox', 'Control: Classic/ListBox',
            'ListBox selected-record control');
    }

    if (directWithoutOperationState) {
        screenYaml = replaceAllRequired(
            screenYaml,
            'IsBlank(drpOperation.Selected.Value) || ',
            '',
            'direct operation gate YAML');
        acceptance = replaceAllRequired(
            acceptance,
            'IsBlank(drpOperation.Selected.Value) \\|\\| ',
            '',
            'direct operation gate evidence');
        screenYaml = replaceOnceRequired(
            screenYaml,
            '            OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)',
            '            OnVisible: =Reset(cmbAdjustItem)',
            'direct selection-only reset');
        acceptance = replaceOnceRequired(
            acceptance,
            'Screen1.OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)',
            'drpOperation.Default: =Blank()',
            'direct unused operation evidence');
    }

    if (customRecordKey || transformedCustomRecordKey) {
        const selected = transformedCustomRecordKey
            ? 'cmbAdjustItem.Selected.ID & "-copy"'
            : 'cmbAdjustItem.Selected.ID && Active = true';
        const replacement = `LookUp(colInventory, ItemID = ${selected}, ThisRecord)`;
        screenYaml = replaceAllRequired(
            screenYaml,
            'LookUp(colInventory, ID = cmbAdjustItem.Selected.ID)',
            replacement,
            'custom-key target YAML');
        acceptance = replaceAllRequired(
            acceptance,
            'LookUp(colInventory, ID = cmbAdjustItem.Selected.ID)',
            replacement,
            'custom-key target evidence');
    }

    if (wrappedGalleryItems) {
        screenYaml = replaceFirstRequired(
            screenYaml,
            '                    Items: =colInventory',
            '                    Items: =SortByColumns(Filter(colInventory, Quantity >= 0), "ID")',
            'wrapped gallery Items');
    }

    if (amountInvalidPolarity) {
        screenYaml = replaceAllRequired(
            screenYaml,
            'Not(Value(txtAmount.Text) > 0)',
            'Value(txtAmount.Text) <= 0',
            'invalid amount polarity YAML');
        acceptance = replaceAllRequired(
            acceptance,
            'Not(Value(txtAmount.Text) > 0)',
            'Value(txtAmount.Text) <= 0',
            'invalid amount polarity evidence');
    }

    if (twoSpaceScreenIndent) {
        screenYaml = screenYaml
            .split('\n')
            .map((line) => {
                const indentation = line.match(/^ */)[0].length;
                return ' '.repeat(Math.floor(indentation / 2)) + line.slice(indentation);
            })
            .join('\n');
    }

    writeFixture(path.join(workspace, 'App.pa.yaml'), { ...appFixture, text: appYaml });
    writeFixture(path.join(workspace, 'Screen1.pa.yaml'), { ...screenFixture, text: screenYaml });
    writeFixture(path.join(workspace, 'canvas-app-plan.md'), { ...planFixture, text: plan });
    writeFixture(
        path.join(workspace, 'canvas-app-acceptance.md'),
        { ...acceptanceFixture, text: acceptance });
    return workspace;
}

function materializeLayout(caseName, { responsive = false } = {}) {
    const workspace = materialize(caseName);
    const widthSource = responsive ? 'App.Width' : 'Parent.Width';
    const adjustEscape = responsive ? '\n                            LayoutWrap: =true' : '';
    const yaml = `Screens:
    Screen1:
        Properties:
            OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem)
        Children:
            - conAdjustPanel:
                Control: GroupContainer
                Variant: AutoLayout
                Properties:
                    Height: =${responsive ? 400 : 'If(Parent.Width<640,318,126)'}
                    LayoutDirection: =If(App.Width<640,LayoutDirection.Vertical,LayoutDirection.Horizontal)
                    LayoutGap: =12
                    PaddingTop: =16
                    PaddingBottom: =16
                    PaddingLeft: =16
                    PaddingRight: =16${adjustEscape}
                Children:
                    - cmbAdjustItem:
                        Control: Classic/ComboBox
                        Properties:
                            DefaultSelectedItems: =[]
                            Items: =colInventory
                            Height: =48
                            Width: =180
                            LayoutMinWidth: =180
                    - drpOperation:
                        Control: Classic/DropDown
                        Properties:
                            AllowEmptySelection: =true
                            Default: =Blank()
                            Items: =["Receive", "Issue"]
                            Height: =48
                            Width: =140
                            LayoutMinWidth: =140
                    - txtAmount:
                        Control: Classic/TextInput
                        Properties:
                            Format: =TextFormat.Number
                            Height: =86
                            Width: =180
                            LayoutMinWidth: =180
                    - btnReceive:
                        Control: Classic/Button
                        Properties:
                            DisplayMode: =If(IsBlank(drpOperation.Selected.Value) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)
                            OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount}))
                            Height: =48
                            Width: =140
                            LayoutMinWidth: =140
                    - btnIssue:
                        Control: Classic/Button
                        Properties:
                            DisplayMode: =If(IsBlank(drpOperation.Selected.Value) || IsBlank(cmbAdjustItem.Selected.ID) || Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit)
                            OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount}))
                            Height: =48
                            Width: =140
                            LayoutMinWidth: =140
            - conManageFormPanel:
                Control: GroupContainer
                Variant: AutoLayout
                Properties:
                    Height: =If(${widthSource}<768,620,250)
                    LayoutDirection: =LayoutDirection.Vertical
                    PaddingTop: =16
                    PaddingBottom: =16
                Children:
                    - conManageFields:
                        Control: GroupContainer
                        Properties:
                            Height: =If(${widthSource}<768,430,110)
                        Children:
                            - galInventory:
                                Control: Gallery
                                Properties:
                                    Items: =colInventory
                                    Height: =100
                    - conManageActions:
                        Control: GroupContainer
                        Properties:
                            Height: =96
            - conAdjustHeading:
                Control: GroupContainer
                Variant: AutoLayout
                Properties:
                    Height: =${responsive ? 180 : 76}
                    LayoutDirection: =LayoutDirection.Vertical
                    LayoutGap: =2
                Children:
                    - lblReceiptOperation:
                        Control: Classic/Label
                        Properties:
                            Text: =varLastOperation
                            Height: =40
                    - lblReceiptOld:
                        Control: Classic/Label
                        Properties:
                            Text: =varOldQuantity
                            Height: =26
                    - lblReceiptAmount:
                        Control: Classic/Label
                        Properties:
                            Text: =varAmount
                            Height: =26
                    - lblReceiptExpected:
                        Control: Classic/Label
                        Properties:
                            Text: =varExpectedQuantity
                            Height: =26
                    - lblReceiptActual:
                        Control: Classic/Label
                        Properties:
                            Text: =varLastMutation.Quantity
                            Height: =28
`;
    fs.writeFileSync(path.join(workspace, 'Screen1.pa.yaml'), yaml);
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

function rewriteScreen(workspace, transform) {
    const screenPath = path.join(workspace, 'Screen1.pa.yaml');
    fs.writeFileSync(screenPath, transform(fs.readFileSync(screenPath, 'utf8')));
}

test.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));

test('accepts a correctly-signed Receive/Issue workspace with a four-space screen key', () => {
    const workspace = materialize('receive-issue-pass');
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /PASS:/);
});

test('rejects exported-shape horizontal, nested-breakpoint, and receipt layout clipping', () => {
    const workspace = materializeLayout('receive-layout-clipped');
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected required controls in clipped containers to fail');
    assert.match(stderr, /horizontal container 'conAdjustPanel' requires 860px/);
    assert.match(stderr, /vertical container 'conManageFormPanel' requires 558px.*Height branch is 250px/);
    assert.match(stderr, /vertical container 'conAdjustHeading' requires 154px.*Height branch is 76px/);
});

test('does not classify a screen as its first versioned Gallery child', () => {
    const workspace = materializeLayout('receive-layout-screen-gallery-first');
    rewriteScreen(workspace, (yaml) => yaml.replace(
        '        Children:\n',
        '        Children:\n' +
        '            - galUnrelated:\n' +
        '                Control: Gallery@2.15.0\n' +
        '                Properties:\n' +
        '                    Items: =[]\n'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected clipped containers to remain in scope');
    assert.match(stderr, /horizontal container 'conAdjustPanel' requires 860px/);
    assert.match(stderr, /vertical container 'conManageFormPanel' requires 558px.*Height branch is 250px/);
    assert.match(stderr, /vertical container 'conAdjustHeading' requires 154px.*Height branch is 76px/);
});

test('retains explicit non-fill sizes when LayoutMinWidth and LayoutMinHeight are zero', () => {
    const workspace = materializeLayout('receive-layout-zero-minimums');
    rewriteScreen(workspace, (yaml) => yaml
        .replace(
            /^(\s*)LayoutMinWidth: =(\d+)$/gm,
            '$1LayoutMinWidth: =0')
        .replace(
            /^(\s*)Height: =(.+)$/gm,
            '$1Height: =$2\n$1LayoutMinHeight: =0'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected explicit non-fill sizes to retain their budget');
    assert.match(stderr, /horizontal container 'conAdjustPanel' requires 860px/);
    assert.match(stderr, /vertical container 'conManageFormPanel' requires 558px.*Height branch is 250px/);
});

test('accepts wrapped horizontal content and App.Width-correlated sufficient vertical budgets', () => {
    const workspace = materializeLayout('receive-layout-responsive', { responsive: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected responsive layout to pass but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts bounded non-fill sizes with zero layout minimums', () => {
    const workspace = materializeLayout('receive-layout-bounded-non-fill', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml
        .replace('\n                            LayoutWrap: =true', '')
        .replaceAll('App.Width<640', 'App.Width<900')
        .replace(
            /^(\s*)LayoutMinWidth: =(\d+)$/gm,
            '$1LayoutMinWidth: =0')
        .replace(
            /^(\s*)Height: =(.+)$/gm,
            '$1Height: =$2\n$1LayoutMinHeight: =0'));
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected bounded non-fill layout to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts a numeric horizontal budget without LayoutWrap', () => {
    const workspace = materializeLayout('receive-layout-arithmetic', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml
        .replace('\n                            LayoutWrap: =true', '')
        .replaceAll('App.Width<640', 'App.Width<900'));
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected bounded horizontal arithmetic to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts FillPortions children without Width or LayoutMinWidth', () => {
    const workspace = materializeLayout('receive-layout-fill-portions', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml
        .replace('\n                            LayoutWrap: =true', '')
        .replace(/^(\s*)Width: =\d+\n/gm, '')
        .replaceAll(/LayoutMinWidth: =\d+/g, 'FillPortions: =1'));
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected FillPortions layout to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects each unresolved horizontal child with an actionable diagnostic', () => {
    const workspace = materializeLayout('receive-layout-unresolved-width');
    rewriteScreen(workspace, (yaml) => yaml
        .replace('Width: =180', 'Width: =Parent.Width / 2')
        .replace('LayoutMinWidth: =180', 'LayoutMinWidth: =0')
        .replace('Width: =140', 'Width: =Parent.Width / 3'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected unresolved child width to fail');
    assert.match(
        stderr,
        /horizontal container 'conAdjustPanel' child 'cmbAdjustItem'.*numeric Width.*numeric LayoutMinWidth/);
    assert.match(
        stderr,
        /horizontal container 'conAdjustPanel' child 'drpOperation'.*numeric Width.*numeric LayoutMinWidth/);
});

test('rejects an unresolved vertical container Height with numeric guidance', () => {
    const workspace = materializeLayout('receive-layout-unresolved-container', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml.replace(
        'Height: =If(App.Width<768,620,250)',
        'Height: =Parent.Height'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected unresolved vertical container Height to fail');
    assert.match(
        stderr,
        /vertical container 'conManageFormPanel' has an unresolved Height.*numeric Height/);
});

test('rejects each unresolved vertical child height with numeric guidance', () => {
    const workspace = materializeLayout('receive-layout-unresolved-child', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml.replace(
        'Height: =If(App.Width<768,430,110)',
        'AutoHeight: =true\n' +
        '                            Height: =Parent.Height'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected unresolved vertical child height to fail');
    assert.match(
        stderr,
        /vertical container 'conManageFormPanel' child 'conManageFields'.*numeric Height.*numeric LayoutMinHeight/);
    assert.match(stderr, /AutoHeight text inside a fixed-height panel/);
});

test('does not correlate Parent.Width conditions across nested layout scopes', () => {
    const workspace = materializeLayout('receive-layout-parent-width-scopes', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml
        .replace('If(App.Width<768,620,250)', 'If(Parent.Width<768,620,250)')
        .replace('If(App.Width<768,430,110)', 'If(Parent.Width<768,430,110)'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected independently scoped Parent.Width branches to fail');
    assert.match(
        stderr,
        /vertical container 'conManageFormPanel' requires 558px.*Height branch is 250px/);
});

test('exempts a canonical scrolling screen root but still rejects its nested fixed panel', () => {
    const workspace = materializeLayout('receive-layout-screen-root', { responsive: true });
    rewriteScreen(workspace, (yaml) => {
        const marker = '        Children:\n';
        const markerIndex = yaml.indexOf(marker);
        assert.notStrictEqual(markerIndex, -1, 'missing screen Children marker');
        const prefix = yaml.slice(0, markerIndex + marker.length);
        const children = yaml.slice(markerIndex + marker.length)
            .split('\n')
            .map((line) => line.length > 0 ? `        ${line}` : line)
            .join('\n')
            .replace(
                'Height: =If(App.Width<768,620,250)',
                'Height: =250')
            .replace(
                'Height: =If(App.Width<768,430,110)',
                'Height: =430');
        return prefix +
            '            - conRoot:\n' +
            '                Control: GroupContainer\n' +
            '                Variant: AutoLayout\n' +
            '                Properties:\n' +
            '                    Width: =Parent.Width\n' +
            '                    Height: =Parent.Height\n' +
            '                    LayoutDirection: =LayoutDirection.Vertical\n' +
            '                    LayoutOverflowY: =LayoutOverflow.Scroll\n' +
            '                Children:\n' +
            children;
    });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected nested fixed panel clipping to fail');
    assert.doesNotMatch(stderr, /vertical container 'conRoot'/);
    assert.match(
        stderr,
        /vertical container 'conManageFormPanel' requires 558px.*Height branch is 250px/);
});

test('accepts a fixed-height vertical container with deliberate scrolling overflow', () => {
    const workspace = materializeLayout('receive-layout-scroll-overflow', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml.replace(
        'Height: =180\n                    LayoutDirection: =LayoutDirection.Vertical',
        'Height: =76\n' +
        '                    LayoutDirection: =LayoutDirection.Vertical\n' +
        '                    LayoutOverflowY: =LayoutOverflow.Scroll'));
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected scrolling fixed-height container to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects a vertical scroll container with a direct FillPortions child', () => {
    const workspace = materializeLayout('receive-layout-scroll-fill-trap', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml.replace(
        'Text: =varLastOperation\n                            Height: =40',
        'Text: =varLastOperation\n' +
        '                            Height: =40\n' +
        '                            FillPortions: =1').replace(
        'LayoutDirection: =LayoutDirection.Vertical\n                    LayoutGap: =2',
        'LayoutDirection: =LayoutDirection.Vertical\n' +
        '                    LayoutOverflowY: =LayoutOverflow.Scroll\n' +
        '                    LayoutGap: =2'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected a direct fill child to defeat scroll escape');
    assert.match(
        stderr,
        /vertical scroll container 'conAdjustHeading'.*'lblReceiptOperation'.*FillPortions > 0/);
});

test('does not treat conditional horizontal Scroll as an all-branch escape', () => {
    const workspace = materializeLayout('receive-layout-conditional-horizontal-scroll');
    rewriteScreen(workspace, (yaml) => yaml.replace(
        'PaddingRight: =16',
        'PaddingRight: =16\n' +
        '                    LayoutOverflowX: =If(App.Width<640,LayoutOverflow.Scroll,LayoutOverflow.Hide)'));
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected overflowing non-scroll branch to fail');
    assert.match(stderr, /horizontal container 'conAdjustPanel' requires 860px/);
});

test('accepts exact horizontal Scroll as an overflow escape', () => {
    const workspace = materializeLayout('receive-layout-horizontal-scroll', { responsive: true });
    rewriteScreen(workspace, (yaml) => yaml
        .replace('\n                            LayoutWrap: =true', '')
        .replace(
            'PaddingRight: =16',
            'PaddingRight: =16\n' +
            '                    LayoutOverflowX: =LayoutOverflow.Scroll'));
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected exact horizontal scroll escape to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('ignores AutoLayout template budgets beneath a versioned Gallery', () => {
    const workspace = materializeLayout('receive-layout-versioned-gallery', { responsive: true });
    rewriteScreen(workspace, (yaml) => {
        const marker = '            - conAdjustHeading:';
        const markerIndex = yaml.indexOf(marker);
        assert.notStrictEqual(markerIndex, -1, 'missing receipt container');
        const prefix = yaml.slice(0, markerIndex);
        const receipt = yaml.slice(markerIndex)
            .split('\n')
            .map((line) => line.length > 0 ? `        ${line}` : line)
            .join('\n')
            .replace('Height: =180', 'Height: =76');
        return prefix +
            '            - galReceipt:\n' +
            '                Control: Gallery@2.15.0\n' +
            '                Properties:\n' +
            '                    Items: =[1]\n' +
            '                Children:\n' +
            receipt;
    });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected versioned Gallery template to be scoped out.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts an equivalent amount <= 0 invalid-submit gate', () => {
    const workspace = materialize(
        'receive-invalid-amount-polarity',
        { amountInvalidPolarity: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected equivalent invalid-polarity gate to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('indexes a two-space exported screen key for exact OnVisible reset evidence', () => {
    const workspace = materialize(
        'receive-two-space-screen',
        { twoSpaceScreenIndent: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects operation-control reset without AllowEmptySelection true', () => {
    const workspace = materialize(
        'receive-operation-not-empty',
        {
            sharedApplyFlow: true,
            dropdownDirectShared: true,
            omitOperationAllowEmpty: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected non-nullable operation control to fail');
    assert.match(
        stderr,
        /blank-operation binding must reset actual operation source 'drpOperation\.Selected\.Value'/);
});

test('accepts docs-compliant ComboBox DefaultSelectedItems reset without AllowEmptySelection', () => {
    const workspace = materialize('receive-selection-empty-combobox');
    const screen = fs.readFileSync(path.join(workspace, 'Screen1.pa.yaml'), 'utf8');
    assert.doesNotMatch(
        screen,
        /Control: Classic\/ComboBox\n\s+Properties:\n\s+AllowEmptySelection/);
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected docs-compliant ComboBox to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts a versioned ComboBox with docs-compliant nullable reset configuration', () => {
    const workspace = materialize('receive-selection-versioned-combobox');
    rewriteScreen(workspace, (yaml) => yaml.replace(
        'Control: Classic/ComboBox',
        'Control: Classic/ComboBox@2.4.0'));
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected versioned ComboBox to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts docs-compliant DropDown blank default and AllowEmptySelection', () => {
    const workspace = materialize(
        'receive-operation-empty-dropdown',
        { sharedApplyFlow: true, dropdownDirectShared: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(
        code,
        0,
        `expected docs-compliant DropDown to pass.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects selected ComboBox proof without DefaultSelectedItems empty', () => {
    const workspace = materialize(
        'receive-selection-not-empty',
        { omitSelectionDefault: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected non-nullable selected control to fail');
    assert.match(stderr, /cannot use 'cmbAdjustItem\.Selected\.ID' as no-selection proof/);
});

test('rejects selected ListBox proof without nullable reset configuration', () => {
    const workspace = materialize(
        'receive-listbox-not-empty',
        { listBoxSelection: true, omitSelectionDefault: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected non-nullable ListBox selection to fail');
    assert.match(stderr, /cannot use 'cmbAdjustItem\.Selected\.ID' as no-selection proof/);
});

test('rejects an orphan operation variable on a non-mutating Apply gate', () => {
    const workspace = materialize('receive-orphan-apply-gate', { orphanApplyGate: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected orphan Apply gate to fail validation');
    assert.match(
        stderr,
        /blank-checks operation variable 'varOperation', but no reachable control event assigns it/);
    assert.match(
        stderr,
        /gated control 'btnApply' must own or route to a declared mutation handler/);
});

test('accepts independent direct actions without a dead shared submit control', () => {
    const workspace = materialize('receive-independent-direct-pass');
    const screen = fs.readFileSync(path.join(workspace, 'Screen1.pa.yaml'), 'utf8');
    assert.doesNotMatch(screen, /btnApply/);
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects the ADO-export contradiction between a claimed selector and direct-mutation YAML', () => {
    const workspace = materialize(
        'receive-action-binding-contradiction',
        { contradictReceiveActionBinding: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected contradictory Action Contract evidence to fail validation');
    assert.match(
        stderr,
        /Action Contract for 'Receive' binding 'btnReceive\.OnSelect' does not match final app YAML/);
    assert.match(stderr, /Action Contract omits the distinct mutation-handler binding/);
});

test('rejects an accurately recorded selector that mutates in a shared Apply flow', () => {
    const workspace = materialize(
        'receive-shared-selector-mutates',
        { sharedApplyFlow: true, sharedSelectorMutates: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, `expected FAIL but validator exited 0.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(
        stderr,
        /Directional action 'Receive' selector 'btnReceive' must select the operation without mutating data/);
});

test('accepts selectors that set a shared operation consumed by the mutating Apply control', () => {
    const workspace = materialize('receive-shared-apply-pass', { sharedApplyFlow: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /PASS:/);
});

test('preserves separate direct actions with selection and amount blank gates', () => {
    const workspace = materialize(
        'receive-direct-without-operation-state',
        { directWithoutOperationState: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects the exported Q8 incomplete-state gaps without disputing directional arithmetic', () => {
    const workspace = materialize(
        'receive-q8-runtime-gaps',
        { sharedApplyFlow: true, q8RuntimeGaps: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected runtime-derived Q8 gaps to fail static acceptance');
    assert.match(
        stderr,
        /blank-operation binding must reset actual operation source 'varOperation'/);
    assert.match(
        stderr,
        /cannot use 'galAdjustItems\.Selected\.ID' as no-selection proof/);
    assert.match(
        stderr,
        /amount control 'numAdjustAmount' has Min=1/);
    assert.doesNotMatch(stderr, /mutation must apply '[+-]'/);
});

test('rejects selected-ID evidence when the mutation still uses Gallery.Selected.ID', () => {
    const workspace = materialize(
        'receive-q8-selection-mismatch',
        {
            sharedApplyFlow: true,
            q8RuntimeGaps: true,
            selectedEvidenceMismatch: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected contradictory selected-record evidence to fail');
    assert.match(
        stderr,
        /receive mutation must target selected-record source 'varSelectedInventoryId'/);
    assert.match(
        stderr,
        /explicit selected ID 'varSelectedInventoryId' must reset to Blank on screen entry/);
});

test('accepts one explicit selected ID reset and assigned by a reachable row event', () => {
    const workspace = materialize(
        'receive-explicit-selected-id',
        { sharedApplyFlow: true, explicitSelectedId: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts a blank Min=0 modern amount with gate and screen-entry reset', () => {
    const workspace = materialize(
        'receive-modern-amount',
        { sharedApplyFlow: true, modernAmount: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts a zero-default Min=0 modern amount when the gate requires greater than zero', () => {
    const workspace = materialize(
        'receive-modern-amount-zero-default',
        { sharedApplyFlow: true, modernAmountDefaultZero: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('resolves a staged amount from reachable OnChange and rejects its Min=1', () => {
    const workspace = materialize(
        'receive-staged-modern-amount-min-one',
        { sharedApplyFlow: true, stagedAmountMinOne: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected staged Min=1 amount source to fail');
    assert.match(stderr, /amount control 'numAdjustAmount' has Min=1/);
});

test('accepts resetting the actual operation state after a successful mutation', () => {
    const workspace = materialize(
        'receive-operation-post-success-reset',
        { sharedApplyFlow: true, operationPostSuccessReset: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts a custom record key, additional predicate, and three-argument LookUp', () => {
    const workspace = materialize(
        'receive-custom-record-key',
        { customRecordKey: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects a transformed custom record key', () => {
    const workspace = materialize(
        'receive-transformed-custom-record-key',
        { transformedCustomRecordKey: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected transformed custom key to fail');
    assert.match(stderr, /transformed record-identity key/);
});

test('rejects wrapped Gallery Items as nullable selected-record proof', () => {
    const workspace = materialize(
        'receive-wrapped-gallery-selection',
        {
            sharedApplyFlow: true,
            q8RuntimeGaps: true,
            wrappedGalleryItems: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected wrapped nonempty Gallery.Selected proof to fail');
    assert.match(stderr, /cannot use 'galAdjustItems\.Selected\.ID' as no-selection proof/);
});

test('accepts correct shared branches when Action Contract contains only the handler', () => {
    const workspace = materialize(
        'receive-shared-handler-only-pass',
        { sharedApplyFlow: true, sharedActionHandlerOnly: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects reversed shared branches when Action Contract omits selectors', () => {
    const workspace = materialize(
        'receive-shared-handler-only-reversed',
        {
            sharedApplyFlow: true,
            sharedActionHandlerOnly: true,
            reverseSharedBranches: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected evidence-shaped shared branch bypass to fail');
    assert.match(stderr, /receive mutation must apply '\+'/);
    assert.match(stderr, /issue mutation must apply '-'/);
});

test('accepts shared handler branching directly on dropdown state', () => {
    const workspace = materialize(
        'receive-dropdown-direct-pass',
        { sharedApplyFlow: true, dropdownDirectShared: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects reversed shared branches that consume dropdown state directly', () => {
    const workspace = materialize(
        'receive-dropdown-direct-reversed',
        {
            sharedApplyFlow: true,
            dropdownDirectShared: true,
            reverseSharedBranches: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected reversed dropdown-direct branches to fail');
    assert.match(stderr, /receive mutation must apply '\+'/);
    assert.match(stderr, /issue mutation must apply '-'/);
});

test('accepts correct shared Receive with direct Issue mixed topology', () => {
    const workspace = materialize(
        'receive-mixed-topology-pass',
        { sharedApplyFlow: true, mixedTopology: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects reversed shared Receive in mixed topology', () => {
    const workspace = materialize(
        'receive-mixed-topology-reversed',
        {
            sharedApplyFlow: true,
            mixedTopology: true,
            reverseSharedBranches: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected mixed-topology reversed Receive to fail');
    assert.match(stderr, /receive mutation must apply '\+'/);
});

test('accepts operation selectors assigned through UpdateContext for gate liveness', () => {
    const workspace = materialize(
        'receive-update-context-selector',
        {
            sharedApplyFlow: true,
            sharedActionHandlerOnly: true,
            updateContextSelectors: true,
        });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('resolves operation source from receipt when a gate has multiple IsBlank operands', () => {
    const workspace = materialize(
        'receive-multi-blank-gate-pass',
        { sharedApplyFlow: true, sharedActionHandlerOnly: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects reversed branches with a multi-IsBlank gate', () => {
    const workspace = materialize(
        'receive-multi-blank-gate-reversed',
        {
            sharedApplyFlow: true,
            sharedActionHandlerOnly: true,
            reverseSharedBranches: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected reversed multi-IsBlank flow to fail');
    assert.match(stderr, /receive mutation must apply '\+'/);
    assert.match(stderr, /issue mutation must apply '-'/);
});

test('accepts shared arithmetic guarded by explicit If conditions', () => {
    const workspace = materialize(
        'receive-shared-if-pass',
        { sharedApplyFlow: true, sharedIfBranches: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects ambiguous multiple matching operation dispatches', () => {
    const workspace = materialize(
        'receive-shared-ambiguous-dispatch',
        { sharedApplyFlow: true, ambiguousSharedDispatch: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected ambiguous shared dispatch to fail closed');
    assert.match(stderr, /must guard exactly one write branch/);
});

test('resolves shared operation state when selectors also assign receipt labels', () => {
    const workspace = materialize(
        'receive-shared-selector-receipt',
        { sharedApplyFlow: true, selectorReceiptAssignment: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects a shared selector whose Action Contract omits the mutation owner', () => {
    const workspace = materialize(
        'receive-shared-owner-omitted',
        { sharedApplyFlow: true, omitSharedMutationBinding: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected omitted shared mutation evidence to fail validation');
    assert.match(stderr, /Action Contract omits the distinct mutation-handler binding/);
});

test('rejects shared mutation branches whose Receive and Issue arithmetic is swapped', () => {
    const workspace = materialize(
        'receive-shared-reversed-branches',
        { sharedApplyFlow: true, reverseSharedBranches: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected reversed shared branches to fail validation');
    assert.match(stderr, /receive mutation must apply '\+'/);
    assert.match(stderr, /issue mutation must apply '-'/);
});

test('rejects different operation variables across shared directional rows', () => {
    const workspace = materialize(
        'receive-shared-variable-mismatch',
        { sharedApplyFlow: true, mismatchedSharedVariables: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected mismatched shared variables to fail validation');
    assert.match(stderr, /shared rows must use the same operation state variable/);
});

test('rejects different mutation owners across shared directional rows', () => {
    const workspace = materialize(
        'receive-shared-owner-mismatch',
        { sharedApplyFlow: true, mismatchedSharedOwner: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected mismatched shared mutation owners to fail validation');
    assert.match(stderr, /shared rows must resolve to the same mutation control and event/);
});

test('rejects a shared mutation handler that does not consume selector operation state', () => {
    const workspace = materialize(
        'receive-shared-disconnected-mutation',
        { sharedApplyFlow: true, mutationDoesNotConsumeOperation: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected disconnected shared mutation to fail validation');
    assert.match(stderr, /mutation handler 'btnApply' must consume operation variable 'varOperation'/);
});

test('rejects a shared gate that blank-checks different operation state', () => {
    const workspace = materialize(
        'receive-shared-gate-mismatch',
        { sharedApplyFlow: true, mismatchedSharedGate: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected mismatched shared gate state to fail validation');
    assert.match(stderr, /shared mutation gate must blank-check operation variable 'varOperation'/);
});

test('accepts explicit operation literals that contain each direction word', () => {
    const workspace = materialize(
        'receive-shared-operation-labels',
        { sharedApplyFlow: true, operationLiteralSuffix: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects a selector operation literal unrelated to its direction', () => {
    const workspace = materialize(
        'receive-shared-unrelated-operation',
        { sharedApplyFlow: true, unrelatedOperationLiteral: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected unrelated selector operation to fail validation');
    assert.match(stderr, /must assign operation state to a declared value containing direction 'receive'/);
});

test('accepts a declared dropdown selection binding for shared operation state', () => {
    const workspace = materialize(
        'receive-shared-dropdown',
        { sharedApplyFlow: true, dropdownSelector: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts valid single- and double-quoted YAML formulas', () => {
    const workspace = materialize('receive-quoted-yaml', { quoteYamlFormulas: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts valid literal and folded YAML block-scalar formulas', () => {
    const workspace = materialize('receive-block-yaml', { blockYamlFormula: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts block scalars that retain their trailing newline', () => {
    const workspace = materialize(
        'receive-block-yaml-keep',
        { blockYamlFormula: true, blockYamlKeepTrailingNewline: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('normalizes documented br separators inside exact Action Contract bindings', () => {
    const workspace = materialize(
        'receive-action-binding-br',
        { actionBindingLineBreak: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts a direct mutation control whose name contains Apply', () => {
    const workspace = materialize('receive-misleading-apply-name', { misleadingApplyDirect: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects common Power Fx mutation functions in a shared operation selector', () => {
    for (const mutation of ['ClearCollect', 'Clear', 'Update', 'Relate', 'Unrelate']) {
        const workspace = materialize(
            `receive-selector-${mutation.toLowerCase()}`,
            { sharedApplyFlow: true, mutatingSelectorFunction: mutation });
        const { code, stderr } = runValidator(workspace);
        assert.notStrictEqual(code, 0, `expected ${mutation} selector mutation to fail`);
        assert.match(stderr, /selector 'btnReceive' must select the operation without mutating data/);
    }
});

test('accepts a gated control that routes to a declared mutation with Select', () => {
    const workspace = materialize(
        'receive-select-gate-route',
        { selectGateRouting: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects a gated control whose unrelated mutation does not route to the declared handler', () => {
    const workspace = materialize(
        'receive-unrelated-gate-mutation',
        { unrelatedGateMutation: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected unrelated gated mutation to fail routing validation');
    assert.match(
        stderr,
        /gated control 'btnUnrelatedMutation' must own or route to a declared mutation handler/);
});

test('matches required record fields against quoted YAML formulas', () => {
    const workspace = materialize(
        'receive-required-record-quoted',
        { requiredRecordScalar: 'quoted' });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('matches required record fields against block-scalar YAML formulas', () => {
    const workspace = materialize(
        'receive-required-record-block',
        { requiredRecordScalar: 'block' });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('accepts one directional arithmetic field in a multi-field Patch record', () => {
    const workspace = materialize(
        'receive-multi-field-patch',
        { multiFieldPatch: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects multiple directional arithmetic fields in one Patch record', () => {
    const workspace = materialize(
        'receive-ambiguous-multi-field-patch',
        { ambiguousMultiFieldPatch: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected ambiguous Patch fields to fail');
    assert.match(stderr, /Patch record must contain exactly one field using both receipt arithmetic operands; found 2/);
});

test('extracts old and amount values from labeled receipt expressions', () => {
    const workspace = materialize(
        'receive-labeled-receipts',
        { labeledReceiptValues: true });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects ambiguous multi-value receipt labels with a dedicated error', () => {
    const workspace = materialize(
        'receive-ambiguous-receipt',
        { ambiguousReceiptValue: true });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected ambiguous receipt evidence to fail validation');
    assert.match(stderr, /receipt binding 'old' has ambiguous label expression/);
    assert.doesNotMatch(stderr, /old operand .*dead staging|must apply .*receipt old-value operand/);
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

test('rejects compound evidence that names a different selected-record source', () => {
    const workspace = materialize(
        'receive-issue-compound-selection-mismatch',
        {
            sourceDir: compoundFixtureDir,
            compoundSelectionMismatch: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected compound selected-record mismatch to fail');
    assert.match(
        stderr,
        /compound evidence must use selected-record source 'cmbAdjustItem\.Selected\.ID' consistently/);
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

test('accepts context staging values written by live UpdateContext OnChange formulas', () => {
    const workspace = materialize(
        'receive-live-context-onchange',
        {
            sourceDir: staleStagingFixtureDir,
            repairPhantomKey: true,
            contextStagingOnChange: true,
        });
    const { code, stdout, stderr } = runValidator(workspace);
    assert.strictEqual(code, 0, `expected PASS but validator exited ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

test('rejects context staging assignments that occur only after Patch', () => {
    const workspace = materialize(
        'receive-late-context-staging',
        {
            sourceDir: staleStagingFixtureDir,
            repairPhantomKey: true,
            contextStagingAfterPatch: true,
        });
    const { code, stderr } = runValidator(workspace);
    assert.notStrictEqual(code, 0, 'expected late UpdateContext staging to fail');
    assert.match(stderr, /receive old operand 'locOldQuantity' is a dead staging variable/);
    assert.match(stderr, /receive amount operand 'locAmount' is a dead staging variable/);
    assert.match(stderr, /issue old operand 'locOldQuantity' is a dead staging variable/);
    assert.match(stderr, /issue amount operand 'locAmount' is a dead staging variable/);
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

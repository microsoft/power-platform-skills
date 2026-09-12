#:property PublishAot=false

using System.Text;
using System.Text.Json;
using System.Linq;
using System.Text.RegularExpressions;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: validate-canvas-acceptance.cs <workspace> <plugin-root>");
    return 2;
}

var workspace = Path.GetFullPath(args[0]);
var pluginRoot = Path.GetFullPath(args[1]);
var planPath = Path.Combine(workspace, "canvas-app-plan.md");
var acceptancePath = Path.Combine(workspace, "canvas-app-acceptance.md");
var skillPath = Path.Combine(pluginRoot, "skills", "canvas-app", "SKILL.md");
var errors = new List<string>();

RequireFile(Path.Combine(workspace, "App.pa.yaml"), "App.pa.yaml");
RequireFile(planPath, "plan");
RequireFile(acceptancePath, "acceptance");
RequireFile(skillPath, "canvas-app skill");

if (errors.Count > 0)
{
    return Fail(errors);
}

var planLines = File.ReadAllLines(planPath);
var acceptanceLines = File.ReadAllLines(acceptancePath);
var skillVersion = ReadSkillVersion(skillPath, errors);
var yamlLines = Directory
    .EnumerateFiles(workspace, "*.pa.yaml", SearchOption.AllDirectories)
    .SelectMany(File.ReadLines)
    .ToArray();
var yamlFormulas = IndexYamlFormulas(yamlLines);

if (acceptanceLines.Length == 0 || acceptanceLines[0] != "Runtime evaluation: NOT RUN")
{
    errors.Add("Acceptance line 1 must be exactly 'Runtime evaluation: NOT RUN'.");
}

RequireMetadata("Plugin root", pluginRoot);
if (skillVersion.Length > 0)
{
    RequireMetadata("Skill contract version", skillVersion);
}
RequireMetadata("Source revision", expected: null);

var plannedActions = ReadColumn(planLines, "## Action Contracts", 0, errors);
var plannedScenarios = ReadColumn(planLines, "## Functional Test Matrix", 0, errors);
var plannedScreens = ReadColumn(planLines, "## Dispatch", 1, errors, keyColumn: 1);
var plannedTargets = ReadColumn(planLines, "## Dispatch", 2, errors, keyColumn: 1);
var plannedRecordFields = ReadOptionalRows(planLines, "## Required Record Fields", errors);
var acceptedActions = ReadRows(acceptanceLines, "## Action Contract Acceptance", errors);
var acceptedScenarios = ReadRows(acceptanceLines, "## Functional Test Matrix Results", errors);
var acceptedScreens = ReadRows(acceptanceLines, "## Screen QA Evidence", errors);
var acceptedRecordFields = ReadOptionalRows(
    acceptanceLines,
    "## Required Record Field Evidence",
    errors);
var directionalPairs = FindDirectionalPairs(plannedActions);
var sharedFlows = new List<SharedFlowResolution>();
var directionalEvidence = directionalPairs.Count == 0
    ? new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase)
    : ReadRows(acceptanceLines, "## Directional Mutation Evidence", errors);

RequireNonEmpty("Action Contract", plannedActions);
RequireNonEmpty("Functional Test Matrix scenario", plannedScenarios);
RequireNonEmpty("dispatch screen", plannedScreens);
if (plannedTargets.Count != plannedScreens.Count)
{
    errors.Add("Every dispatch screen must have a unique target file.");
}
ValidateTargets(plannedTargets);

CompareCoverage("Action Contract", plannedActions, acceptedActions, errors);
CompareCoverage("Functional Test Matrix scenario", plannedScenarios, acceptedScenarios, errors);
CompareCoverage("dispatch screen", plannedScreens, acceptedScreens, errors);
CompareCoverage(
    "required record field",
    plannedRecordFields.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase),
    acceptedRecordFields,
    errors);
CompareCoverage(
    "directional mutation pair",
    directionalPairs,
    directionalEvidence,
    errors);

foreach (var row in plannedRecordFields.Values)
{
    if (row.Count != 6)
    {
        errors.Add($"Required record field '{row[0]}' must have six planning columns.");
        continue;
    }

    if (row.Skip(1).Any(value => string.IsNullOrWhiteSpace(Clean(value))))
    {
        errors.Add($"Required record field '{row[0]}' has incomplete planning evidence.");
    }
}

foreach (var row in acceptedActions.Values.OrderBy(row => Clean(row[0]), StringComparer.OrdinalIgnoreCase))
{
    if (row.Count != 7)
    {
        errors.Add($"Action '{row[0]}' must have seven acceptance columns.");
        continue;
    }

    if (!row[2].Contains('=') || !row[4].Contains('='))
    {
        errors.Add($"Action '{row[0]}' must contain exact event and observer formulas.");
    }

    if (!string.Equals(Clean(row[6]), "PASS", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"Action '{row[0]}' does not pass.");
    }

    if (TryGetDirectionalOperation(row[0], directionalPairs, out var pair, out var operation))
    {
        var sharedFlow = ValidateDirectionalActionEvidence(row, pair, operation);
        if (sharedFlow is not null)
        {
            sharedFlows.Add(sharedFlow.Value);
        }
    }
}

ValidateSharedFlowConsistency(sharedFlows, directionalPairs);

foreach (var row in acceptedScenarios.Values)
{
    if (row.Count != 3 || !string.Equals(Clean(row[1]), "PASS", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"Scenario '{row[0]}' does not contain a passing static trace.");
    }
}

foreach (var row in acceptedRecordFields.Values)
{
    if (row.Count != 6)
    {
        errors.Add($"Required record field '{row[0]}' must have six acceptance columns.");
        continue;
    }

    if (string.IsNullOrWhiteSpace(Clean(row[1])) ||
        !row[2].Contains('=') ||
        string.IsNullOrWhiteSpace(Clean(row[3])) ||
        string.IsNullOrWhiteSpace(Clean(row[4])))
    {
        errors.Add(
            $"Required record field '{row[0]}' must identify its control, exact formula, " +
            "record hierarchy, and visibility/layout evidence.");
    }

    if (!string.Equals(Clean(row[5]), "PASS", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"Required record field '{row[0]}' does not pass.");
    }

    var control = Clean(row[1]);
    var formula = NormalizeWhitespace(
        Clean(row[2])
            .Replace("<br>", " ", StringComparison.OrdinalIgnoreCase)
            .Replace("\\|", "|", StringComparison.Ordinal));
    if (!TryGetControlBlock(yamlLines, control, out var controlBlock))
    {
        errors.Add(
            $"Required record field '{row[0]}' control '{control}' does not exist in app YAML.");
    }
    else
    {
        var formulaMatch = Regex.Match(
            formula,
            @"^(?<property>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?<value>=.+)$",
            RegexOptions.CultureInvariant);
        var actualFormula = formulaMatch.Success
            ? GetPropertyFormula(controlBlock, formulaMatch.Groups["property"].Value)
            : null;
        if (!formulaMatch.Success ||
            actualFormula is null ||
            !string.Equals(
                NormalizeWhitespace(actualFormula),
                NormalizeWhitespace(formulaMatch.Groups["value"].Value),
                StringComparison.Ordinal))
        {
            errors.Add(
                $"Required record field '{row[0]}' formula does not match control '{control}' " +
                "in final app YAML.");
        }
    }

    if (plannedRecordFields.TryGetValue(row[0], out var plannedRow) &&
        plannedRow.Count == 6 &&
        !ReferencesSourceField(formula, Clean(plannedRow[4])))
    {
        errors.Add(
            $"Required record field '{row[0]}' formula does not reference planned source " +
            $"field '{Clean(plannedRow[4])}'.");
    }
}

foreach (var row in acceptedScreens.Values)
{
    if (row.Count != 4 || !string.Equals(Clean(row[1]), "1-44 COMPLETE", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"Screen '{row[0]}' does not report complete Q1-Q44 coverage.");
        continue;
    }

    if (string.IsNullOrWhiteSpace(Clean(row[2])) || string.IsNullOrWhiteSpace(Clean(row[3])))
    {
        errors.Add($"Screen '{row[0]}' must preserve repairs and N/A evidence.");
    }
}

ValidateDirectionalMutationEvidence(directionalEvidence);

if (errors.Count > 0)
{
    return Fail(errors);
}

Console.WriteLine(
    $"PASS: {plannedActions.Count} actions, {plannedScenarios.Count} scenarios, " +
    $"{plannedRecordFields.Count} required record fields, {plannedScreens.Count} screens; " +
    "runtime evaluation NOT RUN.");
return 0;

void RequireFile(string path, string label)
{
    if (!File.Exists(path))
    {
        errors.Add($"Missing {label} file: {path}");
    }
}

void RequireMetadata(string name, string? expected)
{
    var prefix = $"{name}: ";
    var line = acceptanceLines
        .FirstOrDefault(candidate => candidate.StartsWith(prefix, StringComparison.Ordinal));
    var value = line is null ? null : line[prefix.Length..].Trim();

    if (string.IsNullOrWhiteSpace(value))
    {
        errors.Add($"Acceptance metadata '{name}' is missing.");
    }
    else if (expected is not null &&
        !string.Equals(
            PathOrValue(value),
            PathOrValue(expected),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
    {
        errors.Add($"Acceptance metadata '{name}' is '{value}', expected '{expected}'.");
    }
}

void RequireNonEmpty(string label, HashSet<string> values)
{
    if (values.Count == 0)
    {
        errors.Add($"The plan must contain at least one {label}.");
    }
}

void ValidateTargets(HashSet<string> targets)
{
    foreach (var target in targets)
    {
        string targetPath;
        try
        {
            targetPath = Path.GetFullPath(target);
        }
        catch (Exception exception) when (
            exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            errors.Add($"Dispatch target '{target}' is not a valid path.");
            continue;
        }

        var relative = Path.GetRelativePath(workspace, targetPath);
        if (relative == ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            Path.IsPathRooted(relative))
        {
            errors.Add($"Dispatch target '{target}' is outside the app workspace.");
        }
        else if (!targetPath.EndsWith(".pa.yaml", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add($"Dispatch target '{target}' is not a .pa.yaml file.");
        }
        else if (!File.Exists(targetPath))
        {
            errors.Add($"Dispatch target '{target}' does not exist.");
        }
    }
}

void ValidateDirectionalMutationEvidence(Dictionary<string, List<string>> evidence)
{
    foreach (var row in evidence.Values)
    {
        if (row.Count != 9)
        {
            errors.Add($"Directional mutation pair '{row[0]}' must have nine acceptance columns.");
            continue;
        }

        if (!string.Equals(Clean(row[8]), "PASS", StringComparison.OrdinalIgnoreCase))
        {
            errors.Add($"Directional mutation pair '{row[0]}' does not pass.");
        }

        var selectedRecordExpression = Clean(row[1]);
        var blankOperation = ParseYamlBinding(row[2], $"Directional mutation pair '{row[0]}' blank operation binding");
        var invalidGate = ParseYamlBinding(row[3], $"Directional mutation pair '{row[0]}' invalid submission gate");
        var receiveMutation = ParseYamlBinding(row[4], $"Directional mutation pair '{row[0]}' receive mutation");
        var issueMutation = ParseYamlBinding(row[5], $"Directional mutation pair '{row[0]}' issue mutation");
        var canonicalObserver = ParseYamlBinding(row[6], $"Directional mutation pair '{row[0]}' canonical-source observer");
        var receiptBindings = ParseReceiptBindings(row[7], row[0]);

        ValidateYamlBinding(blankOperation);
        ValidateYamlBinding(invalidGate);
        ValidateYamlBinding(receiveMutation);
        ValidateYamlBinding(issueMutation);
        ValidateYamlBinding(canonicalObserver);
        foreach (var receiptBinding in receiptBindings.Values)
        {
            ValidateYamlBinding(receiptBinding);
        }

        if (string.IsNullOrWhiteSpace(selectedRecordExpression) ||
            !selectedRecordExpression.Contains(".Selected", StringComparison.OrdinalIgnoreCase) ||
            !Regex.IsMatch(selectedRecordExpression, @"\b(ID|Id)\b", RegexOptions.CultureInvariant))
        {
            errors.Add(
                $"Directional mutation pair '{row[0]}' must declare a selected-record expression with a stable ID.");
        }

        if (blankOperation is not null &&
            !Regex.IsMatch(blankOperation.Value.Formula, @"^=\s*Blank\(\)\s*$", RegexOptions.CultureInvariant))
        {
            errors.Add(
                $"Directional mutation pair '{row[0]}' operation must start blank with '=Blank()'.");
        }

        if (invalidGate is not null)
        {
            var gate = invalidGate.Value.Formula;
            if (!gate.Contains("DisplayMode.Disabled", StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(gate, @"IsBlank\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
                !Regex.IsMatch(gate, @"(?:>\s*0|0\s*<)", RegexOptions.CultureInvariant))
            {
                errors.Add(
                    $"Directional mutation pair '{row[0]}' invalid submission gate must disable submission for a blank operation and amount <= 0.");
            }

            foreach (Match blankCheck in Regex.Matches(
                gate,
                @"\bIsBlank\s*\(\s*(?<variable>var[A-Za-z_][A-Za-z0-9_]*)\s*\)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                var operationVariable = blankCheck.Groups["variable"].Value;
                var eventAssignment = yamlFormulas
                    .Where(formula =>
                        !string.Equals(
                            formula.Control,
                            invalidGate.Value.Control,
                            StringComparison.OrdinalIgnoreCase) &&
                        formula.Property.StartsWith("On", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(formula.Property, "OnStart", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(formula.Property, "OnVisible", StringComparison.OrdinalIgnoreCase))
                    .SelectMany(formula => ExtractEventAssignments(formula.Formula))
                    .Any(assignment => string.Equals(
                        assignment.Variable,
                        operationVariable,
                        StringComparison.OrdinalIgnoreCase));
                if (!eventAssignment)
                {
                    errors.Add(
                        $"Directional mutation pair '{row[0]}' invalid submission gate blank-checks operation variable '{operationVariable}', but no reachable control event assigns it.");
                }
            }

            var mutationControls = new[] { receiveMutation, issueMutation }
                .Where(binding => binding is not null)
                .Select(binding => binding!.Value.Control)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (!mutationControls.Contains(invalidGate.Value.Control) &&
                !GateRoutesToMutation(invalidGate.Value.Control, mutationControls))
            {
                errors.Add(
                    $"Directional mutation pair '{row[0]}' gated control '{invalidGate.Value.Control}' must own or route to a declared mutation handler.");
            }
        }

        var pairFlows = sharedFlows
            .Where(flow => string.Equals(flow.Pair, row[0], StringComparison.OrdinalIgnoreCase))
            .OrderBy(flow => flow.Direction, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (pairFlows.Count > 0 && invalidGate is not null)
        {
            foreach (var flow in pairFlows
                .DistinctBy(
                    flow => $"{flow.MutationBinding.Control}:{flow.OperationVariable}",
                    StringComparer.OrdinalIgnoreCase))
            {
                if (!string.Equals(
                        invalidGate.Value.Control,
                        flow.MutationBinding.Control,
                        StringComparison.OrdinalIgnoreCase) ||
                    !Regex.IsMatch(
                        invalidGate.Value.Formula,
                        $@"\bIsBlank\s*\(\s*{Regex.Escape(flow.OperationVariable)}\s*\)",
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                {
                    errors.Add(
                        $"Directional mutation pair '{row[0]}' shared mutation gate must blank-check operation variable '{flow.OperationVariable}' on mutation control '{flow.MutationBinding.Control}'.");
                }
            }
        }

        foreach (var flow in pairFlows)
        {
            var evidenceBinding = string.Equals(
                flow.Direction,
                "receive",
                StringComparison.OrdinalIgnoreCase)
                ? receiveMutation
                : issueMutation;
            if (evidenceBinding is not null &&
                !SameBinding(flow.MutationBinding, evidenceBinding.Value))
            {
                errors.Add(
                    $"Directional mutation pair '{row[0]}' {flow.Direction} evidence must name shared mutation owner '{flow.MutationBinding.Control}.{flow.MutationBinding.Property}'.");
            }
        }

        var source = ExtractMutationSource(receiveMutation?.Formula);
        if (string.IsNullOrWhiteSpace(source))
        {
            errors.Add(
                $"Directional mutation pair '{row[0]}' receive mutation must update a named canonical source.");
        }

        // The receipt row commits to displaying the exact old value and amount the mutation
        // combines (columns `old=` and `amount=`). Reusing those same operands to bind the
        // arithmetic direction check is what makes the check meaningful: the operator must sit
        // *between* the committed old-value and amount, not merely appear somewhere in the formula.
        var oldValueOperand = ExtractReceiptOperand(receiptBindings, "old");
        var amountOperand = ExtractReceiptOperand(receiptBindings, "amount");
        var operationOperand = ExtractReceiptOperand(receiptBindings, "operation");

        // The `expected=` receipt binding names the variable the receipt claims it computed
        // (e.g. `varExpectedQuantity`). We reuse it to locate the expected-value `Set(...)` so
        // the directional check can confirm that "what we claim we compute" (the expected-value
        // expression) actually equals "what we persist" (the Patch write) — catching a receipt
        // that shows correct math while the real Patch write is reversed.
        var expectedVariable = ExtractReceiptOperand(receiptBindings, "expected");
        SharedFlowResolution? receiveFlow = pairFlows
            .Where(flow => string.Equals(flow.Direction, "receive", StringComparison.OrdinalIgnoreCase))
            .Select(flow => (SharedFlowResolution?)flow)
            .FirstOrDefault();
        SharedFlowResolution? issueFlow = pairFlows
            .Where(flow => string.Equals(flow.Direction, "issue", StringComparison.OrdinalIgnoreCase))
            .Select(flow => (SharedFlowResolution?)flow)
            .FirstOrDefault();
        var sameMutationBinding =
            receiveMutation is not null &&
            issueMutation is not null &&
            SameBinding(receiveMutation.Value, issueMutation.Value);
        var receiveBranch = ResolveBranchRequirement(
            "receive",
            receiveFlow,
            invalidGate,
            operationOperand,
            sameMutationBinding);
        var issueBranch = ResolveBranchRequirement(
            "issue",
            issueFlow,
            invalidGate,
            operationOperand,
            sameMutationBinding);

        ValidateDirectionalMutation(
            row[0],
            "receive",
            receiveMutation?.Formula,
            selectedRecordExpression,
            source,
            '+',
            oldValueOperand,
            amountOperand,
            expectedVariable,
            receiveBranch);
        ValidateDirectionalMutation(
            row[0],
            "issue",
            issueMutation?.Formula,
            selectedRecordExpression,
            source,
            '-',
            oldValueOperand,
            amountOperand,
            expectedVariable,
            issueBranch);

        if (!string.IsNullOrWhiteSpace(source) &&
            canonicalObserver is not null &&
            !canonicalObserver.Value.Formula.Contains(source, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add(
                $"Directional mutation pair '{row[0]}' observer must read canonical source '{source}'.");
        }

        foreach (var requiredReceiptField in new[] { "operation", "old", "amount", "expected", "actual" })
        {
            if (!receiptBindings.ContainsKey(requiredReceiptField))
            {
                errors.Add(
                    $"Directional mutation pair '{row[0]}' receipt bindings must include '{requiredReceiptField}'.");
            }
        }

        var persistedResult = ExtractPersistedResultVariable(receiveMutation?.Formula, issueMutation?.Formula);
        if (string.IsNullOrWhiteSpace(persistedResult))
        {
            errors.Add(
                $"Directional mutation pair '{row[0]}' must capture each Patch result in a named variable.");
        }
        else if (!receiptBindings.TryGetValue("actual", out var actualBinding) ||
            !actualBinding.Formula.Contains(persistedResult, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add(
                $"Directional mutation pair '{row[0]}' actual receipt binding must read persisted result '{persistedResult}'.");
        }
    }
}

BranchRequirement? ResolveBranchRequirement(
    string direction,
    SharedFlowResolution? sharedFlow,
    YamlBinding? invalidGate,
    string? operationReceiptOperand,
    bool mandatory)
{
    if (sharedFlow is not null)
    {
        return new(
            direction,
            sharedFlow.Value.OperationVariable,
            sharedFlow.Value.OperationLiteral,
            Mandatory: true);
    }

    var gateSources = invalidGate is null
        ? []
        : ExtractFunctionArguments(invalidGate.Value.Formula, "IsBlank")
            .Select(NormalizeWhitespace)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    if (gateSources.Count == 1)
    {
        return new(direction, gateSources[0], OperationLiteral: null, Mandatory: mandatory);
    }
    if (gateSources.Count > 1)
    {
        if (!string.IsNullOrWhiteSpace(operationReceiptOperand))
        {
            var receiptSource = NormalizeWhitespace(operationReceiptOperand);
            var matchingGateSource = gateSources.FirstOrDefault(source =>
                string.Equals(source, receiptSource, StringComparison.OrdinalIgnoreCase));
            if (matchingGateSource is not null)
            {
                return new(direction, matchingGateSource, OperationLiteral: null, Mandatory: mandatory);
            }
        }

        return new(direction, SourceExpression: "", OperationLiteral: null, Mandatory: mandatory);
    }

    if (!string.IsNullOrWhiteSpace(operationReceiptOperand))
    {
        return new(direction, operationReceiptOperand, OperationLiteral: null, Mandatory: mandatory);
    }

    return new(direction, SourceExpression: "", OperationLiteral: null, Mandatory: mandatory);
}

SharedFlowResolution? ValidateDirectionalActionEvidence(
    List<string> row,
    string pair,
    string operation)
{
    var action = Clean(row[0]);
    var bindings = ParseEmbeddedYamlBindings(row[2], action);

    if (bindings.Count == 0)
    {
        errors.Add(
            $"Directional action '{action}' must copy at least one exact `Control.Property: =formula` event binding.");
        return null;
    }

    foreach (var binding in bindings)
    {
        ValidateYamlBinding(binding, $"Action Contract for '{action}'");
    }

    var eventBindings = bindings
        .Where(binding => binding.Property.StartsWith("On", StringComparison.OrdinalIgnoreCase))
        .ToList();
    if (eventBindings.Count == 0)
    {
        errors.Add(
            $"Directional action '{action}' Action Contract must include at least one exact event-property binding.");
        return null;
    }

    var selections = new List<OperationSelection>();
    var selectionCandidates = new List<(YamlBinding Binding, SetAssignment Assignment)>();
    foreach (var binding in eventBindings)
    {
        foreach (var assignment in ExtractSetAssignments(binding.Formula))
        {
            if (IsOperationSelectionExpression(assignment.Expression, binding, bindings))
            {
                selectionCandidates.Add((binding, assignment));
            }

            var literal = ResolveOperationLiteral(
                assignment.Expression,
                binding,
                bindings,
                operation);
            if (literal is not null)
            {
                selections.Add(new(binding, assignment.Variable, literal));
            }
        }
    }

    selections = selections
        .OrderBy(selection => selection.Binding.Control, StringComparer.OrdinalIgnoreCase)
        .ThenBy(selection => selection.Binding.Property, StringComparer.OrdinalIgnoreCase)
        .ThenBy(selection => selection.Variable, StringComparer.OrdinalIgnoreCase)
        .ToList();
    var mutationBindings = eventBindings
        .Where(binding => ContainsMutation(binding.Formula))
        .OrderBy(binding => binding.Control, StringComparer.OrdinalIgnoreCase)
        .ThenBy(binding => binding.Property, StringComparer.OrdinalIgnoreCase)
        .ToList();
    if (selections.Count == 0)
    {
        var pureCandidate = selectionCandidates.FirstOrDefault(
            candidate => !ContainsMutation(candidate.Binding.Formula));
        if (!string.IsNullOrWhiteSpace(pureCandidate.Binding.Control))
        {
            errors.Add(
                $"Directional action '{action}' selector '{pureCandidate.Binding.Control}' must assign operation state to a declared value containing direction '{operation}'.");
        }
        return null;
    }

    // A selector may also update receipt/UI state with the same literal, e.g.
    // `Set(varOperation, "Receive"); Set(varReceiptAction, "Receive")`. The operation
    // variable is the one consumed by the distinct mutation owner; resolve that relationship
    // before treating multiple same-literal assignments as ambiguous.
    var consumedSelections = selections
        .Where(selection => mutationBindings.Any(
            mutation =>
                !SameBinding(mutation, selection.Binding) &&
                ConsumesVariable(mutation.Formula, selection.Variable)))
        .ToList();
    if (consumedSelections.Count > 0)
    {
        selections = consumedSelections;
    }
    else if (selections.All(selection => ContainsMutation(selection.Binding.Formula)))
    {
        // Separate directional buttons commonly set receipt state and mutate in the same
        // handler. With no distinct consumer there is no shared operation selector to resolve.
        return null;
    }

    if (selections
        .Select(selection => $"{selection.Binding.Control}.{selection.Binding.Property}:{selection.Variable}")
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Count() != 1)
    {
        errors.Add(
            $"Directional action '{action}' Action Contract resolves multiple operation selectors; declare one exact selector binding.");
        return null;
    }

    var selection = selections[0];
    var distinctMutations = mutationBindings
        .Where(binding => !SameBinding(binding, selection.Binding))
        .ToList();

    // Setting the operation and mutating in one event is a valid separate-action pattern.
    // It becomes a shared selector/submit flow only when a distinct mutation owner exists.
    if (ContainsMutation(selection.Binding.Formula) && distinctMutations.Count == 0)
    {
        return null;
    }

    if (distinctMutations.Count == 0)
    {
        errors.Add(
            $"Directional action '{action}' selector '{selection.Binding.Control}' sets operation state but its Action Contract omits the distinct mutation-handler binding.");
        return null;
    }

    if (ContainsMutation(selection.Binding.Formula))
    {
        errors.Add(
            $"Directional action '{action}' selector '{selection.Binding.Control}' must select the operation without mutating data.");
    }

    var consumingMutations = distinctMutations
        .Where(binding => ConsumesVariable(binding.Formula, selection.Variable))
        .ToList();
    if (consumingMutations.Count == 0)
    {
        errors.Add(
            $"Directional action '{action}' mutation handler '{distinctMutations[0].Control}' must consume operation variable '{selection.Variable}'.");
        return new(
            pair,
            operation,
            action,
            selection.Binding,
            distinctMutations[0],
            selection.Variable,
            selection.Literal);
    }

    if (consumingMutations.Count > 1)
    {
        errors.Add(
            $"Directional action '{action}' Action Contract has multiple mutation handlers consuming '{selection.Variable}'; declare one shared owner.");
        return null;
    }

    return new(
        pair,
        operation,
        action,
        selection.Binding,
        consumingMutations[0],
        selection.Variable,
        selection.Literal);
}

void ValidateSharedFlowConsistency(
    List<SharedFlowResolution> flows,
    HashSet<string> pairs)
{
    foreach (var pair in pairs.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
    {
        var pairFlows = flows
            .Where(flow => string.Equals(flow.Pair, pair, StringComparison.OrdinalIgnoreCase))
            .OrderBy(flow => flow.Direction, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (pairFlows.Count == 0)
        {
            continue;
        }

        if (pairFlows.Count != 2)
        {
            errors.Add(
                $"Directional mutation pair '{pair}' shared flow must resolve both directional Action Contract rows.");
            continue;
        }

        var first = pairFlows[0];
        foreach (var flow in pairFlows.Skip(1))
        {
            if (!SameBinding(first.MutationBinding, flow.MutationBinding))
            {
                errors.Add(
                    $"Directional mutation pair '{pair}' shared rows must resolve to the same mutation control and event.");
            }

            if (!string.Equals(first.OperationVariable, flow.OperationVariable, StringComparison.OrdinalIgnoreCase))
            {
                errors.Add(
                    $"Directional mutation pair '{pair}' shared rows must use the same operation state variable.");
            }
        }
    }
}

static bool SameBinding(YamlBinding left, YamlBinding right) =>
    string.Equals(left.Control, right.Control, StringComparison.OrdinalIgnoreCase) &&
    string.Equals(left.Property, right.Property, StringComparison.OrdinalIgnoreCase);

List<YamlBinding> ParseEmbeddedYamlBindings(string value, string action)
{
    var bindings = new List<YamlBinding>();
    foreach (Match match in Regex.Matches(value, @"`(?<binding>[^`]+)`", RegexOptions.CultureInvariant))
    {
        var candidate = match.Groups["binding"].Value;
        if (!Regex.IsMatch(
                candidate,
                @"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\s*:",
                RegexOptions.CultureInvariant))
        {
            continue;
        }

        var binding = ParseYamlBinding(candidate, $"Directional action '{action}' event binding");
        if (binding is not null)
        {
            bindings.Add(binding.Value);
        }
    }

    return bindings;
}

string? ResolveOperationLiteral(
    string expression,
    YamlBinding selectorBinding,
    List<YamlBinding> bindings,
    string direction)
{
    if (TryParsePowerFxStringLiteral(expression, out var literal))
    {
        return ContainsActionWord(literal, direction) ? literal : null;
    }

    if (!TryResolveSelectionItemsBinding(expression, selectorBinding, bindings, out var itemsBinding))
    {
        return null;
    }

    return ExtractPowerFxStringLiterals(itemsBinding.Formula)
        .FirstOrDefault(value => ContainsActionWord(value, direction));
}

static bool IsOperationSelectionExpression(
    string expression,
    YamlBinding selectorBinding,
    List<YamlBinding> bindings)
{
    if (TryParsePowerFxStringLiteral(expression, out _))
    {
        return true;
    }

    return TryResolveSelectionItemsBinding(
        expression,
        selectorBinding,
        bindings,
        out _);
}

static bool TryResolveSelectionItemsBinding(
    string expression,
    YamlBinding selectorBinding,
    List<YamlBinding> bindings,
    out YamlBinding itemsBinding)
{
    var selection = Regex.Match(
        expression.Trim(),
        @"^(?:(?<control>[A-Za-z_][A-Za-z0-9_]*)\.)?(?:Selected(?:Text)?\.(?:Value|Result)|Selected\.(?:Value|Result))$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    var control = selection.Groups["control"].Success
        ? selection.Groups["control"].Value
        : selectorBinding.Control;
    if (string.Equals(control, "Self", StringComparison.OrdinalIgnoreCase))
    {
        control = selectorBinding.Control;
    }

    itemsBinding = bindings.FirstOrDefault(
        binding =>
            string.Equals(binding.Control, control, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(binding.Property, "Items", StringComparison.OrdinalIgnoreCase));
    return selection.Success && !string.IsNullOrWhiteSpace(itemsBinding.Control);
}

static bool ContainsMutation(string formula) =>
    Regex.IsMatch(
        formula,
        @"\b(?:Patch|Collect|ClearCollect|Clear|Remove|RemoveIf|Update|UpdateIf|SubmitForm|Relate|Unrelate)\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

static bool TryParsePowerFxStringLiteral(string expression, out string literal)
{
    var trimmed = expression.Trim();
    if (trimmed.Length < 2 || trimmed[0] != '"' || trimmed[^1] != '"')
    {
        literal = "";
        return false;
    }

    literal = trimmed[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal);
    return true;
}

static IEnumerable<string> ExtractPowerFxStringLiterals(string formula)
{
    foreach (Match match in Regex.Matches(
        formula,
        @"""(?<value>(?:""""|[^""])*)""",
        RegexOptions.CultureInvariant))
    {
        yield return match.Groups["value"].Value.Replace("\"\"", "\"", StringComparison.Ordinal);
    }
}

static bool ConsumesVariable(string formula, string variable)
{
    // A Set target is a write, not consumption. Remove only `Set(variable,` target
    // occurrences before checking for a remaining read in the Apply/Submit handler.
    var withoutAssignments = Regex.Replace(
        formula,
        $@"\bSet\s*\(\s*{Regex.Escape(variable)}\s*,",
        "Set(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    return Regex.IsMatch(
        withoutAssignments,
        $@"(?<![A-Za-z0-9_]){Regex.Escape(variable)}(?![A-Za-z0-9_])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}

bool GateRoutesToMutation(string gateControl, HashSet<string> mutationControls)
{
    if (!TryGetControlBlock(yamlLines, gateControl, out var controlBlock))
    {
        return false;
    }

    var eventFormula = GetPropertyFormula(controlBlock, "OnSelect");
    if (string.IsNullOrWhiteSpace(eventFormula))
    {
        return false;
    }

    return mutationControls.Any(control =>
        Regex.IsMatch(
            eventFormula,
            $@"\bSelect\s*\(\s*{Regex.Escape(control)}\s*\)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
}

void ValidateDirectionalMutation(
    string pair,
    string direction,
    string? formula,
    string selectedRecordExpression,
    string? source,
    char operatorCharacter,
    string? oldValueOperand,
    string? amountOperand,
    string? expectedVariable,
    BranchRequirement? branchRequirement)
{
    if (string.IsNullOrWhiteSpace(formula))
    {
        return;
    }

    if (!formula.Contains(selectedRecordExpression, StringComparison.OrdinalIgnoreCase))
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} mutation must target '{selectedRecordExpression}'.");
    }

    // Phantom LookUp key (QAChecks Check 43). Merely *containing* the selected-record
    // expression is not enough: the record identity that locates the row to Patch must be
    // the selected record verbatim. Concatenating or computing onto it silently changes the
    // key so `LookUp(...)` returns Blank() and `Patch` no-ops — the app looks wired but never
    // mutates. The canonical defect is a stray string-concat suffix on the key, e.g.
    //   LookUp(colInventory, ID = cmbAdjustItem.Selected.ID & " ID")
    // where `... .Selected.ID` still appears as a substring (so the .Contains check above
    // passes) but ` & " ID"` corrupts the match. A correct key terminates the selected-record
    // expression with a delimiter (`)` closing the LookUp predicate, or `.` for `LookUp(...).Field`),
    // never a binary operator. Flag any occurrence of the selected-record expression immediately
    // followed (past whitespace) by a string-concat or arithmetic operator. `selectedRecordExpression`
    // is code-adjacent evidence text but may contain regex metacharacters (dots), so escape it.
    var transformedKey = new Regex(
        Regex.Escape(selectedRecordExpression) + @"\s*[&+\-*/^]",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    if (transformedKey.IsMatch(formula))
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} mutation uses a transformed record-identity key: the selected-record expression '{selectedRecordExpression}' is concatenated or computed onto, so LookUp never matches and Patch no-ops (phantom LookUp key).");
    }

    if (!string.IsNullOrWhiteSpace(source) &&
        !formula.Contains(source, StringComparison.OrdinalIgnoreCase))
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} mutation must update canonical source '{source}'.");
    }

    // Direction is the whole point of this pair, so the operator must *bind* the committed
    // old-value and amount operands — not merely appear somewhere in the formula.
    //
    // The original P0 bug was a reversed-sign mutation slipping through: an issue (decrease)
    // that actually added, or a receive that subtracted. The prior check only asserted the
    // expected operator character appeared *anywhere* in the formula (`\+\s*[^;,\)\r\n]+`),
    // which a stray '+'/'-' elsewhere — a negative literal, a LookUp argument, an unrelated
    // subexpression — trivially satisfied while the real old±amount arithmetic ran the wrong
    // way. Binding <oldValue><op><amount> using the exact operands the receipt row commits to
    // closes that hole. Addition is commutative, so a receive may write `old + amount` or
    // `amount + old`; subtraction is not, so an issue must write `old - amount` and never
    // `amount - old` (which would be the reversed-direction bug).
    if (string.IsNullOrWhiteSpace(oldValueOperand) || string.IsNullOrWhiteSpace(amountOperand))
    {
        // Without both committed operands we cannot bind the operator; the missing `old`/`amount`
        // receipt-binding error is already reported for this pair, so stay silent here rather
        // than emit a confusing duplicate.
        return;
    }

    var oldEscaped = Regex.Escape(NormalizeWhitespace(oldValueOperand));
    var amountEscaped = Regex.Escape(NormalizeWhitespace(amountOperand));

    ValidateOperandLiveness(
        pair,
        direction,
        "old",
        oldValueOperand,
        formula,
        selectedRecordExpression);
    ValidateOperandLiveness(
        pair,
        direction,
        "amount",
        amountOperand,
        formula,
        selectedRecordExpression);

    var arithmetic = operatorCharacter == '+'
        ? $@"(?:{oldEscaped}\s*\+\s*{amountEscaped})|(?:{amountEscaped}\s*\+\s*{oldEscaped})"
        : $@"{oldEscaped}\s*-\s*{amountEscaped}";

    // The arithmetic must bind the operands *inside the actual Patch write* — the expression
    // that is really persisted — not merely appear somewhere in the OnSelect formula. The
    // mutation formula also computes an *expected-value* preview, e.g.
    //   Set(varExpectedQuantity, varOldQuantity - amount); Set(varLastMutation, Patch(..., {Quantity: <write>}))
    // A reversed-sign Patch write with a still-correct expected-value preview
    // (`Set(varExpectedQuantity, old - amount)` kept, `{Quantity: old + amount}` swapped)
    // would satisfy a whole-formula match while persisting the wrong direction. Isolating the
    // Patch argument list before matching closes that hole.
    var patchArgs = ExtractPatchWriteFormula(formula);
    if (string.IsNullOrWhiteSpace(patchArgs))
    {
        // No Patch(...) write at all is already reported by the missing-canonical-source check
        // above, so avoid a duplicate error here.
        return;
    }

    var expectedExpression = ExtractExpectedValueExpression(formula, expectedVariable);
    var patchWriteCandidates = ExtractPatchWriteValues(patchArgs)
        .Where(value =>
        {
            var code = RemovePowerFxStringLiterals(NormalizeWhitespace(value));
            return code.Contains(
                    NormalizeWhitespace(oldValueOperand),
                    StringComparison.OrdinalIgnoreCase) &&
                code.Contains(
                    NormalizeWhitespace(amountOperand),
                    StringComparison.OrdinalIgnoreCase);
        })
        .ToList();
    if (patchWriteCandidates.Count != 1)
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} Patch record must contain exactly one field using both receipt arithmetic operands; found {patchWriteCandidates.Count}.");
        return;
    }

    var patchWriteValue = patchWriteCandidates[0];
    var arithmeticScope = patchWriteValue;
    var plusArithmetic =
        $@"(?:{oldEscaped}\s*\+\s*{amountEscaped})|(?:{amountEscaped}\s*\+\s*{oldEscaped})";
    var minusArithmetic = $@"{oldEscaped}\s*-\s*{amountEscaped}";
    var normalizedWrite = NormalizeWhitespace(RemovePowerFxStringLiterals(arithmeticScope));
    var containsBothDirections =
        Regex.IsMatch(normalizedWrite, plusArithmetic, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) &&
        Regex.IsMatch(normalizedWrite, minusArithmetic, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    var requiresBranch = branchRequirement is not null &&
        (branchRequirement.Value.Mandatory || containsBothDirections);
    if (requiresBranch)
    {
        arithmeticScope = string.IsNullOrWhiteSpace(branchRequirement.Value.SourceExpression)
            ? null
            : ExtractGuardedOperationBranch(
            arithmeticScope,
            branchRequirement.Value.SourceExpression,
            branchRequirement.Value.Direction,
            branchRequirement.Value.OperationLiteral);
        if (string.IsNullOrWhiteSpace(arithmeticScope))
        {
            var state = string.IsNullOrWhiteSpace(branchRequirement.Value.SourceExpression)
                ? "a uniquely resolvable operation source"
                : $"operation source '{branchRequirement.Value.SourceExpression}'";
            errors.Add(
                $"Directional mutation pair '{pair}' {direction} shared mutation must guard exactly one write branch with {state}.");
            return;
        }
    }

    var normalizedArithmeticScope = NormalizeWhitespace(arithmeticScope);
    if (!Regex.IsMatch(normalizedArithmeticScope, arithmetic, RegexOptions.CultureInvariant))
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} mutation must apply '{operatorCharacter}' between " +
            $"the receipt old-value operand '{oldValueOperand}' and amount operand '{amountOperand}' in its Patch write.");
    }

    // Cross-check that the receipt's claimed expected-value expression matches what the Patch
    // actually writes. This catches the inverse of the case above: a Patch write that is itself
    // internally consistent but disagrees with the expected-value the receipt advertises, i.e.
    // "what we claim we compute" != "what we actually persist".
    if (!string.IsNullOrWhiteSpace(patchWriteValue) &&
        !string.IsNullOrWhiteSpace(expectedExpression) &&
        !string.Equals(
            NormalizeWhitespace(patchWriteValue),
            NormalizeWhitespace(expectedExpression),
            StringComparison.OrdinalIgnoreCase))
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} mutation Patch write '{patchWriteValue}' must match " +
            $"the receipt expected-value expression '{expectedExpression}'.");
    }
}

void ValidateOperandLiveness(
    string pair,
    string direction,
    string operandName,
    string operand,
    string mutationFormula,
    string selectedRecordExpression)
{
    if (IsLiveSourceExpression(operand, selectedRecordExpression))
    {
        return;
    }

    // A plain variable is safe only when the current mutation handler assigns it from a
    // live control/canonical-record expression, or a control's OnChange does so. App.OnStart
    // and Screen.OnVisible seeds are intentionally excluded: they compile but remain stale
    // when the user changes the selected record or amount.
    if (Regex.IsMatch(
            operand,
            @"^[A-Za-z_][A-Za-z0-9_]*$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
    {
        var hasInlineAssignment = ExtractEventAssignments(ExtractMutationPrelude(mutationFormula)).Any(
            assignment =>
                string.Equals(assignment.Variable, operand, StringComparison.OrdinalIgnoreCase) &&
                IsLiveSourceExpression(assignment.Expression, selectedRecordExpression));
        var hasInputEventAssignment = yamlFormulas
            .Where(binding =>
                string.Equals(binding.Property, "OnChange", StringComparison.OrdinalIgnoreCase))
            .SelectMany(binding => ExtractEventAssignments(binding.Formula))
            .Any(
                assignment =>
                    string.Equals(assignment.Variable, operand, StringComparison.OrdinalIgnoreCase) &&
                    IsLiveSourceExpression(assignment.Expression, selectedRecordExpression));

        if (hasInlineAssignment || hasInputEventAssignment)
        {
            return;
        }

        errors.Add(
            $"Directional mutation pair '{pair}' {direction} {operandName} operand '{operand}' is a dead staging variable: " +
            "assign it from a live .Selected/.Text/.Value expression before Patch in the mutation handler or in a control OnChange formula.");
        return;
    }

    errors.Add(
        $"Directional mutation pair '{pair}' {direction} {operandName} operand '{operand}' must read a live selected record or input control.");
}

static string ExtractMutationPrelude(string formula)
{
    var patch = Regex.Match(
        formula,
        @"\bPatch\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    return patch.Success ? formula[..patch.Index] : formula;
}

bool IsLiveSourceExpression(string expression, string selectedRecordExpression)
{
    if (!string.IsNullOrWhiteSpace(selectedRecordExpression) &&
        expression.Contains(selectedRecordExpression, StringComparison.OrdinalIgnoreCase))
    {
        return true;
    }

    if (Regex.IsMatch(
        expression,
        @"\bThisItem(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
    {
        return true;
    }

    // A `.Selected`/`.Text`/`.Value` shape is evidence of live input only when the name
    // before it is an actual control in the final YAML. Without this existence check, a
    // stale record variable such as `varPreviousSelection.Selected.Value` could masquerade
    // as a control solely because its property names look control-like.
    return Regex.Matches(
            expression,
            @"\b(?<control>[A-Za-z_][A-Za-z0-9_]*)\.(?:Selected(?:\.[A-Za-z_][A-Za-z0-9_]*)?|Text|Value)\b",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
        .Cast<Match>()
        .Any(match => TryGetControlBlock(yamlLines, match.Groups["control"].Value, out _));
}

static IEnumerable<SetAssignment> ExtractSetAssignments(string formula)
{
    foreach (Match match in Regex.Matches(
        formula,
        @"\bSet\s*\(\s*(?<variable>var[A-Za-z0-9_]*)\s*,",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
    {
        var expression = ExtractBalancedGroup(formula, match.Index + match.Length, '(', ')');
        if (!string.IsNullOrWhiteSpace(expression))
        {
            yield return new(match.Groups["variable"].Value, expression.Trim());
        }
    }
}

static IEnumerable<SetAssignment> ExtractEventAssignments(string formula)
{
    foreach (var assignment in ExtractSetAssignments(formula))
    {
        yield return assignment;
    }

    foreach (Match match in Regex.Matches(
        formula,
        @"\bUpdateContext\s*\(\s*\{",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
    {
        var record = ExtractBalancedGroup(formula, match.Index + match.Length, '{', '}');
        if (record is null)
        {
            continue;
        }

        foreach (var field in SplitPowerFxArguments(record))
        {
            var separator = field.IndexOf(':');
            if (separator <= 0)
            {
                continue;
            }

            var variable = field[..separator].Trim();
            var expression = field[(separator + 1)..].Trim();
            if (Regex.IsMatch(
                    variable,
                    @"^[A-Za-z_][A-Za-z0-9_]*$",
                    RegexOptions.CultureInvariant))
            {
                yield return new(variable, expression);
            }
        }
    }
}

// Receipt labels often decorate one value, e.g. `="Old quantity: " & varOldQuantity`.
// Ignore string-only decoration while preserving the single underlying Power Fx value. Multiple
// non-literal segments are ambiguous evidence and get their own error rather than misleading
// arithmetic/liveness diagnostics against the entire label expression.
string? ExtractReceiptOperand(Dictionary<string, YamlBinding> receiptBindings, string field)
{
    if (!receiptBindings.TryGetValue(field, out var binding))
    {
        return null;
    }

    var expression = binding.Formula.TrimStart('=').Trim();
    if (string.IsNullOrWhiteSpace(expression))
    {
        return null;
    }

    var concatenated = SplitTopLevelOperator(expression, '&');
    if (concatenated.Count == 1)
    {
        return UnwrapReceiptText(concatenated[0]);
    }

    var values = concatenated
        .Where(segment => !TryParsePowerFxStringLiteral(segment, out _))
        .Select(UnwrapReceiptText)
        .Where(segment => !string.IsNullOrWhiteSpace(segment))
        .ToList();
    if (values.Count == 1)
    {
        return values[0];
    }

    errors.Add(
        $"Directional mutation receipt binding '{field}' has ambiguous label expression '{expression}'; expose exactly one non-literal value.");
    return null;
}

static string UnwrapReceiptText(string expression)
{
    var trimmed = expression.Trim();
    var textCall = Regex.Match(
        trimmed,
        @"^Text\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    if (!textCall.Success)
    {
        return trimmed;
    }

    var argumentsText = ExtractBalancedGroup(
        trimmed,
        textCall.Index + textCall.Length,
        '(',
        ')');
    if (argumentsText is null)
    {
        return trimmed;
    }

    return SplitPowerFxArguments(argumentsText)[0].Trim();
}

static List<string> SplitTopLevelOperator(string value, char separator)
{
    var parts = new List<string>();
    var start = 0;
    var round = 0;
    var square = 0;
    var curly = 0;
    for (var index = 0; index < value.Length; index++)
    {
        var character = value[index];
        if (character == '"')
        {
            while (++index < value.Length)
            {
                if (value[index] != '"')
                {
                    continue;
                }

                if (index + 1 < value.Length && value[index + 1] == '"')
                {
                    index++;
                    continue;
                }

                break;
            }
            continue;
        }

        switch (character)
        {
            case '(':
                round++;
                break;
            case ')':
                round--;
                break;
            case '[':
                square++;
                break;
            case ']':
                square--;
                break;
            case '{':
                curly++;
                break;
            case '}':
                curly--;
                break;
            default:
                if (character == separator && round == 0 && square == 0 && curly == 0)
                {
                    parts.Add(value[start..index].Trim());
                    start = index + 1;
                }
                break;
        }
    }

    parts.Add(value[start..].Trim());
    return parts;
}

// Isolate the argument list of the mutation's `Patch(...)` write so the directional check binds
// the arithmetic operator to the value that is *actually persisted*, not to any lookalike
// expression elsewhere in the OnSelect formula (notably the expected-value preview
// `Set(varExpectedQuantity, old +/- amount)`). Returns everything between the outermost
// parentheses of the first `Patch(` call, e.g. for
//   Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = ...), {Quantity: old - amount}))
// it returns:
//   colInventory, LookUp(colInventory, ID = ...), {Quantity: old - amount}
// Parentheses are balanced (LookUp/nested calls are common), so a naive `\)` stop would truncate.
static string? ExtractPatchWriteFormula(string? formula)
{
    if (string.IsNullOrWhiteSpace(formula))
    {
        return null;
    }

    var match = Regex.Match(
        formula,
        @"\bPatch\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    return match.Success ? ExtractBalancedGroup(formula, match.Index + match.Length, '(', ')') : null;
}

// Return each top-level field value from the Patch change record. Splitting at Power Fx-aware
// top-level commas keeps nested calls and records intact:
//   {Quantity: old + amount, Notes: "adjusted"}
// becomes `old + amount` and `"adjusted"` rather than one malformed expression.
static List<string> ExtractPatchWriteValues(string? patchArgs)
{
    var values = new List<string>();
    if (string.IsNullOrWhiteSpace(patchArgs))
    {
        return values;
    }

    var brace = patchArgs.IndexOf('{');
    if (brace < 0)
    {
        return values;
    }

    var record = ExtractBalancedGroup(patchArgs, brace + 1, '{', '}');
    if (record is null)
    {
        return values;
    }

    foreach (var field in SplitPowerFxArguments(record))
    {
        var parts = SplitTopLevelOperator(field, ':');
        if (parts.Count == 2 && !string.IsNullOrWhiteSpace(parts[1]))
        {
            values.Add(parts[1].Trim());
        }
    }

    return values;
}

static string RemovePowerFxStringLiterals(string formula) =>
    Regex.Replace(
        formula,
        @"""(?:""""|[^""])*""",
        "\"\"",
        RegexOptions.CultureInvariant);

// Recover the expression the receipt claims it computed, from `Set(<expectedVariable>, <expr>)`.
// `expectedVariable` comes from the `expected=` receipt binding (e.g. `varExpectedQuantity`). Only
// a plain variable name is a Set target we can model; anything else returns null so the caller
// skips the cross-check instead of misfiring.
static string? ExtractExpectedValueExpression(string? formula, string? expectedVariable)
{
    if (string.IsNullOrWhiteSpace(formula) ||
        string.IsNullOrWhiteSpace(expectedVariable) ||
        !Regex.IsMatch(expectedVariable, @"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.CultureInvariant))
    {
        return null;
    }

    var match = Regex.Match(
        formula,
        @"\bSet\s*\(\s*" + Regex.Escape(expectedVariable) + @"\s*,",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    if (!match.Success)
    {
        return null;
    }

    // The match consumed `Set(` and the trailing comma, so the current depth inside Set's
    // parentheses is 1; the balanced scan returns the remaining argument up to Set's closing ')'.
    var expression = ExtractBalancedGroup(formula, match.Index + match.Length, '(', ')');
    return string.IsNullOrWhiteSpace(expression) ? null : expression.Trim();
}

// Return the substring from `startIndex` (already inside one open group) up to the matching
// close delimiter, tracking nesting so inner groups do not end the scan early. Assumes the caller
// positions `startIndex` just past a single opening delimiter (depth starts at 1). Returns null
// when the group never closes (malformed input) so callers can bail rather than parse garbage.
static string? ExtractBalancedGroup(string text, int startIndex, char open, char close)
{
    var depth = 1;
    for (var i = startIndex; i < text.Length; i++)
    {
        var c = text[i];
        if (c == '"')
        {
            while (++i < text.Length)
            {
                if (text[i] != '"')
                {
                    continue;
                }

                if (i + 1 < text.Length && text[i + 1] == '"')
                {
                    i++;
                    continue;
                }

                break;
            }
            continue;
        }

        if (c == open)
        {
            depth++;
        }
        else if (c == close)
        {
            depth--;
            if (depth == 0)
            {
                return text.Substring(startIndex, i - startIndex);
            }
        }
    }

    return null;
}

static IEnumerable<string> ExtractFunctionArguments(string formula, string function)
{
    foreach (Match match in Regex.Matches(
        formula,
        $@"\b{Regex.Escape(function)}\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
    {
        var argument = ExtractBalancedGroup(formula, match.Index + match.Length, '(', ')');
        if (!string.IsNullOrWhiteSpace(argument))
        {
            yield return argument.Trim();
        }
    }
}

static string? ExtractGuardedOperationBranch(
    string formula,
    string sourceExpression,
    string direction,
    string? operationLiteral)
{
    // A shared write often uses `Switch(varOperation, "Receive", old + amount, ...)`.
    // Return the one branch explicitly keyed by the selector's exact state literal. Searching
    // the whole Patch would let a correct-looking `+` in the opposite branch hide swapped
    // Receive/Issue behavior; multiple matching dispatches are ambiguous and fail closed.
    var branches = new List<string>();
    foreach (Match call in Regex.Matches(
        formula,
        @"\b(?<function>If|Switch)\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
    {
        var argumentsText = ExtractBalancedGroup(formula, call.Index + call.Length, '(', ')');
        if (argumentsText is null)
        {
            continue;
        }

        var arguments = SplitPowerFxArguments(argumentsText);
        if (string.Equals(
                call.Groups["function"].Value,
                "Switch",
                StringComparison.OrdinalIgnoreCase))
        {
            if (arguments.Count < 3 ||
                !string.Equals(
                    NormalizeWhitespace(arguments[0]),
                    NormalizeWhitespace(sourceExpression),
                    StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            for (var index = 1; index + 1 < arguments.Count; index += 2)
            {
                if (TryParsePowerFxStringLiteral(arguments[index], out var literal) &&
                    MatchesOperationLiteral(literal, direction, operationLiteral))
                {
                    branches.Add(arguments[index + 1]);
                }
            }
        }
        else
        {
            for (var index = 0; index + 1 < arguments.Count; index += 2)
            {
                if (MatchesOperationGuard(
                    arguments[index],
                    sourceExpression,
                    direction,
                    operationLiteral))
                {
                    branches.Add(arguments[index + 1]);
                }
            }
        }
    }

    return branches.Count == 1 ? branches[0] : null;
}

static bool MatchesOperationGuard(
    string condition,
    string sourceExpression,
    string direction,
    string? operationLiteral)
{
    var sides = SplitTopLevelOperator(condition, '=');
    if (sides.Count != 2)
    {
        return false;
    }

    foreach (var (source, literalExpression) in new[]
    {
        (sides[0], sides[1]),
        (sides[1], sides[0]),
    })
    {
        if (string.Equals(
                NormalizeWhitespace(source),
                NormalizeWhitespace(sourceExpression),
                StringComparison.OrdinalIgnoreCase) &&
            TryParsePowerFxStringLiteral(literalExpression, out var literal) &&
            MatchesOperationLiteral(literal, direction, operationLiteral))
        {
            return true;
        }
    }

    return false;
}

static bool MatchesOperationLiteral(
    string literal,
    string direction,
    string? expectedLiteral) =>
    expectedLiteral is not null
        ? string.Equals(literal, expectedLiteral, StringComparison.OrdinalIgnoreCase)
        : ContainsActionWord(literal, direction);

static List<string> SplitPowerFxArguments(string value)
{
    var arguments = new List<string>();
    var start = 0;
    var round = 0;
    var square = 0;
    var curly = 0;
    for (var index = 0; index < value.Length; index++)
    {
        var character = value[index];
        if (character == '"')
        {
            while (++index < value.Length)
            {
                if (value[index] != '"')
                {
                    continue;
                }

                if (index + 1 < value.Length && value[index + 1] == '"')
                {
                    index++;
                    continue;
                }

                break;
            }
            continue;
        }

        switch (character)
        {
            case '(':
                round++;
                break;
            case ')':
                round--;
                break;
            case '[':
                square++;
                break;
            case ']':
                square--;
                break;
            case '{':
                curly++;
                break;
            case '}':
                curly--;
                break;
            case ',' when round == 0 && square == 0 && curly == 0:
                arguments.Add(value[start..index].Trim());
                start = index + 1;
                break;
        }
    }

    arguments.Add(value[start..].Trim());
    return arguments;
}

void ValidateYamlBinding(
    YamlBinding? binding,
    string context = "Directional mutation evidence")
{
    if (binding is null)
    {
        return;
    }

    if (!TryGetControlBlock(yamlLines, binding.Value.Control, out var controlBlock))
    {
        errors.Add($"{context} binding control '{binding.Value.Control}' does not exist in app YAML.");
        return;
    }

    var actualFormula = GetPropertyFormula(controlBlock, binding.Value.Property);
    if (actualFormula is null)
    {
        errors.Add(
            $"{context} binding '{binding.Value.Control}.{binding.Value.Property}' does not exist in app YAML.");
    }
    else if (!string.Equals(
        NormalizeWhitespace(actualFormula),
        NormalizeWhitespace(binding.Value.Formula),
        StringComparison.Ordinal))
    {
        errors.Add(
            $"{context} binding '{binding.Value.Control}.{binding.Value.Property}' does not match final app YAML.");
    }
}

YamlBinding? ParseYamlBinding(string value, string label)
{
    var match = Regex.Match(
        Clean(value).Replace("<br>", " ", StringComparison.OrdinalIgnoreCase),
        @"^(?<control>[A-Za-z_][A-Za-z0-9_]*)\.(?<property>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?<formula>=.+)$",
        RegexOptions.CultureInvariant);
    if (!match.Success)
    {
        errors.Add($"{label} must use 'Control.Property: =formula' and copy the final YAML formula exactly.");
        return null;
    }

    return new(
        match.Groups["control"].Value,
        match.Groups["property"].Value,
        match.Groups["formula"].Value.Replace("\\|", "|", StringComparison.Ordinal));
}

Dictionary<string, YamlBinding> ParseReceiptBindings(string value, string pair)
{
    var bindings = new Dictionary<string, YamlBinding>(StringComparer.OrdinalIgnoreCase);
    foreach (var item in value.Split("<br>", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
    {
        var separator = item.IndexOf('=');
        if (separator <= 0)
        {
            errors.Add(
                $"Directional mutation pair '{pair}' receipt bindings must use 'field=Control.Property: =formula'.");
            continue;
        }

        var field = item[..separator].Trim().ToLowerInvariant();
        var binding = ParseYamlBinding(
            item[(separator + 1)..],
            $"Directional mutation pair '{pair}' receipt binding '{field}'");
        if (binding is not null && !bindings.TryAdd(field, binding.Value))
        {
            errors.Add($"Directional mutation pair '{pair}' repeats receipt binding '{field}'.");
        }
    }

    return bindings;
}

static HashSet<string> FindDirectionalPairs(HashSet<string> actions)
{
    var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var (pair, first, second) in DirectionalOperationPairs())
    {
        if (actions.Any(action => ContainsActionWord(action, first)) &&
            actions.Any(action => ContainsActionWord(action, second)))
        {
            found.Add(pair);
        }
    }

    return found;
}

static bool TryGetDirectionalOperation(
    string action,
    HashSet<string> directionalPairs,
    out string pairName,
    out string operation)
{
    foreach (var (pair, first, second) in DirectionalOperationPairs())
    {
        if (!directionalPairs.Contains(pair))
        {
            continue;
        }

        if (ContainsActionWord(action, first))
        {
            pairName = pair;
            operation = first;
            return true;
        }

        if (ContainsActionWord(action, second))
        {
            pairName = pair;
            operation = second;
            return true;
        }
    }

    pairName = "";
    operation = "";
    return false;
}

static (string Pair, string First, string Second)[] DirectionalOperationPairs() =>
[
    ("Receive/Issue", "receive", "issue"),
    ("Increase/Decrease", "increase", "decrease"),
    ("Credit/Debit", "credit", "debit"),
    ("Allocate/Release", "allocate", "release"),
    ("Check-in/Check-out", "check-in", "check-out"),
    ("Enable/Disable", "enable", "disable"),
];

static bool ContainsActionWord(string action, string word) =>
    Regex.IsMatch(
        action,
        $@"(?<![A-Za-z]){Regex.Escape(word)}(?![A-Za-z])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

static string? ExtractMutationSource(string? formula)
{
    if (string.IsNullOrWhiteSpace(formula))
    {
        return null;
    }

    var match = Regex.Match(
        formula,
        @"\b(?:Patch|UpdateIf)\s*\(\s*(?<source>[A-Za-z_][A-Za-z0-9_]*)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    return match.Success ? match.Groups["source"].Value : null;
}

static string? ExtractPersistedResultVariable(params string?[] formulas)
{
    foreach (var formula in formulas)
    {
        if (string.IsNullOrWhiteSpace(formula))
        {
            continue;
        }

        var match = Regex.Match(
            formula,
            @"\bSet\s*\(\s*(?<variable>var[A-Za-z0-9_]*)\s*,\s*Patch\s*\(",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (match.Success)
        {
            return match.Groups["variable"].Value;
        }
    }

    return null;
}

static string? GetPropertyFormula(string controlBlock, string property)
{
    return IndexYamlFormulas(controlBlock.Replace("\r", "", StringComparison.Ordinal).Split('\n'))
        .FirstOrDefault(formula => string.Equals(
            formula.Property,
            property,
            StringComparison.OrdinalIgnoreCase))
        .Formula;
}

static Dictionary<string, List<string>> ReadRows(
    string[] lines,
    string heading,
    List<string> errors,
    int keyColumn = 0)
{
    var headingIndex = Array.FindIndex(lines, line => line.Trim() == heading);
    if (headingIndex < 0)
    {
        errors.Add($"Missing acceptance section '{heading}'.");
        return new(StringComparer.OrdinalIgnoreCase);
    }

    var tableStart = Array.FindIndex(lines, headingIndex + 1, line => line.TrimStart().StartsWith('|'));
    if (tableStart < 0 || tableStart + 2 >= lines.Length)
    {
        errors.Add($"Missing table under '{heading}'.");
        return new(StringComparer.OrdinalIgnoreCase);
    }

    var rows = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    for (var index = tableStart + 2; index < lines.Length; index++)
    {
        if (!lines[index].TrimStart().StartsWith('|'))
        {
            break;
        }

        var cells = SplitRow(lines[index]);
        if (cells.Count == 0)
        {
            continue;
        }

        if (cells.Count <= keyColumn)
        {
            errors.Add($"Row under '{heading}' is missing key column {keyColumn + 1}.");
            continue;
        }

        var key = Clean(cells[keyColumn]);
        if (string.IsNullOrWhiteSpace(key) || key.StartsWith('['))
        {
            errors.Add($"Invalid row key under '{heading}': '{key}'.");
        }
        else if (!rows.TryAdd(key, cells))
        {
            errors.Add($"Duplicate row '{key}' under '{heading}'.");
        }
    }

    return rows;
}

static Dictionary<string, List<string>> ReadOptionalRows(
    string[] lines,
    string heading,
    List<string> errors,
    int keyColumn = 0)
{
    return Array.Exists(lines, line => line.Trim() == heading)
        ? ReadRows(lines, heading, errors, keyColumn)
        : new(StringComparer.OrdinalIgnoreCase);
}

static HashSet<string> ReadColumn(
    string[] lines,
    string heading,
    int column,
    List<string> errors,
    int keyColumn = 0)
{
    var rows = ReadRows(lines, heading, errors, keyColumn);
    var values = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var row in rows.Values)
    {
        if (row.Count <= column)
        {
            errors.Add($"Row '{row[0]}' under '{heading}' is missing column {column + 1}.");
            continue;
        }

        values.Add(Clean(row[column]));
    }

    return values;
}

static void CompareCoverage(
    string label,
    HashSet<string> expected,
    Dictionary<string, List<string>> actual,
    List<string> errors)
{
    foreach (var missing in expected.Where(value => !actual.ContainsKey(value)))
    {
        errors.Add($"Missing {label} evidence for '{missing}'.");
    }

    foreach (var extra in actual.Keys.Where(value => !expected.Contains(value)))
    {
        errors.Add($"Unexpected {label} evidence for '{extra}'.");
    }
}

static List<string> SplitRow(string line)
{
    // Acceptance evidence is a Markdown table. Formula cells may contain escaped pipes,
    // e.g. `Filter(Items, State = "Open") \| CountRows(...)`, which must stay in one cell.
    var cells = new List<string>();
    var cell = new StringBuilder();
    var escaped = false;

    foreach (var character in line.Trim().Trim('|'))
    {
        if (character == '|' && !escaped)
        {
            cells.Add(cell.ToString().Trim());
            cell.Clear();
        }
        else
        {
            cell.Append(character);
        }

        escaped = character == '\\' && !escaped;
        if (character != '\\')
        {
            escaped = false;
        }
    }

    cells.Add(cell.ToString().Trim());
    return cells;
}

static string Clean(string value) => value.Trim().Trim('`');

static string NormalizeWhitespace(string value) =>
    string.Join(
        " ",
        value.Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries));

static List<YamlFormula> IndexYamlFormulas(string[] yamlLines)
{
    var formulas = new List<YamlFormula>();
    string? currentControl = null;
    var controlIndentation = -1;

    for (var index = 0; index < yamlLines.Length; index++)
    {
        var line = yamlLines[index];
        var controlMatch = Regex.Match(
            line,
            @"^(?<indent>\s*)-\s+(?<control>[A-Za-z_][A-Za-z0-9_]*):\s*$",
            RegexOptions.CultureInvariant);
        if (controlMatch.Success)
        {
            currentControl = controlMatch.Groups["control"].Value;
            controlIndentation = controlMatch.Groups["indent"].Value.Length;
            continue;
        }

        if (currentControl is null || string.IsNullOrWhiteSpace(line))
        {
            continue;
        }

        var indentation = line.Length - line.TrimStart().Length;
        if (indentation <= controlIndentation)
        {
            currentControl = null;
            controlIndentation = -1;
            continue;
        }

        var propertyMatch = Regex.Match(
            line,
            @"^(?<indent>\s+)(?<property>[A-Za-z_][A-Za-z0-9_]*):\s*(?<scalar>.*)$",
            RegexOptions.CultureInvariant);
        if (!propertyMatch.Success)
        {
            continue;
        }

        var scalar = propertyMatch.Groups["scalar"].Value.Trim();
        string? formula;
        // Exported canvas YAML may serialize the same formula inline, quoted, or as:
        //   OnSelect: |-
        //       =Set(varOperation, "Receive");
        // Read the indented scalar before comparing normalized Power Fx so serialization
        // style cannot make exact Action Contract evidence look absent or contradictory.
        if (Regex.IsMatch(scalar, @"^[|>]-?$", RegexOptions.CultureInvariant))
        {
            var propertyIndentation = propertyMatch.Groups["indent"].Value.Length;
            var blockLines = new List<string>();
            var blockIndex = index + 1;
            while (blockIndex < yamlLines.Length)
            {
                var blockLine = yamlLines[blockIndex];
                var blockIndentation = blockLine.Length - blockLine.TrimStart().Length;
                if (!string.IsNullOrWhiteSpace(blockLine) && blockIndentation <= propertyIndentation)
                {
                    break;
                }

                blockLines.Add(blockLine);
                blockIndex++;
            }

            var contentIndentation = blockLines
                .Where(blockLine => !string.IsNullOrWhiteSpace(blockLine))
                .Select(blockLine => blockLine.Length - blockLine.TrimStart().Length)
                .DefaultIfEmpty(propertyIndentation + 1)
                .Min();
            var content = blockLines
                .Select(blockLine =>
                    blockLine.Length >= contentIndentation
                        ? blockLine[contentIndentation..]
                        : "")
                .ToArray();
            formula = string.Join(
                scalar.StartsWith('>') ? " " : "\n",
                content).Trim();
            index = blockIndex - 1;
        }
        else
        {
            formula = DecodeYamlScalar(scalar);
        }

        if (!string.IsNullOrWhiteSpace(formula) && formula.TrimStart().StartsWith('='))
        {
            formulas.Add(new(currentControl, propertyMatch.Groups["property"].Value, formula.Trim()));
        }
    }

    return formulas;
}

static string? DecodeYamlScalar(string scalar)
{
    if (scalar.StartsWith('='))
    {
        return scalar;
    }

    if (scalar.Length >= 2 && scalar[0] == '\'' && scalar[^1] == '\'')
    {
        return scalar[1..^1].Replace("''", "'", StringComparison.Ordinal);
    }

    if (scalar.Length >= 2 && scalar[0] == '"' && scalar[^1] == '"')
    {
        try
        {
            return JsonSerializer.Deserialize<string>(scalar);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    return null;
}

static bool TryGetControlBlock(
    string[] yamlLines,
    string control,
    out string controlBlock)
{
    for (var index = 0; index < yamlLines.Length; index++)
    {
        var line = yamlLines[index];
        if (!line.TrimStart().StartsWith($"- {control}:", StringComparison.Ordinal))
        {
            continue;
        }

        var indentation = line.Length - line.TrimStart().Length;
        var block = new StringBuilder(line);
        for (var blockIndex = index + 1; blockIndex < yamlLines.Length; blockIndex++)
        {
            var blockLine = yamlLines[blockIndex];
            if (!string.IsNullOrWhiteSpace(blockLine) &&
                blockLine.Length - blockLine.TrimStart().Length <= indentation)
            {
                break;
            }

            block.Append('\n').Append(blockLine);
        }

        controlBlock = block.ToString();
        return true;
    }

    controlBlock = "";
    return false;
}

static bool ReferencesSourceField(string formula, string sourceField)
{
    var pattern = $@"(?<![A-Za-z0-9_]){Regex.Escape(sourceField)}(?![A-Za-z0-9_])";
    return Regex.IsMatch(formula, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}

static string ReadSkillVersion(string skillPath, List<string> errors)
{
    const string prefix = "version:";
    var line = File.ReadLines(skillPath)
        .FirstOrDefault(candidate => candidate.StartsWith(prefix, StringComparison.Ordinal));
    var version = line?[prefix.Length..].Trim().Trim('"', '\'');
    if (string.IsNullOrWhiteSpace(version))
    {
        errors.Add($"Canvas app skill has no frontmatter version: {skillPath}");
        return "";
    }

    return version;
}

static string PathOrValue(string value)
{
    var cleaned = Clean(value);
    return Path.IsPathFullyQualified(cleaned) ? Path.GetFullPath(cleaned).TrimEnd(Path.DirectorySeparatorChar) : cleaned;
}

static int Fail(IEnumerable<string> failures)
{
    foreach (var failure in failures)
    {
        Console.Error.WriteLine($"ERROR: {failure}");
    }

    return 1;
}

readonly record struct YamlBinding(string Control, string Property, string Formula);
readonly record struct YamlFormula(string Control, string Property, string Formula);
readonly record struct SetAssignment(string Variable, string Expression);
readonly record struct OperationSelection(
    YamlBinding Binding,
    string Variable,
    string Literal);
readonly record struct SharedFlowResolution(
    string Pair,
    string Direction,
    string Action,
    YamlBinding SelectorBinding,
    YamlBinding MutationBinding,
    string OperationVariable,
    string OperationLiteral);
readonly record struct BranchRequirement(
    string Direction,
    string SourceExpression,
    string? OperationLiteral,
    bool Mandatory);

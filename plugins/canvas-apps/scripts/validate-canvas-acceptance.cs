#:property PublishAot=false

using System.Text;
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

foreach (var row in acceptedActions.Values)
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
}

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
    else if (!NormalizeWhitespace(controlBlock).Contains(formula, StringComparison.Ordinal))
    {
        errors.Add(
            $"Required record field '{row[0]}' formula does not match control '{control}' " +
            "in final app YAML.");
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

        // The `expected=` receipt binding names the variable the receipt claims it computed
        // (e.g. `varExpectedQuantity`). We reuse it to locate the expected-value `Set(...)` so
        // the directional check can confirm that "what we claim we compute" (the expected-value
        // expression) actually equals "what we persist" (the Patch write) — catching a receipt
        // that shows correct math while the real Patch write is reversed.
        var expectedVariable = ExtractReceiptOperand(receiptBindings, "expected");

        ValidateDirectionalMutation(
            row[0],
            "receive",
            receiveMutation?.Formula,
            selectedRecordExpression,
            source,
            '+',
            oldValueOperand,
            amountOperand,
            expectedVariable);
        ValidateDirectionalMutation(
            row[0],
            "issue",
            issueMutation?.Formula,
            selectedRecordExpression,
            source,
            '-',
            oldValueOperand,
            amountOperand,
            expectedVariable);

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

void ValidateDirectionalMutation(
    string pair,
    string direction,
    string? formula,
    string selectedRecordExpression,
    string? source,
    char operatorCharacter,
    string? oldValueOperand,
    string? amountOperand,
    string? expectedVariable)
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

    var normalizedPatchArgs = NormalizeWhitespace(patchArgs);
    if (!Regex.IsMatch(normalizedPatchArgs, arithmetic, RegexOptions.CultureInvariant))
    {
        errors.Add(
            $"Directional mutation pair '{pair}' {direction} mutation must apply '{operatorCharacter}' between " +
            $"the receipt old-value operand '{oldValueOperand}' and amount operand '{amountOperand}' in its Patch write.");
    }

    // Cross-check that the receipt's claimed expected-value expression matches what the Patch
    // actually writes. This catches the inverse of the case above: a Patch write that is itself
    // internally consistent but disagrees with the expected-value the receipt advertises, i.e.
    // "what we claim we compute" != "what we actually persist".
    var patchWriteValue = ExtractPatchWriteValue(patchArgs);
    var expectedExpression = ExtractExpectedValueExpression(formula, expectedVariable);
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

// Recover the raw operand expression from a receipt binding's formula. Receipt formulas always
// begin with '=' (ParseYamlBinding enforces that), and the operand the mutation must reuse is
// everything after that leading '='. Returns null when the field is absent or empty so the
// caller can fall back to the already-reported missing-binding error instead of a false failure.
static string? ExtractReceiptOperand(Dictionary<string, YamlBinding> receiptBindings, string field)
{
    if (!receiptBindings.TryGetValue(field, out var binding))
    {
        return null;
    }

    var operand = binding.Formula.TrimStart('=').Trim();
    return string.IsNullOrWhiteSpace(operand) ? null : operand;
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

// Recover the persisted value expression from a `Patch(...)` argument list. Patch's change record
// is a record literal whose mutated column carries the write, e.g. `{Quantity: varOldQuantity - varAmount}`;
// the value is everything after the first ':' inside the outermost braces. Returns null when no
// record literal is present (e.g. a whole-record Patch) so the caller skips the cross-check rather
// than emit a false mismatch.
static string? ExtractPatchWriteValue(string? patchArgs)
{
    if (string.IsNullOrWhiteSpace(patchArgs))
    {
        return null;
    }

    var brace = patchArgs.IndexOf('{');
    if (brace < 0)
    {
        return null;
    }

    var record = ExtractBalancedGroup(patchArgs, brace + 1, '{', '}');
    if (record is null)
    {
        return null;
    }

    // `record` is `Quantity: varOldQuantity - varAmount`; the label ends at the first ':'.
    var colon = record.IndexOf(':');
    if (colon < 0)
    {
        return null;
    }

    var value = record.Substring(colon + 1).Trim();
    return string.IsNullOrWhiteSpace(value) ? null : value;
}

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

void ValidateYamlBinding(YamlBinding? binding)
{
    if (binding is null)
    {
        return;
    }

    if (!TryGetControlBlock(yamlLines, binding.Value.Control, out var controlBlock))
    {
        errors.Add($"Directional mutation binding control '{binding.Value.Control}' does not exist in app YAML.");
        return;
    }

    var actualFormula = GetPropertyFormula(controlBlock, binding.Value.Property);
    if (actualFormula is null)
    {
        errors.Add(
            $"Directional mutation binding '{binding.Value.Control}.{binding.Value.Property}' does not exist in app YAML.");
    }
    else if (!string.Equals(
        NormalizeWhitespace(actualFormula),
        NormalizeWhitespace(binding.Value.Formula),
        StringComparison.Ordinal))
    {
        errors.Add(
            $"Directional mutation binding '{binding.Value.Control}.{binding.Value.Property}' does not match final app YAML.");
    }
}

YamlBinding? ParseYamlBinding(string value, string label)
{
    var match = Regex.Match(
        Clean(value),
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
    var pairs = new[]
    {
        ("Receive/Issue", "receive", "issue"),
        ("Increase/Decrease", "increase", "decrease"),
        ("Credit/Debit", "credit", "debit"),
        ("Allocate/Release", "allocate", "release"),
        ("Check-in/Check-out", "check-in", "check-out"),
        ("Enable/Disable", "enable", "disable"),
    };
    var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var (pair, first, second) in pairs)
    {
        if (actions.Any(action => ContainsActionWord(action, first)) &&
            actions.Any(action => ContainsActionWord(action, second)))
        {
            found.Add(pair);
        }
    }

    return found;
}

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
    var match = Regex.Match(
        controlBlock,
        $@"(?m)^\s+{Regex.Escape(property)}:\s*(?<formula>=.+)$",
        RegexOptions.CultureInvariant);
    return match.Success ? match.Groups["formula"].Value.Trim() : null;
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

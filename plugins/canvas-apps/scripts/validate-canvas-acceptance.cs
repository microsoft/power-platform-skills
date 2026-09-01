#:property PublishAot=false

using System.Text;
using System.Text.Json;

if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: validate-canvas-acceptance.cs <workspace> <plugin-root>");
    return 2;
}

var workspace = Path.GetFullPath(args[0]);
var pluginRoot = Path.GetFullPath(args[1]);
var planPath = Path.Combine(workspace, "canvas-app-plan.md");
var acceptancePath = Path.Combine(workspace, "canvas-app-acceptance.md");
var manifestPath = Path.Combine(pluginRoot, ".plugin", "plugin.json");
var errors = new List<string>();

RequireFile(planPath, "plan");
RequireFile(acceptancePath, "acceptance");
RequireFile(manifestPath, "plugin manifest");

if (errors.Count > 0)
{
    return Fail(errors);
}

var planLines = File.ReadAllLines(planPath);
var acceptanceLines = File.ReadAllLines(acceptancePath);
using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
var pluginVersion = manifest.RootElement.GetProperty("version").GetString() ?? "";

if (acceptanceLines.Length == 0 || acceptanceLines[0] != "Runtime evaluation: NOT RUN")
{
    errors.Add("Acceptance line 1 must be exactly 'Runtime evaluation: NOT RUN'.");
}

RequireMetadata("Plugin root", pluginRoot);
RequireMetadata("Skill contract version", pluginVersion);
RequireMetadata("Source revision", expected: null);

var plannedActions = ReadColumn(planLines, "## Action Contracts", 0, errors);
var plannedScenarios = ReadColumn(planLines, "## Functional Test Matrix", 0, errors);
var plannedScreens = ReadColumn(planLines, "## Dispatch", 1, errors);
var acceptedActions = ReadRows(acceptanceLines, "## Action Contract Acceptance", errors);
var acceptedScenarios = ReadRows(acceptanceLines, "## Functional Test Matrix Results", errors);
var acceptedScreens = ReadRows(acceptanceLines, "## Screen QA Evidence", errors);

CompareCoverage("Action Contract", plannedActions, acceptedActions, errors);
CompareCoverage("Functional Test Matrix scenario", plannedScenarios, acceptedScenarios, errors);
CompareCoverage("dispatch screen", plannedScreens, acceptedScreens, errors);

foreach (var row in acceptedActions.Values)
{
    if (row.Count < 7)
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
    if (row.Count < 3 || !string.Equals(Clean(row[1]), "PASS", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"Scenario '{row[0]}' does not contain a passing static trace.");
    }
}

foreach (var row in acceptedScreens.Values)
{
    if (row.Count < 4 || !string.Equals(Clean(row[1]), "1-44 COMPLETE", StringComparison.OrdinalIgnoreCase))
    {
        errors.Add($"Screen '{row[0]}' does not report complete Q1-Q44 coverage.");
        continue;
    }

    if (string.IsNullOrWhiteSpace(Clean(row[2])) || string.IsNullOrWhiteSpace(Clean(row[3])))
    {
        errors.Add($"Screen '{row[0]}' must preserve repairs and N/A evidence.");
    }
}

if (errors.Count > 0)
{
    return Fail(errors);
}

Console.WriteLine(
    $"PASS: {plannedActions.Count} actions, {plannedScenarios.Count} scenarios, " +
    $"{plannedScreens.Count} screens; runtime evaluation NOT RUN.");
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

static Dictionary<string, List<string>> ReadRows(
    string[] lines,
    string heading,
    List<string> errors)
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

        var key = Clean(cells[0]);
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

static HashSet<string> ReadColumn(
    string[] lines,
    string heading,
    int column,
    List<string> errors)
{
    var rows = ReadRows(lines, heading, errors);
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

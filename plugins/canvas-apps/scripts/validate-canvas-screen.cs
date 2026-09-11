#:property PublishAot=false

using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

if (args.Length != 4)
{
    Console.Error.WriteLine(
        "Usage: validate-canvas-screen.cs <screen.pa.yaml> <screen-plan.md> " +
        "<canvas-app-shared.md> <plugin-root>");
    return 2;
}

var targetPath = Path.GetFullPath(args[0]);
var briefPath = Path.GetFullPath(args[1]);
var sharedPath = Path.GetFullPath(args[2]);
var pluginRoot = Path.GetFullPath(args[3]);
var contractPath = Path.Combine(pluginRoot, "qa-contract.json");
var errors = new List<Finding>();

RequireFile(targetPath, "screen YAML");
RequireFile(briefPath, "screen brief");
RequireFile(sharedPath, "shared plan");
RequireFile(contractPath, "QA contract");
if (errors.Count > 0)
{
    return Fail(errors);
}

QaContract? contract;
try
{
    contract = JsonSerializer.Deserialize<QaContract>(
        File.ReadAllText(contractPath),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
}
catch (Exception exception) when (exception is IOException or JsonException)
{
    errors.Add(new("QA-CONTRACT", contractPath, 1, $"Cannot read QA contract: {exception.Message}"));
    return Fail(errors);
}

if (contract is null ||
    contract.HighestCheck != 44 ||
    contract.Coverage != "1-44" ||
    contract.RequiredMarker != "QACHK-SHARED-SOURCE-DERIVATION")
{
    errors.Add(new(
        "QA-CONTRACT",
        contractPath,
        1,
        "Expected coverage 1-44 with required marker QACHK-SHARED-SOURCE-DERIVATION."));
    return Fail(errors);
}

var lines = File.ReadAllLines(targetPath);
var nodes = ParseNodes(lines);
var propertyBlocks = ParsePropertyBlocks(lines);

ValidateProperties();
ValidateNodes();
ValidateRoot();

if (errors.Count > 0)
{
    return Fail(errors);
}

Console.WriteLine(
    $"PASS: deterministic Canvas QA preflight for {Path.GetFileName(targetPath)}. " +
    "Complete the compact manual checks in references/QAChecksRuntime.md, then report " +
    "QA coverage: 1-44 COMPLETE.");
return 0;

void RequireFile(string path, string label)
{
    if (!File.Exists(path))
    {
        errors.Add(new("QA-INPUT", path, 1, $"Missing {label}: {path}"));
    }
}

void ValidateProperties()
{
    foreach (var block in propertyBlocks)
    {
        var seen = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in block.Properties)
        {
            if (seen.TryGetValue(property.Name, out var firstLine))
            {
                Add(
                    "QACHK-DUPLICATE-PROPERTY-KEY",
                    property.Line,
                    $"Property '{property.Name}' duplicates line {firstLine}; keep one intended value.");
            }
            else
            {
                seen[property.Name] = property.Line;
            }

            if (!property.IsBlock &&
                property.Value.Length > 0 &&
                !property.Value.StartsWith('=') &&
                !property.Value.StartsWith("'=", StringComparison.Ordinal) &&
                !property.Value.StartsWith("\"=", StringComparison.Ordinal))
            {
                Add(
                    "QACHK-MISSING-FORMULA-PREFIX",
                    property.Line,
                    $"Property '{property.Name}' must start with '='; quote literal text as =\"...\".");
            }

            if (property.IsBlock && !property.BlockFirstContentStartsWithEquals)
            {
                Add(
                    "QACHK-MISSING-FORMULA-PREFIX",
                    property.Line,
                    $"Block property '{property.Name}' must begin its first content line with '='.");
            }

            if (Regex.IsMatch(
                    property.Value,
                    @"(?:'[A-Za-z_][^']*'|[A-Za-z_][A-Za-z0-9_.]*)\.[0-9]+\b"))
            {
                Add(
                    "QACHK-ENUM-LITERAL",
                    property.Line,
                    $"Quote numeric enum members, for example DecimalPrecision.'1'.");
            }

            if ((property.Name.Equals("ItemDisplayText", StringComparison.OrdinalIgnoreCase) ||
                 property.Name.Equals("ItemKey", StringComparison.OrdinalIgnoreCase)) &&
                Regex.IsMatch(property.Value, "^=[\"'][^&]*[\"']$"))
            {
                Add(
                    "QACHK-ITEM-DISPLAY-TEXT",
                    property.Line,
                    $"'{property.Name}' is a constant string; bind through ThisItem or omit it for a single-column table.");
            }
        }
    }
}

void ValidateNodes()
{
    foreach (var node in nodes)
    {
        var control = node.Control;
        if (control.Length == 0)
        {
            continue;
        }

        if ((control == "GroupContainer" || control == "Gallery") &&
            string.IsNullOrWhiteSpace(node.Variant))
        {
            Add(
                "QACHK-MISSING-VARIANT",
                node.StartLine,
                $"{control} '{node.Name}' requires an explicit Variant from the screen brief.");
        }

        if (control == "GroupContainer")
        {
            RequireExact(node, "LayoutMinWidth", "=0", "QACHK-CONTAINER-MIN-SIZE");
            RequireExact(node, "LayoutMinHeight", "=0", "QACHK-CONTAINER-MIN-SIZE");
        }

        if (node.Parent is { } parent && parent.HasProperty("LayoutDirection"))
        {
            if (!node.HasProperty("FillPortions"))
            {
                Add(
                    "QACHK-FILLPORTIONS-DEFAULT",
                    node.StartLine,
                    $"AutoLayout child '{node.Name}' must set FillPortions explicitly.");
            }

            var mainSize = MainAxisSize(parent.PropertyValue("LayoutDirection"));
            var fill = node.HasProperty("FillPortions")
                ? ParseFormulaNumber(node.PropertyValue("FillPortions"))
                : 0;
            if (mainSize is not null && fill == 0 && !node.HasProperty(mainSize))
            {
                Add(
                    "QACHK-NO-HEIGHT-TRAP",
                    node.StartLine,
                    $"Fixed AutoLayout child '{node.Name}' needs an explicit {mainSize} that fits its content.");
            }

            if (mainSize is not null && fill > 0 && node.HasProperty(mainSize))
            {
                Add(
                    mainSize == "Height"
                        ? "QACHK-FILLPORTIONS-HEIGHT-CONFLICT"
                        : "QACHK-FILLPORTIONS-WIDTH-CONFLICT",
                    node.PropertyLine(mainSize),
                    $"'{node.Name}' sets FillPortions > 0 and {mainSize}; remove the explicit main-axis size.");
            }
        }

        if (node.PropertyValue("LayoutOverflowY").Contains(
                "LayoutOverflow.Scroll",
                StringComparison.OrdinalIgnoreCase))
        {
            foreach (var child in node.Children.Where(child => ParseFormulaNumber(child.PropertyValue("FillPortions")) > 0))
            {
                Add(
                    "QACHK-SCROLL-TRAP",
                    child.PropertyLine("FillPortions"),
                    $"Direct child '{child.Name}' of a scroll container must not use FillPortions > 0.");
            }
        }

        if (control is "ModernText" or "Label")
        {
            foreach (var padding in new[] { "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight" })
            {
                if (!node.HasProperty(padding))
                {
                    Add(
                        "QACHK-TEXT-PADDING",
                        node.StartLine,
                        $"Text control '{node.Name}' must set {padding} explicitly.");
                }
            }
        }

        if (control == "Gallery" &&
            (node.Children.Count > 1 || node.Children.Any(child => child.HasProperty("X") || child.HasProperty("Y"))))
        {
            Add(
                "QACHK-GALLERY-TEMPLATE-LAYOUT",
                node.StartLine,
                $"Gallery '{node.Name}' must use one direct row shell without absolute X/Y positioning.");
        }

        if (control is "GroupContainer" or "Gallery" &&
            TryParseFormulaNumber(node.PropertyValue("Width"), out var width) &&
            width > 400)
        {
            Add(
                "QACHK-FIXED-LAYOUT-WIDTH",
                node.PropertyLine("Width"),
                $"Layout control '{node.Name}' uses fixed width {width}; use Parent, Self, App, or AutoLayout sizing.");
        }

        if (control == "ModernCard" && !node.HasProperty("Image"))
        {
            Add(
                "QACHK-CARD-PLACEHOLDER",
                node.StartLine,
                $"ModernCard '{node.Name}' must set Image explicitly; use =Blank() for a text-only card.");
        }

        if (control == "GroupContainer" &&
            node.Variant.Equals("GridLayout", StringComparison.OrdinalIgnoreCase))
        {
            foreach (var property in new[]
                     {
                         "LayoutGridColumns",
                         "LayoutGridRows",
                         "LayoutGridColumnMinWidth",
                         "LayoutGridRowMinHeight",
                         "Height"
                     })
            {
                if (!node.HasProperty(property))
                {
                    Add(
                        "QACHK-GRID-CONTRACT",
                        node.StartLine,
                        $"GridLayout '{node.Name}' is missing required property '{property}'.");
                }
            }
        }

        if (IsInteractive(control) &&
            node.Ancestors().Any(ancestor =>
                ancestor.PropertyValue("DisplayMode").Contains("DisplayMode.View", StringComparison.OrdinalIgnoreCase) ||
                ancestor.PropertyValue("DisplayMode").Contains("DisplayMode.Disabled", StringComparison.OrdinalIgnoreCase)))
        {
            Add(
                "QACHK-READ-ONLY-ANCESTOR",
                node.StartLine,
                $"Interactive control '{node.Name}' is nested under a read-only ancestor.");
        }
    }
}

void ValidateRoot()
{
    var roots = nodes.Where(node => node.Parent is null).ToList();
    if (roots.Count == 0)
    {
        return;
    }

    var responsiveRoot = roots.FirstOrDefault(node =>
        node.Control == "GroupContainer" &&
        node.Variant.Equals("AutoLayout", StringComparison.OrdinalIgnoreCase));
    if (responsiveRoot is null)
    {
        return;
    }

    if (roots.Count != 1)
    {
        Add(
            "QACHK-ROOT-CONTAINMENT",
            responsiveRoot.StartLine,
            "A responsive screen must contain exactly one screen-level root control.");
    }

    RequireExact(responsiveRoot, "Width", "=Parent.Width", "QACHK-ROOT-CONTAINMENT");
    RequireExact(responsiveRoot, "Height", "=Parent.Height", "QACHK-ROOT-CONTAINMENT");
    RequireExact(responsiveRoot, "LayoutMinWidth", "=0", "QACHK-ROOT-CONTAINMENT");
    RequireExact(responsiveRoot, "LayoutMinHeight", "=0", "QACHK-ROOT-CONTAINMENT");
}

void RequireExact(Node node, string property, string expected, string check)
{
    if (!node.HasProperty(property))
    {
        Add(check, node.StartLine, $"'{node.Name}' must set {property}: {expected}.");
        return;
    }

    if (!string.Equals(node.PropertyValue(property), expected, StringComparison.OrdinalIgnoreCase))
    {
        Add(check, node.PropertyLine(property), $"'{node.Name}' must set {property}: {expected}.");
    }
}

void Add(string check, int line, string message) =>
    errors.Add(new(check, targetPath, line, message));

int Fail(IEnumerable<Finding> findings)
{
    foreach (var finding in findings
                 .OrderBy(finding => finding.Path, StringComparer.OrdinalIgnoreCase)
                 .ThenBy(finding => finding.Line)
                 .ThenBy(finding => finding.Check, StringComparer.Ordinal))
    {
        Console.Error.WriteLine(
            $"{finding.Check} {finding.Path}:{finding.Line}: {finding.Message}");
    }

    Console.Error.WriteLine("FAIL: repair every finding, then rerun the deterministic preflight.");
    return 1;
}

static List<PropertyBlock> ParsePropertyBlocks(string[] source)
{
    var result = new List<PropertyBlock>();
    for (var index = 0; index < source.Length; index++)
    {
        if (!TryMapping(source[index], out var indent, out var key, out _) ||
            !key.Equals("Properties", StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        var properties = new List<PropertyEntry>();
        var directPropertyIndent = -1;
        for (var cursor = index + 1; cursor < source.Length; cursor++)
        {
            if (string.IsNullOrWhiteSpace(source[cursor]) || source[cursor].TrimStart().StartsWith('#'))
            {
                continue;
            }

            var currentIndent = LeadingSpaces(source[cursor]);
            if (currentIndent <= indent)
            {
                break;
            }

            if (!TryMapping(source[cursor], out var propertyIndent, out var propertyName, out var value) ||
                propertyIndent <= indent)
            {
                continue;
            }

            directPropertyIndent = directPropertyIndent < 0 ? propertyIndent : directPropertyIndent;
            if (propertyIndent != directPropertyIndent)
            {
                continue;
            }

            var isBlock = value is "|-" or "|" or ">-" or ">";
            var blockStartsWithEquals = true;
            if (isBlock)
            {
                blockStartsWithEquals = false;
                for (var blockLine = cursor + 1; blockLine < source.Length; blockLine++)
                {
                    if (string.IsNullOrWhiteSpace(source[blockLine]))
                    {
                        continue;
                    }

                    if (LeadingSpaces(source[blockLine]) <= propertyIndent)
                    {
                        break;
                    }

                    blockStartsWithEquals = source[blockLine].TrimStart().StartsWith('=');
                    break;
                }
            }

            properties.Add(new(
                propertyName,
                value.Trim(),
                cursor + 1,
                isBlock,
                blockStartsWithEquals));
        }

        result.Add(new(index + 1, properties));
    }

    return result;
}

static List<Node> ParseNodes(string[] source)
{
    var nodes = new List<Node>();
    var stack = new Stack<Node>();
    for (var index = 0; index < source.Length; index++)
    {
        var match = Regex.Match(source[index], @"^(?<indent>\s*)-\s+(?<name>[^:]+):\s*$");
        if (!match.Success)
        {
            continue;
        }

        var indent = match.Groups["indent"].Value.Length;
        while (stack.Count > 0 && stack.Peek().Indent >= indent)
        {
            stack.Pop();
        }

        var node = new Node(match.Groups["name"].Value.Trim(), index + 1, indent)
        {
            Parent = stack.Count > 0 ? stack.Peek() : null
        };
        node.Parent?.Children.Add(node);
        nodes.Add(node);
        stack.Push(node);
    }

    foreach (var node in nodes)
    {
        var end = source.Length;
        for (var index = node.StartLine; index < source.Length; index++)
        {
            if (index + 1 > node.StartLine &&
                !string.IsNullOrWhiteSpace(source[index]) &&
                LeadingSpaces(source[index]) <= node.Indent)
            {
                end = index;
                break;
            }
        }

        var directKeyIndent = -1;
        var propertiesIndent = -1;
        var propertyValueIndent = -1;
        for (var index = node.StartLine; index < end; index++)
        {
            if (!TryMapping(source[index], out var indent, out var key, out var value))
            {
                continue;
            }

            if (indent <= node.Indent)
            {
                continue;
            }

            directKeyIndent = directKeyIndent < 0 ? indent : directKeyIndent;
            if (indent == directKeyIndent &&
                key.Equals("Control", StringComparison.OrdinalIgnoreCase) &&
                node.Control.Length == 0)
            {
                node.Control = value.Trim();
            }
            else if (indent == directKeyIndent &&
                     key.Equals("Variant", StringComparison.OrdinalIgnoreCase) &&
                     node.Variant.Length == 0)
            {
                node.Variant = value.Trim();
            }
            else if (indent == directKeyIndent &&
                     key.Equals("Properties", StringComparison.OrdinalIgnoreCase))
            {
                propertiesIndent = indent;
                propertyValueIndent = -1;
            }
            else if (propertiesIndent >= 0 &&
                     indent > propertiesIndent)
            {
                propertyValueIndent = propertyValueIndent < 0 ? indent : propertyValueIndent;
                if (indent == propertyValueIndent &&
                    !node.Properties.ContainsKey(key))
                {
                    node.Properties[key] = new(value.Trim(), index + 1);
                }
            }

            if (propertiesIndent >= 0 &&
                indent <= propertiesIndent &&
                !key.Equals("Properties", StringComparison.OrdinalIgnoreCase))
            {
                propertiesIndent = -1;
                propertyValueIndent = -1;
            }
        }
    }

    return nodes;
}

static bool TryMapping(string line, out int indent, out string key, out string value)
{
    var match = Regex.Match(line, @"^(?<indent>\s*)(?:-\s+)?(?<key>[^:#][^:]*):(?<value>.*)$");
    if (!match.Success)
    {
        indent = 0;
        key = "";
        value = "";
        return false;
    }

    indent = match.Groups["indent"].Value.Length;
    key = match.Groups["key"].Value.Trim();
    value = match.Groups["value"].Value.Trim();
    return true;
}

static int LeadingSpaces(string value)
{
    var count = 0;
    while (count < value.Length && value[count] == ' ')
    {
        count++;
    }

    return count;
}

static double ParseFormulaNumber(string value) =>
    TryParseFormulaNumber(value, out var number) ? number : double.NaN;

static bool TryParseFormulaNumber(string value, out double number)
{
    value = value.Trim().TrimStart('=');
    return double.TryParse(value, NumberStyles.Number, CultureInfo.InvariantCulture, out number);
}

static bool IsInteractive(string control) =>
    control.Contains("Button", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("Input", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("Dropdown", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("Combo", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("Toggle", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("Checkbox", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("Radio", StringComparison.OrdinalIgnoreCase) ||
    control.Contains("DatePicker", StringComparison.OrdinalIgnoreCase) ||
    control is "Timer";

static string? MainAxisSize(string layoutDirection) =>
    layoutDirection.Trim() switch
    {
        "=LayoutDirection.Horizontal" => "Width",
        "=LayoutDirection.Vertical" => "Height",
        _ => null
    };

sealed record Finding(string Check, string Path, int Line, string Message);
sealed record PropertyBlock(int Line, List<PropertyEntry> Properties);
sealed record PropertyEntry(
    string Name,
    string Value,
    int Line,
    bool IsBlock,
    bool BlockFirstContentStartsWithEquals);
sealed record PropertyValue(string Value, int Line);
sealed class Node(string name, int startLine, int indent)
{
    public string Name { get; } = name;
    public int StartLine { get; } = startLine;
    public int Indent { get; } = indent;
    public string Control { get; set; } = "";
    public string Variant { get; set; } = "";
    public Node? Parent { get; set; }
    public List<Node> Children { get; } = [];
    public Dictionary<string, PropertyValue> Properties { get; } =
        new(StringComparer.OrdinalIgnoreCase);

    public bool HasProperty(string name) => Properties.ContainsKey(name);
    public string PropertyValue(string name) =>
        Properties.TryGetValue(name, out var property) ? property.Value : "";
    public int PropertyLine(string name) =>
        Properties.TryGetValue(name, out var property) ? property.Line : StartLine;
    public IEnumerable<Node> Ancestors()
    {
        for (var current = Parent; current is not null; current = current.Parent)
        {
            yield return current;
        }
    }
}

sealed class QaContract
{
    public string Coverage { get; init; } = "";
    public int HighestCheck { get; init; }
    public string RequiredMarker { get; init; } = "";
}

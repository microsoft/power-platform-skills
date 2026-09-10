using System.Text.Json;

internal static class Program
{
    private const string MarketplaceName = "power-platform-skills";
    private const string DefaultManifestUrl =
        "https://raw.githubusercontent.com/microsoft/power-platform-skills/main/plugins/canvas-apps/.plugin/plugin.json";

    private static async Task<int> Main(string[] args)
    {
        try
        {
            return await CheckVersion(args);
        }
        catch (Exception)
        {
            // Version discovery is advisory and must never block MCP configuration.
            return 0;
        }
    }

    private static async Task<int> CheckVersion(string[] args)
    {
        string pluginRoot = GetRequiredOption(args, "--plugin-root");
        string manifestUrl = GetOption(args, "--manifest-url") ?? DefaultManifestUrl;
        PluginManifest local = ReadManifest(
            Path.Combine(pluginRoot, ".plugin", "plugin.json")
        );

        using var httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(5),
        };
        string remoteJson = await httpClient.GetStringAsync(manifestUrl);
        PluginManifest remote = ParseManifest(remoteJson);

        if (CompareVersions(local.Version, remote.Version) >= 0)
        {
            return 0;
        }

        Console.WriteLine(
            $"Plugin update available: {local.Name} {local.Version} -> {remote.Version}."
        );
        WriteUpdateCommands(local.Name);

        return 0;
    }

    private static void WriteUpdateCommands(string pluginName)
    {
        string? cli = DetectPluginCli();
        if (cli is not null)
        {
            Console.WriteLine("Run:");
            WriteUpdateCommands(cli, pluginName, "  ");
            return;
        }

        Console.WriteLine("Run the commands for your CLI:");
        Console.WriteLine("  Claude Code:");
        WriteUpdateCommands("claude", pluginName, "    ");
        Console.WriteLine("  GitHub Copilot CLI:");
        WriteUpdateCommands("copilot", pluginName, "    ");
    }

    private static void WriteUpdateCommands(string cli, string pluginName, string indent)
    {
        Console.WriteLine($"{indent}{cli} plugin marketplace update {MarketplaceName}");
        Console.WriteLine(
            $"{indent}{cli} plugin update {pluginName}@{MarketplaceName}"
        );
    }

    private static string? DetectPluginCli()
    {
        // Match the host detection contract used by shared telemetry. Claude
        // wins if both markers are present, which avoids ambiguous instructions.
        if (IsTruthyEnvironmentVariable("CLAUDECODE"))
        {
            return "claude";
        }

        return IsTruthyEnvironmentVariable("COPILOT_CLI") ? "copilot" : null;
    }

    private static bool IsTruthyEnvironmentVariable(string name)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (value is null)
        {
            return false;
        }

        string normalized = value.Trim().ToLowerInvariant();
        return normalized is not ("" or "0" or "false");
    }

    private static PluginManifest ReadManifest(string path) =>
        ParseManifest(File.ReadAllText(path));

    private static PluginManifest ParseManifest(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        return new PluginManifest(
            root.GetProperty("name").GetString()
                ?? throw new InvalidDataException("Plugin name is missing."),
            root.GetProperty("version").GetString()
                ?? throw new InvalidDataException("Plugin version is missing.")
        );
    }

    private static string GetRequiredOption(string[] args, string option) =>
        GetOption(args, option)
        ?? throw new ArgumentException($"Missing required option: {option}");

    private static string? GetOption(string[] args, string option)
    {
        for (int index = 0; index < args.Length - 1; index++)
        {
            if (args[index] == option)
            {
                return args[index + 1];
            }
        }

        return null;
    }

    private static int CompareVersions(string left, string right)
    {
        string[] leftSegments = left.Split('.');
        string[] rightSegments = right.Split('.');
        int segmentCount = Math.Max(leftSegments.Length, rightSegments.Length);

        for (int index = 0; index < segmentCount; index++)
        {
            int leftSegment = ParseSegment(leftSegments, index, left);
            int rightSegment = ParseSegment(rightSegments, index, right);
            int comparison = leftSegment.CompareTo(rightSegment);
            if (comparison != 0)
            {
                return comparison;
            }
        }

        return 0;
    }

    private static int ParseSegment(string[] segments, int index, string version)
    {
        if (index >= segments.Length)
        {
            return 0;
        }

        return int.TryParse(segments[index], out int value)
            ? value
            : throw new FormatException($"Invalid plugin version: {version}");
    }

    private sealed record PluginManifest(string Name, string Version);
}

#:property PublishAot=false

using System.Text.Json;

// Prompt hook for the canvas-apps plugin.
//
// The hook injects guidance instead of calling sync_canvas directly because it only
// receives the session cwd, not the per-app working directory. A blanket sync could
// overwrite the wrong directory or clobber local edits that have not been pushed.
const string Reminder =
    "Canvas Apps coauthoring reminder: " +
    "Before acting on this request, if a Canvas Authoring session is " +
    "active (i.e. `connect` has already been called for a canvas app), first call " +
    "the `sync_canvas` MCP tool targeting the app's working directory to pull the " +
    "current session state into the local .pa.yaml files. This avoids editing stale " +
    "YAML. If no coauthoring session is active yet, or this request is unrelated to " +
    "a canvas app, skip the sync.";

try
{
    var rawInput = await Console.In.ReadToEndAsync();
    string? transformedPrompt = null;

    try
    {
        using var input = JsonDocument.Parse(rawInput);
        if (input.RootElement.ValueKind == JsonValueKind.Object &&
            input.RootElement.TryGetProperty("transformedPrompt", out var prompt) &&
            prompt.ValueKind == JsonValueKind.String)
        {
            transformedPrompt = prompt.GetString();
        }
    }
    catch (JsonException)
    {
        // Hook failures must not block the user's prompt. Preserve the previous
        // behavior by falling back to Claude's additional-context response.
    }

    using var writer = new Utf8JsonWriter(Console.OpenStandardOutput());
    writer.WriteStartObject();

    if (transformedPrompt is not null)
    {
        writer.WriteString(
            "modifiedTransformedPrompt",
            $"{transformedPrompt}\n\n{Reminder}");
    }
    else
    {
        writer.WriteStartObject("hookSpecificOutput");
        writer.WriteString("hookEventName", "UserPromptSubmit");
        writer.WriteString("additionalContext", Reminder);
        writer.WriteEndObject();
    }

    writer.WriteEndObject();
    writer.Flush();
}
catch
{
    // Hooks are advisory and must never prevent the host from processing a prompt.
}

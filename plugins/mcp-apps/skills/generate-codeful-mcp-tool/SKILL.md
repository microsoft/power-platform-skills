---
name: generate-codeful-mcp-tool
version: 1.0.0
description: >
  Generate a self-contained JavaScript server runtime and registration metadata
  for an MCP codeful tool.
  Use when the user asks to create a codeful MCP tool, generate server logic for
  an MCP tool, write a runTool function, build a Dataverse-backed MCP tool, or
  pair MCP server logic with an MCP App widget.
author: Microsoft Corporation
argument-hint: <tool purpose, inputs, and expected result>
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
---

**Triggers:** codeful MCP tool, MCP server tool, generate runTool, MCP tool JavaScript,
Dataverse MCP tool, server logic for MCP App

**Keywords:** mcp apps, codeful tool, runTool, dataApi, Dataverse, server runtime

**Aliases:** /generate-codeful-mcp-tool, /codeful-tool

**References:**
- Host API types: [codeful-tool-host-data-api.d.ts](../../references/codeful-tool-host-data-api.d.ts)
- Known-good tool: [account-summary.tool.js](../../samples/account-summary.tool.js)
- Known-good metadata: [account-summary.tool.json](../../samples/account-summary.tool.json)
- Widget generation: [generate-mcp-app-ui](../generate-mcp-app-ui/SKILL.md)

---

You generate a matched pair of files for one MCP tool:

- `<tool-name>.tool.js`: the complete JavaScript server implementation.
- `<tool-name>.tool.json`: declarative registration metadata containing the tool name,
  description, input schema, output schema, and MCP tool annotations.

The host imports the JavaScript module and calls:

```javascript
await runTool({ toolInput, dataApi });
```

## Required information

Before generating, establish:

1. The tool's purpose and kebab-case tool name. Use the purpose to write a concise,
   model-actionable tool description; ask only when the intended behavior is ambiguous.
2. Its input fields, types, required fields, and constraints. Accept a JSON Schema, a
   representative input object, or an exact field description. Never guess the input shape.
3. The expected result, preferably as a representative output object.
4. Whether it reads or writes Dataverse, the requested tables in business terms, and
   whether any write creates, appends, updates, overwrites, or deletes state.
5. Whether the user also wants an MCP App widget.

Ask only for information that is missing. A sample input/output is preferred but not
mandatory when the user has supplied an equally precise contract.

## Phase 1: Read the runtime and metadata contracts

Read:

```text
${PLUGIN_ROOT}/references/codeful-tool-host-data-api.d.ts
${PLUGIN_ROOT}/samples/account-summary.tool.js
${PLUGIN_ROOT}/samples/account-summary.tool.json
```

The generated runtime is plain ESM JavaScript, and the sidecar is plain JSON. Type files
are generation-time references only and MUST NOT be imported by the output.

## Phase 2: Verify Dataverse schema when needed

Skip this phase when the tool does not use Dataverse.

For a Dataverse-backed tool:

1. Confirm PAC CLI is authenticated to the intended environment.
2. Discover candidate tables:

   ```powershell
   pac model list-tables --search "table terms"
   ```

   `--search` is substring-based. Post-filter its output and accept a table only when its
   logical name exactly matches the selected result. If multiple tables remain plausible,
   ask the user to choose.
3. Create a unique temporary directory outside the final output path and generate types:

   ```powershell
   pac model genpage generate-types --data-sources "logical1,logical2" --output-file "<temp>/RuntimeTypes.ts"
   ```

4. Read `RuntimeTypes.ts`. Extract the registered tables, exact readable/writable logical
   columns, lookup shapes, choice names, and raw numeric choice values.
5. Use ONLY names and values verified in that file. Custom columns are unpredictable; do
   not derive them from display names.

If discovery or type generation fails, stop and report the error. Do not fall back to
invented tables or columns. Delete the temporary types and directory after validation so
the final output contains only the requested `.tool.js`, `.tool.json`, and optional
widget files.

## Phase 3: Generate the paired tool artifacts

Write `<tool-name>.tool.js` and `<tool-name>.tool.json` in the user's working directory
unless they requested another output directory. Both files MUST use the same basename,
which MUST equal the confirmed kebab-case tool name.

The JavaScript file MUST:

- Export exactly one MCP entry point named `runTool`, preferably:

  ```javascript
  export async function runTool({ toolInput, dataApi }) {
    // complete implementation
  }
  ```

- Be self-contained JavaScript with no runtime imports, packages, network calls,
  filesystem access, environment-variable access, or generated-type dependency.
- Validate all externally supplied `toolInput` before using it. Apply bounds to counts and
  escape values interpolated into OData filters.
- Use singular Dataverse entity logical names. Use exact logical column names in `select`,
  `filter`, `orderBy`, and row objects.
- Read choice and lookup labels from
  `"<column>@OData.Community.Display.V1.FormattedValue"`.
- Access query rows through `page.rows`. Follow `page.loadMoreRows()` only while
  `page.hasMoreRows` is true and the function exists.
- Set lookups through the verified `_<field>_value` shape from `RuntimeTypes.ts`; never
  emit raw Web API `@odata.bind` keys.
- Let `dataApi` failures throw. Catch only when adding useful context, and rethrow with the
  original error as the cause. Never return a success-shaped fallback after a failed read
  or write.
- Contain no placeholders, TODOs, ellipses, test credentials, or real environment IDs.
- Return JSON-serializable values only. Never return `loadMoreRows`, functions, class
  instances, or cyclic objects.
- Emit telemetry only when the user explicitly asks for it, and never include tool inputs,
  row contents, identifiers, or other user data in telemetry properties.

The JSON sidecar MUST be valid JSON with exactly these top-level fields:

```json
{
  "name": "account-summary",
  "description": "Search accounts and return revenue and status summaries.",
  "annotations": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inputSchema": {
    "type": "object",
    "properties": {}
  },
  "outputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

- `name`: exactly the confirmed tool name and the shared file basename.
- `description`: concise, model-actionable guidance explaining what the tool does and when
  to call it. Do not copy the user's prompt verbatim or include implementation details.
- `annotations`: MCP
  [`ToolAnnotations`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)
  describing the tool's behavior. Always emit all four boolean hints:
  - `readOnlyHint`: `true` only when the tool cannot modify Dataverse or any other state.
  - `destructiveHint`: `true` when the tool may delete, overwrite, or otherwise cause a
    destructive update. Set it to `false` for read-only tools and non-destructive creates
    or additive writes.
  - `idempotentHint`: `true` when repeated calls with the same valid input have no
    additional effect. Reads, deterministic calculations, and updates that set the same
    values are idempotent; creates and append-style operations are not.
  - `openWorldHint`: always `false` because the codeful runtime cannot access arbitrary
    external systems.
  Infer these values from the generated implementation and requested behavior. If the
  write semantics are genuinely ambiguous, ask before generating rather than guessing.
  Treat annotations as advisory metadata, not as a substitute for runtime validation or
  authorization.
- `inputSchema`: the complete JSON Schema for `toolInput`. Use an object root, list every
  accepted field under `properties`, identify required fields with `required`, encode
  runtime constraints such as bounds, formats, enums, and array item shapes, and set
  `additionalProperties: false` unless the user explicitly requires extensible input.
- `outputSchema`: the JSON Schema for the model-visible `structuredContent` business
  payload. For a plain-object return, describe the complete returned object because the
  host promotes it to `structuredContent`. For an envelope return, describe only its
  `structuredContent` property. Never include `content`, authored `meta`, or runtime
  `_meta` in `outputSchema`.

Use standard JSON Schema keywords only. Do not include credentials, environment
identifiers, Dataverse discovery artifacts, host configuration, JavaScript expressions,
comments, or placeholders in the sidecar.

## Result-channel contract

Choose the smallest correct result shape.

### Simple structured result

Return a plain object when all useful output belongs in model-visible structured data:

```javascript
return { records, totalCount: records.length };
```

The host promotes that object to MCP `structuredContent`.

### Partitioned MCP result

Return an envelope when the channels have different audiences:

```javascript
return {
  content: `Found ${records.length} records.`,
  structuredContent: { records },
  meta: { preferredView: "table" },
};
```

- `content`: model-visible conversational text, either a string or text content blocks.
- `structuredContent`: model-visible machine-readable object.
- `meta`: widget-only object. The host maps it to MCP `_meta`; widgets read `result._meta`.

The names `content`, `structuredContent`, and `meta` are reserved envelope keys. If a
business payload naturally has any of those keys, wrap the whole payload explicitly:

```javascript
return { structuredContent: businessPayload };
```

Do not mix envelope keys with unrelated top-level business fields.

## Phase 4: Validate

Before reporting completion:

1. Confirm exactly one final `.tool.js` and one matching `.tool.json` were created for
   this skill.
2. Import the file as an ESM data URL with Node.js and assert that `runTool` is a function.
   Importing MUST NOT execute data access or other top-level side effects.
3. Parse the sidecar with `JSON.parse`. Confirm it has exactly `name`, `description`,
   `annotations`, `inputSchema`, and `outputSchema`; the name matches both filenames;
   all four annotation hints are booleans, `openWorldHint` is `false`, the other hints
   match the implementation's actual behavior, both schemas have object roots, and every
   input constraint enforced by the runtime is represented in `inputSchema`.
4. Grep the output for imports, `require`, placeholders, guessed columns, and unsupported
   host access.
5. When representative input/output was supplied, invoke `runTool` with an in-memory mock
   `dataApi` from an inline Node script. Do not create a persistent test file.
6. Confirm the returned value matches the requested result contract, contains no
   functions or non-serializable values, and its structured payload conforms to
   `outputSchema`. Confirm the representative input conforms to `inputSchema`.
7. Delete all temporary schema artifacts.

## Optional MCP App handoff

When the user asks for a widget:

1. Finish and validate the paired `.tool.js` and `.tool.json` first.
2. Build a representative result sample:
   - Plain tool return -> treat it as `structuredContent`.
   - Envelope return -> pass `content`, `structuredContent`, and `_meta` (renamed from the
     authored `meta` field).
3. Invoke `generate-mcp-app-ui` with the visual requirements, tool name, input sample, and
   representative full result. Forward an explicit CDN policy from the user's request.
   If none was supplied, let the UI skill ask its required CDN-policy question; do not
   assume public URLs are allowed.
4. Keep the outputs separate: one `.tool.js`, one `.tool.json`, and one single-file
   `.html` using the selected CDN policy.

## Refinement

When editing an existing codeful tool, read both paired files and change only the
requested behavior. Keep runtime validation and metadata schemas synchronized. Re-run
schema verification if the edit introduces a table, column, lookup, or choice value not
already verified for the file.

## Completion response

State both generated tool file paths and summarize the description, tool annotations,
input contract, and structured result contract. If a widget was requested, also state the
HTML path and which result channels it consumes.

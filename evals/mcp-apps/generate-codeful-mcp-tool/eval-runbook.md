# Eval Runbook for generate-codeful-mcp-tool

Evaluate the skill in three layers. Run the smoke tier on every relevant change and the
full tier before release.

## Related files

- **Skill:** `plugins/mcp-apps/skills/generate-codeful-mcp-tool/SKILL.md`
- **Host contract:** `plugins/mcp-apps/references/codeful-tool-host-data-api.d.ts`
- **Known-good sample:** `plugins/mcp-apps/samples/account-summary.tool.js`
- **Known-good metadata:** `plugins/mcp-apps/samples/account-summary.tool.json`
- **Eval definitions:** `evals.json`

## Eval data

Each case contains:

- `prompt`: the user request passed to the skill;
- `input_sample`: representative `toolInput`;
- `dataverse`: tables and columns the schema-discovery phase must verify, when applicable;
- `expected_result_sample`: an expected result shape, when result-channel behavior matters;
- `assertions`: behavior specific to that case.

Apply every `common_assertions` entry to every generated tool pair.

## Layer 1: Static source assertions

Inspect the generated output and verify:

1. Exactly one final `.tool.js` and one matching `.tool.json` exist.
2. The module exports an async `runTool({ toolInput, dataApi })`.
3. The sidecar parses as JSON, contains exactly `name`, `description`, `inputSchema`, and
   `outputSchema`, and its name matches both file basenames.
4. The description is concise and model-actionable. Both schemas have object roots;
   `inputSchema` captures all accepted fields and constraints; and `outputSchema`
   describes only the `structuredContent` business payload.
5. There are no imports, `require` calls, package references, host transports, direct HTTP,
   filesystem calls, environment reads, or top-level side effects.
6. Input validation occurs before data access.
7. Every Dataverse table, column, lookup, and choice value appears in the generated
   `RuntimeTypes.ts` used during the run.
8. Queries use `page.rows`; pagination guards both `hasMoreRows` and `loadMoreRows`.
9. Result objects follow either the plain-object or intentional-envelope contract.
10. Reserved business keys are wrapped in `structuredContent`.
11. There are no placeholders, credentials, real environment identifiers, or temporary
   schema files.

## Layer 2: Execute with a mock dataApi

Use Node.js built-ins only. Import the generated source as an ESM data URL, assert
`typeof runTool === "function"`, and call it with the eval's `input_sample` plus an
in-memory `dataApi` mock.

The mock should:

- record every operation and argument;
- return the rows/pages required by the case;
- provide `loadMoreRows` only when another page exists;
- throw a known error for failure-path cases;
- reject unexpected method calls.

Assert:

- representative valid input conforms to `inputSchema`;
- representative invalid input is rejected by `inputSchema` and the runtime;
- calls use the expected singular table names and exact options;
- invalid input produces no data API calls;
- pagination stops at the requested bound;
- result values are JSON-serializable;
- the plain return or envelope `structuredContent` conforms to `outputSchema`;
- `outputSchema` excludes result-channel transport fields while retaining any same-named
  business fields nested inside the structured payload;
- errors reject with actionable messages;
- plain objects match the expected structured payload;
- envelopes partition `content`, `structuredContent`, and `meta` correctly.

Do not save the harness beside the generated tool. Run it inline or from a disposable
temporary location, then remove it.

## Layer 3: Requirement and safety review

Score each output from 1-5 on:

| Dimension | Question |
| --- | --- |
| Requirement fidelity | Does the implementation perform exactly the requested tool behavior? |
| Input safety | Are types, required fields, bounds, GUIDs, and OData strings validated? |
| Schema safety | Are all Dataverse names and values verified instead of inferred? |
| Runtime compatibility | Is the file self-contained ESM with the exact host entry point? |
| Metadata contract | Does the sidecar accurately describe the tool and match runtime validation and structured output? |
| Result visibility | Is data placed intentionally in model-visible or widget-private channels? |
| Error behavior | Do failures throw without leaking internals or pretending success? |
| UI handoff | When requested, does the widget receive the normalized complete result? |

A case passes when all static and execution assertions pass and no review dimension scores
below 4.

## Tiers

| Tier | Cases | Purpose |
| --- | ---: | --- |
| `smoke` | 3 | Plain result, Dataverse read, and server-plus-widget composition |
| `full` | 5 | Writes, pagination, reserved keys, failures, and lookups |

## Recording results

For each run, record the eval id, generated runtime and sidecar names, assertion failures,
runtime error output, review scores, and whether temporary schema artifacts were removed.
Do not commit generated eval outputs or environment-specific `RuntimeTypes.ts` files.

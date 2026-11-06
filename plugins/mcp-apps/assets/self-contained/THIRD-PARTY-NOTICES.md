# Third-party notices

`mcp-app-runtime.min.js` is generated from these direct packages:

- `@modelcontextprotocol/ext-apps` 1.7.5
- `@fluentui/tokens` 1.0.0-alpha.22

The peer-dependent `@modelcontextprotocol/ext-apps` entry and Fluent token build also include their runtime dependencies.
The SDK and Zod are bundled from the installed lockfile rather than upstream's `app-with-deps` distribution:

- `@modelcontextprotocol/sdk` 1.32.1
- `@standard-schema/spec`
- `@swc/helpers`
- `zod` 4.6.7
- `zod-to-json-schema` 3.25.2

The license texts distributed by those packages are preserved in [`licenses/`](licenses/):

| Package | License file |
| --- | --- |
| `@modelcontextprotocol/ext-apps` | [`modelcontextprotocol-ext-apps.txt`](licenses/modelcontextprotocol-ext-apps.txt) |
| `@modelcontextprotocol/sdk` | [`modelcontextprotocol-sdk.txt`](licenses/modelcontextprotocol-sdk.txt) |
| `@fluentui/tokens` | [`fluentui-tokens.txt`](licenses/fluentui-tokens.txt) |
| `@standard-schema/spec` | [`standard-schema-spec.txt`](licenses/standard-schema-spec.txt) |
| `@swc/helpers` | [`swc-helpers.txt`](licenses/swc-helpers.txt) |
| `zod` | [`zod.txt`](licenses/zod.txt) |
| `zod-to-json-schema` | [`zod-to-json-schema.txt`](licenses/zod-to-json-schema.txt) |

See [`PROVENANCE.json`](PROVENANCE.json) and
`scripts/_vendor-build/package-lock.json` for pinned direct build inputs and integrity
hashes. The same license texts are embedded in `mcp-app-runtime.min.js` so every generated
single-file widget carries the notices required for redistribution.

# Existing connector selection

## Read-only catalogue contract

`list-prototype-connections.js` works before initialization and emits:

```json
{
  "schemaVersion": 1,
  "kind": "connector",
  "environmentId": "<explicit-environment-id>",
  "references": "not-requested",
  "items": [],
  "catalogRevision": "<sha256>"
}
```

Items are actual minimal provider projections, never fabricated catalogue entries.
Connection items contain `apiId`, `connectionId`, `displayName`, `availability`
and a stable opaque `id`. Reference items contain `connectionRef` and the
verified `boundConnectionId`; unavailable/unbound references are not selectable.
No owner email, credential, connection parameter bag, or account detail is
included. This helper currently targets the commercial Power Platform API;
do not silently route a sovereign environment through it.

The connection reader uses the environment-sharded PPAPI
`GET /connectivity/connections?api-version=1` (or its exact connector-scoped
variant), with an explicit `https://api.powerplatform.com` token audience.
Optional references use GET on the same selected environment's Dataverse
`connectionreferences`. Environment resolution is explicitly `noCache: true`,
so listing does not rewrite app auth/configuration. No POST/PATCH/DELETE or
create/repair fallback exists in this reader.

## Selection contract and skill arguments

The exact normalized selection is:

```json
{
  "kind": "connector",
  "apiId": "<catalogue-api-id>",
  "environmentId": "<catalogue-environment-id>",
  "catalogRevision": "<catalogue-sha256>",
  "connectionId": "<existing-id>"
}
```

`connectionRef` may replace `connectionId`; exactly one key is allowed. Both,
neither, null substitutes, stale revisions and unavailable selections fail.
Use `lib/prototype-connections.validateConnectorSelection(catalog, selection)`;
its `discoveryConnectionId` is the exact selected connection or the selected
reference's verified bound connection.

Invoke `/add-connector` or `/add-sharepoint` with:

```text
--existing-only --environment-id <id> --api-id <api>
--catalog-revision <sha256> --connection-id <id>
```

or the same arguments with `--connection-ref <logical-name>` instead of the ID.
In Player, these values come from the verified descriptor's `integration`,
not a separately chosen connection. Forward all arguments through dedicated
skill routing. Keep SharePoint additions on the existing-list path; catalogue
selection never authorizes creating lists, columns or connections.

After the owning preparation approval, persist the real catalogue response
and the exact selection as proposal artifacts, then verify them:

```bash
node "${PLUGIN_ROOT}/scripts/verify-prototype-connection.js" \
  --project-root "<candidate_root>" \
  --catalog ".tmp/prototype-connection-catalog.json" \
  --selection ".tmp/prototype-connection-selection.json"
```

The verifier does not mutate anything. The bridge must also revalidate the
catalogue/selection against its current app/environment context; a locally
authored snapshot is not maker consent or live inventory proof.

## Explicit connected transition

If the verifier reports `initialized: false`, the app is a verified local
prototype. The owning edit workflow must separately approve the environment
and connected initialization, run the official `power-apps init` flow, then
rerun the verifier. Never fabricate `power.config.json`, silently pick an
environment, or invoke Dataverse table/seed/offline provisioning.

If configuration already exists, its environment must match the selected
environment exactly. Do not change it to make a connection fit.

After approval, use only official `npx power-apps add-data-source` and
`npm run generate-schemas` outputs. Preserve local domain, rules, records,
repositories, screens, IDs and design. The owning connected edit must compose
the actual supported host/auth root while retaining local repositories;
adding a connector does not authorize turning every logical entity into a
Dataverse table or replacing existing screens. Do not overwrite a prototype
root with guessed configuration or claim the runtime is connected from files
alone. Shared Apply/Discard remains a separate transaction.

### Retained-local connector startup

Local plus connector-owned concepts compile to **`connector-only`**, not
`mixed`: `mixed` requires Dataverse. Keep the original local/transient owners
and domain entities. An **action-only connector** may have no persistent
concept at all: its approved architecture connector decision enables
connectivity while persistence correctly remains **`local-prototype`**.
Never fabricate an entity or manually set `connector-only` just because SDK
configuration now exists. A generated SDK data-source name is not itself a
Product Scope persistence concept. Rebind only the approved scenario-facts
scope/persistence revisions; startup refuses local fixture payload changes.

After official initialization, authentication setup and schema generation,
invoke the actual startup owner in the approved candidate workspace:

```bash
node "${PLUGIN_ROOT}/scripts/stage-prototype-connector.js" \
  --project-root "<candidate_root>" \
  --catalog ".tmp/prototype-connection-catalog.json" \
  --selection ".tmp/prototype-connection-selection.json" \
  --connector-name "<approved-architecture-apiName>" \
  --preview ".tmp/prototype-connector-preview.json"
```

`connector-name` is the explicit approved architecture connector decision, not a guessed
normalization of the catalogue API ID. Add `--local-ref-id <id>` when official
configuration contains multiple references for that API. A selected reference
must retain its exact official key. The preview file is a `DataPreview` from
the owning transaction: `previewKind: "candidate"`, its isolated
`dataNamespace`, and the active `baseDataNamespace`. Never copy a sample
namespace between jobs or derive one from a Metro URL.

The owner replaces only the current root's local provider binding and wraps
the existing root before its data consumers. Existing UI, AuthoringProvider,
logical model, rules, hooks, repositories and fixture module stay intact.
The real PowerAppsProvider owns theme/query/auth once; no duplicate local
query/theme provider is nested. Only its selected runtime reference is pinned
to the verified connection using the host's supported `sharedConnectionId`;
official configuration and schemas are not rewritten. Prior connector
bindings remain pinned. Missing auth, incomplete schemas, unsupported root
composition, stale input revisions or ambiguous references block.

Missing saved login/OAuth routes are restored with the approved entry route;
existing auth UI is not overwritten. Gate the **new connector section/action**
on real `useAuth` state and offer `/login` when required. Do not hide all local
screens behind a network sign-in gate. Local queries remain `networkMode:
"always"` and use the existing persistent store. Remote connector calls are
real effects, not isolated local fixtures; new writes still require their
own explicit approved action scope.

The typed startup profile is `profile: "connector"`, `storageMode: "local"`,
and `persistenceMode` retains the compiler's **`local-prototype` or
`connector-only`** value with the selected environment. Startup connectivity
is separate from persistence ownership and candidate data mode. The logical
data-access registry remains `mode: "local-prototype"` in both cases. This remains a
development prototype with real connector/auth integration, not a production
auth bypass. Subsequent native additions use the initialized profile, not
the no-environment `--prototype` verification path.

Use `stage-prototype-connector.js --project-root <app> --verify` for read-only
verification, including action-only integrations whose persistence mode is
still local. Do not run the no-environment `generate-prototype --check` or
select `--prototype` solely from data mode after startup profile becomes
`connector`. Interrupted staging keeps only its exact bounded pending writes;
changed canonical inputs or unrelated UI edits block replay.

Player's AuthoringProvider applies the publisher-verified data namespace
before mounting children, superseding the standalone fallback. Player Apply
never uses a CLI activation flag. For standalone Apply only, the owning
approved transaction can call `activatePrototypeConnectorData(root,
{expectedSourceRevision, confirmStandaloneApply:true})`, or the CLI's
`--activate --expected-source-revision <sha256> --confirm-standalone-apply`.
It selects the existing active local namespace, validates TypeScript and
rolls back its own files on failure. It does **not** publish, move Metro,
import candidate records or own durable transaction recovery. The caller
must publish/reload through the shared Apply transaction; `published:false`
is not a success-shaped Apply receipt.

## Exact CLI connection binding

App-root CLI verbs derive environment from the officially initialized
configuration; do not append an unsupported `--environment-id` to those verbs.
The explicit environment remains a skill/verifier input.

Use the selected ID or reference—not both—for the final add:

```bash
npx power-apps add-data-source --api-id "<api>" --connection-id "<selected-id>"
npx power-apps add-data-source --api-id "<api>" --connection-ref "<selected-ref>"
```

For tabular connectors, add the approved dataset and resource name. Discovery
verbs use `--connection-id <discoveryConnectionId>` from the verified selection:

```bash
npx power-apps list-datasets --api-id "<api>" --connection-id "<verified-bound-id>" --json
npx power-apps list-tables --api-id "<api>" --connection-id "<verified-bound-id>" --dataset "<approved-dataset>" --json
```

Do not substitute that discovery ID into a final add that selected a reference.
A changed reference binding requires refreshed inventory and reapproval.

All dataset/list/action questions remain in the same foreground channel:
shared blocking Player questions when a descriptor exists, ordinary chat
questions otherwise. New native dependencies/configuration are forbidden;
missing generated-code dependencies require approved existing pure-JavaScript
dependency planning, not automatic `expo install`.

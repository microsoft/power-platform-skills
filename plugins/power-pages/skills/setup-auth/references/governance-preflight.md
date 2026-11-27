# Setup-time authentication governance preflight

Run the initial gate after provider selection, before any IdP app-registration
walkthrough, provisioning, or auth changes. Reuse that result during generation
and run a fresh check immediately before deployment, as described in Check lifecycle.
It is not a visitor-side runtime filter and does not invoke or re-enable the
disabled `manage-governance` skill. The checker uses the shared API client
directly, without importing archived governance modules. The inventory-discovery
helper referenced below is a separate existing dependency.

## Target and command

**Workforce Microsoft Entra ID is exempt.** The built-in `entra-id` provider,
using the legacy `Authentication/OpenIdConnect/AzureAD/*` settings, is independent
of authentication governance. For workforce Entra-only setup, skip this gate
and its later rechecks, governance inventory/host resolution, and governance-only
tenant/Azure CLI prerequisites. Preserve the existing Entra settings and normal
auth service, claims mapping, login UI, and role-based UI behavior. Other setup
prerequisites and consent still apply.

The checker also accepts `--providers entra-id` without target IDs or CLI
authentication. It returns `allowed: true`, `status: "enabled"`, and no policy
reads; this expresses eligibility, not verification of a governance policy.
For mixed selections, include `entra-id` alongside the governed provider keys;
only governed providers contribute required policies, and all target/authentication
guards below still apply. Microsoft Entra External ID is a separate customer
identity option and remains governed as `oidc`.

### Governed-provider prerequisites and recovery

Initial deployment uploads the site's code/metadata and provides the local
`.powerpages-site` files. It does **not** by itself establish activation.
Activation provisions the runtime host; governance reads target that host's
`portalId`, not the Dataverse `websiteRecordId`.

First establish activation history with the user and the project's existing
activation evidence. A matching successful activation receipt or an existing
runtime host requires the activated-portal path below, even if the host is
currently stopped or unreachable.

**Confirmed never activated:** If the user confirms this project site has never
been activated and no conflicting activation evidence exists, do not require a
host or call the portal checker with missing IDs. Confirm the target environment
as described below, then check environment-level governance using
`--scope environment` without `--portalId`. There is no unchecked continuation:
apply the same batch decision, warning, and consent rules as portal checks.
Missing receipts, missing IDs, unreachable URLs, and failed lookups do not prove
the site was never activated. If history is uncertain, use the local-only
discovery outcome below rather than taking this path. Conflicting target evidence
requires clarification before remote changes.

For both scopes, PAC must select the target environment and Azure CLI
must be signed in to its confirmed owning tenant in the matching cloud.
If PAC is not signed in, direct the user to authenticate with PAC for the target
environment. If Azure CLI sign-in is missing, direct the user to `az login`
for the confirmed tenant/cloud; `az login --allow-no-subscriptions` is a fallback
only for accounts without an associated subscription. If the account or token
tenant differs from the confirmed owner, stop and explain which sign-in context
needs correction. Never switch accounts or environments automatically, expose
tokens, or treat a sign-in failure as an authentication restriction.
If missing/expired sign-in prevents discovery before a checker call, use the
local-only discovery outcome below instead of blocking local preparation.
An observed tenant/environment/cloud mismatch is a target conflict, not an
unavailable lookup; do not convert it to warning-based approval.

Workforce Entra-only setup skips this entire governance-specific prerequisite
and recovery section; it still requires the ordinary deployed-site/web-role
prerequisites of `setup-auth`.

### Confirm the target

Confirm the portal's expected owning tenant GUID from the target environment's
metadata or explicit user input. Do not infer it from the current Azure CLI
account. Retain this confirmed `TENANT_ID` for every preflight and recheck; if the
target changes, confirm its owner again. Never switch accounts automatically.

Read the project's `.powerpages-site/website.yml` for its Dataverse website record
ID; this file does not establish an environment or runtime host ID. Inspect
`docs/alm/last-activate.json` when present. A receipt with successful `Activated`
or `AlreadyActivated` status can supply `environmentId`, `environmentUrl`,
`websiteRecordId`, `siteUrl`, and optionally `websiteHostId`. Older receipts may
omit the host ID; do not require a new receipt or invent missing fields.

Confirm the intended environment with the user. Reuse a receipt only when its
website record ID matches the local project, its environment ID/URL matches
the confirmed target, and its site URL agrees with any independently known
deployed URL. Validate IDs as non-zero GUIDs and keep host and record IDs distinct.
The current `pac auth who` context is a connection check, not proof of where the
site was deployed. On a PAC/receipt/target mismatch, stop and explain the mismatch;
do not switch automatically or reuse the old host in a different environment.
Confirm the owning tenant separately if the receipt does not establish it.

When no reliable saved environment exists, read `pac auth who` and present its
environment name, URL, and ID as a candidate, using the same confirmation pattern
as `/deploy-site`. Ask whether this is the environment for this deployed website.
If not, let the user select the intended environment using `pac org list` and,
with their approval, `pac org select --environment "<ID_OR_URL>"`; reread
`pac auth who` to obtain the final ENV_ID. Never infer the deployed environment
from the website ID or silently accept the current connection. Verify the exact
local website record ID is present in `pac pages list` for the confirmed
environment; a missing record, failed list, or conflict stops target resolution.
Before local generation, missing/unavailable identity may use the local-only
discovery outcome below; deployment must wait until the destination is verified.
The website's presence verifies this target, not a unique last-deployment history.
Use that confirmed ENV_ID and owning tenant for either governance scope.

When a matching receipt includes `websiteHostId`, use it as `portalId` without a
mandatory inventory read. The live checker must still run; a stale/deleted host's
404 stops verification, not an environment-scope fallback. A failed, malformed, or
conflicting receipt cannot establish a trusted target; clarify it first.

If no usable host ID is available, confirm the intended environment explicitly
and resolve the **Power Platform host ID** from that environment's normalized
website inventory (`portals[].portalId`), matching the project's
Dataverse `websiteRecordId` and deployed URL when available. Do not select by name alone, use
the Dataverse record ID as `portalId`, or use a failed/obsolete host. If the
identity is ambiguous, do not choose a host. Retain the uncertainty for target
clarification before deployment; local preparation may continue as below.

For inventory reads, reuse `fetchPortalsPaged(context)` exported by
`skills/manage-governance/scripts/list-portals.js`, passing the normal
`scripts/lib/power-platform-api.js` resolved context. Do not run the governance
inventory CLI with its implicit TIP configuration or trust partial/error results.
`fetchPortalsPaged(context)` returns `{ portals, error }`; match each entry's
`portalId`, `websiteRecordId`, and `websiteUrl`. Raw API `id`/`Id` fields are
normalized by the helper and are not fields on these returned entries.
An `error` also reports malformed pages/records, invalid or non-advancing
pagination links, and reaching the page limit while more pages remain.
Only a result without `error` establishes a complete inventory.

Verify a previously obtained `portalId` without a matching activation receipt
against this inventory before reusing it. The entry must match the project's
`websiteRecordId` and deployed URL when available, in the confirmed environment.
An ID printed by an upload is not sufficient evidence that it is the host ID.

Handle inventory outcomes before invoking the checker:

| Inventory outcome | Required action |
|---|---|
| One matching provisioned host | Use its normalized `portalId`; keep `websiteRecordId` separate |
| Successful, complete inventory has no matching host | This alone does not establish activation history. For a confirmed never-provisioned target, check environment-level governance with `--scope environment`. Otherwise retain `HostIdentityUnresolved`, warn, and continue local preparation only. Resolve the target/history before deployment; if the user chooses recovery with `/activate-site`, after activation, refresh inventory before retrying setup |
| Inventory read fails, returns an error, or is partial/incomplete | Retain `HostLookupUnavailable`, warn, and continue local preparation only, with sign-in/permission/network recovery guidance; do not claim the site is inactive or use partial records |
| Multiple matching hosts or uncertain activation history | Retain `HostIdentityUnresolved`, warn, and continue local preparation only; resolve identity before deployment, never choose by name |
| Conflicting IDs/URLs/tenant/environment/cloud, or a known failed/obsolete host | Stop remote changes and obtain target clarification; do not substitute the record ID, reuse a stale host, or classify a target conflict as an unavailable lookup |

Confirm pagination completed before concluding no host exists. An empty or
partial list from a failed read is not proof of missing activation. Do not
activate a site automatically, substitute `websiteRecordId` for `portalId`,
or use the policy-read warning-and-continue rule to bypass an unverified deployment
destination or a known target conflict. Inventory is a fallback, not mandatory for
a matching activation receipt. These steps document the discovery workflow;
the checker still accepts explicit verified target IDs, not `--projectRoot`.

### Discovery unavailable: local preparation only

Discovery outcomes are workflow decisions, not checker responses or a new CLI
mode. If host discovery cannot finish, do not invoke the checker with a null,
guessed, or ambiguous host ID. Do not select environment scope merely because
discovery failed. Retain this initial result in the current run's context:

```json
{
  "status": "unverified",
  "allowed": false,
  "canContinue": true,
  "reason": "HostLookupUnavailable",
  "continuation": "local-only"
}
```

Use `HostLookupUnavailable` for expired/missing sign-in, permission/network/service
errors, or malformed/incomplete inventory. Use `HostIdentityUnresolved` instead
when no unique host or reliable activation history can be established. Never
trust partial inventory. Recovery attempts must be bounded: at most three
inventory attempts for clearly transient network/429/5xx failures, with
500 ms/1000 ms waits; do not retry permissions, invalid pagination, or malformed
responses automatically. Stop retries on success or a non-transient failure;
discard incomplete pages before any retry. Never sign in or switch accounts
automatically. If the error cannot be classified, do not retry it automatically;
retain it as unverified, not as evidence of absent activation.

Show this warning once before continuing, with a concise recovery reason and
without raw API bodies, tokens, or private exception details:

> We couldn't resolve the site's runtime host, so authentication governance could not be verified. Local IdP settings and auth-code generation will continue. Administrator policies may prevent sign-in from working. The target will be checked again before deployment.

This initial `canContinue: true` permits only local settings/code/UI generation
and non-mutating guidance, under the existing plan/settings consent. It is not
governance approval or permission for remote IdP provisioning, deployment, or
activation. Defer real IdP changes until target verification and the applicable
preflight permit them; do not invent missing provider values to finish generation.
Never downgrade a verified restriction for the same unchanged target/provider
selection, a known target conflict, or a checker's `canContinue: false` to this
outcome. Keep selected providers intact and leave governance policies unchanged.

On deployment, discard the initial local-only continuation and retry discovery
after final environment selection. Confirm the owning tenant and account/cloud
alignment, and verify the exact local website record in `pac pages list` for the
confirmed environment. Missing website records, failed destination verification,
multiple host matches, unresolved activation history, and known target conflicts
stop deployment, not local preparation.

A previously activated target requires a trusted `portalId` from a matching
activation receipt or complete matching host inventory before upload. If no
trusted host can be resolved, keep `HostLookupUnavailable` or
`HostIdentityUnresolved` local-only and stop upload, even when the deployment
destination and activation history are verified. Preserve local artifacts and
defer remote IdP changes; deployment consent does not waive this guard.
If a host is recovered, run the portal checker; if never-provisioned status is
confirmed without conflicting evidence, run the environment checker. Apply actual
checker results unchanged, including all non-continuable errors and restrictions.
Only the checker's existing policy-read rules may allow warning-and-continue
after target/host resolution; failed host discovery is not a policy-read failure.

Run from the project's signed-in PAC environment:

```text
node "${PLUGIN_ROOT}/scripts/check-auth-governance.js" --tenantId "<TENANT_ID>" --envId "<ENV_ID>" --portalId "<HOST_ID>" --websiteRecordId "<WEBSITE_RECORD_ID>" --providers "facebook,google"
```

For a confirmed never-provisioned target, use the same validated environment and
owning tenant without inventing a host ID:

```text
node "${PLUGIN_ROOT}/scripts/check-auth-governance.js" --scope environment --tenantId "<TENANT_ID>" --envId "<ENV_ID>" --websiteRecordId "<WEBSITE_RECORD_ID>" --providers "facebook,google"
```

Environment scope is explicit; omitting a portal ID in the default portal scope
is an input error, not an automatic fallback. Do not select environment scope for
an existing but unresolved, stopped, deleted, or unreachable host. Supplying a
host ID together with environment scope is rejected.

The checker requires the expected owning tenant and verifies GUIDs plus
tenant/environment/cloud alignment. The optional
record ID rejects accidentally passing that ID as the host ID; it does not
replace the receipt or inventory identity checks. It resolves the normal PAC/Azure CLI context once,
never the governance helper's implicit TIP context.

Before governance reads, the checker compares the confirmed owner with both
`context.tenantId` and the bearer token's `tid`, using the existing tenant reader.
This is a local routing guard, not token signature verification; the API still
authenticates the token. Missing ownership, an unavailable authenticated/token
tenant, or a mismatch returns `allowed: false`, `status: "unverified"`, and CLI
exit 2 with zero governance requests. Missing expected ownership also skips CLI
context resolution. Malformed/zero expected tenant GUIDs are invalid input
(exit 3). Sign in to the expected tenant and retry; no automatic account switch,
policy writes, or fallback tenant is permitted.

Map workforce Microsoft Entra ID -> `entra-id` (no required policies),
Facebook -> `facebook`, Google -> `google`, Microsoft Account -> `microsoft`,
configured OIDC providers (including Microsoft Entra External ID) -> `oidc`,
SAML2 -> `saml`, WS-Federation -> `ws-federation`, local authentication -> `local`.
Do not classify an arbitrary OIDC provider as `entra-id` merely because its
issuer is Microsoft. Microsoft Account OAuth is also distinct from workforce
Entra ID. Do not alter Power Pages' internal-only Entra fallback.

Check every provider being configured, regenerated, or newly surfaced, including
existing providers in keep-only/keep-and-add mode. Leave unrelated retained
providers and their settings untouched.

## Check lifecycle

A normal governed-provider setup run has **two check points**:

1. **Initial check:** After selecting all providers, before provider-specific
   walkthroughs, IdP provisioning, or any auth code/UI/settings changes. The
   smart-inference, keep-only, and normal selection paths share this same initial
   check; do not run it twice when they converge.
2. **Deployment check:** After deployment consent, pass the complete provider
   selection and activation/target context to `/deploy-site`. After its final
   environment confirmation and before upload, run a fresh preflight against
   that deployment target. Never reuse the initial result for deployment.
   If the user does not deploy, no deployment check is needed.

At both check points, use portal scope when a host is resolved and environment
scope only for a confirmed never-provisioned target. If the site has since been
activated, resolve its host and run the live portal check before upload.
A changed environment or uncertain activation history requires fresh target
resolution. Never reuse an environment-scope result after activation.
Activation remains optional.
When discovery is unavailable, follow the explicit local-only/deployment rules
above instead of inventing a checker result. A local-only result never authorizes
IdP provisioning or upload and must not be reused as deployment approval.

Retain the initial result in the current run's conversation context, together
with its confirmed owning tenant, environment, host/website-record identity,
account/cloud context, governance scope and activation history, selected provider instances, and normalized checker
provider keys. Retain `canContinue`, `allowed`, and the warning as well; a
warning-based continuation must never become verified approval when reused.
Do not persist tokens, create an on-disk cache, or reuse results across
independent setup runs.

**Reuse, not reread:** IdP provisioning, auth-service generation (Phase 3),
login/registration UI generation (Phase 5), and site-settings creation (Phase 8.1)
reuse the initial result. Do not repeat inventory, CLI authentication resolution,
or policy reads solely because a phase changes, a consent prompt is answered,
or an ordinary pause/resume occurs. Existing provisioning and settings consent
remain mandatory.
If the initial result has `continuation: "local-only"`, reuse it only for local
generation and non-mutating guidance; defer remote IdP provisioning. Retain its
discovery warning just like an unavailable-read warning. Do not repeatedly prompt
or retry merely because a generation phase changes.

**Invalidate before further affected work** when activation status changes or when the target, owning tenant,
account/cloud context, or selected provider instances change. Reconfirm the
target as needed and run a new initial check for the complete revised selection;
do not apply an earlier provider's approval to a newly added provider. On resume,
reuse only when the earlier result and its unchanged context are reliably
retained; if the result or context is missing or uncertain, recheck instead.
Do not resolve CLI authentication again just to support normal phase transitions.
Workforce Entra-only setup remains exempt from both check points.

For actual checker calls at either check point or an invalidation recheck, apply the same bounded retries
and batch `canContinue` decision below. If a deployment check stops, preserve all
earlier local artifacts and report what was already changed, plus any earlier
IdP provisioning. Do not deploy, automatically roll back, or claim that the
whole run made no changes. These checks reduce interruption risk; they do not
make the complete setup transactional.

## Reads and decisions

Every unique required policy uses `request()` from
`scripts/lib/power-platform-api.js` with `method: 'GET'`, an explicit validated
normal CLI context, and path `/websites/{portalId}/governance/{policy}` for an
existing host or `/governance/{policy}` for a confirmed never-provisioned host.
The shared client adds the API version and authenticates the request:

```http
GET {cloudApiHost}/powerpages/environments/{envId}/websites/{portalId}/governance/{policy}?api-version=2022-03-01-preview
```

The server resolves portal inclusion/exclusion. For environment scope, the direct
GET uses the same base URL without `/websites/{portalId}`; do not invoke archived
`getEnv`/`getDetails` wrappers or fetch membership lists.

| Environment response | Never-provisioned host |
|---|---|
| `All` / `AllSites` | Enabled |
| `Exclude` and supported Exclude aliases | Enabled; the future host is not already excluded |
| `Include` and supported Include aliases | Disabled; the future host is not already included |
| `None` | Disabled |
| Unknown/missing values, unexpected envelopes, or HTTP 404 | Unverified; never infer enabled or disabled |

These membership-free rules apply only to genuinely never-provisioned hosts,
not existing hosts whose ID was lost or whose lookup failed. Scope strings are
trimmed and case-insensitive. All required reads start in parallel, with shared
parents read once per batch and no persistent cache.

| Provider | Required portal policies |
|---|---|
| Microsoft Entra ID (built-in workforce) | None; independent of authentication governance |
| Facebook | External Auth + OAuth + Facebook OAuth |
| Google | External Auth + OAuth + Google OAuth |
| Microsoft Account | External Auth + OAuth + Microsoft OAuth |
| OIDC (including Microsoft Entra External ID) | External Auth + OIDC |
| SAML | External Auth + SAML |
| WS-Federation | External Auth + WS-Federation |
| Local login | External Auth + Local Login |

In portal scope, verified approval requires boolean `true` (or text `true`, ignoring case and
surrounding whitespace) for every requirement. Boolean `false`/text `false`
(also case-insensitive) is disabled. Other
response shapes and read failures remain **unverifiable**, never converted to
enabled or disabled. Setup continuation is a separate decision (`canContinue`).
The existing governance reference describes the
single-boolean contract. A commercial-cloud read-only retest on 2026-11-07,
authenticated to the confirmed owning tenant, successfully read External Auth,
OAuth, and Facebook as enabled and reconfirmed the exact host/website-record
pair through inventory. An earlier probe using a different Azure CLI tenant
returned HTTP 404 for the same routes and failed inventory discovery. Confirm
the owning tenant as well as the environment before interpreting read errors;
an environment match alone does not establish tenant alignment. Do not broaden
the parser or switch APIs to manufacture an allowed result.

Read JSON `allowed`, `canContinue`, `status`, `providers`, and `message`.
Display the batch `message` so a provider-level warning cannot hide a known
restriction elsewhere in the batch. Exit 0/`allowed: true` means verified approval
(or workforce Entra exemption). Exit 1/`blocked` lists disabled requirements.
Exit 2/`unverified` retains verification failures and any known restrictions;
inspect `canContinue` rather than stopping solely on the exit code.
Exit 3 means invalid input or an unexpected execution failure, not an
administrator restriction. Stop setup, correct the input or execution problem,
and retry; there is no policy decision to reuse.

### Unavailable reads: retry, warn, and continue

The checker retries each transient read independently, at most **three total
attempts**, waiting **500 ms** and **1000 ms** before the retries. This applies
to network/timeout failures (HTTP status 0), HTTP 429, and HTTP 5xx except 501.
Shared parent policies are still read once per batch, apart from these bounded
retries; successful reads are not repeated. Authentication is resolved once.
HTTP 403, 405, and 501 are not automatically retried.

| Result | Setup behavior |
|---|---|
| All requirements verified enabled | `allowed: true`, `canContinue: true`; continue through normal consent |
| Only unavailable reads: 403, 405, 501, or exhausted transient failures | `status: "unverified"`, `allowed: false`, `canContinue: true`; show the warning and automatically continue setup |
| Any verified disabled requirement, even alongside unavailable reads | `canContinue: false`; stop the entire selected batch |
| Context/tenant/environment/cloud errors, missing ownership, 401, unexplained 404, malformed responses, or other unclassified failures | `canContinue: false`; stop and correct the cause |

Unavailable-read diagnostics use `error.code: "ReadUnavailable"`. Do not infer
that a 404 means an unsupported endpoint or an unconfigured/default-allowed
policy. Do not retry by switching accounts, using admin credentials, or changing
the target. A malformed response/envelope or unclassified thrown error is not
proof of a network outage and does not permit continuation.

For **checker responses** at every preflight and recheck, when batch `canContinue: true` but
`allowed: false`, show its warning before proceeding: governance could not be
verified, setup is continuing without treating the policies as enabled, and
Power Pages runtime governance still applies. Configured sign-in methods may
not work. Do not add a separate continuation prompt; all existing provisioning,
settings-review, and deployment consent remains required. This behavior applies
to walkthroughs, local generation, settings, and deployment, not just Phase 2.1.
Do not describe warning-based continuation as verified governance approval.

### User-facing blocked message

Start every blocked preflight, including late rechecks, with this exact message:

> Your administrator has restricted the use of [authentication Protocol/Provider] for this website. Contact your administrator if you need this setting enabled.

Replace the placeholder with the disabled protocol/provider label(s), not
enabled parent options or unverified requirements. Keep the wording unchanged.
Do not append policy-state summaries, portal/environment details, admin links,
or configuration navigation unless the user explicitly asks for those details.
The structured checker result retains policy states and target IDs for
diagnostics; omitting them from the message does not change the governance gate.
When disabled policies and verification failures coexist, show the approved
restriction sentence for known disabled labels first, followed by separate
verification-error guidance; the result remains `unverified`. Denied batch
messages must omit enabled-provider success messages, regardless of provider
order. Use unique disabled labels across the batch so shared parents appear
only once, while retaining every provider's structured diagnostics.

Only if the user requests configuration guidance: for commercial cloud, link to
https://admin.powerplatform.microsoft.com/manage/portals/settings. If the deep
link redirects, the navigation is **Manage > Products > Power Pages > Settings >
Authentication**. For other clouds, use the tenant's verified admin-center URL
when available, otherwise the documented entry point https://aka.ms/ppac;
do not invent sovereign-cloud deep links.

Example when only OIDC is disabled:

> Your administrator has restricted the use of OpenID Connect protocol for this website. Contact your administrator if you need this setting enabled.
>
> No identity provider settings or custom login page changes have been made in this run.

For other providers or multiple disabled requirements, substitute **all and only**
the disabled labels into the approved message. Keep policy keys and enabled
requirements in the structured diagnostics rather than the default message.
Do not describe unknown responses as disabled. An allowed policy
permits maker configuration; it does not create or configure the IdP.

The example's no-change statement applies only when this run has made no
changes. After a late blocker, disclose earlier local artifacts and say that the
read-only recheck made no additional changes. For an `unverified` result, retain
the checker's verification diagnostics and corrective sign-in/target/network
guidance; never suggest enabling a policy as a substitute for verification.

Navigation and site-targeting behavior:
https://learn.microsoft.com/power-pages/security/external-auth-control#configure-authentication-governance-controls

Stop the entire selected batch before mutation when batch `canContinue: false`,
including any known disabled policy or non-continuable verification failure.
Never silently remove providers, partially configure the allowed
subset, delete existing settings, enable governance, or offer an override.
The user may explicitly revise the selection; then rerun the initial gate.
Follow Check lifecycle for result reuse, context invalidation, and the fresh
deployment check; do not introduce additional per-phase checks.
If earlier stages already changed files, report those changes accurately;
the check's no-change statement applies only to the read-only checker.

## Importable function

`scripts/check-auth-governance.js` exports `checkAuthGovernance({ tenantId, envId,
portalId?, scope?, websiteRecordId?, providers, context? })` for detailed diagnostics.
Scope defaults to `portal` and requires a host ID. `scope: "environment"` requires
confirmed absence of a provisioned host and no portal ID. Governed results include
the selected scope and a null `portalId` for environment-level checks.
Use the batch `canContinue` and `message` to implement warning-and-continue,
not `allowed` alone: continuable outages remain unverified, not approved.
No API bodies, tokens, or raw exceptions are included in its output.

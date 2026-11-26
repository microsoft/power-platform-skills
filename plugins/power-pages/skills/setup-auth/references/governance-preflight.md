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

For governed providers, PAC must select the target environment and Azure CLI
must be signed in to its confirmed owning tenant in the matching cloud.
If PAC is not signed in, direct the user to authenticate with PAC for the target
environment. If Azure CLI sign-in is missing, direct the user to `az login`
for the confirmed tenant/cloud; `az login --allow-no-subscriptions` is a fallback
only for accounts without an associated subscription. If the account or token
tenant differs from the confirmed owner, stop and explain which sign-in context
needs correction. Never switch accounts or environments automatically, expose
tokens, or treat a sign-in failure as an authentication restriction.

Workforce Entra-only setup skips this entire governance-specific prerequisite
and recovery section; it still requires the ordinary deployed-site/web-role
prerequisites of `setup-auth`.

### Confirm the target

Confirm the portal's expected owning tenant GUID from the target environment's
metadata or explicit user input. Do not infer it from the current Azure CLI
account. Retain this confirmed `TENANT_ID` for every preflight and recheck; if the
target changes, confirm its owner again. Never switch accounts automatically.

Resolve the project's environment GUID and **Power Platform host ID** from the
target environment's normalized website inventory (`portals[].portalId`), matching the project's
Dataverse `websiteRecordId` and deployed URL. Do not select by name alone, use
the Dataverse record ID as `portalId`, or use a failed/obsolete host. If the
identity is ambiguous, stop and ask the user to confirm the target.

For inventory reads, reuse `fetchPortalsPaged(context)` exported by
`skills/manage-governance/scripts/list-portals.js`, passing the normal
`scripts/lib/power-platform-api.js` resolved context. Do not run the governance
inventory CLI with its implicit TIP configuration or trust partial/error results.
`fetchPortalsPaged(context)` returns `{ portals, error }`; match each entry's
`portalId`, `websiteRecordId`, and `websiteUrl`. Raw API `id`/`Id` fields are
normalized by the helper and are not fields on these returned entries.

Verify a previously obtained `portalId` (including one reported during deployment)
against this inventory before reusing it. The entry must match the project's
`websiteRecordId` and deployed URL when available, in the confirmed environment.
An ID printed by an upload is not sufficient evidence that it is the host ID.

Handle inventory outcomes before invoking the checker:

| Inventory outcome | Required action |
|---|---|
| One matching provisioned host | Use its normalized `portalId`; keep `websiteRecordId` separate |
| Successful, complete inventory has no matching host | Explain that no provisioned host was found for this target and direct the user to `/activate-site` to verify/complete activation; after activation, refresh inventory before retrying setup |
| Inventory read fails, returns an error, or is partial/incomplete | Stop target resolution and report the inventory failure with sign-in/permission/network recovery guidance; do not claim the site is inactive |
| Multiple matches, conflicting IDs/URLs, or failed/obsolete hosts | Stop and obtain target clarification; do not choose by name, substitute the record ID, or reuse a stale host |

Confirm pagination completed before concluding no host exists. An empty or
partial list from a failed read is not proof of missing activation. Do not
activate a site automatically, substitute `websiteRecordId` for `portalId`,
or use the policy-read warning-and-continue rule to bypass unresolved identity
or inventory failures. These steps document the existing discovery workflow;
the checker still accepts explicit verified target IDs, not `--projectRoot`.

Run from the project's signed-in PAC environment:

```text
node "${PLUGIN_ROOT}/scripts/check-auth-governance.js" --tenantId "<TENANT_ID>" --envId "<ENV_ID>" --portalId "<HOST_ID>" --websiteRecordId "<WEBSITE_RECORD_ID>" --providers "facebook,google"
```

The checker requires the expected owning tenant and verifies GUIDs plus
tenant/environment/cloud alignment. The optional
record ID rejects accidentally passing that ID as the host ID; it does not
replace inventory matching. It resolves the normal PAC/Azure CLI context once,
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
2. **Deployment check:** After deployment consent, immediately before invoking
   `/deploy-site`, run a fresh check against the confirmed deployment target and
   complete provider selection. Never reuse the initial result for deployment.
   If the user does not deploy, no deployment check is needed.

Retain the initial result in the current run's conversation context, together
with its confirmed owning tenant, environment, host/website-record identity,
account/cloud context, selected provider instances, and normalized checker
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

**Invalidate before further affected work** when the target, owning tenant,
account/cloud context, or selected provider instances change. Reconfirm the
target as needed and run a new initial check for the complete revised selection;
do not apply an earlier provider's approval to a newly added provider. On resume,
reuse only when the earlier result and its unchanged context are reliably
retained; if the result or context is missing or uncertain, recheck instead.
Do not resolve CLI authentication again just to support normal phase transitions.
Workforce Entra-only setup remains exempt from both check points.

At either check point or an invalidation recheck, apply the same bounded retries
and batch `canContinue` decision below. If a deployment check stops, preserve all
earlier local artifacts and report what was already changed, plus any earlier
IdP provisioning. Do not deploy, automatically roll back, or claim that the
whole run made no changes. These checks reduce interruption risk; they do not
make the complete setup transactional.

## Reads and decisions

Every unique required policy uses `request()` from
`scripts/lib/power-platform-api.js` with `method: 'GET'`, an explicit validated
normal CLI context, and path `/websites/{portalId}/governance/{policy}`.
The shared client adds the API version and authenticates the request:

```http
GET {cloudApiHost}/powerpages/environments/{envId}/websites/{portalId}/governance/{policy}?api-version=2022-03-01-preview
```

The server resolves portal inclusion/exclusion. Do not call `getEnv`/`getDetails`
or interpret membership lists. All required reads start in parallel, with shared
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

Verified approval requires boolean `true` (or text `true`, ignoring case and
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

At **every preflight and recheck**, when batch `canContinue: true` but
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

`scripts/check-auth-governance.js` exports `checkAuthGovernance({ tenantId, envId, portalId,
websiteRecordId?, providers, context? })` for detailed diagnostics.
Use the batch `canContinue` and `message` to implement warning-and-continue,
not `allowed` alone: continuable outages remain unverified, not approved.
No API bodies, tokens, or raw exceptions are included in its output.

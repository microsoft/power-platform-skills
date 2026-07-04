# Git Integration Prerequisites

Shared prerequisite reference for **inner-loop** skills that interact with Dataverse Git integration (Connect-to-Git). Used by `git-configure` and `git-sync`.

> **Source of truth.** This document mirrors the Microsoft Learn page [Dataverse Git integration setup](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git) and the [Git API reference](https://learn.microsoft.com/power-platform/alm/git-integration/git-api). If those pages move, update this doc.

---

## 1. Managed Environments (mandatory per Microsoft Learn; empirically required only for env-binding)

Dataverse Git integration is documented as a **feature of Managed Environments**. The Connect-to-Git UI and APIs are documented as **invisible** unless Managed Environments is on for *both* the source dev env and any other env that will share the binding.

**Detection helper:** `scripts/lib/verify-managed-env.js` — returns `{ enabled: true/false, envId, envUrl }`. Skills must call this in Phase 1.

**Enforcement guidance for skills (HAR-confirmed 2026-06):**
- **Env-level binding (`ConnectionType=1`)** — treat Managed Env as **required** until proven otherwise. Hard-block setup with the message below.
- **Solution-level binding (`ConnectionType=0`)** — Managed Env is **empirically not enforced** on multiple tenants. Skills must **warn-not-block** and offer an "I know what I'm doing, proceed anyway" option.

> ⚠️ **Field test (June 2026, development tenant):** `protectionLevel: "Basic"` (Managed Env OFF), yet two solutions were successfully solution-bound, the `SourceControlInitialSyncPlugin` ran to completion, and `sourcecontrolsyncstatus` reached `3` (Synced) on both. The reference doc was previously too strict. See [`inner-loop-empirical-findings.md`](inner-loop-empirical-findings.md) §1.

**Recommended hard-block remediation message** (for env-binding only):
> "Managed Environments is OFF on env `{envName}`. Enable it in [Power Platform Admin Center → Environments → {env} → Manage → Edit Managed Environments](https://admin.powerplatform.microsoft.com/environments). Or switch to `/power-pages:git-configure` with solution binding, which is empirically known to work without Managed Env on some tenants."

---

## 2. Azure DevOps prerequisites

Azure DevOps is currently the **only supported Git provider** (`GitProvider = 0`). GitHub is enumerated in the API surface (`GitProvider = 1`) but is not generally available for Dataverse Git integration as of this writing.

| Prereq | How to check | Failure remediation |
|---|---|---|
| ADO organization exists | User-supplied URL `https://dev.azure.com/{org}` | Create at https://dev.azure.com |
| ADO project exists | `GET https://dev.azure.com/{org}/_apis/projects/{project}?api-version=7.1` (via `ado-client.js`) | Skill prompts user to create in ADO |
| ADO **repo exists AND is initialized** | `GET .../repos/{repo}` (200 + `defaultBranch` populated). **Empty repos return 200 with `defaultBranch=null` — must reject.** | `verify-repo-initialized.js` catches this; `git-configure` then offers a one-tap consent gate that auto-creates the first README commit via `init-ado-repo.js` (idempotent — re-running against an initialized repo is a no-op). |
| User has **Contribute** permission on the repo | Try a no-op operation, or check `/_apis/permissions/{namespaceId}/...` | Surface ADO permission URL; cannot auto-grant. `init-ado-repo.js` surfaces this exact remediation on 403. |
| User has an ADO **Basic license** (not Stakeholder) | `GET .../graph/users/{descriptor}` | Stakeholders cannot push commits — escalate to ADO admin |
| **Auth to `dev.azure.com` for the pre-checks** | ADO helpers mint an ADO-scoped Microsoft Entra JWT in-process via `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` (the well-known, tenant-invariant ADO Entra app id) when no explicit token is supplied. `buildAuthHeader` in `verify-ado-permissions.js` auto-detects PAT vs JWT and emits the correct header. | Nothing is written to disk: helpers use the acquired token directly in the Authorization header and never print it or pass it on a command line. `get-ado-token.js` is used for the tenant cross-check only (`--verifyTenant --organization <org>`), and its stdout is masked. On failure, helpers surface `az login` / `az login --tenant <guid>` hints. Cross-tenant scenarios are not supported by this skill's Entra-OAuth path; use the explicit-token fallback when a PAT or CI/SP token is required. |

> ⚠️ **Cryptic-error footgun.** An uninitialized repo fails ~30 min into the Connect flow with *"Failed to retrieve default branch"*. `verify-repo-initialized.js` catches this in <1 sec; `init-ado-repo.js` fixes it in the same skill run with one consent.

---

## 3. Dataverse role + tenant prerequisites

| Prereq | Detection | Notes |
|---|---|---|
| Caller is **System Administrator** in the source env | `WhoAmI` + `RetrieveCurrentOrganization` (security role enumeration) | Required to invoke `ConnectToGit` / `DisconnectFromGit` |
| Env is **NOT BYOK-encrypted** with a customer-managed key under the deprecated scheme | Read `organization` table `customerencryptionkey` columns | BYOK envs throw *"Source Control Integration is not enabled"* on Connect |
| Dev env and ADO repo are in the **same tenant** | Compare `tenantId` from `pac env who` to the ADO org's tenant | Cross-tenant is **not supported** |
| If dev env and ADO are in **different geos**, the user accepts the inline cross-geo consent | UI-only prompt during Connect | Skills should pre-warn the user before calling the API |

**Helper:** `verify-managed-env.js` covers Managed Env + BYOK + sys-admin in one pass.

---

## 4. Per-developer prerequisites

These cannot be auto-checked end-to-end; the skill should surface them as a one-time checklist on first run:

1. Added to the dev env with the appropriate Dataverse security role
2. Added to the ADO project with Contribute permission
3. Either:
   - **Shared env strategy** — all devs work in one dev env (simpler, but every change is shared instantly), OR
   - **Per-dev env strategy** — each dev has their own dev env with the same unmanaged solution (same `uniquename` + publisher), all bound to the same repo/branch/folder
4. (Optional but recommended) Cloned the ADO repo locally to view diffs / open PRs from the IDE

---

## 5. Cross-feature compatibility notes

| Feature | Compatible with Git integration? |
|---|---|
| Power Pages **code sites** (`pac pages upload-code-site`) | ✅ — uploaded web files land in the solution and appear as pending Changes. See `pac-pages-vs-git-integration.md` for the recommended workflow. |
| **Power Platform Pipelines** (outer loop) | ✅ — orthogonal. Pipelines reads exported solutions; Git integration tracks unmanaged-solution diffs in source. Use both. |
| **Default Solution** / **Common Data Service Default Solution** | ❌ — these cannot be Connect-to-Git'd. Work must live in a custom solution. |
| Sovereign clouds (Gov, DoD, China) | ✅ — per Microsoft Learn FAQ as of Wave 2 2024. |
| BYOK with customer-managed encryption keys (deprecated scheme) | ❌ — see §3 above. |

---

## 6. Quick prerequisite-check pseudocode

```
node scripts/lib/get-ado-token.js --verifyTenant --organization <o>
  → stdout: { ok: true, tokenType: "OAuth", tenantId, expiresOn, tenantMismatch: false, token: "***" }
  // git-configure runs this once the org is known and hard-blocks on tenantMismatch:true.
  // ADO REST helpers such as verify-repo-initialized.js and verify-ado-permissions.js self-acquire
  // their own ADO-scoped Entra token in-process via az when no explicit token is supplied.
  // ADO tokens are never written to disk, printed to stdout, or passed on command lines.

node scripts/lib/verify-managed-env.js --envUrl <url>
  → { managedEnv: true, sysAdmin: true, byok: false }

node scripts/lib/verify-repo-initialized.js --organization <o> --project <p> --repository <r>
  → { initialized: true, defaultBranch: "main" }
  // initialized:false → git-configure calls init-ado-repo.js after a one-tap consent gate.

node scripts/lib/verify-ado-permissions.js --organization <o> --project <p> --repository <r>
  → { contribute: true, basicLicense: true }
  // buildAuthHeader auto-detects: <2 dots in --token → Basic <base64(:PAT)>; exactly 2 dots → Bearer <JWT>.
```

Skills must surface a **single composite "Prerequisites" report** before any mutating call — never run a Connect-to-Git API blind.

---

## 7. References

- [Git integration overview](https://learn.microsoft.com/power-platform/alm/git-integration/overview)
- [Git integration setup](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git)
- [Connect/Disconnect API reference](https://learn.microsoft.com/power-platform/alm/git-integration/git-api)
- [Source control operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations)
- [Git integration FAQ](https://learn.microsoft.com/power-platform/alm/git-integration/faqs)
- [Managed Environments overview](https://learn.microsoft.com/power-platform/admin/managed-environment-overview)

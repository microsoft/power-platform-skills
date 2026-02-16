# Dataverse Prerequisites

Shared prerequisite steps for skills that interact with the Dataverse OData Web API. Used by `setup-datamodel`, `add-sample-data`, and any future skills that need Dataverse API access.

---

## 1. Check PAC CLI

Run `pac env who` to get the current environment URL:

```powershell
pac env who
```

Extract the `Environment URL` (e.g., `https://org12345.crm.dynamics.com`). Store as `$envUrl`.

**If `pac env who` fails**: Tell the user to authenticate first:

```powershell
pac auth create
```

## 2. Get Azure CLI Token

Get an access token for the Dataverse environment:

```powershell
$token = az account get-access-token --resource "$envUrl" --query accessToken -o tsv
```

**If `az` fails**: Tell the user to run `az login` first.

## 3. Verify API Access

Make a lightweight test request to confirm the token works:

```powershell
$headers = @{ Authorization = "Bearer $token"; Accept = "application/json" }
Invoke-RestMethod -Uri "$envUrl/api/data/v9.2/WhoAmI" -Headers $headers
```

If this returns a valid response, proceed. If it returns 401/403, the token is invalid — ask the user to re-authenticate.

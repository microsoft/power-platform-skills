# Entity Creation Log

## Environment
- URL: https://contoso.crm.dynamics.com
- Solution: ContosoOperations
- Publisher Prefix: cr
- Warning: az (admin@contoso.onmicrosoft.com) and pac (maker@contoso.onmicrosoft.com) use different identities; WhoAmI passed, so provisioning proceeds (run `az login --username maker@contoso.onmicrosoft.com` if a later step returns 403).

## Created Tables

### Widget
- Schema Name: cr_Widget
- Resolved Full Name: cr_widget
- Metadata ID: n/a (SDK does not surface metadata ids)

## Created Columns

| Table | Display Name | Schema Name | Resolved Full Name | Metadata ID |
|-------|--------------|-------------|--------------------|-------------|
| cr_widget | SKU | cr_Sku | cr_sku | n/a |
| cr_widget | Quantity | cr_Quantity | cr_quantity | n/a |

## Created Relationships

| Type | From | To | Lookup Schema Name | Resolved Full Name |
|------|------|-----|--------------------|-------------------|

## Commands

```powershell
node "${PLUGIN_ROOT}/scripts/check-auth.js" --env "$ENV_URL" --require-pac  # ok: true, identitiesMatch: false (warning above)
node "${PLUGIN_ROOT}/scripts/provision-entities.js" --env "$ENV_URL" --input @D:/work/widgets/provision-input.json --apply
```

## Sample Data

The user declined sample data ("No, skip"); cr_widget was left empty.

# Entity Creation Log

## Environment
- URL: https://aurorabapenv610b3.crmtest.dynamics.com/
- Solution: Crdec34
- Publisher Prefix: cr

## Created Tables

### Ticket
- Schema Name: cr_Ticket
- Resolved Full Name: cr_ticket
- Metadata ID: n/a

## Created Columns

| Table | Display Name | Schema Name | Resolved Full Name | Metadata ID |
|-------|--------------|-------------|--------------------|-------------|
| cr_ticket | Priority | cr_Priority | cr_priority | n/a |
| cr_ticket | Status | cr_Status | cr_status | n/a |
| cr_ticket | Due Date | cr_DueDate | cr_duedate | n/a |

## Created Relationships

(No relationships created)

## Commands

```powershell
node check-auth.js  # ok: true
node provision-entities.js --env "$ENV_URL" --input @support-tickets/provision-input.json --apply --sample-data
```

## Created Record IDs (cr_ticket)

- 56690ca2-5355-f111-a821-000d3a380330 — Login page returns 500 error for SSO users (Critical / Open)
- 57690ca2-5355-f111-a821-000d3a380330 — Export to Excel truncates long descriptions (Medium / In Progress)
- 58690ca2-5355-f111-a821-000d3a380330 — Dashboard widget shows stale data after refresh (High / Open)
- 59690ca2-5355-f111-a821-000d3a380330 — Email notifications missing attachments (High / In Progress)
- 5a690ca2-5355-f111-a821-000d3a380330 — Typo on the account settings help text (Low / Open)
- 5b690ca2-5355-f111-a821-000d3a380330 — Mobile layout breaks on iPad portrait orientation (Medium / Resolved)
- 5c690ca2-5355-f111-a821-000d3a380330 — Search filter does not persist across pages (Medium / Open)
- 5d690ca2-5355-f111-a821-000d3a380330 — Password reset email goes to spam folder (High / Closed)
- 5e690ca2-5355-f111-a821-000d3a380330 — Calendar invite timezone offset incorrect (Medium / In Progress)
- 5f690ca2-5355-f111-a821-000d3a380330 — Bulk import fails on records with special characters (Critical / Open)

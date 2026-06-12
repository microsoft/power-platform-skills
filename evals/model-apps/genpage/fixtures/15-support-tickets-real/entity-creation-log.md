# Entity Creation Log

Env: https://aurorabapenv610b3.crmtest.dynamics.com
Solution: Crdec34
Publisher Prefix: cr
Started: 2026-05-21T00:00:00Z

| Step | Operation | Status | Resolved Full Name | MetadataId | Notes |
|------|-----------|--------|---------------------|------------|-------|
| 1 | Auth check | OK | n/a | n/a | az + pac signed in as Aurora365-User1@auroratstgeo.onmicrosoft.com |
| 2 | Create table cr_Ticket | EXISTS | cr_ticket | 8a63d937-5355-f111-a821-000d3a380330 | Table already existed in env; verified PrimaryNameAttribute=cr_name, EntitySetName=cr_tickets |
| 3 | Add column cr_priority (picklist) | OK | cr_priority | 1a2ed57f-5355-f111-a821-000d3a380330 | Options: Low(100000000), Medium(100000001), High(100000002), Critical(100000003) |
| 4 | Add column cr_status (picklist) | OK | cr_status | bf5f0089-5355-f111-a821-000d3a380330 | Options: Open(100000000), In Progress(100000001), Resolved(100000002), Closed(100000003) |
| 5 | Add column cr_duedate (datetime) | OK | cr_duedate | c95f0089-5355-f111-a821-000d3a380330 | DateOnly format, UserLocal behavior |
| 6 | Verify metadata | OK | cr_ticket | 8a63d937-5355-f111-a821-000d3a380330 | EntitySetName=cr_tickets confirmed |
| 7 | Seed sample tickets | OK | cr_tickets | n/a | 10 records inserted via $batch, 0 errors |

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

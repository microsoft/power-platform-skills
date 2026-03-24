# Table Permission Analysis Guide

Reference document for systematically analyzing per-table privileges and performing cross-table validation when configuring Power Pages table permissions.

## Per-Table Privilege Analysis Checklist

For each table, work through the following checklist **in order**. For every decision, note the **specific code evidence** (file path, line pattern, or API pattern) that justifies it. Do NOT guess — if no evidence exists for a privilege, leave it `false`.

### A. Determine Source — Why does this table need permissions?

Classify the table into one or more categories:

- **Direct API target** — Code makes `/_api/<entity_set>` calls to this table
- **`$expand` related** — This table is fetched via `$expand` on another table's query
- **Lookup target** — This table is referenced by a lookup column on another table (needs `append`)
- **Data model only** — Table exists in manifest but no code references found (may not need permissions yet)

Record the source files and patterns that reference this table.

### B. Determine Web Role(s)

Which web role(s) need access to this table?

- Search for authentication checks near the API calls (e.g., `getCurrentContactId()`, `getPortalUser()`, role checks)
- If the table is accessed without auth checks → likely needs Anonymous Users role
- If the table is accessed behind auth/login → needs Authenticated Users role
- If role-specific checks exist → map to the specific custom role

**If the required role does not exist** in the discovered web roles, flag it as a new role to create. Record it so it can be included in the plan and created before table permissions. At minimum, every site needs `Authenticated Users` (`authenticatedusersrole: true`). If anonymous/public access is needed, also flag `Anonymous Users` (`anonymoususersrole: true`).

### C. Determine Scope

Evaluate the scope based on code patterns. Check **each scope option** and pick the most restrictive one that fits:

| Scope | Code Pattern to Look For | When to Use |
|-------|-------------------------|-------------|
| **Self** (`756150004`) | Queries filter by current contact ID for contact table itself | Only for the contact record itself |
| **Contact** (`756150001`) | `getCurrentContactId()`, `_contactid_value eq`, filter by current user | User's own records (orders, profiles) — **default choice** |
| **Account** (`756150002`) | Account-based filters, shared team access patterns | Organizational shared access |
| **Parent** (`756150003`) | Table is a child accessed via parent (e.g., order lines under orders), `$expand` with one-to-many | Child tables that inherit access from parent |
| **Global** (`756150000`) | No user/contact filter, public browsing, anonymous access | **Last resort** — only for read-only public reference data |

Search the service code for scope-relevant filter patterns: contact-scoped filters (`getCurrentContactId`, `_contactid_value`, `contactid`) and account-scoped filters (`_accountid_value`, `parentcustomerid`).

**Scope guardrails (critical):**

- Do **not** replace an existing or proposed **Parent** scope permission with **Contact** or **Account** scope unless you have **direct evidence on the child table itself**:
  - the child table has its own direct lookup to contact/account,
  - the corresponding Dataverse relationship exists for that child table, and
  - the business rule truly grants access based on the child record's own owner/contact/account — not inherited parent access.
- Do **not** assume Power Pages "flattens" a Parent→Contact or Parent→Account chain onto the child table unless Microsoft documentation explicitly states it or deterministic validation proves it.
- Relationship schema names do **not** need to match across different entities. A parent table's contact relationship name and a child table's contact relationship name may legitimately differ. Never rewrite scope just because the names differ across entities.
- For **Contact** scope, validate the relationship against the secured table itself. For **Parent** scope, validate only the child→parent `parentrelationship` plus the parent permission chain; do not compare unrelated relationship names across entities.

### D. Determine Read

Is `read: true` needed?

- Search the service code for: GET requests to `/_api/<entity_set>`, list/get functions (`list<TableName>`, `get<TableName>`), `$select` patterns, `$expand` that references this table
- If this table is only accessed via `$expand` from another table → still needs `read: true`
- **Decision:** `true` if any read pattern found, `false` otherwise

### E. Determine Create

Is `create: true` needed?

- Search the service code for: POST requests (`method: 'POST'`) to `/_api/<entity_set>`, create functions (`create<TableName>`)
- **Decision:** `true` only if POST/create pattern found for this specific table, `false` otherwise

### F. Determine Write

Is `write: true` needed?

- Search the service code for: PATCH requests (`method: 'PATCH'`) to `/_api/<entity_set>`, update functions (`update<TableName>`), file upload patterns (`uploadFileColumn`, `uploadFile`, `upload*Photo`, `upload*Image`, `upload*File`)
- **Important:** File/image uploads use PATCH → require `write: true` even if no other field updates exist
- **Decision:** `true` if PATCH/update/upload pattern found, `false` otherwise

### G. Determine Delete

Is `delete: true` needed?

- Search the service code for: DELETE requests (`method: 'DELETE'`) to `/_api/<entity_set>`, delete functions (`delete<TableName>`)
- **Decision:** `true` only if DELETE pattern found for this specific table, `false` otherwise

### H. Determine Append

Is `append: true` needed?

- **Required when:** This table is the TARGET of a lookup column on another table that has create or write permissions — i.e., other records link TO this table
- Search the service code for `@odata.bind` references to this table's entity set (e.g., `<entity_set>(`)
- Also check the **reverse target map** from the relationship discovery step — does any other table with create/write have a lookup whose `Targets` include this table?
- **Decision:** `true` if any other table with create/write has a lookup to this table, `false` otherwise
- **If `true`:** Record which source table's lookup triggers this (needed for rationale)

### I. Determine AppendTo

Is `appendto: true` needed?

- **Required when:** This table has lookup columns that are set during create or write operations — i.e., this table links TO other records
- Search the service code for `@odata.bind` patterns in create/update functions for this table
- Also check the **source map** from the relationship discovery for lookup columns on this table
- **Decision:** `true` if this table sets lookup columns during create/write, `false` otherwise
- **If `true`:** Record which lookup columns trigger this (needed for rationale)

### J. Determine Parent Relationship (if Parent scope)

If scope is Parent (`756150003`):

- Identify the parent table and its permission (must be analyzed first)
- Identify the Dataverse relationship name (from relationship discovery) — use `SchemaName` as `parentrelationship`

### K. Record Decision Summary

After completing all checks, record the final permission configuration for this table:

```
Table: <table_logical_name>
Source: <Direct API target / $expand related / Lookup target>
Web Role: <role name(s)>
Scope: <scope name> (code evidence: <file:pattern>)
read: <true/false> (evidence: <reason>)
create: <true/false> (evidence: <reason>)
write: <true/false> (evidence: <reason>)
delete: <true/false> (evidence: <reason>)
append: <true/false> (evidence: <reason>)
appendto: <true/false> (evidence: <reason>)
Parent: <parent permission + relationship if Parent scope>
```

---

## Cross-Table Validation

After all individual table analyses are complete, do a cross-table validation pass:

1. **Append/AppendTo consistency:** For every table with `appendto: true` (source table with lookups), verify that each lookup target table has `append: true`. For every table with `append: true` (target table), verify that the source table that references it has `appendto: true`.
2. **`$expand` coverage:** For every `$expand` usage found during code analysis, verify the expanded table has `read: true` in the inventory.
3. **Parent chain completeness:** For every Parent scope permission, verify the parent permission exists in the inventory and will be created first.
4. **No orphaned permissions:** If a table is only in the inventory because of `append` (lookup target) but has no direct code references, confirm that read-only + append is sufficient — it does not need create/write/delete.
5. **Web role coverage:** Collect all web roles referenced across all table analyses. For each role, verify it exists in the discovered roles. If any required role does not exist, add it to a "roles to create" list that will be included in the plan and created before table permissions.
6. **Role consolidation (critical):** Group all per-table permission entries by `(table, scope, CRUD flags, append, appendto, parent, parentRelationship)`. If two or more roles produce an **identical** permission tuple for the same table, merge them into a **single** permission with multiple `webRoleIds` instead of creating separate per-role permissions. For example, if both Anonymous Users and Authenticated Users need `read-only + Global scope` on the Product table, create one permission `Product - Read` assigned to both roles — not two permissions `Product - Anonymous Read` and `Product - Authenticated Read`. This prevents count inflation and matches how Power Pages actually enforces permissions (one permission record, many role associations).

---

## Scope Reference

Available scopes:

- `756150000` — **Global**: Access all records. **Avoid whenever possible** — grants unrestricted access. Only use for truly public, read-only reference data (e.g., product catalog for anonymous browsing).
- `756150001` — **Contact**: Access records associated with the current user's contact. **Default and safest choice** for user-specific data (orders, profiles, addresses).
- `756150002` — **Account**: Access records associated with the current user's parent account. Use when business logic requires shared access within an organization.
- `756150003` — **Parent**: Access records through parent table permission relationship. Use for child tables (order items, line items) that inherit access from a parent table.
- `756150004` — **Self**: Access only the user's own contact record and records directly linked to it.

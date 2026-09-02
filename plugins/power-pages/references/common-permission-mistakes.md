# Common Table-Permission Mistakes (learned from past evaluations)

> **Read this before designing or writing ANY table permission.** These are the recurring
> mistakes an independent security evaluator has flagged most often across ~46 past graded
> generations of this exact task. They are ordered **most-frequent first**. Treat each one as a
> checklist item: after drafting your permission plan, re-read this list and confirm you did NOT
> commit any of them. Fixing a high-ranked mistake must not create a lower-ranked one — aim for a
> plan with NO issue on any line.

---

## 1. PII tables at Global scope for staff/admin roles  — *by far the most frequent (~140 flags)*

**The mistake:** Granting **Global**-scope Read on tables that carry per-person / per-family PII
(e.g. a student table exposing `guardianemail`/`homeroom`/`grade`, a teacher/staff table exposing
`email`/`phone`/`office`) to broad or line-level roles (e.g. a generic "School Staff" / "Teachers"
role). Global scope lets *every* member of that role read *every* person's record and PII, which
exceeds least-privilege need-to-know.

**How to avoid it:**
- For per-person PII tables, prefer a **record-level scope** (`Contact` / `Account` / `Parental` /
  `Self`) tied to the ownership/relationship column, so each user sees only their own related
  records.
- Reserve **Global** read on a PII table for a **dedicated, explicitly-defined org-wide staff/manager
  role** whose responsibility is unambiguously to see every person's record — NOT the built-in
  `Administrators` web role (respect the "No Administrators permissions by default" constraint; only
  grant the `Administrators` role a permission when the user explicitly asks for it). Record that
  justification in the scope rationale.
- If a genuine public directory is required, split the public-safe columns into a **separate,
  narrower permission** rather than exposing the full PII-bearing table.
- **Do NOT over-correct:** inherently public reference tables (announcements, facilities, faculty,
  leadership directory) are legitimately **Global read** — don't tighten those.

## 2. Read-only everywhere on a management/authoring site  — *~74 flags*

**The mistake:** The request implies managing / authoring / maintaining records (a "management"
site, publishing announcements, updating rosters, editing content), yet **every** permission is
Read-only — no role has any Create/Write/Delete on any table. The site cannot fulfill its stated
purpose.

**How to avoid it:** Infer CRUD from **site intent and role semantics**, not only from the
read-only GETs you observe in the frontend code. When the intent is management/administration,
grant **Create + Write (and usually Delete)** on the core managed tables to the appropriate
**staff/manager/editor** role — reserve the built-in `Administrators` web role only when the user
explicitly requests Administrators permissions (see the "No Administrators permissions by default"
constraint).

## 3. The management role is left with no CRUD  — *~14 flags*

**The mistake:** A top-tier role that should own record management (an "Administrators" /
"School Administrators" / manager / editor role) is given only Read, or nothing at all, so no one
can actually manage the data.

**How to avoid it:** Ensure **at least one management-capable role has full Read+Write+Create+Delete
on the core managed tables** via its own dedicated permission. Note: if you follow the
"No Administrators permissions by default" constraint, then a **dedicated staff/manager/editor role
MUST carry that CRUD instead** — never leave the site with zero write-capable role.

## 4. Anonymous role can read PII  — *~29 flags*

**The mistake:** Granting the **Anonymous Users** role Read on a table whose whitelisted Web API
fields include personal contact info (teacher `email`/`phone`/`office`, student `guardianemail`),
publishing PII to unauthenticated visitors.

**How to avoid it:** Anonymous read belongs **only** on genuinely public content tables
(announcements, facilities, public directory pages). Anonymous must **never** read a per-person PII
table and must **never** get write/create/delete.

## 5. Missing Delete for content-lifecycle owners  — *~6 flags*

**The mistake:** A role that owns a content table's lifecycle (already has Create + Write, e.g. for
announcements) has **no Delete**, so stale content can't be removed through the portal.

**How to avoid it:** For a content-management table where a role has Create + Write, also grant
**Delete** to that managing role — unless records must be retained for audit/history.

## 6. Duplicate / redundant permissions  — *~10 flags*

**The mistake:** The same table listed under redundant roles that already get access another way
(e.g. Administrators/Staff bundled onto a public-read permission alongside Anonymous/Authenticated),
or two separate full-access permissions on the same table for roles with identical rights.

**How to avoid it:** Consolidate. One permission per distinct (scope × CRUD) need; don't list a role
on a permission whose access it already inherits from a broader/baseline grant.

## 7. Tables left uncovered or written as blank/empty permissions  — *~52 flags (often from failed generations)*

**The mistake:** A user-facing table in the data model has **no** permission entry, OR permission
files are written with a **blank `entitylogicalname`**, no web-role association, and all CRUD bits
unset (empty shells that grant nothing).

**How to avoid it:** Every user-facing table must have at least one **valid** permission — a real
`entitylogicalname` that resolves in the data-model manifest, a non-empty
`adx_entitypermission_webrole`, a real scope, and the intended CRUD bits. Always create permissions
with the deterministic `create-table-permission.js` script (never hand-written empty YAML), and
verify each file is non-empty before finishing.

---

### Balance reminder
These mistakes pull against each other: tightening PII scope (#1) must not (a) remove the public
read Anonymous legitimately needs on public tables, (b) drop a needed role, or (c) strip the
Create/Write a management site requires (#2/#3). When in doubt, prefer the plan that has **no** flag
on any line above over one that is perfect on a single dimension but fails another.

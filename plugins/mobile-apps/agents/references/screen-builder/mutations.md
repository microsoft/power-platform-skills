# Persisted actions — load only for writes

The approved UX contract determines the operation and evidence of completion. Do not
infer “Save” from a form archetype or “Approve” from a status field. Missing approved
mutation wiring blocks completion; samples may deliberately disable unwired actions.

## Checked, narrow adapter

Reuse an imported app helper when supplied; otherwise define one inside the assigned
screen, never in shared paths. Build payloads from a `Pick` of the generated input
type's exact editable keys. Centralize an unavoidable boundary cast only when the
generated base type incorrectly requires server-managed columns.

```ts
type CreateTaskInput = { title: string; projectId?: string };
async function createTask(input: CreateTaskInput): Promise<void> {
  type Fields = Pick<Parameters<typeof TasksService.create>[0],
    'cr_name' | 'cr_projectid@odata.bind'>;
  const payload: Pick<Fields, 'cr_name'> & Partial<Pick<Fields, 'cr_projectid@odata.bind'>> = {
    cr_name: input.title,
  };
  if (input.projectId) payload['cr_projectid@odata.bind'] = `/cr_projects(${input.projectId})`;
  const result = await TasksService.create(payload as Parameters<typeof TasksService.create>[0]);
  if (!result.success) throw new Error(result.error?.message ?? 'Create failed');
}
```

Names above are illustrative: copy the actual case-sensitive `@odata.bind` key from
the generated model and verified plural entity set name. Missing key blocks; never
use raw GUIDs, read-only `_value` properties, or `Record<string, unknown>` payloads.
Store picker selection as the GUID; build the bind only at the write boundary.

Never send server-managed fields: `ownerid`, `owneridtype`, `statecode`, `statuscode`,
`importsequencenumber`, `overriddencreatedon`, `timezoneruleversionnumber`,
`utcconversiontimezonecode`, `versionnumber`, `createdon`, `modifiedon`, `createdby`,
`modifiedby`. Assignment/state changes require their supported actions, not junk
values to satisfy generated types.

## In-flight and success boundary

Use `useMutation` with the checked adapter; raw `{ success: false }` must reject before
`onSuccess`. Confirm destructive operations. Guard the handler synchronously with a
ref before calling `mutateAsync` and disable/label-swap using pending state. A second
same-tick tap must not write, invalidate, announce completion, or navigate twice.

Keep errors inline, values intact, and retry available. After verified success,
invalidate affected query keys and implement the approved success/exit path.
Do not convert cache-refresh failure after a committed write into “save failed” and
offer a duplicate create; distinguish saved-but-refresh-failed from write failure.
Ordinary forms exit with `router.back()`, or the Navigation Contracts parent via
`router.navigate(...)` without back history. Redirect only when explicitly planned.

## Sparse create responses and multi-step writes

Dataverse create success may have no data/ID (204-style). Ordinary saves return void
or an app-owned value; do not depend on `result.data.<id>`. Only when an immediate
next step needs the ID (navigation, lookup bind, child row, upload), pre-generate it
with `newId()` from `@/utils`, include the primary ID field, check success, then use
that known ID. Never search/refetch to rediscover it or encode business/user data in IDs.

Every child create/upload/audit write also needs a success check. Follow the planned
artifact parent/child boundary and keep committed IDs for targeted retry. Do not replay
successful stages or claim the entire workflow completed after partial failure.
Only emit audit writes when the spec includes `Audit`; use its event/payload and verified
service. See native reference for File/Image persistence.

Dates serialize to UTC ISO. For DateOnly, preserve picked calendar components with
`new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString()`.
Display with shared formatters or `Intl.DateTimeFormat(undefined, explicitOptions)`.

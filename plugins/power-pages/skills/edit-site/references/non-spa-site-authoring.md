# Non-SPA Site Authoring

Shared routing and execution contract for local PAC-downloaded declarative Power Pages
authoring. `/edit-site` supports individual page or component edits and
coordinated customization. These references are not independently invocable skills.
Read-only callers may consult metadata and identity rules without executing authoring.

Work only in the local downloaded site. Do not upload, deploy, activate,
modify Dataverse directly, sync to Studio, or clear caches as part of authoring.

## Dispatch and reference loading

Select the primary workflow from the requested outcome:

| Operation identifier | Requested outcome | Authoritative reference |
|---|---|---|
| `author-web-file` | Import, author, replace, rename, move, configure, or delete a site-served asset and its metadata | [Web files](web-file-authoring.md) |
| `author-content-snippet` | Create, translate, edit, rename, convert, or delete a localized or language-neutral reusable value | [Content snippets](content-snippet-authoring.md) |
| `author-web-template` | Create or modify Liquid/HTML source, fragments, inherited layouts, or header/footer source | [Web templates](web-template-authoring.md) |
| `author-page-template` | Create or modify rendering metadata, an end-to-end custom layout, or associated webpage assignments | [Page templates](page-template-authoring.md) |
| `author-webpage` | Create or modify root/localized records, routes, parents, template assignments, shells, or navigation | [Webpages](webpage-authoring.md) |
| `author-site-marker` | Create, retarget, rename, or locally remove a named same-site webpage binding with verified caller scope | [Site markers](site-marker-authoring.md) |
| `style-site` | Apply guarded CSS/source styling without changing native component structure | [Styling](style-site-workflow.md) |

`operation.skill` and `capabilities[].ownerSkill` use the identifiers in this table to
select reference workflows. Execute them directly in the coordinator.
Do not invoke these operation identifiers through the `Skill` tool.
Do not rewrite an approved plan, its identifiers, or its hash to change dispatch.

New pages update navigation by default unless the user explicitly asks not to.
Resolve placement through the webpage reference before writing. Include navigation placement
or the explicit opt-out in new customization plans; do not expand an approved execution's scope.

Read this index and
`${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, then the complete primary
reference. Load another component reference only when its records or callers are affected.
Do not preload unrelated component references, design guidance, asset planning, or plan contracts for
an individual page or component edit. The component references own PAC fields, serialization, identity, and
verification; do not invent a second interpretation in the entry skill.

Use the body-composition skill and styling workflow:

- `author-webpage-content` composes one exact existing localized body file after its
  webpage identity, locale, Bootstrap evidence, values, and preservation are resolved.
- `style-site` owns visual CSS/cascade changes and its separate exact-diff/hash approval.
  Execute its reference directly for styling-only requests; do not enter the seven coordinated
  phases or invoke it through the `Skill` tool. Asset metadata authoring must not bypass
  that workflow.

## Individual page or component edits

Use this route for one resolved component outcome or one straightforward page, including
the exact dependency changes required by its reference. Multiple independently planned
operations, new-site design, redesign, typed output bindings, or resuming an approved
execution use the coordinated workflow instead.

Show **Inspect -> Author -> Independently verify -> Report**. Phase-task bookkeeping,
browser approval documents, and a new Git baseline are not required for these edits.

1. **Locate and inspect.** Follow the shared discovery contract with the primary
   reference's required paths. Resolve exactly one declarative site and read the complete
   target files. Code-site markers are not sufficient. Preserve pre-existing dirty files.
2. **Classify and resolve.** Establish the action, stable target identity, locale scope,
   final values, affected callers, and preservation requirements. Distinguish metadata-only
   work from rendering, layout, navigation, and global binding changes.
3. **Resolve dependencies before writing.** Follow the relevant component references.
   Stop with candidates and evidence when identity, locale, source, permissions, output
   safety, or impact cannot be established. If a reference requires additional approval
   that has not been obtained, use the coordinated route and its plan approval before
   applying that change; do not infer approval from routine-edit autonomy.
4. **Execute the selected reference workflow.** Generate new IDs through
   `${PLUGIN_ROOT}/scripts/generate-uuid.js`; preserve existing IDs and unknown PAC fields.
   Make the smallest coherent change. Invoke only the content skill when its execution boundary
   is involved, passing the resolved inputs and preview handoff marker. Execute styling through
   its reference workflow and exact-diff/hash approval.
5. **Independently verify and report.** Re-read changed files and relationships, run every
   applicable reference's verification checklist and prohibited-shortcut checks, and
   review the final diff against the operation and locale scope. Report actual files,
   stable identities, routes/bindings, dependencies, and any unresolved runtime evidence.

Do not create or replace a customization plan/receipt, initialize Git, commit, or offer
automatic deployment as part of this route. A separately requested deployment
uses `/deploy-site` and its normal identity/environment/approval checks. When a current
approved execution exists, inspect its scope and resume it or establish a fresh coordinated
plan; do not silently edit outside a resumable approval.

## Autonomy and scope

Complete routine authoring without asking the user about routine implementation
details. Infer low-risk file stems, formatting, encoding, accessibility, and creation defaults
from the request, primary reference, site conventions, and comparable records.

Stop before writing when a material choice remains unresolved:

- multiple sites or records with no supported winner;
- missing or ambiguous parent, rendering source, source asset, language, or translation;
- conflicting shared metadata, filename/signature/MIME type, or output context;
- a rename, move, scope/type migration, deletion, or rebind with unresolved dependencies;
- security, visibility, response-boundary, global-binding, or permissions impact that
  exceeds the resolved request.

## Coordinated inputs and results

For an approved operation, retain the exact selected site root, action, target identity,
locales, `resolvedInputs`, caller scope, and preservation requirements. Revalidate supplied
paths and existing IDs before writing. Use approved `designContext` and any exact-plan
`imageChecks` without restarting the brief or repeating unchanged network checks.
New-site custom composition does not authorize unrelated changes, record churn, or the
loss of required native behavior. Existing-site narrow edits remain preservation-first.

Execute component operations in the coordinator. Re-read actual results before
recording the stable keys required by
`expectedOutputs`; examples include:

| Workflow | Typical verified results |
|---|---|
| Web file | `publicUrl`, site-relative `metadataPath`, web-file and annotation identities |
| Webpage | `websitePageId`, `route`, exact `localizedTargetFile` for a resolved locale |
| Web/page template | Stable template identity, source/metadata paths, actual bindings |
| Content snippet | Stable record identities, logical name, type, and language scope |
| Site marker | `siteMarkerId`, exact `name`, target `pageId`, and site-relative `metadataPath` |

The approved operation defines the output keys; these examples do not change its contract.
Do not predict generated IDs or URLs, substitute unresolved tokens, or manufacture a missing
output. Complete an operation only after its reference verification succeeds; failure must
remain explicit in the execution receipt.

## Entry-point behavior

The entry skill owns its version check and
`${PLUGIN_ROOT}/references/non-spa-preview.md` disclosure. When invoking a
covered skill, forward `previewNoticeShown: true` and
`invocationSource: edit-site` only after the notice was displayed.
Reading another reference is not another preview entry or skill invocation.

Record successful entry-point usage through
`${PLUGIN_ROOT}/references/skill-tracking-reference.md` as `EditSite`.
Record only skill invocations, not reference reads. Preserve existing tracking records;
never create a tracking directory merely to record non-SPA authoring.
Report any supported tracking diff separately from authored site changes.

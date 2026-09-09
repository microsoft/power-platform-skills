# Requirements Discovery Reference

Read only when the foreground `/create-mobile-app` flow needs to clarify an incomplete brief. Do not run a generic feature questionnaire for a brief that already identifies actors, tasks, outcomes, and integrations.

## Ground the brief

Capture who acts, what they are trying to do, how they enter/resume, what decision they make, the committed outcome, the next destination, and recovery after interruption. Separate confirmed facts, inferred context, and unknowns. Color, industry, or schema size does not establish a workflow or native capability.

Ask only about uncertainty that changes primary work, data ownership/persistence, authorization, an external integration, or native feasibility. The **foreground** owns questions and approval. A leaf agent returns `NEEDS_CONTEXT: <missing fact and consequence>`, never prompts the user or fabricates approval.

## Evidence-to-requirement mapping

The following are interpretations to check against the actual brief, not automatic feature selections:

| Evidence in the brief | Requirement to record | Do not infer |
|---|---|---|
| Log, record, submit, fill out | A task with a capture/edit host and defined save outcome | A separate CRUD screen for every related table |
| Take a photo, scan with camera | Camera/scanner use, permission/failure fallback, persistence if retained | Gallery selection, annotation, or background capture |
| Choose an existing photo/image | Image picker and target if retained | Camera permission merely because an image is attached |
| Attach, evidence | Determine the artifact/source only if it changes capture/storage | Camera or Dataverse Image from generic attachment alone |
| Pick file, upload PDF, import document | Document picker; local/retained destination as required | PDF generation or viewing |
| Generate/export a PDF report | PDF generation; on-device/share-only or retained destination | Document picker from the word PDF |
| View/open/preview a PDF | Native PDF viewer with supported input | A picker or generation pipeline |
| Draw a signature, ink, pen drawing | Pen-input capture, cancellation/failure path, explicit Image/File/child-table target | An approval workflow by itself |
| Approve, reject, authorize, sign off | Decision/action, role rules, reason/audit if required, committed state change | Handwritten signature, biometrics, or PIN; clarify ambiguous "sign" only when consequential |
| One current coordinate, tag with coordinates | One-shot location | Continuous/background tracking |
| Continuous GPS/background route tracking | Geolocation with permission, start/stop/status, supported Dataverse target | Tracking from "field worker" or "site visit" alone |
| Device share sheet, share a local file | Device sharing | Teams, email delivery, or server retention |
| Notify, alert, send, share | Delivery channel/recipient only when specified; clarify if essential | Office 365 connector or push capability from a generic verb |
| Store a token/credential securely on device | Secure-store if app-owned local secrets are actually needed | Custom auth/PIN screens from the adjective "secure" |
| Assign work, manager/technician roles | Actor responsibilities and relevant permission boundaries | A separate admin app or team connector |
| Explicit SharePoint site/list/library as data source | SharePoint connector and actual list/library contract | SharePoint from generic "list", "document", or "history" |
| Explicit Microsoft Teams channel/chat integration | Teams connector and intended operation | Teams from generic "chat" or "message" |
| Generic in-app chat/message feed | Conversation task, participants, actual data/delivery source | A named external provider without evidence |
| Report, history, view all | Needed read/comparison outcome and data scope | Dashboard, KPI tiles, or an independent screen by keyword alone |
| Audit, inspect, compliance check | Clarify whether users perform a checklist/evidence workflow, review historical changes, or both | A custom Audit Event table, change-log screen, or inspection workflow from the word alone |

A generic list/document can use Dataverse, another service, or local content. A generic chat can be app-owned. Do not present unrequested connectors as preselected "recommended" features.

## Native and artifact feasibility

Resolve native requirements through [native capability proposals](../../../agents/native-app-planner.md#native-capability-proposals), which checks the live `template/package.json` and [add-native allowlist boundary](../../add-native/SKILL.md). An absent or runtime-banned module is a feasibility constraint, not a capability to promise. Pure JavaScript follows [dependency planning](../../../shared/references/javascript-dependency-planning.md), not the native allowlist.

- PDF viewing requires `@microsoft/power-apps-native-pdf-viewer` 0.2.9+ for HTTPS or local `file://`; no `content://`, `blob:`, or `http://` viewer input.
- Local PDF generation requires `expo-print`; sharing requires `expo-sharing` when shipped and requested. Retention requires a Dataverse File column or Attachment/Evidence table with a verified write path.
- Signature/ink capture needs an explicit target in `native-app-plan.md`; a successful local capture is not proof of upload/retention.
- Continuous/background tracking uses `geolocation` (`@microsoft/power-apps-native-bglocation`, MSAL-only) with an existing Dataverse table: default entity set `msdyn_locationrecords`, or verified custom `tableName`/`fieldMap`.
- `/add-native geolocation` must verify that control table; a missing table is provisioned through the geolocation-control setup, not `/add-dataverse`. Do not use the control until verification succeeds.
- One-shot foreground location uses `location` (`expo-location`), not the background control.
- An offline profile does not provide a generated runtime queue. Record supported retry/draft behavior; seek foreground clarification only if required offline operation cannot be met.

## Consequential questions through the foreground

Use the smallest focused question that resolves the branching decision; do not reconfirm all inferred features. Examples:

- When one action may create another record or change another state, ask the missing rule directly:
  "Should <action> only record the result, trigger <related action>, or wait for review?"
  Fill placeholders from the maker's vocabulary. Do not assume coupled transitions because records relate.
- When several roles are implied but consequential authority is unclear, ask:
  "Who can perform <specific transition>?" Record UI visibility, server-side authorization, and
  any separate verification step; role names alone do not grant permission.
- When completing work may imply a second business outcome, ask whether that outcome is automatic,
  separately verified, or explicitly decided by another role. Ask only when the brief leaves a
  consequential dependency unresolved; do not assume that all transitions must remain independent.
- "When you say audit, do users perform a scheduled checklist/inspection, review a history of
  changes, or both?" — only when the requested audit meaning changes the work or records.
- "Does sign-off mean recording an approve/reject decision, or capturing a drawn signature?" — only if the brief leaves this important distinction unresolved.
- "Should messages stay inside the app, or be sent to an existing Teams channel?" — only if external delivery is required but its destination is unclear.
- "Are these documents already in a SharePoint library, or should the app retain newly uploaded files?" — only when the source/ownership affects integration work.

Question priority:

1. Primary job/outcome or actor authority that changes product behavior.
2. Data/system ownership needed to make approved operations real.
3. Native feasibility or disconnected/offline requirement that changes the workflow.
4. Brand/content input only when supplied or explicitly requested; no-brand design can proceed.

Do not ask "how many screens," generic fidelity, or a feature checklist when the request already
asks for a complete mobile app. Derive the smallest coherent screen set and a clickable intent
preview. Optional preview depth, style comparisons, galleries, existing-code import, and real
content upload belong to their explicit standalone/edit/design paths—not the ordinary create wizard.

Do not ask about decorative preferences here, force an option count, or present unrelated extras. If facts already answer the question, proceed without it.

Summarize the confirmed brief compactly: actors/jobs, outcomes, supporting data, explicit integrations/native needs, and consequential constraints. Store as `<requirements_brief>` through the existing foreground plan/approval flow; do not add a duplicate "Look right?" gate after an already approved brief. Reversible assumptions are recorded, not turned into repeated questions.

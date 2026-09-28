# Requirements Discovery Reference

Use this only for Step 2b.1 of `/create-mobile-app` when prompt richness selects the `walk-through` path.

## Infer Options From The Brief

Scan the user's description and wizard answers for these signals, then confirm inferred items with one `AskUserQuestion`.

| Signal in description | Infer |
|---|---|
| "log", "record", "submit", "fill out" | Data entry / form screens |
| "photo", "attach", "image", "camera" | Camera capability; storage target is resolved at the architecture gate |
| "pick file", "upload PDF", "import document", "attach file" | Document-picker capability; storage target is resolved at the architecture gate |
| "generate PDF", "export report", "print report", "evidence packet", "certificate PDF" | PDF-report capability; retention target is resolved at the architecture gate |
| "view PDF", "open PDF", "preview PDF" | Native PDF viewer capability for HTTPS URLs or local `file://` URIs with viewer |
| "signature", "sign", "sign off", "approval", "pen", "ink", "draw" | Pen-input capability; storage target is resolved at the architecture gate |
| "track location", "background location", "GPS tracking", "follow route", "breadcrumb", "field worker location" | Geolocation capability (`@microsoft/power-apps-native-bglocation`) + Dataverse location table (default `msdyn_locationrecords`) |
| Explicit request for Microsoft's barcode/QR control or `@microsoft/power-apps-native-barcode-scanner` | `native-barcode-scanner` from the OOB controls reference; generic scan requests retain the existing Expo flow |
| "current location", "where am I", "tag with coordinates", "one-shot location" | One-shot location capability (`expo-location`) |
| "share", "send to", "export" | Sharing capability |
| "secure", "credentials", "token", "PIN" | Secure-store capability |
| "assign", "technician", "manager" | Multiple user types |
| "notify", "email", "alert" | Office 365 connector |
| "SharePoint", "list", "document" | SharePoint connector |
| "Teams", "chat", "message" | Teams connector |
| "report", "dashboard", "history", "view all" | Read/list screens |

Resolve every native signal against the live `template/package.json` plus the allowlisted Microsoft OOB controls in [Microsoft control dependency setup](${PLUGIN_ROOT}/skills/add-native/references/oob-controls.md). Microsoft OOB controls can be planned with an on-demand app dependency addition; do not exclude them just because the template omits them. For any other absent native package or any runtime-banned package, surface a transparency note instead of pretending support exists. Use `agents/native-app-planner.md` Step 3.0 as the canonical planning gate.

Apply the shared
[`connectivity-intent-ownership.md`](${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md)
contract during feature inference.

PDF/pen rules:
- Do not infer `document-picker` from generic "PDF" alone; use the specific signal rows above.
- Native PDF viewing supports HTTPS URLs and local `file://` URIs with `@microsoft/power-apps-native-pdf-viewer`.
- Local generated PDFs require `expo-print`; preview requires native PDF viewer, while sharing requires `expo-sharing`.
- Retained generated PDFs use a Dataverse File column or child
  Evidence/Attachment table only when Dataverse is approved; otherwise use an
  approved connector-owned or on-device/share-only target.
- Signature/ink capture must record the Gate 1-approved target in
  `native-app-plan.md`: Dataverse Image/File/child row, connector-owned storage,
  or on-device/share-only.
- Background/continuous location tracking uses the `geolocation` capability (`@microsoft/power-apps-native-bglocation`, MSAL-only) and requires an existing Dataverse target table (default entity set `msdyn_locationrecords`, or a custom `tableName` whose `fieldMap` columns exist). `/add-native geolocation` must verify that table; if it is missing, do not allow the control to be used. The missing control table is not created through `/add-dataverse`; use the geolocation-control table provisioning/setup mechanism, then re-run `/add-native geolocation`. Use one-shot `location` (`expo-location`) for a single foreground coordinate read; do not conflate the two.

## Ask Shape

Ask exactly one structured question. Inferred items are `recommended: true`; plausible extras are unselected. Keep 2-6 options total and allow freeform input.

```json
{
  "questions": [
    {
      "header": "features",
      "question": "Which of these should the app do? (multi-select -- add anything else as freeform text)",
      "multiSelect": true,
      "options": [
        { "label": "Log inspection visits with date, notes, status", "recommended": true },
        { "label": "Attach photos to each visit", "recommended": true },
        { "label": "Assign visits to specific technicians" },
        { "label": "Email manager on completion" }
      ]
    }
  ]
}
```

Rules:
- Use the `header` field as a stable answer key, such as `features`.
- Never include `[x]` or `[ ]` checkbox markdown in the `question` field; it produces invalid tool parameters.
- Ask no unrelated questions in this call.

After the answer, summarize the confirmed requirements brief in 4-8 bullets covering what users can do, tracked data, and integrations. Confirm once with `Look right? (yes / adjust)`, then store the result as `<requirements_brief>`.
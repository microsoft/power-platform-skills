# Requirements Discovery Reference

Use this only for Step 2b.1 of `/create-mobile-app` when prompt richness selects the `walk-through` path.

## Infer Options From The Brief

Scan the user's description and wizard answers for these signals, then confirm inferred items with one `AskUserQuestion`.

| Signal in description | Infer |
|---|---|
| "log", "record", "submit", "fill out" | Data entry / form screens |
| "photo", "attach", "image", "camera" | Camera capability + image column |
| "pick file", "upload PDF", "import document", "attach file" | Document-picker capability + optional Dataverse File column |
| "generate PDF", "export report", "print report", "evidence packet", "certificate PDF" | PDF-report capability + optional Dataverse File column when retained |
| "view PDF", "open PDF", "preview PDF" | Native PDF viewer capability for HTTPS PDF URLs only |
| "signature", "sign", "sign off", "approval", "pen", "ink", "draw" | Pen-input capability + Dataverse Image/File storage target |
| "track location", "background location", "GPS tracking", "follow route", "breadcrumb", "field worker location" | Geolocation capability (`@microsoft/power-apps-native-bglocation`) + Dataverse location table (default `msdyn_locationrecords`) |
| "current location", "where am I", "tag with coordinates", "one-shot location" | One-shot location capability (`expo-location`) |
| "share", "send to", "export" | Sharing capability |
| "secure", "credentials", "token", "PIN" | Secure-store capability |
| "assign", "technician", "manager" | Multiple user types |
| "notify", "email", "alert" | Office 365 connector |
| "SharePoint", "list", "document" | SharePoint connector |
| "Teams", "chat", "message" | Teams connector |
| "report", "dashboard", "history", "view all" | Read/list screens |

Do not infer capabilities the template does not ship. Resolve every native signal against the live `template/package.json`; if a package is absent or runtime-banned, surface that as a transparency note instead of pretending the capability exists. Use `agents/native-app-planner.md` Step 3.0 as the canonical native allowlist.

PDF/pen rules:
- Do not infer `document-picker` from generic "PDF" alone; use the specific signal rows above.
- Native PDF viewing supports HTTPS URLs only and requires `@microsoft/power-apps-native-pdf-viewer`.
- Local generated PDFs require `expo-print`; share/open behavior also requires `expo-sharing`.
- Retained generated PDFs require a Dataverse File column or child Evidence/Attachment table.
- Signature/ink capture must record a Dataverse target in `native-app-plan.md`: Image column, File column, or child Evidence/Signature table.
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
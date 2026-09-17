# SharePoint report model

Use this schema when preparing data for `scripts/render-sharepoint-artifact.js`.
Keep report content in this model and let the plugin template own presentation.
The renderer rejects unknown fields and unsupported block types.

## Report

| Field | Value |
|---|---|
| `version` | `1`. |
| `artifact` | `requirements`, `discovery`, `plan`, or `progress`. |
| `title` | Non-empty report title. |
| `updatedAt` | Non-empty timestamp of the recorded content update. |
| `phase` | Non-empty human-readable phase/status, such as `Phase 2 - Intake`. |
| `links` | All four records, each `{ artifact, label, href }`; `href` is the actual neighboring HTML filename, without a directory or URL. |
| `sections` | Ordered `{ id, title, blocks, detail? }` entries. IDs are unique lowercase slugs and must not collide with renderer controls or generated heading IDs; `overview` is reserved for the summary. Use `detail: true` for supporting evidence/history rather than the main brief. |
| `summary` | Required, non-empty rich text. In a few sentences, explain the subject, current scope/result, key gap, and next action. Older records without a summary remain readable for migration but require one before regeneration. |
| `metadata` | Optional rich text for technical context preserved in the supporting record. |
| `footer` | Optional rich text; otherwise the template displays its local-working-record notice. |

Example initial requirements record:

```json
{
  "version": 1,
  "artifact": "requirements",
  "title": "Requirements",
  "updatedAt": "2026-09-16T14:00:00Z",
  "phase": "Phase 2 - Intake",
  "summary": "The maker has chosen an authenticated customer portal. The current goal is a local React preview; source fields and cloud setup are not yet approved. Confirm the source and read-only content scope before discovery.",
  "links": [
    { "artifact": "requirements", "label": "Requirements", "href": "sharepoint-requirements.html" },
    { "artifact": "discovery", "label": "Discovery", "href": "sharepoint-discovery.html" },
    { "artifact": "plan", "label": "Plan", "href": "sharepoint-migration-plan.html" },
    { "artifact": "progress", "label": "Progress", "href": "sharepoint-migration-progress.html" }
  ],
  "sections": [
    {
      "id": "scope",
      "title": "Current scope",
      "blocks": [
        {
          "type": "facts",
          "items": [
            { "label": "Audience", "value": "Authenticated customers outside the organization." },
            { "label": "Delivery", "value": "Local preview; no cloud resources or copied source data." },
            { "label": "Next action", "value": "The maker needs to identify the source and approve the inspection scope." }
          ]
        }
      ]
    }
  ]
}
```

Replace the example content, timestamp, phase, and paths with the actual record.
The example is illustrative, not a default set of facts to assume.
Add gathered facts and their implications to the appropriate reader-facing section, retaining detailed evidence in supporting sections.

## Rich text

A rich-text value is either a string or an ordered array of inline runs.
Every run has `kind` and `text`.

| `kind` | Additional fields | Rendering |
|---|---|---|
| `text` | None | Plain text. |
| `strong` | None | Emphasized factual label. |
| `emphasis` | None | Italic text. |
| `code` | None | Code, field name, or path. |
| `badge` | `tone`: `neutral`, `info`, `success`, `warning`, or `danger` | Status/provenance label. |
| `link` | `href`: HTTPS URL without credentials, neighboring HTML filename, or section fragment | Explicit source/reference link, including the create-site plan. |

Use explicit text runs for spaces between adjacent badges or emphasized phrases.
Newlines in text are preserved.
Badge tone is presentation, not proof of approval; the recorded evidence establishes status.

## Blocks

| `type` | Required fields | Optional fields |
|---|---|---|
| `paragraph` | `content`: rich text | None |
| `heading` | `text`: non-empty string | `level`: `3` or `4`; defaults to `3` |
| `list` | `items`: rich-text values | `ordered`: boolean |
| `facts` | `items`: `{ label: non-empty string, value: rich text }` entries | None |
| `table` | `columns`: non-empty string array; `rows`: arrays of rich-text cells | `emptyMessage`: text shown when there are no rows |
| `callout` | `tone`: one of the badge tones; `blocks`: nested blocks | None |
| `code` | `text`: string | None |

Each table row must have exactly one cell per column.
Use `rows: []` with `emptyMessage` for an empty table rather than fabricating records.
Nested callouts are limited to eight levels.
Raw HTML, arbitrary CSS, executable code, and embedded source pages are not model types.
The renderer generates complete HTML rather than requiring JavaScript to display the record.
Main sections form a continuous document; `detail: true` sections remain available under “Detailed record and evidence.”

## Preserve existing records

When converting older HTML, preserve the reading order, headings, paragraphs, list items, table cells, status labels, provenance, timestamps, links, and decision history.
Preserve approved facts and decision history.
When improving a handoff, synthesize plain-language current summaries from the evidence and mark earlier contradictory wording as historical rather than treating both as current.
Compare the old and new text before adopting the generated report.
For a full-width empty table row, carry its text into `emptyMessage`.
If a source element cannot be represented safely, pause and explain the mismatch instead of dropping it.

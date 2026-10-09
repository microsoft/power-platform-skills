# Genpage Edit Plan

## User Request
Add sorting only.

## Target
Existing page 88888888-8888-4888-8888-888888888888 in app 11111111-1111-4111-8111-111111111111.
This independent edit starts from edit/config-before.json and edit/page-before.json.

## Preservation Constraints
Keep the own name "Renamed Revenue $100", the separate sitemap title "Revenue Overview", model gpt-4.1, account data source, both connectors and both Custom APIs.

## Connector Changes
None. Omit --connectors.

## Custom API Changes
None. Omit --actions.

## Changes
Local sorting only. Omit name-file and model; the wrapper reads and re-sends the current values.

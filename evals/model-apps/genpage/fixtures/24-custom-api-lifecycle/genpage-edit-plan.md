# Genpage Edit Plan

## Preserve-only edit
Change the panel spacing; keep both Custom API controls and bindings.
Omit --actions so the existing actionBindings survive.

## Explicit clear edit
Remove both Custom API controls and all Custom API bindings.
Write [] to clear-actions.json and pass --actions.
Keep the page id, own name, model and salesorder data-source binding.

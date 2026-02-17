# PAC CLI Reference for Generative Pages

Official documentation: https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/model

---

## Authentication

```powershell
# Create new auth profile
pac auth create --environment https://your-env.crm.dynamics.com

# List auth profiles (* = active)
pac auth list

# Select active profile by index
pac auth select --index <n>
```

---

## Schema Generation

Generate TypeScript types from Dataverse entity metadata. **Must be run before code generation for entity-based pages.**

```powershell
pac model genpage generate-types --data-sources "account,contact" --output-file RuntimeTypes.ts
```

---

## App and Page Listing

```powershell
# List all model-driven apps in the environment
pac model list

# List all genux pages in a specific app
pac model genpage list --app-id <app-id>
```

---

## Upload New Page

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --code-file page.tsx `
  --name "Page Display Name" `
  --data-sources "entity1,entity2" `
  --prompt "Description of the page" `
  --add-to-sitemap
```

---

## Upload Update to Existing Page

```powershell
pac model genpage upload `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file page.tsx `
  --data-sources "entity1,entity2" `
  --prompt "Summary of changes"
# --name is optional when updating; omit to keep existing name
```

---

## Download Existing Page

```powershell
pac model genpage download `
  --app-id <app-id> `
  --page-id <page-id> `
  -o ./output-dir
```

---

## Key Parameters

| Parameter | When Required | Notes |
|-----------|--------------|-------|
| `--app-id` | Always | Get from `pac model list`. Use the GUID. If user gives app name, look up the GUID first. |
| `--code-file` | Always (upload) | Path to `.tsx` file |
| `--name` | New pages only | Display name. Optional on updates (omit to keep existing). |
| `--page-id` | Updates only | Get from `pac model genpage list` |
| `--data-sources` | Entity pages | Comma-separated logical names matching code + schema |
| `--prompt` | Always (upload) | Original user request or summary. Essential for context. |
| `--add-to-sitemap` | New pages only | Adds page to app navigation. Do NOT use on updates. |

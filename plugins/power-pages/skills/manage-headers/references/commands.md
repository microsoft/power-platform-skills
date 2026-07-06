# Manage Headers — Commands

## Table of contents

- [`create-site-setting.js` (shared)](#create-site-settingjs-shared)
- [`transform-headers.js`](#transform-headersjs)

---

## `create-site-setting.js` (shared)

Use the shared script to create new `HTTP/*` site-setting YAML files:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" --projectRoot "<project-root>" --name "<setting-name>" --value "<value>" --description "<description>"
```

The script generates a UUID, checks for duplicates, and writes the YAML file to `.powerpages-site/site-settings/`.

To update an existing setting, use the `Edit` tool directly on the YAML file — do not use this script (it rejects duplicates).

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success — new YAML file created. |
| `1`  | Failure — duplicate setting, missing args, or write error. |

The script validates inputs and exits with a descriptive error if arguments are missing or the setting already exists.

---

## `transform-headers.js`

Reads every `HTTP/*` site-setting YAML in `.powerpages-site/site-settings/` and emits the unified findings shape used by the consolidated security review. Read-only — does not modify any file.

### Usage

```bash
node "${PLUGIN_ROOT}/skills/manage-headers/scripts/transform-headers.js" --projectRoot "<project-root>" [--annotations "<path>"]
```

### Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--projectRoot` | Yes | Power Pages project root (the folder that contains `.powerpages-site/`). |
| `--annotations` | No | Path to an agent-written annotations JSON file. Shape: `{ "headers": { "HTTP/<HeaderName>": { "description": "...", "fix": "..." } } }`. Used to add plain-language descriptions and optional fixes to the emitted findings. |

### Response (stdout)

```json
{ "status": "ok", "findings": [ ], "details": {} }
```

…or, when `.powerpages-site/site-settings/` is absent:

```json
{ "status": "missing-settings", "findings": [], "details": {} }
```

Each finding has the inventory shape `{ id, title, details, fix? }` — no `severity` and no `tag` (the section is informational; the orchestrator does not roll these up into severity totals, and the header name already appears as the `title`). `details` contains the agent-supplied description (when annotations were passed) followed by the current value. `fix` is present only when the annotations file supplied one for that header.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success (also returns `missing-settings` when `.powerpages-site/site-settings/` is absent). |
| `1`  | Invocation error (missing `--projectRoot`). |

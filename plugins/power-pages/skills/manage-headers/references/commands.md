# Manage Headers — Commands

## Creating a new site setting

Use the shared script to create new `HTTP/*` site-setting YAML files:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<setting-name>" \
  --value "<value>" \
  --description "<description>"
```

The script generates a UUID, checks for duplicates, and writes the YAML file to `.powerpages-site/site-settings/`.

To update an existing setting, use the `Edit` tool directly on the YAML file — do not use this script (it rejects duplicates).

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success — new YAML file created. |
| `1`  | Failure — duplicate setting, missing args, or write error. |

The script validates inputs and exits with a descriptive error if arguments are missing or the setting already exists.

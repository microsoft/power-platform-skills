# Detect publisher prefix

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 1.7 | Step 1.7 |
| the planning step | Step 10 | Step 3 |

<!-- The step starts here; everything above is about the file. -->

Detect the publisher prefix for the env's Default solution so the planner uses the correct prefix rather than assuming `cr_`.

**Deferred execution:** do not run the query at this point. The architecture
gate first selects `required` or `connector-only`; only `required` runs execute
the block below. Connector-only runs set
`$DETECTED_PUBLISHER_PREFIX = ""` and make no Dataverse prefix query.

```bash
PUBLISHER_PREFIX_JSON=$(node "${PLUGIN_ROOT}/scripts/detect-publisher-prefix.js" \
  "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID")
echo "$PUBLISHER_PREFIX_JSON"
```

Output is one line of JSON, e.g.:

```json
{"prefix": "cr8142a", "source": "detected"}
{"prefix": null, "reason": "no token (run `az login --tenant <env-tenant>`)"}
```

The script queries the Default solution's publisher via:
`/api/data/v9.2/solutions?$select=uniquename&$expand=publisherid($select=customizationprefix)&$filter=uniquename eq 'Default'`

A second solution name can be passed as a second argument if the env uses a different solution (defaults to `'Default'`).

**Token tenant note:** the script's `getAuthToken` discovers the env's tenant ID from the Dataverse HTTPS auth challenge and passes `--tenant <env-tenant>` to `az`, so detection works even when the active az identity is on a DIFFERENT tenant. If the user has not run `az login --tenant <env-tenant>` at any point, detection may return null.

**Stash the result for the planning step (planner spawn):**

| Output | Stash as | Behavior at the planning step |
|---|---|---|
| `{"prefix": "cr8142a", ...}` | `$DETECTED_PUBLISHER_PREFIX = "cr8142a"` | Pass to planner prompt as a fact: *"Publisher prefix (detected from env): `cr8142a_`"* |
| `{"prefix": null, ...}` | `$DETECTED_PUBLISHER_PREFIX = ""` (empty) | Pass to planner as: *"Publisher prefix: NOT DETECTED — use placeholder `cr_` and warn the user that Dataverse will normalize the actual prefix at create time."* |

Do NOT block on null detection — the user can still proceed; the Power Apps CLI normalizes prefixes when `pa app add data-source` runs. The detection step is purely to make the plan output accurate.

If the script exits non-zero (rare — should always exit 0 with `prefix: null`), treat it as the null case and continue.

## Phase 3: Gather Site and Destination Configuration

<!-- not-a-gate: creation parameters are data gathering; Phase 4 is the final cloud-mutation gate -->

Ask the user:

- Site name
- Destination: current directory, a new child folder, or another directory

Use `BASE_LANGUAGE_LCID` as `SELECTED_BASE_LANGUAGE` without asking a language question during the
normal flow. It is the confirmed environment's Dataverse organization default and is already
valid for that organization. Set `SELECTED_BASE_LANGUAGE_SOURCE` to `Organization default`. Do not
silently replace it with English `1033`.

If the user explicitly requested a different base language, handle that intent before the
provisioning review. Ask for a human-readable language, not a raw LCID, and use only a language
verified as enabled in the selected Dataverse organization. Store its LCID as
`SELECTED_BASE_LANGUAGE` and set `SELECTED_BASE_LANGUAGE_SOURCE` to `User selected`. If the
requested language cannot be verified, explain the problem and do not continue to the provisioning
review until the user accepts the organization default or selects a verified alternative. Never
guess an LCID.

Generate the same random subdomain suggestion used by the SPA activation workflow:

```bash
node "${PLUGIN_ROOT}/skills/activate-site/scripts/generate-subdomain.js"
```

Store stdout as `SUGGESTED_SUBDOMAIN`. It has the Power Pages Studio-style form
`site-<five base-36 characters>`.

Collect the subdomain as one editable text field pre-populated with the suggestion:

| Question | Header | Default value |
|---|---|---|
| Subdomain | Subdomain | `<SUGGESTED_SUBDOMAIN>` |

The field remains editable so the user can replace the suggestion before submitting it. Store the
submitted value as `SUBDOMAIN`; never append another random suffix or otherwise change it.

Validate before any cloud mutation:

- Site name is non-empty and no longer than 200 characters.
- The confirmed subdomain contains 2-63 lowercase letters, numbers, or hyphens and does not
  start/end with `-`.
- Destination resolves to a concrete path.
- Destination does not contain an unrelated Power Pages project.
- A non-empty destination requires a different directory; do not overwrite.

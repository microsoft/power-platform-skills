# Retained Apple signing keychain

Use `scripts/manage-apple-signing-keychain.js` for every provisioning or build
command that needs signing identities:

```bash
node "${PLUGIN_ROOT}/scripts/manage-apple-signing-keychain.js" \
  --project-root . --timeout 3600 -- /absolute/path/to/command arg
```

The helper derives a stable project fingerprint from the real project path and
retains `signing.keychain-db` under the user's `~/Library/Application Support`
tree, outside the repository. It rejects repository destinations, symlinked
roots/components, and mismatched retained state.

The password is generated without terminal echo with `SecRandomCopyBytes`,
stored as a generic-password item explicitly in the login Keychain, retrieved through Security
framework APIs, and passed only as in-process bytes to keychain APIs. It is
never printed, placed in argv/environment/project files, or exposed to
Fastlane. The helper temporarily prepends and unlocks the signing keychain,
configures lock-on-sleep plus a bounded timeout, runs the child command, and
restores the prior search list on success or failure.

For `/build-ios`, use the helper once for the live selected-mode signing proof
and again around `npm run build:ios`, so Wrap sees the same dedicated keychain.
The proof command is `scripts/verify-apple-ios-build-signing.js`; it emits only
safe Team/bundle/mode/APNs fields and booleans. Never log the child command with
expanded signing details or add passwords, certificate names, profile UUIDs,
device UDIDs, or the raw keychain path to `wrap.config.json`.

Missing, corrupt, or half-present retained state fails closed. Recovery is
explicit: preserve/archive the retained keychain and reset its matching login
Keychain generic-password item together. The helper never silently deletes
either asset. Its successful handoff contains only `serviceIdentifier` and
`pathFingerprint`; raw external paths and passwords are not handoff fields.

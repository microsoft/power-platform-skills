# Power Apps YAML validation runtime

`power-apps-yaml-runtime.cjs` is a checked-in, offline CommonJS bundle used by the mobile-app modernizer. It contains only the YAML parser and Draft-07 validator needed to validate untrusted `*.pa.yaml` source before semantic extraction.

Pinned direct dependencies:

- `yaml@2.9.0`
- `ajv@8.20.0`

Regenerate from the repository root with Node.js 22 or later:

```bash
npm install --prefix /tmp/mobile-schema-validator --ignore-scripts --no-audit --no-fund \
  yaml@2.9.0 ajv@8.20.0 esbuild@0.25.6
NODE_PATH=/tmp/mobile-schema-validator/node_modules \
  /tmp/mobile-schema-validator/node_modules/.bin/esbuild \
  plugins/mobile-apps/scripts/lib/vendor/power-apps-yaml-runtime.entry.cjs \
  --bundle --platform=node --format=cjs --target=node22 \
  --legal-comments=eof \
  --outfile=plugins/mobile-apps/scripts/lib/vendor/power-apps-yaml-runtime.cjs
```

Review the generated dependency graph, update `power-apps-yaml-runtime.lock.json` with the exact package graph plus bundle SHA-256/byte count, and update `THIRD_PARTY_NOTICES.md` in the same change. The schema test verifies the committed checksum. Runtime conversion never invokes npm or accesses the network.

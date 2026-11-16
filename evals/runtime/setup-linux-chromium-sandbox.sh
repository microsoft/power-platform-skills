#!/usr/bin/env bash
set -euo pipefail

# Ubuntu restricts user namespaces for downloaded Chromium builds. Allow only
# Playwright's installed headless executable so its sandbox stays enabled.
# https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
browser="$(node -e "const { registry } = require('./evals/runtime/node_modules/playwright-core/lib/server/registry'); process.stdout.write(registry.findExecutable('chromium-headless-shell').executablePath())")"
if [[ ! "$browser" =~ ^/[-a-zA-Z0-9_./]+$ ]] || [[ ! -x "$browser" ]]; then
    echo "Cannot configure AppArmor for Chromium: invalid or missing executable" >&2
    exit 1
fi

printf '%s\n' \
    'abi <abi/4.0>,' \
    'include <tunables/global>' \
    "profile power-platform-eval-chromium \"$browser\" flags=(unconfined) {" \
    '  userns,' \
    '}' | sudo apparmor_parser -r

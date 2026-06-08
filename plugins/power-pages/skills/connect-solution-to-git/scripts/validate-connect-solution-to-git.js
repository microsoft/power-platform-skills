#!/usr/bin/env node
/**
 * validate-connect-solution-to-git.js — Thin alias to the shared validator.
 *
 * Both `setup-git-integration` and `connect-solution-to-git` write the same
 * `.git-integration-manifest.json` + `docs/inner-loop/last-setup.json` pair,
 * so the validation logic is identical. Keep this file as a tiny re-export
 * rather than duplicating the helper, so any future change to the manifest
 * schema lands in exactly one place.
 *
 * The hook runner (powerpages-hook-utils.js) looks up `validatorScript` per
 * skill name and runs whatever file is at that path — having two paths
 * resolve to one implementation is fine.
 */

'use strict';

// Re-execute the shared validator as the entry point. spawnSync-style
// `require(...)` would attach the inner-loop runner's stdin/stdout to ours,
// which is exactly what we want — runValidation reads stdin and writes the
// same outputs. The shared script self-bootstraps via `runValidation(...)`.
require('../../setup-git-integration/scripts/validate-setup-git-integration');

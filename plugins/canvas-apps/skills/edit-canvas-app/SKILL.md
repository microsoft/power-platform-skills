---
name: edit-canvas-app
version: 1.0.0
description: Edit an existing Power Apps canvas app. USE WHEN the user wants to modify, update, change, or edit an existing Canvas App or pa.yaml files.
author: Microsoft Corporation
user-invocable: true
---

# Edit a Canvas App

Make the following changes to the existing Canvas App:

$ARGUMENTS

## CRITICAL: Review Guidance First

Before making any changes, you MUST read and internalize the technical reference document:

- `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md` — Technical best practices, control selection, validation workflow, formulas, layout strategies

Read this file before planning any edits.

## CRITICAL: Sync the Canvas App First

Before editing any YAML files, call the `sync_canvas` MCP tool to ensure a local copy of the canvas app YAML is present and up to date. This pulls the current app state from the coauthoring session into local `.pa.yaml` files.

Only proceed to edit the YAML files after `sync_canvas` completes successfully.

## Editing Workflow

1. **Read** the synced `.pa.yaml` files to understand the current app structure
2. **Plan** the changes needed to satisfy the requirements — identify which screens and controls are affected
3. **Edit** the YAML files with the required changes, following conventions from TechnicalGuide.md
4. **Validate** by calling `compile_canvas` after making changes — fix any errors before finishing

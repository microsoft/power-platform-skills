#!/usr/bin/env node

// Validates cloud flow consumer metadata files created by the add-cloud-flow skill.
// Checks all .cloudflowconsumer.yml files in .powerpages-site/cloud-flow-consumer/.
// Runs as a PostToolUse hook when the add-cloud-flow skill completes.

const fs = require('fs');
const path = require('path');
const {
  approve,
  block,
  runValidation,
  findProjectRoot,
  UUID_REGEX,
} = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const cloudFlowDir = path.join(projectRoot, '.powerpages-site', 'cloud-flow-consumer');
  if (!fs.existsSync(cloudFlowDir)) return approve();

  const flowFiles = fs
    .readdirSync(cloudFlowDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.cloudflowconsumer.yml'))
    .map((e) => path.join(cloudFlowDir, e.name));

  if (flowFiles.length === 0) return approve();

  const errors = [];

  for (const filePath of flowFiles) {
    const fileName = path.basename(filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    // id — must be a valid UUID
    const idMatch = content.match(/^id:\s*(.+)$/m);
    if (!idMatch) {
      errors.push(`${fileName}: missing 'id' field`);
    } else {
      const val = idMatch[1].trim().replace(/^['"]|['"]$/g, '');
      if (!UUID_REGEX.test(val)) {
        errors.push(`${fileName}: 'id' is not a valid UUID: ${val}`);
      }
    }

    // processid — must be a valid UUID
    const processIdMatch = content.match(/^processid:\s*(.+)$/m);
    if (!processIdMatch) {
      errors.push(`${fileName}: missing 'processid' field`);
    } else {
      const val = processIdMatch[1].trim().replace(/^['"]|['"]$/g, '');
      if (!UUID_REGEX.test(val)) {
        errors.push(`${fileName}: 'processid' is not a valid UUID: ${val}`);
      }
    }

    // name — must be present and non-empty
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    if (!nameMatch || !nameMatch[1].trim()) {
      errors.push(`${fileName}: missing or empty 'name' field`);
    }

    // flowapiurl — must be present with a non-empty URL value
    const flowApiMatch = content.match(/^flowapiurl:\s*(.*)$/m);
    if (!flowApiMatch) {
      errors.push(`${fileName}: missing 'flowapiurl' field`);
    } else {
      const val = flowApiMatch[1].trim().replace(/^['"]|['"]$/g, '');
      if (!val) {
        errors.push(`${fileName}: 'flowapiurl' is empty — it must contain the cloud flow API endpoint URL`);
      }
    }

    // flowtriggerurl — must be present (value is always empty in Power Pages cloud flow consumer YAML)
    if (!/^flowtriggerurl:/m.test(content)) {
      errors.push(`${fileName}: missing 'flowtriggerurl' field`);
    }

    // adx_CloudFlowConsumer_adx_webrole — must have at least one valid UUID
    const webRoleHeader = /^adx_CloudFlowConsumer_adx_webrole:\s*$/m.exec(content);
    if (!webRoleHeader) {
      errors.push(`${fileName}: missing 'adx_CloudFlowConsumer_adx_webrole' — at least one web role is required`);
    } else {
      const sectionStart = webRoleHeader.index + webRoleHeader[0].length;
      const rest = content.slice(sectionStart);
      const nextKey = rest.match(/^[A-Za-z0-9_]+:/m);
      const section = nextKey ? rest.slice(0, nextKey.index) : rest;

      const roleRegex = /^\s*-\s+([^\s#]+)/gm;
      let match;
      let hasItems = false;
      while ((match = roleRegex.exec(section)) !== null) {
        hasItems = true;
        const val = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (!UUID_REGEX.test(val)) {
          errors.push(`${fileName}: web role '${val}' is not a valid UUID`);
        }
      }
      if (!hasItems) {
        errors.push(`${fileName}: 'adx_CloudFlowConsumer_adx_webrole' array is empty`);
      }
    }

    // No adx_-prefixed scalar fields (M2M key is allowed)
    const adxScalars = content.match(/^adx_(?!CloudFlowConsumer_adx_webrole)[a-z_]+:/gim);
    if (adxScalars) {
      errors.push(`${fileName}: unexpected adx_-prefixed fields: ${[...new Set(adxScalars)].join(', ')}`);
    }

    // statecode / statuscode must not be present
    if (/^statecode:/m.test(content) || /^statuscode:/m.test(content)) {
      errors.push(`${fileName}: 'statecode' and 'statuscode' must not be present in code-site YAML`);
    }
  }

  if (errors.length > 0) {
    block('Cloud flow consumer validation failed:\n- ' + errors.join('\n- '));
  }

  approve();
});

'use strict';

function descendants(element, byParent) {
  const output = [];
  const queue = [...(byParent.get(element.id) || [])];
  while (queue.length > 0) {
    const child = queue.shift();
    output.push(child);
    queue.push(...(byParent.get(child.id) || []));
  }
  return output;
}

function runApp(rendered) {
  const failures = [];
  const notRunReasons = [];
  const expectedIcons = new Map();
  const actualIcons = new Map();
  const contractCount = rendered.reduce((total, item) => {
    const contracts = item.context.conditionalContracts || {};
    return total + ['visibility', 'warnings', 'inputs', 'icons']
      .reduce((count, key) => count + (contracts[key]?.length || 0), 0);
  }, 0);
  if (contractCount === 0) notRunReasons.push('conditional UX contract is absent');

  for (const { snapshot, context } of rendered) {
    const contracts = context.conditionalContracts || {};
    const elements = snapshot.elements.filter((element) => element.rendered !== false);
    const byParent = new Map();
    for (const element of elements) {
      const children = byParent.get(element.parentId) || [];
      children.push(element);
      byParent.set(element.parentId, children);
    }

    for (const contract of contracts.visibility || []) {
      const stateRows = elements.filter((element) => (
        element.testId.startsWith('row:')
        && String(element.attributes?.['data-record-state'] || '').trim()
      ));
      if (stateRows.length === 0) {
        notRunReasons.push(`${context.screenRelative}: required row:* data-record-state evidence is absent for ${contract.field}`);
        continue;
      }
      if (!elements.some((element) => element.testId === `conditional-field:${contract.field}`)) {
        notRunReasons.push(`${context.screenRelative}: required conditional-field:${contract.field} testID is absent`);
        continue;
      }
      let allowedRows = 0;
      let disallowedRows = 0;
      for (const row of stateRows) {
        const state = String(row.attributes?.['data-record-state'] || '').trim();
        if (!state) continue;
        const fieldVisible = descendants(row, byParent).some((child) => child.testId === `conditional-field:${contract.field}`);
        const allowed = contract.states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
        if (allowed) {
          allowedRows += 1;
          if (!fieldVisible) failures.push(`${context.screenRelative}: ${contract.field} missing for allowed state ${state}`);
        } else {
          disallowedRows += 1;
          if (fieldVisible) failures.push(`${context.screenRelative}: ${contract.field} visible outside allowed states on ${state}`);
        }
      }
      if (allowedRows === 0 || disallowedRows === 0) {
        failures.push(`${context.screenRelative}: ${contract.field} needs rendered rows on both sides of its visibility condition`);
      }
    }

    for (const contract of contracts.warnings || []) {
      const warnings = elements.filter((element) => element.testId === `warning:${contract.warning}`);
      if (warnings.length === 0) {
        notRunReasons.push(`${context.screenRelative}: required warning:${contract.warning} testID is absent`);
        continue;
      }
      for (const warning of warnings) {
        const remedy = elements.find((element) => (
          element.testId === `remedy:${contract.remedy}`
          && element.parentId === warning.parentId
          && element.interactive
        ));
        if (!remedy) failures.push(`${context.screenRelative}: warning ${contract.warning} lacks adjacent interactive remedy ${contract.remedy}`);
      }
    }

    for (const contract of contracts.inputs || []) {
      if (contract.role !== 'count-against-expected') continue;
      const root = elements.find((element) => element.testId === `input-role:${contract.field}:numeric-stepper`);
      if (!root) {
        notRunReasons.push(`${context.screenRelative}: required input-role:${contract.field}:numeric-stepper testID is absent`);
        continue;
      }
      const children = descendants(root, byParent);
      for (const direction of ['decrement', 'increment']) {
        const control = children.find((child) => child.testId === `stepper-${direction}:${contract.field}` && child.interactive);
        if (!control) failures.push(`${context.screenRelative}: ${contract.field} is missing interactive ${direction} affordance`);
      }
    }

    for (const contract of contracts.icons || []) {
      const expected = expectedIcons.get(contract.entity);
      if (expected && expected !== contract.icon) failures.push(`entity ${contract.entity} has conflicting planned icons ${expected} and ${contract.icon}`);
      expectedIcons.set(contract.entity, contract.icon);
    }
    for (const element of elements) {
      const match = element.testId.match(/^entity-icon:([^:]+):([^:]+)$/);
      if (!match) continue;
      const icons = actualIcons.get(match[1]) || new Set();
      icons.add(match[2]);
      actualIcons.set(match[1], icons);
    }
  }

  const ownerByIcon = new Map();
  for (const [entity, icon] of expectedIcons) {
    const owner = ownerByIcon.get(icon);
    if (owner && owner !== entity) failures.push(`entities ${owner} and ${entity} share icon ${icon}`);
    ownerByIcon.set(icon, entity);
    const renderedIcons = actualIcons.get(entity) || new Set();
    if (renderedIcons.size === 0) {
      notRunReasons.push(`required entity-icon:${entity}:${icon} testID is absent`);
    } else if (renderedIcons.size !== 1 || !renderedIcons.has(icon)) {
      failures.push(`entity ${entity} rendered ${[...renderedIcons].join(', ') || 'no icon'}, expected only ${icon}`);
    }
  }

  return {
    pass: failures.length === 0 && notRunReasons.length === 0,
    failures: [...notRunReasons, ...failures],
    notRun: notRunReasons.length > 0,
    reportOnly: failures.length === 0 && notRunReasons.length === 0,
    report: {
      fieldVisibilityContracts: rendered.reduce((total, item) => total + (item.context.conditionalContracts?.visibility?.length || 0), 0),
      warningRemedyContracts: rendered.reduce((total, item) => total + (item.context.conditionalContracts?.warnings?.length || 0), 0),
      inputRoleContracts: rendered.reduce((total, item) => total + (item.context.conditionalContracts?.inputs?.length || 0), 0),
      entityIcons: Object.fromEntries([...actualIcons].map(([entity, icons]) => [entity, [...icons]])),
      notRunReasons,
    },
  };
}

module.exports = { runApp, scope: 'app' };
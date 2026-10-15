'use strict';
// How the stages of a business process flow the spec describes compare with the ones deployed, and which differences a rebuild
// applies to the live flow. PURE: no I/O and no SDK handle — the build (sdk-build.js) reads the deployed flow and applies the plan
// this makes, and the change classifier (classify-changes.js) asks the same question of two specs, so that an edit the build
// applies is never filed as debt it does not leave.
//
// A flow is a `workflows` row whose stages are `processstage` rows, and every record that runs the flow is a row of the flow's own
// table holding the stage it is on (`activestageid`), a lookup to that stage:
//   https://learn.microsoft.com/en-us/power-automate/developer/business-process-flows-code
//   https://learn.microsoft.com/en-us/power-automate/best-practices-entity-attributes
// An edit therefore falls in one of two classes:
//   * APPLIED IN PLACE — it leaves every deployed stage where it is in the process, so every record keeps its stage: a stage added
//     (anywhere), a stage renamed, and the steps of a stage added, renamed, rebound to another column, made required or optional, or
//     put in another order. A step is only a column binding shown on the stage; no record refers to one.
//   * REFUSED — it removes a stage or a step, or puts the deployed stages in another order. A record partway through the flow sits
//     on one of its stages, and the platform does not document what becomes of a record whose stage is removed or moved; removing
//     a step is the spec stripping what a maker may have added to the flow in Maker, which no reconcile of this plugin does (a
//     reconcile adds and never removes — docs/app-builder-design.md §14). A stage or step the flow has and the spec does not list
//     is a removal whether its author dropped it from the spec or a maker added it in Maker: nothing here can tell which, and a
//     removal is never made on a guess. No stage or step edit of a refused flow is applied, the safe edits included: its stages and
//     steps are either brought to what the spec says or left exactly as they are (the flow's Active/Draft state is converged on its
//     own, whatever the plan says).
//
// The spec identifies a stage and a step by NAME (it carries no id), so a rename cannot be told from a removal plus an addition by
// names alone. It is told by position: the deployed stages the spec no longer names, and the stages it names that are not deployed,
// are paired when they sit between the same two stages the two lists share and are the same in number — a stage that is
// the same stage under another name keeps its place and its id, so no record moves. When the numbers differ the build cannot say
// which stage is which, and refuses rather than guess. Steps carry no such weight (nothing refers to one), so unmatched steps are
// paired in the order they appear and only a deployed step left over is a removal.

const lower = (value) => String(value == null ? '' : value).toLowerCase();

// The stages a spec flow asks for, in the comparable shape: names, and per step the column (lower-case, the logical name) and whether
// it is required. `required` is a plain boolean: an absent one is false, as the deployed flow reads it.
function desiredBpfStages(flow) {
  return ((flow && flow.stages) || []).map((stage) => ({
    name: stage && stage.name,
    steps: ((stage && stage.steps) || []).map((step) => ({ name: step && step.name, field: lower(step && step.field), required: !!step && step.required === true })),
  }));
}

// The same shape from the SDK's BPF artifact (`artifact.stages`: { id, name, entityLogicalName, steps: [{ id, name, fieldName?,
// required? }] }), keeping the ids the plan needs to find a stage and a step again.
function deployedBpfStages(artifactStages) {
  return (artifactStages || []).map((stage) => ({
    id: stage.id,
    name: stage.name,
    entity: lower(stage.entityLogicalName),
    steps: (stage.steps || []).map((step) => ({ id: step.id, name: step.name, field: lower(step.fieldName), required: step.required === true })),
  }));
}

const duplicates = (items) => [...new Set(items.filter((item, i) => items.findIndex((other) => other.name === item.name) !== i).map((item) => item.name))];
const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const sameStep = (a, b) => a.name === b.name && a.field === b.field && a.required === b.required;

// The steps of ONE stage: each desired step takes the deployed step of its name, then the deployed steps the spec does not name are
// paired with the desired ones the deployed stage does not have, in the order they appear (a renamed step keeps its id). A deployed
// step left with no partner is a removal; a desired step left with none is an addition.
function matchSteps(deployedSteps, desiredSteps) {
  const byName = new Map(deployedSteps.map((step) => [step.name, step]));
  const named = new Set(desiredSteps.map((step) => step.name));
  const orphans = deployedSteps.filter((step) => !named.has(step.name));
  const fresh = desiredSteps.filter((step) => !byName.has(step.name));
  const partner = new Map(fresh.slice(0, orphans.length).map((step, i) => [step.name, orphans[i]]));
  const steps = desiredSteps.map((step) => {
    const found = byName.get(step.name) || partner.get(step.name) || null;
    return { name: step.name, field: step.field, required: step.required, stepId: found ? found.id : null, renamedFrom: found && found.name !== step.name ? found.name : null };
  });
  const removed = orphans.slice(fresh.length).map((step) => step.name);
  const unchanged = removed.length === 0 && deployedSteps.length === desiredSteps.length && desiredSteps.every((step, i) => sameStep(deployedSteps[i], step));
  return { steps, removed, changed: !unchanged };
}

// Compare the deployed stages (deployedBpfStages) with the desired ones (desiredBpfStages) and say what a rebuild does.
//   verdict: 'same'    — nothing to change;
//            'edit'    — `target` is what to apply: one entry per desired stage, in order —
//                        { name, isNew, stageId, renamedFrom, steps: [{ name, field, required, stepId, renamedFrom }], stepsChanged };
//            'refused' — `refusals` says why, and no stage or step edit is applied: [{ code, ... }] with `code` one of
//                        'ambiguous-stages' (the deployed flow names two stages alike), 'ambiguous-steps' (two steps of a stage),
//                        'removed-stages' ({ deployed, desired }: stages dropped, or replaced by a different number),
//                        'reordered' ({ deployed, desired }: the stages both lists have, in the order each lists them),
//                        'removed-steps' ({ stage, steps }), 'other-table' ({ stages, entity }: a stage on another table).
// `opts.entity` is the table the spec's flow is on; a deployed stage on another one is a flow the spec cannot describe, so an edit
// to it is refused — but only when there is an edit: a flow that already matches is never complained about.
function diffBpfStages(deployed, desired, opts = {}) {
  const E = deployed || [];
  const D = desired || [];
  const refusals = [];

  const dupStages = [...duplicates(E), ...duplicates(D)];
  if (dupStages.length) return { verdict: 'refused', target: [], refusals: [{ code: 'ambiguous-stages', stages: [...new Set(dupStages)] }] };

  const eAt = new Map(E.map((stage, i) => [stage.name, i]));
  const dAt = new Map(D.map((stage, i) => [stage.name, i]));
  const anchorsE = E.filter((stage) => dAt.has(stage.name)).map((stage) => stage.name);
  const anchorsD = D.filter((stage) => eAt.has(stage.name)).map((stage) => stage.name);
  if (anchorsE.some((name, i) => name !== anchorsD[i])) {
    refusals.push({ code: 'reordered', deployed: anchorsE, desired: anchorsD });
  }

  // Between two stages both lists have (an anchor), the deployed stages the spec no longer names and the stages it names that
  // are not deployed: none deployed — all additions; as many of each — renames, in order; any other count — not told apart.
  const paired = new Array(D.length).fill(null); // desired index -> deployed index
  if (!refusals.length) {
    let ePrev = -1;
    let dPrev = -1;
    const bounds = [...anchorsD.map((name) => [eAt.get(name), dAt.get(name)]), [E.length, D.length]];
    for (const [ePos, dPos] of bounds) {
      const gapE = range(ePrev + 1, ePos);
      const gapD = range(dPrev + 1, dPos);
      if (gapE.length && gapE.length === gapD.length) gapE.forEach((ei, k) => { paired[gapD[k]] = ei; });
      else if (gapE.length) refusals.push({ code: 'removed-stages', deployed: gapE.map((i) => E[i].name), desired: gapD.map((j) => D[j].name) });
      if (ePos < E.length) paired[dPos] = ePos;
      ePrev = ePos;
      dPrev = dPos;
    }
  }

  const target = [];
  for (let j = 0; j < D.length; j += 1) {
    const e = paired[j] === null ? null : E[paired[j]];
    const stage = { name: D[j].name, isNew: !e, stageId: e ? e.id : null, renamedFrom: e && e.name !== D[j].name ? e.name : null, steps: [], stepsChanged: false };
    if (e) {
      const dupSteps = duplicates(e.steps);
      if (dupSteps.length) {
        refusals.push({ code: 'ambiguous-steps', stage: e.name, steps: dupSteps });
      } else {
        const m = matchSteps(e.steps, D[j].steps);
        stage.steps = m.steps;
        stage.stepsChanged = m.changed;
        if (m.removed.length) refusals.push({ code: 'removed-steps', stage: e.name, steps: m.removed });
      }
    } else {
      stage.steps = D[j].steps.map((step) => ({ name: step.name, field: step.field, required: step.required, stepId: null, renamedFrom: null }));
    }
    target.push(stage);
  }
  if (refusals.length) return { verdict: 'refused', target: [], refusals };

  const edits = target.some((stage) => stage.isNew || stage.renamedFrom || stage.stepsChanged);
  if (!edits) return { verdict: 'same', target, refusals: [] };

  const entity = lower(opts.entity);
  const elsewhere = entity ? E.filter((stage) => stage.entity && stage.entity !== entity) : [];
  if (elsewhere.length) return { verdict: 'refused', target: [], refusals: [{ code: 'other-table', stages: elsewhere.map((stage) => stage.name), entity }] };
  return { verdict: 'edit', target, refusals: [] };
}

const quoted = (names) => names.map((name) => `'${name}'`).join(', ');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What an applicable plan does, in a few words for a step label: "1 stage renamed, 2 stages added, steps changed in 1 stage".
function describeBpfEdit(plan) {
  const parts = [];
  const renamed = plan.target.filter((stage) => stage.renamedFrom).length;
  const added = plan.target.filter((stage) => stage.isNew).length;
  const stepped = plan.target.filter((stage) => stage.stepsChanged).length;
  if (renamed) parts.push(`${plural(renamed, 'stage', 'stages')} renamed`);
  if (added) parts.push(`${plural(added, 'stage', 'stages')} added`);
  if (stepped) parts.push(`steps changed in ${plural(stepped, 'stage', 'stages')}`);
  return parts.join(', ');
}

// Why a plan was refused, one sentence per refusal.
function describeBpfRefusals(refusals) {
  return refusals.map((r) => {
    switch (r.code) {
      case 'removed-stages':
        return r.desired.length
          ? `the flow has stage${r.deployed.length === 1 ? '' : 's'} ${quoted(r.deployed)} where the spec has ${quoted(r.desired)} — with a different number of stages there, the build cannot tell a rename from a removal`
          : `the flow has stage${r.deployed.length === 1 ? '' : 's'} ${quoted(r.deployed)}, which the spec does not list`;
      case 'reordered':
        return `the spec lists the stages ${quoted(r.desired)} in another order than the flow's ${quoted(r.deployed)}`;
      case 'removed-steps':
        return `stage '${r.stage}' has step${r.steps.length === 1 ? '' : 's'} ${quoted(r.steps)}, which the spec does not list`;
      case 'ambiguous-stages':
        return `two stages of the flow share the name ${quoted(r.stages)}, so they cannot be told apart by name`;
      case 'ambiguous-steps':
        return `two steps of stage '${r.stage}' share the name ${quoted(r.steps)}, so they cannot be told apart by name`;
      case 'other-table':
        return `stage${r.stages.length === 1 ? '' : 's'} ${quoted(r.stages)} of the deployed flow ${r.stages.length === 1 ? 'is' : 'are'} on another table than '${r.entity}', which a spec cannot describe`;
      default:
        return r.code;
    }
  });
}

// Whether a rebuild applies the stage edit from a flow as an EARLIER spec described it to the flow as the spec describes it now — for
// the change classifier, which has no deployed flow to read and takes the earlier spec's as what is deployed (a flow this plugin
// built, and nobody has edited in Maker, is exactly that). It answers with the same plan the build makes, so an edit the build
// applies is never filed as debt it leaves behind, and one it refuses always is.
function stageEditApplies(prior, current) {
  const asDeployed = ((prior && prior.stages) || []).map((stage, i) => ({
    id: `stage-${i}`,
    name: stage && stage.name,
    entity: lower(prior && prior.entity),
    steps: ((stage && stage.steps) || []).map((step, k) => ({ id: `step-${i}-${k}`, name: step && step.name, field: lower(step && step.field), required: !!step && step.required === true })),
  }));
  return diffBpfStages(asDeployed, desiredBpfStages(current), { entity: current && current.entity }).verdict !== 'refused';
}

module.exports = { desiredBpfStages, deployedBpfStages, diffBpfStages, describeBpfEdit, describeBpfRefusals, stageEditApplies };

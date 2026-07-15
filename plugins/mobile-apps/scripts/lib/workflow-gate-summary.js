'use strict';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function stepControlFlowKinds(step, workflow) {
  if (toArray(step && step.controlFlowKinds).length > 0) return [...step.controlFlowKinds].sort();
  const frames = workflow && workflow.controlFlowFrames || {};
  return [...new Set(toArray(step && step.controlFlowIds)
    .map((id) => frames[id] && frames[id].kind)
    .filter(Boolean))].sort();
}

function deriveWorkflowGateSummary(workflowPlan) {
  const workflows = toArray(workflowPlan && workflowPlan.workflows);
  return {
    $schema: 'workflow-gate-summary-v1',
    generatedAt: workflowPlan && workflowPlan.generatedAt || null,
    sourcePlan: {
      file: 'workflows.json',
      schema: workflowPlan && workflowPlan.$schema || null,
    },
    rule: 'Compact Gate 2c review feed. Exact actions, formulas, payloads, and control-flow frames remain in bounded implementation shards and global audit artifacts.',
    stats: JSON.parse(JSON.stringify(workflowPlan && workflowPlan.stats || {})),
    workflows: workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      implementationShard: `workflow-shards/${workflow.workflowId}.json`,
      source: {
        screen: workflow.source && workflow.source.screen || null,
        control: workflow.source && workflow.source.control || null,
        controlPath: workflow.source && workflow.source.controlPath || null,
        event: workflow.source && workflow.source.event || null,
        behaviorCount: toArray(workflow.source && workflow.source.behaviorIds).length
          || (toArray(workflow.source && workflow.source.coreBehaviorIds).length
            + toArray(workflow.source && workflow.source.regenerableBehaviorIds).length),
        coreBehaviorCount: toArray(workflow.source && workflow.source.coreBehaviorIds).length,
        regenerableBehaviorCount: toArray(workflow.source && workflow.source.regenerableBehaviorIds).length,
        unmatchedCount: Number(workflow.source && workflow.source.unmatchedCount || 0),
      },
      detection: {
        score: workflow.detection && workflow.detection.score || 0,
        reasons: toArray(workflow.detection && workflow.detection.reasons),
        metrics: JSON.parse(JSON.stringify(workflow.detection && workflow.detection.metrics || {})),
      },
      proposal: {
        architecture: workflow.proposal && workflow.proposal.architecture || null,
        executionOwner: workflow.proposal && workflow.proposal.executionOwner || null,
        uxMode: workflow.proposal && workflow.proposal.uxMode || null,
        target: JSON.parse(JSON.stringify(workflow.proposal && workflow.proposal.target || null)),
        intentHintCount: toArray(workflow.proposal && workflow.proposal.intentHintIds).length,
        steps: toArray(workflow.proposal && workflow.proposal.steps).map((step) => ({
          stepId: step.stepId,
          sequence: step.sequence,
          phase: step.phase,
          title: step.title,
          targetFunction: step.targetFunction,
          behaviorCount: toArray(step.behaviorIds).length,
          controlFlowKinds: stepControlFlowKinds(step, workflow),
        })),
      },
      requiredDecisions: JSON.parse(JSON.stringify(toArray(workflow.requiredDecisions))),
      approval: JSON.parse(JSON.stringify(workflow.approval || null)),
    })),
  };
}

module.exports = {
  deriveWorkflowGateSummary,
  stepControlFlowKinds,
};

'use strict';

const WORKFLOW_APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'blocked']);
const WORKFLOW_EXECUTION_OWNERS = Object.freeze(['client-orchestrator', 'server-orchestrator']);
const WORKFLOW_UX_MODES = Object.freeze(['single-action-with-progress', 'native-multi-step', 'background-job']);

function emptyWorkflowApproval() {
  return {
    status: 'pending',
    approvedStepIds: [],
    decisions: [],
    executionOwner: null,
    uxMode: null,
    serverDependency: null,
    compensationPlan: null,
    reason: null,
    approvedBy: null,
    approvedAt: null,
  };
}

function decisionIsResolved(decision, approval) {
  const resolution = (approval && Array.isArray(approval.decisions) ? approval.decisions : [])
    .find((entry) => entry && entry.decisionId === decision.decisionId);
  return !!(resolution
    && resolution.status === 'resolved'
    && typeof resolution.value === 'string'
    && resolution.value.trim().length > 0);
}

function deriveWorkflowStats(workflows, analysis = {}) {
  const rows = Array.isArray(workflows) ? workflows : [];
  const byDecisionType = {};
  const mappedBehaviorIds = new Set();
  const coreMappedBehaviorIds = new Set();
  const regenerableMappedBehaviorIds = new Set();
  let requiredDecisions = 0;
  let unresolvedDecisions = 0;
  let totalSteps = 0;
  let workflowsWithQuestions = 0;

  for (const workflow of rows) {
    const decisions = Array.isArray(workflow && workflow.requiredDecisions)
      ? workflow.requiredDecisions
      : [];
    if (decisions.length > 0) workflowsWithQuestions += 1;
    requiredDecisions += decisions.length;
    unresolvedDecisions += decisions.filter((decision) => !decisionIsResolved(decision, workflow && workflow.approval)).length;
    for (const decision of decisions) {
      const type = String((decision && decision.type) || 'unknown');
      byDecisionType[type] = (byDecisionType[type] || 0) + 1;
    }
    const steps = Array.isArray(workflow && workflow.proposal && workflow.proposal.steps)
      ? workflow.proposal.steps
      : [];
    totalSteps += steps.length;
    for (const step of steps) {
      for (const behaviorId of Array.isArray(step && step.behaviorIds) ? step.behaviorIds : []) {
        if (behaviorId) coreMappedBehaviorIds.add(behaviorId);
      }
    }
    for (const behaviorId of Array.isArray(workflow && workflow.source && workflow.source.regenerableBehaviorIds)
      ? workflow.source.regenerableBehaviorIds : []) {
      if (behaviorId) regenerableMappedBehaviorIds.add(behaviorId);
    }
    for (const behaviorId of Array.isArray(workflow && workflow.source && workflow.source.behaviorIds)
      ? workflow.source.behaviorIds : []) {
      if (behaviorId) mappedBehaviorIds.add(behaviorId);
    }
  }

  return {
    handlersScanned: Number(analysis.handlersScanned || 0),
    handlersSkippedUnclassified: Number(analysis.handlersSkippedUnclassified || 0),
    total: rows.length,
    pathologicalHandlers: rows.length,
    totalSteps,
    mappedBehaviors: mappedBehaviorIds.size,
    coreMappedBehaviors: coreMappedBehaviorIds.size,
    regenerableMappedBehaviors: regenerableMappedBehaviorIds.size,
    workflowsWithQuestions,
    requiredDecisions,
    unresolvedDecisions,
    pendingApproval: rows.filter((row) => row && row.approval && row.approval.status === 'pending').length,
    approved: rows.filter((row) => row && row.approval && row.approval.status === 'approved').length,
    blocked: rows.filter((row) => row && row.approval && row.approval.status === 'blocked').length,
    byDecisionType: Object.fromEntries(Object.entries(byDecisionType).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function resetWorkflowApprovals(input, workflowPlan) {
  const workflows = Array.isArray(workflowPlan && workflowPlan.workflows)
    ? workflowPlan.workflows
    : [];
  const emptyApproval = emptyWorkflowApproval();
  let resetCount = 0;
  for (const workflow of workflows) {
    if (JSON.stringify(workflow.approval || null) !== JSON.stringify(emptyApproval)) resetCount += 1;
    workflow.approval = emptyWorkflowApproval();
  }
  const analysis = {
    handlersScanned: workflowPlan && workflowPlan.stats && workflowPlan.stats.handlersScanned,
    handlersSkippedUnclassified: workflowPlan && workflowPlan.stats && workflowPlan.stats.handlersSkippedUnclassified,
  };
  workflowPlan.stats = deriveWorkflowStats(workflows, analysis);
  if (!input.workflowPlan || typeof input.workflowPlan !== 'object') {
    throw new Error('mobile-plugin-input.json workflowPlan summary is missing');
  }
  input.workflowPlan.stats = JSON.parse(JSON.stringify(workflowPlan.stats));
  return resetCount;
}

module.exports = {
  WORKFLOW_APPROVAL_STATUSES,
  WORKFLOW_EXECUTION_OWNERS,
  WORKFLOW_UX_MODES,
  decisionIsResolved,
  deriveWorkflowStats,
  emptyWorkflowApproval,
  resetWorkflowApprovals,
};

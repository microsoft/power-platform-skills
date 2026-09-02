'use strict';

const fs = require('node:fs');

const { escapeHtml } = require('./mobile-build-plan-html');
const {
  ARTIFACTS,
  BUILD_PLAN_OUTPUT,
  BUILD_PLAN_SCHEMA_VERSION,
  EDIT_JOURNAL_ARTIFACT,
  PHASES,
  PROGRESS_ARTIFACT,
  deriveBuildPlanModel,
  editableContractContent,
  emptyProgress,
  hasExecutionStarted,
  nextProgressState,
  resolveInsideProject,
  revisionOf,
  updateProgress,
} = require('./mobile-build-plan-model');
const { renderBuildPlanHtml } = require('./mobile-build-plan-renderer');

function writeBuildPlan(projectRoot, options = {}) {
  const model = deriveBuildPlanModel(projectRoot, options);
  const output = resolveInsideProject(projectRoot, options.output || BUILD_PLAN_OUTPUT);
  fs.writeFileSync(output, renderBuildPlanHtml(model, options), 'utf8');
  return { output, model };
}

module.exports = {
  ARTIFACTS,
  BUILD_PLAN_OUTPUT,
  BUILD_PLAN_SCHEMA_VERSION,
  EDIT_JOURNAL_ARTIFACT,
  PHASES,
  PROGRESS_ARTIFACT,
  deriveBuildPlanModel,
  editableContractContent,
  emptyProgress,
  escapeHtml,
  hasExecutionStarted,
  nextProgressState,
  renderBuildPlanHtml,
  resolveInsideProject,
  revisionOf,
  updateProgress,
  writeBuildPlan,
};

'use strict';

const { canonicalJson, sha256Hex } = require('./product-experience-contracts');

function buildPreviewAuthoringProjection(contract) {
  const projection = {
    schemaVersion: 1,
    contractType: 'product-experience-preview-authoring',
    finalContractRevision: contract.contractRevision,
    experienceDirective: contract.experienceDirective,
    selectedScreenIds: contract.selectedScreenIds,
    selectionRationale: contract.selectionRationale,
    navigationShell: contract.navigation,
    generatedTokens: contract.designTokens,
    signatureComponentContracts: contract.sharedDesignInputs.signatureComponents,
    screenSpecifications: contract.screens.map((screen) => ({
      screenId: screen.screenId,
      title: screen.title,
      pattern: screen.pattern,
      packRevision: screen.packRevision,
      navigationShell: screen.navigationShell,
      identityHierarchy: screen.identityHierarchy,
      firstViewport: screen.firstViewport,
      signatureInteraction: screen.signatureIntent,
      primaryActions: screen.primaryActions,
      states: screen.states.map((state) => [state.name, state.copy]),
      media: screen.media,
      scenarioValues: screen.scenarioEvidence.map((evidence) => [
        evidence.id,
        evidence.role,
        evidence.value,
      ]),
      prohibitedDefaults: screen.prohibitedDefaults,
    })),
    review: {
      allScreenIds: contract.allScreenIds,
      requirements: contract.requirements.map((requirement) => [
        requirement.requirementId,
        requirement.statement,
      ]),
    },
    prohibitedDefaults: contract.experienceDirective.forbiddenDefaults || [],
  };
  projection.projectionRevision = sha256Hex(canonicalJson(projection));
  return projection;
}

module.exports = { buildPreviewAuthoringProjection };
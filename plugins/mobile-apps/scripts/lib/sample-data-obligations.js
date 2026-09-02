'use strict';

const {
  canonicalJson,
  contractRevision,
  sha256Hex,
} = require('./product-experience-contracts');
const {
  projectScreenFacts,
  validateScenarioFacts,
} = require('../validate-fixture-scenarios');

function validateCompiledBinding(compiled, { experience, scope, journey }) {
  const expected = {
    experienceRevision: contractRevision(experience),
    scopeRevision: contractRevision(scope),
    journeyRevision: contractRevision(journey),
  };
  for (const [field, revision] of Object.entries(expected)) {
    if (compiled[field] !== revision) {
      throw new Error(`${field} does not match the supplied contract`);
    }
  }
  const withoutRevision = structuredClone(compiled);
  const suppliedRevision = withoutRevision.compiledRevision;
  delete withoutRevision.compiledRevision;
  if (suppliedRevision !== sha256Hex(canonicalJson(withoutRevision))) {
    throw new Error('compiledRevision does not match the compiled screen build pack');
  }
}

function compileSampleDataObligations({
  experience,
  scope,
  journey,
  compiled,
  scenario,
  persistence = null,
  navigation = null,
}) {
  validateCompiledBinding(compiled, { experience, scope, journey });
  const scenarioValidation = validateScenarioFacts(scenario, {
    scope,
    journey,
    compiled,
    persistence,
    navigation,
  });
  if (!scenarioValidation.ok) {
    throw new Error(scenarioValidation.errors.map((item) => item.message).join('; '));
  }

  const coverageByScreen = new Map();
  for (const row of scope.requirementCoverage || []) {
    if (!coverageByScreen.has(row.screenId)) coverageByScreen.set(row.screenId, []);
    coverageByScreen.get(row.screenId).push(structuredClone(row));
  }

  const operationsByScreen = new Map();
  for (const entry of journey.journeys || []) {
    for (const step of entry.steps || []) {
      const screenId = step.surface?.screenId;
      if (!screenId) continue;
      if (!operationsByScreen.has(screenId)) operationsByScreen.set(screenId, []);
      operationsByScreen.get(screenId).push({
        journeyId: entry.id,
        jobId: entry.jobId,
        stepId: step.id,
        operation: structuredClone(step.dataOperation),
        entryCondition: step.entryCondition,
        exitCondition: step.exitCondition,
      });
    }
  }

  const obligations = {
    schemaVersion: 1,
    contractType: 'sample-data-obligations',
    experienceRevision: compiled.experienceRevision,
    scopeRevision: compiled.scopeRevision,
    journeyRevision: compiled.journeyRevision,
    buildPackRevision: compiled.buildPackRevision,
    compiledRevision: compiled.compiledRevision,
    scenarioRevision: scenario.scenarioRevision,
    connectivity: experience.operatingContext.connectivity,
    domainVocabulary: [...(experience.domainVocabulary || [])],
    mediaStrategy: structuredClone(experience.mediaStrategy),
    requirements: structuredClone(scope.requirements || []),
    records: structuredClone(scenario.records),
    relationships: structuredClone(scenario.relationships),
    scenarios: structuredClone(scenario.scenarios),
    mediaAssets: structuredClone(scenario.mediaAssets),
    screens: compiled.screens.map((entry) => ({
      screenId: entry.screenId,
      jobIds: [...entry.jobIds],
      requirementCoverage: coverageByScreen.get(entry.screenId) || [],
      dataOperations: operationsByScreen.get(entry.screenId) || [],
      states: structuredClone(entry.pack.states),
      actions: [
        ...entry.pack.primaryActions.map((action) => ({ ...structuredClone(action), priority: 'primary' })),
        ...entry.pack.secondaryActions.map((action) => ({ ...structuredClone(action), priority: 'secondary' })),
      ],
      scenarioFacts: projectScreenFacts(scenario, entry.screenId),
      trustSignals: structuredClone(entry.pack.trustSignals),
      decisionSupport: structuredClone(entry.pack.decisionSupport),
      media: structuredClone(entry.pack.media),
    })),
  };
  obligations.obligationsRevision = sha256Hex(canonicalJson(obligations));
  return obligations;
}

module.exports = { compileSampleDataObligations, validateCompiledBinding };
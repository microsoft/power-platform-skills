'use strict';

const crypto = require('node:crypto');
const SCHEMA = require('../schema-prototype-semantic-plan.json');
const { validateJsonSchema } = require('./json-schema-lite');

const RESPONSE_LIMIT_BYTES = 256 * 1024;
const FINAL_ARTIFACT_KEYS = new Set([
  'contextenrichmentcontract', 'workflowjourneycontract', 'navigationcontract',
  'prototypedomainmodel', 'dataverseschemacontract', 'experiencescreencontract',
  'experiencefoundationcontract', 'executioncontract', 'nativeappplanmarkdown',
  'screenbuildpack', 'outputpath', 'targetpath', 'writepath', 'approvalstate',
]);
const DATAVERSE_KEYS = new Set([
  'logicalname', 'schemaname', 'publisherprefix', 'ownershiptype', 'entitysetname',
  'servicename', 'environmentid', 'environmenturl', 'solutionname', 'metadataid',
  'planneddecision', 'requiredlevel', 'alternatekays', 'alternatekeys',
]);
const REQUIRED_SCREEN_STATES = ['loading', 'empty', 'error', 'offline', 'recovery'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedKey(value) {
  return String(value).replace(/[-_\s]/g, '').toLowerCase();
}

function semanticPlanRevision(plan) {
  return sha256(JSON.stringify(plan));
}

function collectForbidden(value, path = '', errors = []) {
  if (typeof value === 'string') {
    if (/(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]|file:\/\/|\.tmp\/|app\/\(app\)\/)/.test(value)) errors.push(`${path}: semantic plan contains a filesystem path`);
    if (/\.crm(?:\d+)?\.dynamics\.com/i.test(value)) errors.push(`${path}: semantic plan contains a Dataverse environment host`);
    if (/(?:^|\n)\s*(?:node|npm|npx|git|curl|wget|rm|cp|mv|mkdir)\b/m.test(value)) errors.push(`${path}: semantic plan contains a shell command`);
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbidden(item, `${path}/${index}`, errors));
    return errors;
  }
  if (!value || typeof value !== 'object') return errors;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    const childPath = `${path}/${key}`;
    if (FINAL_ARTIFACT_KEYS.has(normalized)) errors.push(`${childPath}: final-artifact boilerplate is forbidden in a semantic plan`);
    if (DATAVERSE_KEYS.has(normalized)) errors.push(`${childPath}: Dataverse or environment identity is forbidden in prototype semantics`);
    if (/sha256$|hash$|revision$/.test(normalized)) errors.push(`${childPath}: compiler-owned hashes and revisions are forbidden`);
    collectForbidden(child, childPath, errors);
  }
  return errors;
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function exactSet(actual, expected) {
  return actual.length === expected.length && actual.every((value) => expected.includes(value));
}

function pointerValue(root, pointer) {
  if (pointer === '') return root;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  return pointer.slice(1).split('/').reduce((value, segment) => {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value) && key.startsWith('@')) {
      const identity = key.slice(1);
      return value.find((item) => [item?.id, item?.screenId, item?.key].includes(identity));
    }
    return value === null || value === undefined ? undefined : value[key];
  }, root);
}

function validateEvidencePaths(plan, evidencePaths, label, errors) {
  for (const evidencePath of evidencePaths || []) {
    if (pointerValue(plan, evidencePath) === undefined) errors.push(`${label}: evidence path does not exist: ${evidencePath}`);
  }
}

function validatePrototypeSemanticPlan(plan, context = {}) {
  const errors = validateJsonSchema(plan, SCHEMA);
  collectForbidden(plan, '', errors);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors };

  const entities = plan.domain?.entities || [];
  const entityKeys = entities.map((entity) => entity.key);
  const entityMap = new Map(entities.map((entity) => [entity.key, entity]));
  const operationKeys = (plan.domain?.operations || []).map((operation) => operation.key);
  const operationMap = new Map((plan.domain?.operations || []).map((operation) => [operation.key, operation]));
  const actorKeys = (plan.domain?.actors || []).map((actor) => actor.key);
  for (const value of duplicates(entityKeys)) errors.push(`/domain/entities: duplicate entity ${value}`);
  for (const value of duplicates(operationKeys)) errors.push(`/domain/operations: duplicate operation ${value}`);
  for (const entity of entities) {
    const fieldKeys = (entity.fields || []).map((field) => field.key);
    for (const value of duplicates(fieldKeys)) errors.push(`/domain/entities/${entity.key}/fields: duplicate field ${value}`);
    if (!fieldKeys.includes(entity.primaryNameField)) errors.push(`/domain/entities/${entity.key}/primaryNameField: field does not exist`);
    for (const field of entity.fields || []) {
      if (field.referenceTarget && !entityKeys.includes(field.referenceTarget)) errors.push(`/domain/entities/${entity.key}/fields/${field.key}/referenceTarget: unknown entity ${field.referenceTarget}`);
    }
  }
  for (const relationship of plan.domain?.relationships || []) {
    if (!entityMap.has(relationship.parent) || !entityMap.has(relationship.child)) errors.push(`/domain/relationships/${relationship.key}: relationship references an unknown entity`);
    const childField = entityMap.get(relationship.child)?.fields?.find((field) => field.key === relationship.childField);
    if (!childField || childField.type !== 'reference' || childField.referenceTarget !== relationship.parent) errors.push(`/domain/relationships/${relationship.key}/childField: must reference ${relationship.parent}`);
  }
  for (const operation of plan.domain?.operations || []) {
    const entity = entityMap.get(operation.entity);
    if (!entity) {
      errors.push(`/domain/operations/${operation.key}/entity: unknown entity ${operation.entity}`);
      continue;
    }
    const fields = new Set(entity.fields.map((field) => field.key));
    for (const field of [...operation.selectFields, ...operation.filterFields, ...operation.sortFields, ...(operation.writeFields || [])]) {
      if (!fields.has(field)) errors.push(`/domain/operations/${operation.key}: unknown field ${field}`);
    }
  }
  for (const permission of plan.domain?.uxPermissions || []) {
    if (!actorKeys.includes(permission.actor)) errors.push(`/domain/uxPermissions: unknown actor ${permission.actor}`);
    if (!operationKeys.includes(permission.operation)) errors.push(`/domain/uxPermissions: unknown operation ${permission.operation}`);
  }
  for (const operation of plan.domain?.offlineIntent?.requiredOperations || []) {
    if (!operationKeys.includes(operation)) errors.push(`/domain/offlineIntent/requiredOperations: unknown operation ${operation}`);
  }
  for (const entityKey of Object.keys(plan.domain?.fixtures || {})) {
    if (!entityMap.has(entityKey)) errors.push(`/domain/fixtures/${entityKey}: unknown entity`);
    const ids = (plan.domain.fixtures[entityKey] || []).map((record) => record.id).filter(Boolean);
    for (const value of duplicates(ids)) errors.push(`/domain/fixtures/${entityKey}: duplicate record id ${value}`);
  }
  for (const scenario of plan.domain?.scenarios || []) {
    if (scenario.entity && !entityMap.has(scenario.entity)) errors.push(`/domain/scenarios/${scenario.key}/entity: unknown entity ${scenario.entity}`);
    if (scenario.entity) {
      const ids = new Set((plan.domain.fixtures?.[scenario.entity] || []).map((record) => record.id));
      for (const recordId of scenario.recordIds || []) if (!ids.has(recordId)) errors.push(`/domain/scenarios/${scenario.key}/recordIds: unknown fixture ${recordId}`);
    }
  }

  const screens = plan.screens?.items || [];
  const screenIds = screens.map((screen) => screen.id);
  const screenMap = new Map(screens.map((screen) => [screen.id, screen]));
  for (const value of duplicates(screenIds)) errors.push(`/screens/items: duplicate screen ${value}`);
  const primary = screenMap.get(plan.screens?.primaryScreenId);
  if (!primary || primary.role !== 'primary') errors.push('/screens/primaryScreenId: must identify the one primary screen');
  const primaryCount = screens.filter((screen) => screen.role === 'primary').length;
  if (primaryCount !== 1) errors.push('/screens/items: exactly one screen must have role primary');
  for (const screenId of plan.screens?.keyFlowScreenIds || []) if (screenMap.get(screenId)?.role !== 'key-flow') errors.push(`/screens/keyFlowScreenIds: ${screenId} is not a key-flow screen`);
  for (const screenId of plan.screens?.criticalFlow?.screenIds || []) if (!screenMap.has(screenId)) errors.push(`/screens/criticalFlow/screenIds: unknown screen ${screenId}`);
  for (const screen of screens) {
    for (const state of REQUIRED_SCREEN_STATES) if (!screen.states?.includes(state)) errors.push(`/screens/items/${screen.id}/states: missing ${state}`);
    const regionIds = (screen.regions || []).map((region) => region.id);
    for (const regionId of screen.firstViewport?.regionIds || []) if (!regionIds.includes(regionId)) errors.push(`/screens/items/${screen.id}/firstViewport/regionIds: unknown region ${regionId}`);
    for (const dependency of screen.dependencies?.screens || []) if (!screenMap.has(dependency) || dependency === screen.id) errors.push(`/screens/items/${screen.id}/dependencies/screens: invalid dependency ${dependency}`);
    for (const fixture of screen.dependencies?.fixtures || []) if (!entityMap.has(fixture)) errors.push(`/screens/items/${screen.id}/dependencies/fixtures: unknown fixture entity ${fixture}`);
    for (const entity of screen.data?.entities || []) if (!entityMap.has(entity)) errors.push(`/screens/items/${screen.id}/data/entities: unknown entity ${entity}`);
    for (const operation of screen.data?.operations || []) {
      const domainOperation = operationMap.get(operation.domainOperation);
      if (!domainOperation) errors.push(`/screens/items/${screen.id}/data/operations/${operation.id}/domainOperation: unknown operation ${operation.domainOperation}`);
      else if (operation.repository !== domainOperation.repository || operation.repositoryMethod !== domainOperation.method || operation.hook !== domainOperation.hook) errors.push(`/screens/items/${screen.id}/data/operations/${operation.id}: repository or hook identity differs from domain operation ${operation.domainOperation}`);
    }
    const pathParameters = new Set((screen.routeIntent?.parameters || []).filter((parameter) => parameter.source === 'path').map((parameter) => parameter.name));
    for (const segment of screen.routeIntent?.pathSegments || []) {
      if (segment.kind === 'literal' && !segment.value) errors.push(`/screens/items/${screen.id}/routeIntent/pathSegments: literal segment requires value`);
      if (segment.kind === 'parameter' && (!segment.name || !pathParameters.has(segment.name))) errors.push(`/screens/items/${screen.id}/routeIntent/pathSegments: parameter segment must reference a declared path parameter`);
    }
    if (screen.routeIntent?.parentScreenId && !screenMap.has(screen.routeIntent.parentScreenId)) errors.push(`/screens/items/${screen.id}/routeIntent/parentScreenId: unknown screen ${screen.routeIntent.parentScreenId}`);
    if (screen.primaryAction?.destinationScreenId && !screenMap.has(screen.primaryAction.destinationScreenId)) errors.push(`/screens/items/${screen.id}/primaryAction/destinationScreenId: unknown screen`);
    if (screen.primaryAction?.binding?.startsWith('operation:') && !operationMap.has(screen.primaryAction.binding.slice('operation:'.length))) errors.push(`/screens/items/${screen.id}/primaryAction/binding: unknown operation`);
  }

  const structure = plan.screens?.productStructure || {};
  const durableIds = structure.durableDestinationIds || [];
  const keyFlowIds = structure.keyFlowScreenIds || [];
  if (structure.primaryScreenId !== plan.screens?.primaryScreenId) errors.push('/screens/productStructure/primaryScreenId: must match /screens/primaryScreenId');
  if (structure.primaryScreenRole !== primary?.productRole) errors.push('/screens/productStructure/primaryScreenRole: must match the primary screen productRole');
  if (!screenMap.has(structure.launchRoute)) errors.push('/screens/productStructure/launchRoute: must identify a known screen');
  if (structure.resumeRoute !== null && !screenMap.has(structure.resumeRoute)) errors.push('/screens/productStructure/resumeRoute: must identify a known screen or be null');
  if (!exactSet(keyFlowIds, plan.screens?.keyFlowScreenIds || [])) errors.push('/screens/productStructure/keyFlowScreenIds: must match /screens/keyFlowScreenIds exactly');
  if (structure.resumeRoutePolicy === 'none' && structure.resumeRoute !== null) errors.push('/screens/productStructure/resumeRoute: none policy requires null');
  if (structure.resumeRoutePolicy === 'home' && structure.resumeRoute !== structure.primaryScreenId) errors.push('/screens/productStructure/resumeRoute: home policy requires the primary screen');
  if (structure.resumeRoutePolicy === 'incomplete-flow-step' && !keyFlowIds.includes(structure.resumeRoute)) errors.push('/screens/productStructure/resumeRoute: incomplete-flow-step policy requires a key-flow screen');
  if (structure.resumeRoutePolicy === 'last-visited' && structure.resumeRoute !== null) errors.push('/screens/productStructure/resumeRoute: last-visited policy must remain dynamic and null');
  for (const screenId of durableIds) if (!screenMap.has(screenId)) errors.push(`/screens/productStructure/durableDestinationIds: unknown screen ${screenId}`);
  for (const screen of screens) {
    const durable = durableIds.includes(screen.id);
    if (screen.id === structure.primaryScreenId && !['primary-hub', 'immersive-utility'].includes(screen.productRole)) errors.push(`/screens/items/${screen.id}/productRole: permanent primary must be a primary-hub or immersive-utility`);
    if (screen.id !== structure.primaryScreenId && durable && screen.productRole !== 'durable-destination') errors.push(`/screens/items/${screen.id}/productRole: durable destination must use durable-destination`);
    if (!durable && ['primary-hub', 'durable-destination'].includes(screen.productRole)) errors.push(`/screens/items/${screen.id}/productRole: bounded or transient screen cannot own a durable role`);
    if (['capture-surface', 'workflow-step', 'transient', 'modal'].includes(screen.productRole) && screen.id === structure.primaryScreenId) errors.push(`/screens/items/${screen.id}/productRole: capability or flow role cannot be permanent Home`);
  }
  if (structure.primaryScreenRole === 'immersive-utility') {
    if (!(structure.singlePurposeImmersiveEvidence || []).length) errors.push('/screens/productStructure/singlePurposeImmersiveEvidence: immersive Home requires explicit brief evidence');
  } else if ((structure.singlePurposeImmersiveEvidence || []).length) errors.push('/screens/productStructure/singlePurposeImmersiveEvidence: evidence is only valid for an immersive primary utility');
  validateEvidencePaths(plan, structure.singlePurposeImmersiveEvidence, '/screens/productStructure/singlePurposeImmersiveEvidence', errors);

  const independentJobIds = (structure.independentJobs || []).map((job) => job.id);
  for (const value of duplicates(independentJobIds)) errors.push(`/screens/productStructure/independentJobs: duplicate job ${value}`);
  for (const job of structure.independentJobs || []) {
    if (!durableIds.includes(job.owningScreenId)) errors.push(`/screens/productStructure/independentJobs/${job.id}/owningScreenId: must own a durable destination`);
    validateEvidencePaths(plan, job.evidencePaths, `/screens/productStructure/independentJobs/${job.id}/evidencePaths`, errors);
  }
  const boundedFlowIds = (structure.boundedFlows || []).map((flow) => flow.id);
  for (const value of duplicates(boundedFlowIds)) errors.push(`/screens/productStructure/boundedFlows: duplicate flow ${value}`);
  const boundedScreenIds = [];
  for (const flow of structure.boundedFlows || []) {
    if (!durableIds.includes(flow.ownerDestinationId)) errors.push(`/screens/productStructure/boundedFlows/${flow.id}/ownerDestinationId: must reference a durable destination`);
    for (const screenId of flow.screenIds) {
      if (!screenMap.has(screenId)) errors.push(`/screens/productStructure/boundedFlows/${flow.id}/screenIds: unknown screen ${screenId}`);
      if (durableIds.includes(screenId)) errors.push(`/screens/productStructure/boundedFlows/${flow.id}/screenIds: durable destination ${screenId} cannot be a bounded step`);
      boundedScreenIds.push(screenId);
    }
    validateEvidencePaths(plan, flow.evidencePaths, `/screens/productStructure/boundedFlows/${flow.id}/evidencePaths`, errors);
  }
  const expectedBoundedIds = screenIds.filter((screenId) => !durableIds.includes(screenId));
  if (!exactSet(boundedScreenIds, expectedBoundedIds)) errors.push('/screens/productStructure/boundedFlows: must cover every non-durable screen exactly once');
  for (const value of duplicates(boundedScreenIds)) errors.push(`/screens/productStructure/boundedFlows: screen appears in multiple flows: ${value}`);

  const conceptValues = {
    primaryScreenId: structure.primaryScreenId,
    launchRoute: structure.launchRoute,
    resumeRoute: structure.resumeRoute,
    'keyFlowScreenIds[0]': keyFlowIds[0],
  };
  const declaredEqualities = new Set();
  for (const equality of structure.intentionalEqualities || []) {
    const pair = [equality.left, equality.right].sort().join('|');
    if (equality.left === equality.right) errors.push('/screens/productStructure/intentionalEqualities: equality must compare two different concepts');
    if (declaredEqualities.has(pair)) errors.push(`/screens/productStructure/intentionalEqualities: duplicate equality ${pair}`);
    declaredEqualities.add(pair);
    if (conceptValues[equality.left] === null || conceptValues[equality.left] !== conceptValues[equality.right]) errors.push(`/screens/productStructure/intentionalEqualities/${pair}: declared concepts are not equal`);
    validateEvidencePaths(plan, equality.evidencePaths, `/screens/productStructure/intentionalEqualities/${pair}/evidencePaths`, errors);
  }
  const concepts = Object.keys(conceptValues);
  for (let left = 0; left < concepts.length; left += 1) {
    for (let right = left + 1; right < concepts.length; right += 1) {
      const leftName = concepts[left];
      const rightName = concepts[right];
      if (conceptValues[leftName] !== null && conceptValues[leftName] === conceptValues[rightName]) {
        const pair = [leftName, rightName].sort().join('|');
        if (!declaredEqualities.has(pair)) errors.push(`/screens/productStructure/intentionalEqualities: missing rationale for ${pair}`);
      }
    }
  }
  for (const screen of screens) {
    const visited = new Set([screen.id]);
    let parent = screen.routeIntent?.parentScreenId;
    while (parent) {
      if (visited.has(parent)) {
        errors.push(`/screens/items/${screen.id}/routeIntent/parentScreenId: route ownership cycle`);
        break;
      }
      visited.add(parent);
      parent = screenMap.get(parent)?.routeIntent?.parentScreenId;
    }
  }

  const journeyStageIds = new Set((context.workflowJourney?.stages || []).map((stage) => stage.id));
  if (journeyStageIds.size) {
    const boundStageIds = screens.flatMap((screen) => screen.journeyStageIds || []);
    for (const stageId of boundStageIds) if (!journeyStageIds.has(stageId)) errors.push(`/screens/items/journeyStageIds: unknown foreground stage ${stageId}`);
    for (const stageId of journeyStageIds) if (!boundStageIds.includes(stageId)) errors.push(`/screens/items/journeyStageIds: foreground stage ${stageId} is not bound to a screen`);
  }
  const contextEntryIds = new Set((context.contextContract?.displayContext || []).map((entry) => entry.id));
  if (contextEntryIds.size) for (const screen of screens) for (const entryId of screen.context?.entryIds || []) if (!contextEntryIds.has(entryId)) errors.push(`/screens/items/${screen.id}/context/entryIds: unknown foreground context entry ${entryId}`);
  const foundationMotifs = new Set((context.foundationContract?.primitives || []).map((primitive) => primitive.motif));
  if (foundationMotifs.size) for (const screen of screens) for (const motif of screen.foundationMotifs || []) if (!foundationMotifs.has(motif)) errors.push(`/screens/items/${screen.id}/foundationMotifs: unknown foreground motif ${motif}`);

  const preflightRequirements = context.executionPreflight?.requirements || [];
  if (preflightRequirements.length) {
    const ordinals = (plan.requirementBindings || []).map((binding) => binding.requirementOrdinal);
    const expected = preflightRequirements.map((requirement) => requirement.ordinal);
    if (!exactSet(ordinals, expected)) errors.push('/requirementBindings: must bind every foreground requirement ordinal exactly once');
    for (const binding of plan.requirementBindings || []) {
      if (binding.status === 'planned' && !binding.satisfiedBy.length) errors.push(`/requirementBindings/${binding.requirementOrdinal}/satisfiedBy: planned requirement needs an owner`);
      if (binding.status === 'not-planned' && !binding.reason) errors.push(`/requirementBindings/${binding.requirementOrdinal}/reason: not-planned requirement needs a reason`);
    }
  }
  const availableCapabilities = new Map((context.executionPreflight?.nativeCapabilities || []).map((item) => [item.id, item]));
  const selectedCapabilityIds = (plan.capabilitySelections || []).map((selection) => selection.capabilityId);
  for (const capabilityId of duplicates(selectedCapabilityIds)) errors.push(`/capabilitySelections: duplicate capability ${capabilityId}`);
  if (availableCapabilities.size && !exactSet(selectedCapabilityIds, [...availableCapabilities.keys()])) errors.push('/capabilitySelections: must bind every foreground native capability exactly once');
  const jobIds = new Set([
    ...(structure.independentJobs || []).map((job) => job.id),
    ...(structure.boundedFlows || []).map((flow) => flow.id),
  ]);
  for (const selection of plan.capabilitySelections || []) {
    const label = `/capabilitySelections/${selection.capabilityId}`;
    if (!availableCapabilities.has(selection.capabilityId)) errors.push(`${label}/capabilityId: capability is absent from the foreground preflight`);
    if (!jobIds.has(selection.supportedJobId)) errors.push(`${label}/supportedJobId: must reference an independent job or bounded flow`);
    if (!operationMap.has(selection.operationId)) errors.push(`${label}/operationId: must reference a domain operation`);
    const owningScreen = screenMap.get(selection.owningScreenId);
    if (!owningScreen) errors.push(`${label}/owningScreenId: unknown screen ${selection.owningScreenId}`);
    else if (!(owningScreen.data?.operations || []).some((operation) => operation.domainOperation === selection.operationId)) errors.push(`${label}/operationId: owning screen does not bind operation ${selection.operationId}`);
    const boundedFlow = (structure.boundedFlows || []).find((flow) => flow.id === selection.supportedJobId);
    const independentJob = (structure.independentJobs || []).find((job) => job.id === selection.supportedJobId);
    if (boundedFlow && !boundedFlow.screenIds.includes(selection.owningScreenId)) errors.push(`${label}/owningScreenId: must belong to supported bounded flow ${selection.supportedJobId}`);
    if (independentJob && independentJob.owningScreenId !== selection.owningScreenId) errors.push(`${label}/owningScreenId: must own supported independent job ${selection.supportedJobId}`);
    if (selection.primaryProductCapability) {
      if (selection.owningScreenId !== structure.primaryScreenId || structure.primaryScreenRole !== 'immersive-utility') errors.push(`${label}/primaryProductCapability: primary capability requires an immersive primary utility`);
      if (!(structure.singlePurposeImmersiveEvidence || []).length) errors.push(`${label}/primaryProductCapability: requires single-purpose immersive evidence`);
    } else if (selection.owningScreenId === structure.primaryScreenId) errors.push(`${label}/owningScreenId: supporting capability cannot own permanent Home`);
    validateEvidencePaths(plan, selection.evidencePaths, `${label}/evidencePaths`, errors);
  }
  const availableConnectors = new Set((context.executionPreflight?.connectorOperations || []).map((item) => item.id));
  for (const binding of plan.connectorIntentBindings || []) {
    if (!availableConnectors.has(binding.operationId)) errors.push(`/connectorIntentBindings/${binding.operationId}: operation is absent from the foreground preflight`);
    for (const screenId of binding.screenIds) if (!screenMap.has(screenId)) errors.push(`/connectorIntentBindings/${binding.operationId}/screenIds: unknown screen ${screenId}`);
  }

  for (const signature of plan.designIntent?.signatureComponents || []) {
    for (const motif of signature.foundationMotifs || []) {
      if (!foundationMotifs.has(motif)) errors.push(`/designIntent/signatureComponents/${signature.kind}/foundationMotifs: unknown foreground motif ${motif}`);
    }
    for (const screenId of signature.screenIds) {
      const screen = screenMap.get(screenId);
      if (!screen) errors.push(`/designIntent/signatureComponents/${signature.kind}/screenIds: unknown screen ${screenId}`);
      else if (signature.source === 'experience-primary') {
        const foreground = context.experienceContract?.visualCompositionIntent?.signatureComponent;
        if (screen.signatureComponent?.source !== 'experience-primary-signature' || foreground?.kind !== signature.kind || foreground?.testId !== signature.testId) errors.push(`/designIntent/signatureComponents/${signature.kind}: screen ${screenId} does not reference the foreground signature`);
      } else if (signature.source === 'experience-foundation') {
        const primitive = (context.foundationContract?.primitives || []).find((candidate) => signature.foundationMotifs?.includes(candidate.motif));
        if (!primitive || primitive.testID !== signature.testId) errors.push(`/designIntent/signatureComponents/${signature.kind}: does not reference the foreground foundation motif`);
      } else if (screen.signatureComponent?.kind !== signature.kind || screen.signatureComponent?.testId !== signature.testId) errors.push(`/designIntent/signatureComponents/${signature.kind}: screen ${screenId} does not preserve the signature kind and test ID`);
    }
  }
  const boundFoundationMotifs = (plan.designIntent?.signatureComponents || []).flatMap((signature) => signature.foundationMotifs || []);
  for (const motif of duplicates(boundFoundationMotifs)) errors.push(`/designIntent/signatureComponents/foundationMotifs: duplicate foreground motif ${motif}`);
  for (const motif of foundationMotifs) if (!boundFoundationMotifs.includes(motif)) errors.push(`/designIntent/signatureComponents/foundationMotifs: missing foreground motif ${motif}`);

  const navigation = plan.navigationIntent || {};
  const durable = navigation.durableDestinations || [];
  const navigationDurableIds = durable.map((destination) => destination.screenId);
  if (!exactSet(durableIds, navigationDurableIds)) errors.push('/screens/productStructure/durableDestinationIds: must match /navigationIntent/durableDestinations exactly');
  for (const value of duplicates(navigationDurableIds)) errors.push(`/navigationIntent/durableDestinations: duplicate screen ${value}`);
  for (const screenId of navigationDurableIds) if (!screenMap.has(screenId)) errors.push(`/navigationIntent/durableDestinations: unknown screen ${screenId}`);
  for (const screen of screens) {
    if (navigationDurableIds.includes(screen.id) && screen.routeIntent.parentScreenId !== null) errors.push(`/screens/items/${screen.id}/routeIntent/parentScreenId: durable destination must be a root`);
    if (!navigationDurableIds.includes(screen.id) && !screen.routeIntent.parentScreenId) errors.push(`/screens/items/${screen.id}/routeIntent/parentScreenId: nested screen requires an explicit semantic parent`);
  }
  if (!navigationDurableIds.includes(navigation.primaryDestinationScreenId)) errors.push('/navigationIntent/primaryDestinationScreenId: must be one of the durable destinations');
  const revisitIds = (navigation.revisitPatterns || []).map((pattern) => pattern.screenId);
  if (!exactSet(revisitIds, navigationDurableIds)) errors.push('/navigationIntent/revisitPatterns: must describe every durable destination exactly once');
  const nestedIds = screenIds.filter((screenId) => !navigationDurableIds.includes(screenId));
  const visibilityIds = (navigation.nestedScreenTabVisibility || []).map((item) => item.screenId);
  if (!exactSet(visibilityIds, nestedIds)) errors.push('/navigationIntent/nestedScreenTabVisibility: must describe every non-durable screen exactly once');
  if (navigation.tabsStackRecommendation?.recommended && navigationDurableIds.length < 3) errors.push('/navigationIntent/tabsStackRecommendation: tabs-stack requires at least three durable destinations');
  if (!navigation.tabsStackRecommendation?.recommended && !(navigation.stackOnlyEvidence || []).length) errors.push('/navigationIntent/stackOnlyEvidence: evidence is required when tabs-stack is not recommended');
  if (navigation.tabsStackRecommendation?.recommended && (navigation.stackOnlyEvidence || []).length) errors.push('/navigationIntent/stackOnlyEvidence: must be empty when tabs-stack is recommended');

  return { valid: errors.length === 0, errors };
}

module.exports = {
  FINAL_ARTIFACT_KEYS,
  REQUIRED_SCREEN_STATES,
  RESPONSE_LIMIT_BYTES,
  collectForbidden,
  semanticPlanRevision,
  sha256,
  validatePrototypeSemanticPlan,
};

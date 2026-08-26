'use strict';

const HEADER_MODES = new Set(['root', 'back', 'close', 'none']);
const ROLES = new Set(['primary', 'key-flow', 'supporting']);
const PRESENTATION_PATTERNS = new Set([
  'editorial-hero', 'image-card-grid', 'image-list', 'compact-list', 'form', 'timeline',
  'detail', 'conversation', 'summary', 'capture', 'guided-flow', 'custom',
]);
const DENSITIES = new Set(['sparse', 'balanced', 'dense']);
const ACTION_PLACEMENTS = new Set(['inline', 'sticky-bottom', 'header', 'floating']);
const MEDIA_FALLBACKS = new Set(['local-asset', 'code-native-illustration', 'text-only', 'none']);
const REQUIRED_STATES = ['loading', 'empty', 'error', 'offline'];
const OPERATION_KINDS = new Set(['list', 'get', 'create', 'update', 'delete', 'related-list', 'connector']);
const READ_KINDS = new Set(['list', 'get', 'related-list']);
const LIST_KINDS = new Set(['list', 'related-list']);
const METHOD_BY_KIND = Object.freeze({
  list: new Set(['getAll']),
  get: new Set(['get', 'getById']),
  create: new Set(['create']),
  update: new Set(['update']),
  delete: new Set(['delete']),
  'related-list': new Set(['getAll']),
});

function identifier(value) {
  const words = String(value || '').replace(/\([^)]*\)/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('') || 'Screen';
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function defaultPattern(screen, contract) {
  const text = `${screen.id || ''} ${screen.route || ''} ${screen.archetype || ''}`.toLowerCase();
  if (/detail|\[id\]/.test(text)) return 'detail';
  if (/catalog|categor|browse|collection/.test(text)) {
    return contract?.mediaIntent?.criticality === 'required' || contract?.contentModel?.includes('media') ? 'image-card-grid' : 'compact-list';
  }
  if (/\b(?:list|queue|records?)\b/.test(text)) return 'compact-list';
  if (/cart|bag|review|confirm|summary/.test(text)) return 'summary';
  if (/capture|scan|camera/.test(text)) return 'capture';
  if (/form|edit|create/.test(text)) return 'form';
  if (/message|inbox|conversation/.test(text)) return 'conversation';
  if (/timeline|history|activity/.test(text)) return 'timeline';
  if (screen.role === 'primary') return contract?.presentationIntent?.primaryPattern || 'guided-flow';
  return 'custom';
}

function defaultAction(screen, contract) {
  if (screen.role === 'primary') {
    return {
      id: 'primary-action',
      label: contract.firstViewport.primaryAction,
      placement: contract.presentationIntent?.primaryActionPlacement || 'inline',
    };
  }
  if (screen.role === 'key-flow') {
    return {
      id: `${slug(screen.id)}-primary-action`,
      label: screen.outcome || 'Continue',
      placement: 'sticky-bottom',
      clearance: {
        safeArea: true,
        tabBar: contract.navigationModel === 'tabs-stack' ? 'above' : 'not-applicable',
      },
    };
  }
  return null;
}

function defaultMedia(screen, contract, pattern) {
  const imageLed = ['editorial-hero', 'image-card-grid', 'image-list', 'detail'].includes(pattern);
  const required = imageLed && contract?.mediaIntent?.criticality === 'required';
  return {
    required,
    role: imageLed ? 'content' : 'supporting',
    aspectRatio: pattern === 'editorial-hero' ? '16:9' : pattern === 'detail' ? '1:1' : '4:3',
    minCoverage: required ? (contract.mediaIntent?.minimumCoverage ?? 0.9) : 0,
    fallback: contract?.mediaIntent?.fallback || (required ? 'code-native-illustration' : 'text-only'),
  };
}

function legacyScreenSpec(raw, role, contract, foundationComponents) {
  const screen = { ...raw, role };
  const pattern = defaultPattern(screen, contract);
  const id = role === 'primary' ? 'Home' : identifier(raw.id || raw.route);
  const action = defaultAction({ ...screen, id }, contract);
  const regionIds = role === 'primary'
    ? contract.firstViewport.regionOrder.map((region) => `experience-region-${slug(region)}`)
    : [`${slug(id)}-content`, ...(action ? [`${slug(id)}-action`] : [])];
  return {
    id,
    route: raw.route,
    file: raw.file,
    role,
    ...(typeof raw.productRole === 'string' && raw.productRole ? { productRole: raw.productRole } : {}),
    ...(raw.navigation && typeof raw.navigation === 'object' && !Array.isArray(raw.navigation)
      ? { navigation: { ...raw.navigation, ...(raw.navigation.candidate ? { candidate: { ...raw.navigation.candidate } } : {}) } }
      : {}),
    routeParameters: (raw.routeParameters || []).map((parameter) => ({ ...parameter })),
    purpose: role === 'primary' ? contract.primaryJob : raw.outcome || `Support ${contract.primaryJob.toLowerCase()}`,
    presentation: {
      pattern,
      density: contract.firstViewport.contentDensity,
      hierarchy: role === 'primary'
        ? [contract.firstViewport.focalPoint, contract.firstViewport.primaryAction]
        : [raw.outcome || `${id} content`, action?.label || 'Supporting information'],
    },
    regions: regionIds.map((regionId, index) => ({
      id: regionId,
      kind: index === 0 ? 'content' : 'action',
      priority: index === 0 ? 1 : 2,
      viewport: index < 2 ? 'first' : 'below-fold',
      mediaRequired: index === 0 && ['editorial-hero', 'image-card-grid', 'image-list', 'detail'].includes(pattern),
    })),
    firstViewport: {
      regionIds: regionIds.slice(0, contract.presentationIntent?.maxFirstViewportRegions || 4),
      focalPoint: role === 'primary' ? contract.firstViewport.focalPoint : raw.outcome || `${id} content`,
      maxRegions: contract.presentationIntent?.maxFirstViewportRegions || 4,
      nextContentVisible: contract.visualCompositionIntent?.nextContentVisible ?? true,
      maxFeatureViewportShare: contract.visualCompositionIntent?.maxFeatureViewportShare ?? 0.38,
    },
    context: { entryIds: [], placementIntent: 'none', assumptions: [] },
    signatureComponent: role === 'primary'
      ? { ...(contract.visualCompositionIntent?.signatureComponent || { kind: 'experience-signature', required: true, testId: 'experience-signature-primary' }) }
      : { kind: 'supporting-screen', required: false, testId: null },
    header: { mode: role === 'primary' ? 'root' : 'back', title: role === 'primary' ? '' : id.replace(/([a-z])([A-Z])/g, '$1 $2') },
    primaryAction: action,
    media: { ...defaultMedia(screen, contract, pattern), prominence: role === 'primary' ? contract.visualCompositionIntent?.mediaProminence || 'medium' : 'low' },
    states: [...REQUIRED_STATES],
    qualityCriteria: [
      'Preserve one obvious focal point in the first viewport.',
      'Keep the primary action visible without overlapping system or host controls.',
      'Support large text without clipping or horizontal overflow.',
    ],
    testIds: role === 'primary' ? [] : role === 'key-flow' ? ['experience-key-flow'] : [`screen-${slug(id)}`],
    dependencies: { foundation: foundationComponents, fixtures: [], screens: [] },
    data: { entities: [], fixtureScenarios: ['populated', ...REQUIRED_STATES] },
    capabilityComposition: (raw.capabilityComposition || []).map((composition) => ({ ...composition })),
    forbiddenDefaults: [],
    contractSource: 'legacy-derived',
  };
}

function normalizeV2Screen(screen) {
  return {
    ...screen,
    routeParameters: (screen.routeParameters || []).map((parameter) => ({ ...parameter })),
    navigation: screen.navigation ? { ...screen.navigation } : undefined,
    header: { ...screen.header },
    presentation: { ...screen.presentation },
    regions: (screen.regions || []).map((region) => ({ ...region })),
    firstViewport: { ...screen.firstViewport, regionIds: [...(screen.firstViewport?.regionIds || [])] },
    context: screen.context ? { ...screen.context, entryIds: [...(screen.context.entryIds || [])], assumptions: [...(screen.context.assumptions || [])] } : undefined,
    signatureComponent: screen.signatureComponent ? { ...screen.signatureComponent } : undefined,
    primaryAction: screen.primaryAction ? { ...screen.primaryAction } : null,
    media: { ...screen.media },
    states: [...(screen.states || [])],
    qualityCriteria: [...(screen.qualityCriteria || [])],
    testIds: [...(screen.testIds || [])],
    dependencies: {
      foundation: [...(screen.dependencies?.foundation || [])],
      fixtures: [...(screen.dependencies?.fixtures || [])],
      screens: [...(screen.dependencies?.screens || [])],
    },
    data: {
      entities: [...(screen.data?.entities || [])],
      fixtureScenarios: [...(screen.data?.fixtureScenarios || [])],
      operations: (screen.data?.operations || []).map((operation) => ({
        ...operation,
        select: [...(operation.select || [])],
        filter: (operation.filter || []).map((item) => ({ ...item })),
        sort: (operation.sort || []).map((item) => ({ ...item })),
        routeBindings: (operation.routeBindings || []).map((binding) => ({ ...binding })),
        writeFields: [...(operation.writeFields || [])],
        ...(operation.pagination ? { pagination: { ...operation.pagination } } : {}),
        ...(operation.relationship ? { relationship: { ...operation.relationship } } : {}),
      })),
    },
    forbiddenDefaults: [...(screen.forbiddenDefaults || [])],
    contractSource: 'structured',
  };
}

function normalizeScreenContract(screenContract, contract, fallbackScreens = [], foundationComponents = []) {
  if ([2, 3].includes(screenContract?.schemaVersion) && Array.isArray(screenContract.screens)) {
    return screenContract.screens.map(normalizeV2Screen);
  }

  // Version 1 plans remain executable while planners migrate. Only this compatibility
  // adapter reads the Markdown screen map; v2 builders receive no Markdown-derived intent.
  const primary = screenContract?.primaryScreen;
  const keyFlow = screenContract?.keyFlow;
  const merged = [...fallbackScreens];
  for (const candidate of [
    primary && { ...primary, id: 'Home' },
    keyFlow && { ...keyFlow, id: identifier(keyFlow.route) },
    ...(screenContract?.requiredScreens || []),
  ].filter(Boolean)) {
    const existing = merged.findIndex((screen) => screen.route === candidate.route);
    if (existing >= 0) merged[existing] = { ...merged[existing], ...candidate };
    else merged.push(candidate);
  }
  return merged.map((screen) => {
    const role = screen.route === primary?.route ? 'primary' : screen.route === keyFlow?.route ? 'key-flow' : 'supporting';
    const spec = legacyScreenSpec(screen, role, contract, foundationComponents);
    if (role === 'primary') {
      spec.testIds = [...(primary?.runtimeMarkers || [])];
      spec.forbiddenDefaults = [...(primary?.forbiddenDefaults || contract.forbiddenDefaults || [])];
    }
    return spec;
  });
}

function validateScreenSpec(screen, index, errors) {
  const label = `screens[${index}]`;
  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (typeof screen.id !== 'string' || !screen.id.trim()) errors.push(`${label}.id is required`);
  if (typeof screen.route !== 'string' || !screen.route.startsWith('/')) errors.push(`${label}.route must start with /`);
  if (typeof screen.file !== 'string' || !/^app\/.+\.tsx$/i.test(screen.file)) errors.push(`${label}.file must be an app/*.tsx path`);
  if (!ROLES.has(screen.role)) errors.push(`${label}.role is invalid`);
  if (typeof screen.purpose !== 'string' || screen.purpose.trim().length < 5) errors.push(`${label}.purpose is required`);
  if (!PRESENTATION_PATTERNS.has(screen.presentation?.pattern)) errors.push(`${label}.presentation.pattern is invalid`);
  if (!DENSITIES.has(screen.presentation?.density)) errors.push(`${label}.presentation.density is invalid`);
  if (!Array.isArray(screen.presentation?.hierarchy) || screen.presentation.hierarchy.length < 2) errors.push(`${label}.presentation.hierarchy requires at least two ordered levels`);
  if (!Array.isArray(screen.regions) || !screen.regions.length) errors.push(`${label}.regions must be non-empty`);
  const regionIds = new Set();
  for (const [regionIndex, region] of (screen.regions || []).entries()) {
    if (typeof region?.id !== 'string' || !region.id.trim() || regionIds.has(region.id)) errors.push(`${label}.regions[${regionIndex}].id must be unique`);
    else regionIds.add(region.id);
    if (typeof region?.kind !== 'string' || !region.kind.trim()) errors.push(`${label}.regions[${regionIndex}].kind is required`);
    if (![1, 2, 3].includes(region?.priority)) errors.push(`${label}.regions[${regionIndex}].priority must be 1, 2, or 3`);
    if (!['first', 'below-fold'].includes(region?.viewport)) errors.push(`${label}.regions[${regionIndex}].viewport is invalid`);
    if (typeof region?.mediaRequired !== 'boolean') errors.push(`${label}.regions[${regionIndex}].mediaRequired must be boolean`);
  }
  if (!Array.isArray(screen.firstViewport?.regionIds) || !screen.firstViewport.regionIds.length || screen.firstViewport.regionIds.some((id) => !regionIds.has(id))) errors.push(`${label}.firstViewport.regionIds must reference declared regions`);
  if (typeof screen.firstViewport?.focalPoint !== 'string' || screen.firstViewport.focalPoint.trim().length < 5) errors.push(`${label}.firstViewport.focalPoint is required`);
  if (!Number.isInteger(screen.firstViewport?.maxRegions) || screen.firstViewport.maxRegions < 1 || screen.firstViewport.maxRegions > 5 || (screen.firstViewport.regionIds || []).length > screen.firstViewport.maxRegions) errors.push(`${label}.firstViewport.maxRegions must be 1-5 and bound regionIds`);
  if (screen.firstViewport?.nextContentVisible !== undefined && typeof screen.firstViewport.nextContentVisible !== 'boolean') errors.push(`${label}.firstViewport.nextContentVisible must be boolean`);
  if (screen.firstViewport?.maxFeatureViewportShare !== undefined && (typeof screen.firstViewport.maxFeatureViewportShare !== 'number' || screen.firstViewport.maxFeatureViewportShare < 0 || screen.firstViewport.maxFeatureViewportShare > 0.6)) errors.push(`${label}.firstViewport.maxFeatureViewportShare is invalid`);
  if (!HEADER_MODES.has(screen.header?.mode)) errors.push(`${label}.header.mode is invalid`);
  if (typeof screen.header?.title !== 'string') errors.push(`${label}.header.title must be a string`);
  if (screen.primaryAction !== null && (typeof screen.primaryAction?.id !== 'string' || typeof screen.primaryAction?.label !== 'string' || !ACTION_PLACEMENTS.has(screen.primaryAction?.placement))) errors.push(`${label}.primaryAction is invalid`);
  if (typeof screen.media?.required !== 'boolean' || typeof screen.media?.role !== 'string' || typeof screen.media?.aspectRatio !== 'string' || typeof screen.media?.minCoverage !== 'number' || screen.media.minCoverage < 0 || screen.media.minCoverage > 1 || !MEDIA_FALLBACKS.has(screen.media?.fallback)) errors.push(`${label}.media is invalid`);
  if (screen.media?.required && screen.media.fallback === 'text-only') errors.push(`${label}.media cannot use text-only fallback when media is required`);
  if (screen.media?.prominence !== undefined && !['none', 'low', 'medium', 'high'].includes(screen.media.prominence)) errors.push(`${label}.media.prominence is invalid`);
  if (!Array.isArray(screen.states) || !REQUIRED_STATES.every((state) => screen.states.includes(state))) errors.push(`${label}.states must include ${REQUIRED_STATES.join(', ')}`);
  if (!Array.isArray(screen.qualityCriteria) || screen.qualityCriteria.length < 3) errors.push(`${label}.qualityCriteria requires at least three checks`);
  if (!Array.isArray(screen.testIds) || !screen.testIds.length) errors.push(`${label}.testIds must be non-empty`);
  for (const key of ['foundation', 'fixtures', 'screens']) {
    if (!Array.isArray(screen.dependencies?.[key])) errors.push(`${label}.dependencies.${key} must be an array`);
  }
  if (!Array.isArray(screen.data?.entities) || !Array.isArray(screen.data?.fixtureScenarios)) errors.push(`${label}.data requires entities and fixtureScenarios arrays`);
  if (!Array.isArray(screen.forbiddenDefaults)) errors.push(`${label}.forbiddenDefaults must be an array`);
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase();
}

function activeTables(dataContract) {
  return (dataContract?.tables || []).filter((table) => table?.logicalName
    && table.serviceRequired !== false
    && normalizedName(table.plannedDecision || table.decision) !== 'defer');
}

function tableByLogicalName(dataContract, logicalName) {
  const target = normalizedName(logicalName);
  return activeTables(dataContract).find((table) => normalizedName(table.logicalName) === target) || null;
}

function tableFieldNames(table) {
  return new Set([
    table?.primaryIdAttribute,
    ...(table?.columns || [])
      .filter((column) => normalizedName(column.plannedDecision || column.decision) !== 'defer')
      .map((column) => column.logicalName || column.name),
  ].filter(Boolean).map(normalizedName));
}

function relationshipBySchemaName(dataContract, schemaName) {
  const target = normalizedName(schemaName);
  for (const owner of activeTables(dataContract)) {
    const relationship = (owner.relationships || []).find((candidate) => (
      normalizedName(candidate.schemaName) === target
      && normalizedName(candidate.plannedDecision || candidate.decision) !== 'defer'
    ));
    if (relationship) return { owner, relationship };
  }
  return null;
}

function pathParameters(route) {
  return [...String(route || '').matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((match) => match[1]);
}

function validatePagination(operation, label, errors) {
  const pagination = operation.pagination;
  if (!pagination || !['cursor', 'bounded', 'none'].includes(pagination.mode)) {
    errors.push(`${label}.pagination is required for list operations`);
    return;
  }
  if (['none', 'bounded'].includes(pagination.mode)) {
    if (typeof pagination.boundedReason !== 'string' || pagination.boundedReason.trim().length < 5) errors.push(`${label}.pagination none requires boundedReason`);
    if (!Number.isInteger(pagination.maximumExpectedCount) || pagination.maximumExpectedCount < 0) errors.push(`${label}.pagination none requires maximumExpectedCount`);
  } else {
    if (!Number.isInteger(pagination.pageSize) || pagination.pageSize < 1 || pagination.pageSize > 100) errors.push(`${label}.pagination ${pagination.mode} requires pageSize between 1 and 100`);
    const parameter = pagination.cursorParameter;
    if (typeof parameter !== 'string' || !parameter.trim()) errors.push(`${label}.pagination ${pagination.mode} requires its continuation parameter`);
  }
}

function domainEntityByKey(dataContract, key) {
  return (dataContract?.entities || []).find((entity) => entity.key === key) || null;
}

function domainOperationByKey(dataContract, key) {
  return (dataContract?.operations || []).find((operation) => operation.key === key) || null;
}

function domainRelationshipByKey(dataContract, key) {
  return (dataContract?.relationships || []).find((relationship) => relationship.key === key) || null;
}

function validateDomainRelationship(operation, label, dataContract, errors) {
  const binding = operation.relationship;
  if (!binding || typeof binding !== 'object') {
    errors.push(`${label}.relationship is required for related-list operations`);
    return;
  }
  const relationship = domainRelationshipByKey(dataContract, binding.key);
  if (!relationship) {
    errors.push(`${label}.relationship ${binding.key || '<missing>'} does not exist in the prototype domain model`);
    return;
  }
  const parent = domainEntityByKey(dataContract, relationship.parent);
  const parentId = parent?.fields?.find((field) => field.type === 'id')?.key;
  if (binding.sourceEntity !== relationship.parent || binding.targetEntity !== relationship.child) errors.push(`${label}.relationship source/target do not match ${binding.key}`);
  if (binding.sourceField !== parentId || binding.targetField !== relationship.childField) errors.push(`${label}.relationship fields do not match ${binding.key}`);
  if (binding.readStrategy === 'external-projection-required') errors.push(`${label}.relationship requires an unresolved external projection`);
  if (binding.readStrategy !== 'repository') errors.push(`${label}.related-list must use repository read strategy`);
  if (binding.sourceRouteParameter) {
    const expectedValueFrom = `route:${binding.sourceRouteParameter}`;
    const routeBound = (operation.routeBindings || []).some((item) => item.parameter === binding.sourceRouteParameter && item.target === 'relationship' && item.field === relationship.childField);
    const filterBound = (operation.filter || []).some((item) => item.field === relationship.childField && item.valueFrom === expectedValueFrom);
    if (!routeBound || !filterBound) errors.push(`${label}.relationship route parameter ${binding.sourceRouteParameter} must bind and filter ${relationship.childField}`);
  }
}

function validateDomainOperation(operation, screen, label, context, errors) {
  const domainOperation = domainOperationByKey(context.dataContract, operation.domainOperation);
  if (!domainOperation) {
    errors.push(`${label}.domainOperation ${operation.domainOperation || '<missing>'} does not exist in the prototype domain model`);
    return;
  }
  const expectedKind = operation.kind === 'related-list' ? 'list' : operation.kind;
  if (domainOperation.kind !== expectedKind) errors.push(`${label}.kind does not match domain operation ${domainOperation.key}`);
  if (operation.entity !== domainOperation.entity) errors.push(`${label}.entity does not match domain operation ${domainOperation.key}`);
  if (operation.repository !== domainOperation.repository || operation.repositoryMethod !== domainOperation.method || operation.hook !== domainOperation.hook) errors.push(`${label} repository or hook identity does not match domain operation ${domainOperation.key}`);
  if (!(screen.data?.entities || []).includes(domainOperation.entity)) errors.push(`${label}.entity is missing from screen.data.entities`);
  const entity = domainEntityByKey(context.dataContract, domainOperation.entity);
  const fields = new Set((entity?.fields || []).map((field) => field.key));
  for (const field of [...(operation.select || []), ...(operation.filter || []).map((item) => item.field), ...(operation.sort || []).map((item) => item.field), ...(operation.writeFields || []), operation.idField].filter(Boolean)) {
    if (!fields.has(field)) errors.push(`${label} references unknown domain field ${field}`);
  }
  for (const field of operation.select || []) if (!(domainOperation.selectFields || []).includes(field)) errors.push(`${label}.select field ${field} is not approved by ${domainOperation.key}`);
  for (const filter of operation.filter || []) if (!(domainOperation.filterFields || []).includes(filter.field)) errors.push(`${label}.filter field ${filter.field} is not approved by ${domainOperation.key}`);
  for (const sort of operation.sort || []) if (!(domainOperation.sortFields || []).includes(sort.field)) errors.push(`${label}.sort field ${sort.field} is not approved by ${domainOperation.key}`);
  for (const field of operation.writeFields || []) if (!(domainOperation.writeFields || []).includes(field)) errors.push(`${label}.write field ${field} is not approved by ${domainOperation.key}`);
  if (['list', 'related-list'].includes(operation.kind)) {
    validatePagination(operation, label, errors);
    const expectedMode = domainOperation.pagination?.mode;
    if (operation.pagination?.mode !== expectedMode) errors.push(`${label}.pagination mode does not match domain operation ${domainOperation.key}`);
  }
  if (operation.kind === 'related-list' || operation.relationship) validateDomainRelationship(operation, label, context.dataContract, errors);
}

function validateRelationshipBinding(operation, label, dataContract, errors) {
  const binding = operation.relationship;
  if (!binding || typeof binding !== 'object') {
    errors.push(`${label}.relationship is required for related-list operations`);
    return;
  }
  const match = relationshipBySchemaName(dataContract, binding.schemaName);
  if (!match) {
    errors.push(`${label}.relationship ${binding.schemaName || '<missing>'} does not exist in the data contract`);
    return;
  }
  const { owner, relationship } = match;
  if (!['formatted-lookup', 'chained-fetch', 'external-projection-required'].includes(binding.readStrategy)) errors.push(`${label}.relationship readStrategy is invalid`);
  if (binding.readStrategy === 'external-projection-required') errors.push(`${label}.relationship requires an unresolved external projection`);
  if (operation.kind === 'related-list' && binding.readStrategy !== 'chained-fetch') errors.push(`${label}.related-list must use a bounded chained-fetch strategy`);
  const kind = normalizedName(relationship.kind);
  let expectedSource;
  let expectedTarget;
  let expectedSourceField;
  let expectedTargetField;
  let routeFilterField;
  if (kind === 'many-to-one') {
    const parent = relationship.parentTable;
    const child = relationship.childTable || owner.logicalName;
    const parentTable = tableByLogicalName(dataContract, parent);
    expectedSource = parent;
    expectedTarget = child;
    expectedSourceField = parentTable?.primaryIdAttribute || `${parent}id`;
    expectedTargetField = relationship.lookup?.logicalName;
    routeFilterField = expectedTargetField;
  } else if (kind === 'many-to-many') {
    expectedSource = relationship.entity1;
    expectedTarget = relationship.entity2;
    const intersectName = relationship.adaptedIntersectTable || relationship.intersectTable;
    const intersect = tableByLogicalName(dataContract, intersectName);
    if (!intersect || normalizedName(operation.entity) !== normalizedName(intersectName)) {
      errors.push(`${label}.relationship ${binding.schemaName} requires an explicit intersect table operation on ${intersectName || '<missing>'}`);
    } else {
      const sourceLookup = (intersect.columns || []).find((column) => normalizedName(column.lookupTarget || column.target) === normalizedName(expectedSource));
      const targetLookup = (intersect.columns || []).find((column) => normalizedName(column.lookupTarget || column.target) === normalizedName(expectedTarget));
      expectedSourceField = sourceLookup?.logicalName || sourceLookup?.name;
      expectedTargetField = targetLookup?.logicalName || targetLookup?.name;
      routeFilterField = expectedSourceField;
      if (!expectedSourceField || !expectedTargetField) errors.push(`${label}.relationship ${binding.schemaName} intersect table lacks lookup fields for both entities`);
    }
  }
  if (normalizedName(binding.sourceEntity) !== normalizedName(expectedSource)
    || normalizedName(binding.targetEntity) !== normalizedName(expectedTarget)) {
    errors.push(`${label}.relationship source/target do not match ${binding.schemaName}`);
  }
  if (expectedSourceField && normalizedName(binding.sourceField) !== normalizedName(expectedSourceField)) errors.push(`${label}.relationship sourceField does not match ${expectedSourceField}`);
  if (expectedTargetField && normalizedName(binding.targetField) !== normalizedName(expectedTargetField)) errors.push(`${label}.relationship targetField does not match ${expectedTargetField}`);
  if (binding.sourceRouteParameter) {
    const expectedValueFrom = `route:${binding.sourceRouteParameter}`;
    const hasRelationshipRouteBinding = (operation.routeBindings || []).some((routeBinding) => (
      routeBinding?.parameter === binding.sourceRouteParameter
      && routeBinding.target === 'relationship'
      && normalizedName(routeBinding.field) === normalizedName(routeFilterField || binding.targetField)
    ));
    const hasRelationshipFilter = (operation.filter || []).some((filter) => (
      normalizedName(filter?.field) === normalizedName(routeFilterField || binding.targetField)
      && filter.valueFrom === expectedValueFrom
    ));
    if (!hasRelationshipRouteBinding || !hasRelationshipFilter) {
      errors.push(`${label}.relationship route parameter ${binding.sourceRouteParameter} must bind and filter ${routeFilterField || binding.targetField}`);
    }
  }
}

function validateOperation(operation, screen, screenIndex, operationIndex, context, errors) {
  const label = `screens[${screenIndex}].data.operations[${operationIndex}]`;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(String(operation.id || ''))) errors.push(`${label}.id is invalid`);
  if (!OPERATION_KINDS.has(operation.kind)) errors.push(`${label}.kind is invalid`);
  if (typeof operation.repository !== 'string' || !operation.repository.trim()) errors.push(`${label}.repository is required`);
  if (typeof operation.repositoryMethod !== 'string' || !operation.repositoryMethod.trim()) errors.push(`${label}.repositoryMethod is required`);
  if (typeof operation.hook !== 'string' || !operation.hook.trim()) errors.push(`${label}.hook is required`);
  const routeParameters = new Set((screen.routeParameters || []).map((parameter) => parameter.name));
  if (!Array.isArray(operation.routeBindings)) errors.push(`${label}.routeBindings must be an array`);
  for (const [bindingIndex, binding] of (operation.routeBindings || []).entries()) {
    if (!routeParameters.has(binding?.parameter)) errors.push(`${label}.routeBindings references undeclared parameter ${binding?.parameter || '<missing>'}`);
    if (!['id', 'filter', 'relationship', 'input'].includes(binding?.target) || typeof binding?.field !== 'string' || !binding.field.trim()) errors.push(`${label}.routeBindings[${bindingIndex}] is invalid`);
  }
  if (READ_KINDS.has(operation.kind) && (!Array.isArray(operation.select) || !operation.select.length)) errors.push(`${label}.select must be non-empty for read operations`);
  if (['create', 'update'].includes(operation.kind) && (!Array.isArray(operation.writeFields) || !operation.writeFields.length)) errors.push(`${label}.writeFields must be non-empty for ${operation.kind}`);
  if (['get', 'update', 'delete'].includes(operation.kind)) {
    if (!operation.idField) errors.push(`${label}.idField is required for ${operation.kind}`);
    else if (!(operation.routeBindings || []).some((binding) => binding?.target === 'id' && binding.field === operation.idField)) {
      const parameter = (screen.routeParameters || []).find((candidate) => candidate?.required)?.name || '<required>';
      errors.push(`${label} path parameter ${parameter} is not bound to screen operation id field ${operation.idField}`);
    }
  }
  for (const [filterIndex, filter] of (operation.filter || []).entries()) {
    if (!['eq', 'ne', 'contains', 'startswith', 'endswith', 'gt', 'ge', 'lt', 'le', 'in'].includes(filter?.operator)) errors.push(`${label}.filter[${filterIndex}].operator is invalid`);
    const hasValue = Object.prototype.hasOwnProperty.call(filter || {}, 'value');
    const hasValueFrom = typeof filter?.valueFrom === 'string' && filter.valueFrom.length > 0;
    if (hasValue === hasValueFrom) errors.push(`${label}.filter[${filterIndex}] requires exactly one of value or valueFrom`);
    if (hasValueFrom && filter.valueFrom.startsWith('route:') && !routeParameters.has(filter.valueFrom.slice(6))) errors.push(`${label}.filter[${filterIndex}] references undeclared route parameter ${filter.valueFrom.slice(6)}`);
  }
  for (const [sortIndex, sort] of (operation.sort || []).entries()) {
    if (!sort || typeof sort.field !== 'string' || !['asc', 'desc'].includes(sort.direction)) errors.push(`${label}.sort[${sortIndex}] is invalid`);
  }

  if (operation.kind === 'connector') {
    if (!/^connector-[a-z0-9][a-z0-9-]*$/.test(String(operation.connectorOperationId || ''))) {
      errors.push(`${label}.connectorOperationId is required and must use the connector-* identifier format`);
      return;
    }
    const connector = (context.executionContract?.connectorOperations || []).find((item) => item.id === operation.connectorOperationId);
    if (!connector) errors.push(`${label}.connectorOperationId does not resolve in the execution contract`);
    else if (operation.domainOperation !== connector.id) errors.push(`${label}.domainOperation must match connector operation ${connector.id}`);
    return;
  }

  if (context.dataContract?.mode === 'prototype-domain') {
    validateDomainOperation(operation, screen, label, context, errors);
    return;
  }

  const allowedMethods = METHOD_BY_KIND[operation.kind];
  if (allowedMethods && !allowedMethods.has(operation.repositoryMethod)) errors.push(`${label}.repositoryMethod ${operation.repositoryMethod} is invalid for ${operation.kind}`);
  if (context.serviceSurface) {
    const serviceMethods = context.serviceSurface[operation.service];
    if (!serviceMethods) errors.push(`${label}.service ${operation.service} is absent from the generated service surface`);
    else if (!serviceMethods.includes(operation.serviceMethod)) errors.push(`${label}.serviceMethod ${operation.serviceMethod} is absent from service ${operation.service}`);
  }
  if (READ_KINDS.has(operation.kind) && (!Array.isArray(operation.select) || !operation.select.length)) errors.push(`${label}.select must be non-empty for read operations`);
  if (LIST_KINDS.has(operation.kind)) validatePagination(operation, label, errors);
  if (['create', 'update'].includes(operation.kind) && (!Array.isArray(operation.writeFields) || !operation.writeFields.length)) errors.push(`${label}.writeFields must be non-empty for ${operation.kind}`);
  if (['get', 'update', 'delete'].includes(operation.kind)) {
    if (!operation.idField) {
      errors.push(`${label}.idField is required for ${operation.kind}`);
    } else if (!(operation.routeBindings || []).some((binding) => (
      binding?.target === 'id' && normalizedName(binding.field) === normalizedName(operation.idField)
    ))) {
      const parameter = (screen.routeParameters || []).find((candidate) => candidate?.required)?.name || '<required>';
      errors.push(`${label} path parameter ${parameter} is not bound to a screen operation id field ${operation.idField}`);
    }
  }
  for (const [filterIndex, filter] of (operation.filter || []).entries()) {
    if (!['eq', 'ne', 'contains', 'startswith', 'endswith', 'gt', 'ge', 'lt', 'le', 'in'].includes(filter?.operator)) errors.push(`${label}.filter[${filterIndex}].operator is invalid`);
    const hasValue = Object.prototype.hasOwnProperty.call(filter || {}, 'value');
    const hasValueFrom = typeof filter?.valueFrom === 'string' && filter.valueFrom.length > 0;
    if (hasValue === hasValueFrom) errors.push(`${label}.filter[${filterIndex}] requires exactly one of value or valueFrom`);
    if (hasValueFrom && filter.valueFrom.startsWith('route:') && !routeParameters.has(filter.valueFrom.slice(6))) errors.push(`${label}.filter[${filterIndex}] references undeclared route parameter ${filter.valueFrom.slice(6)}`);
  }
  for (const [sortIndex, sort] of (operation.sort || []).entries()) {
    if (!sort || typeof sort.field !== 'string' || !['asc', 'desc'].includes(sort.direction)) errors.push(`${label}.sort[${sortIndex}] is invalid`);
  }
  if (!context.dataContract) return;

  const table = tableByLogicalName(context.dataContract, operation.entity);
  if (!table) {
    errors.push(`${label}.entity ${operation.entity || '<missing>'} is not an active logical table`);
    return;
  }
  if (!(screen.data?.entities || []).some((entity) => normalizedName(entity) === normalizedName(operation.entity))) errors.push(`${label}.entity is missing from screen.data.entities`);
  const fields = tableFieldNames(table);
  const fieldReferences = [
    ...(operation.select || []),
    ...(operation.filter || []).map((item) => item?.field),
    ...(operation.sort || []).map((item) => item?.field),
    ...(operation.writeFields || []),
    operation.idField,
  ].filter(Boolean);
  for (const field of fieldReferences) {
    if (!fields.has(normalizedName(field))) errors.push(`${label} references unknown field ${field} on ${table.logicalName}`);
  }
  if (operation.relationship) validateRelationshipBinding(operation, label, context.dataContract, errors);
  else if (operation.kind === 'related-list') validateRelationshipBinding(operation, label, context.dataContract, errors);
}

function validateV3Operations(screenContract, contract, context, errors) {
  const operationIds = [];
  const routes = new Set(screenContract.screens.map((screen) => screen.route));
  const tabRoots = [];
  const contextEntries = new Map((context.contextContract?.displayContext || []).map((entry) => [entry.id, entry]));
  for (const [screenIndex, screen] of screenContract.screens.entries()) {
    const screenLabel = `screens[${screenIndex}]`;
    if (!screen.context || !Array.isArray(screen.context.entryIds) || !Array.isArray(screen.context.assumptions) || !['primary-screen-context-rail', 'inline-label', 'supporting-section', 'none'].includes(screen.context.placementIntent)) {
      errors.push(`${screenLabel}.context is invalid`);
    } else {
      if (!screen.context.entryIds.length && screen.context.placementIntent !== 'none') errors.push(`${screenLabel}.context placement must be none when no context entries are used`);
      if (screen.context.entryIds.length && screen.context.placementIntent === 'none') errors.push(`${screenLabel}.context placement is required when context entries are used`);
      for (const entryId of screen.context.entryIds) {
        const entry = contextEntries.get(entryId);
        if (!entry) errors.push(`${screenLabel}.context references unknown entry ${entryId}`);
        else if (!screen.context.assumptions.includes(entry.assumption)) errors.push(`${screenLabel}.context must preserve the assumption for ${entryId}`);
      }
    }
    if (typeof screen.firstViewport?.nextContentVisible !== 'boolean' || typeof screen.firstViewport?.maxFeatureViewportShare !== 'number') errors.push(`${screenLabel}.firstViewport requires nextContentVisible and maxFeatureViewportShare`);
    if (!screen.signatureComponent || typeof screen.signatureComponent.required !== 'boolean' || typeof screen.signatureComponent.kind !== 'string') errors.push(`${screenLabel}.signatureComponent is invalid`);
    if (!['none', 'low', 'medium', 'high'].includes(screen.media?.prominence)) errors.push(`${screenLabel}.media.prominence is required`);
    if (screen.signatureComponent?.required && (!screen.signatureComponent.testId || !(screen.testIds || []).includes(screen.signatureComponent.testId))) errors.push(`${screenLabel}.signatureComponent testId must be present in screen.testIds`);
    if (screen.role === 'primary' && contract?.visualCompositionIntent) {
      const expectedSignature = contract.visualCompositionIntent.signatureComponent;
      if (screen.signatureComponent?.kind !== expectedSignature.kind || screen.signatureComponent?.required !== true || screen.signatureComponent?.testId !== expectedSignature.testId) errors.push(`${screenLabel}.signatureComponent does not match visualCompositionIntent`);
      if (screen.firstViewport.nextContentVisible !== contract.visualCompositionIntent.nextContentVisible) errors.push(`${screenLabel}.firstViewport.nextContentVisible does not match visualCompositionIntent`);
      if (screen.firstViewport.maxFeatureViewportShare > contract.visualCompositionIntent.maxFeatureViewportShare) errors.push(`${screenLabel}.firstViewport exceeds visualCompositionIntent maxFeatureViewportShare`);
      const requiredContextIds = (context.contextContract?.displayContext || []).filter((entry) => entry.placementIntent === 'primary-screen-context-rail').map((entry) => entry.id);
      if (requiredContextIds.some((id) => !screen.context?.entryIds?.includes(id))) errors.push(`${screenLabel}.context drops primary-screen enriched context`);
    }
    const navigation = screen.navigation;
    if (!navigation || !['tab-root', 'stack-root', 'pushed', 'modal'].includes(navigation.kind) || !['navigate', 'push', 'replace', 'present'].includes(navigation.intent)) {
      errors.push(`screens[${screenIndex}].navigation is invalid`);
    } else {
      if (navigation.kind === 'tab-root') {
        tabRoots.push(screen);
        if (!navigation.tabLabel) errors.push(`screens[${screenIndex}] tab-root requires tabLabel`);
        if (pathParameters(screen.route).length) errors.push(`screens[${screenIndex}] dynamic routes cannot be tab roots`);
      }
      if (['pushed', 'modal'].includes(navigation.kind) && (!navigation.parentRoute || !routes.has(navigation.parentRoute))) errors.push(`screens[${screenIndex}] ${navigation.kind} navigation requires a declared parentRoute`);
      if (navigation.kind === 'pushed' && screen.header?.mode !== 'back') errors.push(`screens[${screenIndex}] pushed routes require back header mode`);
      if (navigation.kind === 'modal' && !['close', 'none'].includes(screen.header?.mode)) errors.push(`screens[${screenIndex}] modal routes require close or none header mode`);
    }
    if (screen.primaryAction?.placement === 'sticky-bottom') {
      const navigationModel = context.navigationContract?.model || contract?.navigationModel;
      const expectedTabBar = ['tabs-stack', 'drawer'].includes(navigationModel) ? 'above' : 'not-applicable';
      if (screen.primaryAction.clearance?.safeArea !== true || screen.primaryAction.clearance?.tabBar !== expectedTabBar) {
        errors.push(`screens[${screenIndex}] sticky-bottom action requires safe-area clearance and tabBar ${expectedTabBar}`);
      }
    }
    if (!Array.isArray(screen.routeParameters)) errors.push(`screens[${screenIndex}].routeParameters must be an array in schema version 3`);
    const parameterNames = [];
    for (const [parameterIndex, parameter] of (screen.routeParameters || []).entries()) {
      const label = `screens[${screenIndex}].routeParameters[${parameterIndex}]`;
      if (!parameter || typeof parameter.name !== 'string' || !parameter.name.trim()) errors.push(`${label}.name is required`);
      if (!['path', 'query'].includes(parameter?.source)) errors.push(`${label}.source is invalid`);
      if (typeof parameter?.required !== 'boolean') errors.push(`${label}.required must be boolean`);
      parameterNames.push(parameter?.name);
    }
    if (new Set(parameterNames).size !== parameterNames.length) errors.push(`screens[${screenIndex}].routeParameters names must be unique`);
    const declared = new Map((screen.routeParameters || []).map((parameter) => [parameter.name, parameter]));
    const dynamicPathParameters = new Set(pathParameters(screen.route));
    for (const parameter of dynamicPathParameters) {
      if (declared.get(parameter)?.source !== 'path' || declared.get(parameter)?.required !== true) errors.push(`screens[${screenIndex}] path parameter ${parameter} must be declared as a required path parameter`);
    }
    for (const parameter of screen.routeParameters || []) {
      if (parameter?.source === 'path' && !dynamicPathParameters.has(parameter.name)) errors.push(`screens[${screenIndex}] declared path parameter ${parameter.name} is absent from route ${screen.route}`);
    }
    if (!Array.isArray(screen.data?.operations)) {
      errors.push(`screens[${screenIndex}].data.operations must be an array in schema version 3`);
      continue;
    }
    if ((screen.data?.entities || []).length > 0 && screen.data.operations.length === 0) {
      errors.push(`screens[${screenIndex}] declares data entities but no executable operations`);
    }
    const boundParameters = new Set(screen.data.operations.flatMap((operation) => (
      operation?.routeBindings || []
    )).map((binding) => binding?.parameter).filter(Boolean));
    for (const parameter of screen.routeParameters || []) {
      if (parameter?.required === true && !boundParameters.has(parameter.name)) {
        errors.push(`screens[${screenIndex}] ${parameter.source || 'route'} parameter ${parameter.name} is not bound to a screen operation`);
      }
    }
    screen.data.operations.forEach((operation, operationIndex) => {
      operationIds.push(operation?.id);
      validateOperation(operation, screen, screenIndex, operationIndex, context, errors);
    });
  }
  const duplicates = operationIds.filter((id, index) => id && operationIds.indexOf(id) !== index);
  if (duplicates.length) errors.push(`operation ids must be unique: ${[...new Set(duplicates)].join(', ')}`);
  const navigationModel = context.navigationContract?.model || contract?.navigationModel;
  if (['tabs-stack', 'drawer'].includes(navigationModel)) {
    if (navigationModel === 'tabs-stack' && (tabRoots.length < 2 || tabRoots.length > 5)) errors.push('tabs-stack navigation requires 2-5 declared tab-root screens');
    if (navigationModel === 'drawer' && tabRoots.length <= 5) errors.push('drawer navigation requires more than five declared destination roots');
    const primary = screenContract.screens.find((screen) => screen.role === 'primary');
    if (primary?.navigation?.kind !== 'tab-root') errors.push('tabs-stack primary screen must be a tab root');
    const byRoute = new Map(screenContract.screens.map((screen) => [screen.route, screen]));
    for (const screen of screenContract.screens) {
      if (screen.navigation?.kind === 'stack-root') errors.push(`tabs-stack screen ${screen.id} cannot declare an independent stack root`);
      if (screen.navigation?.kind !== 'pushed') continue;
      const visited = new Set([screen.route]);
      let parent = byRoute.get(screen.navigation.parentRoute);
      while (['pushed', 'modal'].includes(parent?.navigation?.kind) && !visited.has(parent.route)) {
        visited.add(parent.route);
        parent = byRoute.get(parent.navigation.parentRoute);
      }
      if (parent?.navigation?.kind !== 'tab-root') errors.push(`tabs-stack pushed screen ${screen.id} must resolve to an owning tab root`);
    }
    if (contract.primarySurface === 'product-led-discovery') {
      const labels = new Set(tabRoots.map((screen) => normalizedName(screen.navigation?.tabLabel)));
      for (const required of ['shop', 'categories', 'bag']) {
        if (!labels.has(required)) errors.push(`product-led tabs-stack navigation requires ${required} tab root`);
      }
    }
  } else if (contract && tabRoots.length) {
    errors.push(`navigation model ${navigationModel} cannot declare tab-root screens`);
  }
}

function validateExperienceScreenContract(screenContract, contract, context = {}) {
  const errors = [];
  if (!screenContract || typeof screenContract !== 'object' || Array.isArray(screenContract)) return ['screen contract must be an object'];
  if (![1, 2, 3].includes(screenContract.schemaVersion)) errors.push('schemaVersion must be 1, 2, or 3');
  if (screenContract.schemaVersion === 1) return errors;
  if (!Array.isArray(screenContract.screens) || screenContract.screens.length < 2) {
    errors.push('screens must contain at least primary and key-flow specifications');
    return errors;
  }
  screenContract.screens.forEach((screen, index) => validateScreenSpec(screen, index, errors));
  const ids = screenContract.screens.map((screen) => screen?.id);
  const routes = screenContract.screens.map((screen) => screen?.route);
  const files = screenContract.screens.map((screen) => screen?.file);
  if (new Set(ids).size !== ids.length) errors.push('screen ids must be unique');
  if (new Set(routes).size !== routes.length) errors.push('screen routes must be unique');
  if (new Set(files).size !== files.length) errors.push('screen files must be unique');
  const primaryScreens = screenContract.screens.filter((screen) => screen?.role === 'primary');
  const keyFlowScreens = screenContract.screens.filter((screen) => screen?.role === 'key-flow');
  if (primaryScreens.length !== 1) errors.push('screens must contain exactly one primary screen');
  if (!keyFlowScreens.length) errors.push('screens must contain at least one key-flow screen');
  const primary = primaryScreens[0];
  if (contract && (primary?.route !== contract.primaryScreen.route || primary?.file !== contract.primaryScreen.file)) errors.push('primary screen must match the experience contract');
  if (!screenContract.primaryScreen || screenContract.primaryScreen.route !== primary?.route || screenContract.primaryScreen.file !== primary?.file) errors.push('primaryScreen compatibility projection must match screens');
  if (!screenContract.keyFlow || !keyFlowScreens.some((screen) => screen.route === screenContract.keyFlow.route && screen.file === screenContract.keyFlow.file)) errors.push('keyFlow compatibility projection must match a key-flow screen');
  if (!screenContract.criticalFlow || typeof screenContract.criticalFlow.outcome !== 'string' || !Array.isArray(screenContract.criticalFlow.screenIds) || screenContract.criticalFlow.screenIds.length < 2 || screenContract.criticalFlow.screenIds.some((id) => !ids.includes(id))) errors.push('criticalFlow must name at least two declared screen ids and an outcome');
  if (primary && !screenContract.criticalFlow?.screenIds?.includes(primary.id)) errors.push('criticalFlow must include the primary screen');
  for (const screen of screenContract.screens) {
    for (const dependency of screen.dependencies?.screens || []) {
      if (!ids.includes(dependency)) errors.push(`screen ${screen.id} depends on unknown screen ${dependency}`);
      if (dependency === screen.id) errors.push(`screen ${screen.id} cannot depend on itself`);
    }
  }
  if (screenContract.schemaVersion === 3) validateV3Operations(screenContract, contract, context, errors);
  return errors;
}

module.exports = {
  ACTION_PLACEMENTS, DENSITIES, HEADER_MODES, MEDIA_FALLBACKS, OPERATION_KINDS, PRESENTATION_PATTERNS, REQUIRED_STATES,
  identifier, normalizeScreenContract, validateExperienceScreenContract,
};

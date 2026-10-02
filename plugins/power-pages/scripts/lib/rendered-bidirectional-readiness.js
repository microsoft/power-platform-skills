'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveLocale,
} = require('./localization-config');
const {
  COMPONENT_RISKS,
  VERIFICATION_PROFILES,
  buildManualReviewChecklist,
  resolveRepresentatives,
  resolveVerificationProfile,
  selectComponentDimensions,
} = require('./localization-verification-profile');

const CLASSIFICATIONS = new Set([
  'direction-neutral',
  'direction-aware',
  'direction-fixed',
  'unknown-third-party',
]);
const DIRECTIONS = new Set(['ltr', 'rtl']);
const PRESERVATION_KINDS = new Set([
  'attribute',
  'auto',
  'checked',
  'property',
  'text',
  'value',
]);
const ACTION_TYPES = new Set([
  'activate-locale',
  'check',
  'click',
  'fill',
  'focus',
  'hover',
  'navigate',
  'press',
  'select',
  'set-attribute',
  'set-document',
  'uncheck',
  'use-current',
  'wait',
]);
const STATE_ISOLATION = new Set(['isolated', 'reload', 'resettable']);
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

function validateRunSpec(spec, localizationContext = null) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['The rendered bidirectional run specification must be an object.'];
  }
  if (spec.version !== 1) errors.push('version must be 1.');
  const verificationProfile = resolveVerificationProfile(spec);
  if (!VERIFICATION_PROFILES.has(verificationProfile)) {
    errors.push(
      'verificationProfile must be standard, extensive, or targeted when provided.'
    );
  }
  if (spec.runtimeSwitching !== undefined &&
      typeof spec.runtimeSwitching !== 'boolean') {
    errors.push('runtimeSwitching must be boolean when provided.');
  }
  if (spec.maxConcurrency !== undefined &&
      (!Number.isInteger(spec.maxConcurrency) ||
       spec.maxConcurrency < 1 ||
       spec.maxConcurrency > MAX_CONCURRENCY)) {
    errors.push(
      `maxConcurrency must be an integer from 1 through ${MAX_CONCURRENCY}.`
    );
  }
  const viewports = Array.isArray(spec.viewports) ? spec.viewports : [];
  const locales = Array.isArray(spec.locales) ? spec.locales : [];
  const components = Array.isArray(spec.components) ? spec.components : [];
  const unavailableLocaleChecks = Array.isArray(spec.unavailableLocaleChecks)
    ? spec.unavailableLocaleChecks
    : [];
  const unavailableLocales = new Set(
    Array.isArray(localizationContext?.unavailableLocales)
      ? localizationContext.unavailableLocales
      : []
  );
  const verificationLocales = new Set(
    Array.isArray(localizationContext?.verificationLocales)
      ? localizationContext.verificationLocales
      : []
  );
  if (viewports.length === 0) errors.push('viewports must contain at least one viewport.');
  if (locales.length < 2) errors.push('locales must contain LTR and RTL verification locales.');
  if (components.length === 0) errors.push('components must contain the reconciled review scope.');

  const viewportNames = new Set();
  for (const [index, viewport] of viewports.entries()) {
    const prefix = `viewports[${index}]`;
    if (!isNonEmpty(viewport?.name)) errors.push(`${prefix}.name is required.`);
    if (viewportNames.has(viewport?.name)) errors.push(`${prefix}.name must be unique.`);
    viewportNames.add(viewport?.name);
    if (!Number.isInteger(viewport?.width) || viewport.width < 240) {
      errors.push(`${prefix}.width must be an integer of at least 240.`);
    }
    if (!Number.isInteger(viewport?.height) || viewport.height < 240) {
      errors.push(`${prefix}.height must be an integer of at least 240.`);
    }
  }

  const localeIds = new Set();
  const directions = new Set();
  for (const [index, locale] of locales.entries()) {
    const prefix = `locales[${index}]`;
    if (!isNonEmpty(locale?.id)) errors.push(`${prefix}.id is required.`);
    if (localeIds.has(locale?.id)) errors.push(`${prefix}.id must be unique.`);
    localeIds.add(locale?.id);
    if (!isNonEmpty(locale?.locale)) errors.push(`${prefix}.locale is required.`);
    if (!locale?.pseudo && isNonEmpty(locale?.locale)) {
      const resolved = resolveLocale(locale.locale);
      if (!resolved.valid || !resolved.locale) {
        errors.push(`${prefix}.locale must be a valid BCP-47 locale tag.`);
      } else if (resolved.direction !== locale.direction) {
        errors.push(
          `${prefix}.direction must be ${resolved.direction} for ${resolved.locale}.`
        );
      }
    }
    if (!DIRECTIONS.has(locale?.direction)) {
      errors.push(`${prefix}.direction must be ltr or rtl.`);
    } else {
      directions.add(locale.direction);
    }
    validateActions(locale?.activate, `${prefix}.activate`, errors);
    if (locale?.pseudo !== undefined && typeof locale.pseudo !== 'boolean') {
      errors.push(`${prefix}.pseudo must be boolean when provided.`);
    }
    if (locale?.textExpansion !== undefined &&
        (!Number.isFinite(locale.textExpansion) || locale.textExpansion < 0)) {
      errors.push(`${prefix}.textExpansion must be a non-negative number.`);
    }
    const activation = asArray(locale?.activate);
    if (locale?.pseudo === true) {
      if (!activation.some((action) => action.type === 'set-document')) {
        errors.push(`${prefix} pseudo locales require a set-document action.`);
      }
    } else {
      if (activation.length === 0) {
        errors.push(`${prefix} real locales require application-driven activation.`);
      }
      if (activation.some((action) => action.type === 'set-document')) {
        errors.push(`${prefix} real locales cannot use set-document.`);
      }
      if (!Array.isArray(locale?.expect) || locale.expect.length === 0) {
        errors.push(`${prefix} real locales require localized content expectations.`);
      }
      if (verificationLocales.has(locale.locale)) {
        const localeActivations = activation.filter(
          (action) => action.type === 'activate-locale'
        );
        if (localeActivations.length !== 1 ||
            localeActivations[0].locale !== locale.locale) {
          errors.push(
            `${prefix} verification targets require exactly one ` +
            `activate-locale action for ${locale.locale}.`
          );
        }
        if (activation.some(
          (action) => !['activate-locale', 'wait'].includes(action.type)
        )) {
          errors.push(
            `${prefix} verification target activation may contain only ` +
            'activate-locale and wait actions.'
          );
        }
      }
      if (unavailableLocales.has(locale.locale) &&
          localizationContext) {
        errors.push(
          `${prefix} unavailable locales cannot be included as rendered ` +
          'verification locales.'
        );
      }
    }
    if (locale?.expect !== undefined && !Array.isArray(locale.expect)) {
      errors.push(`${prefix}.expect must be an array.`);
    }
    for (const [expectIndex, expectation] of asArray(locale?.expect).entries()) {
      const expectPrefix = `${prefix}.expect[${expectIndex}]`;
      if (!isNonEmpty(expectation?.selector)) {
        errors.push(`${expectPrefix}.selector is required.`);
      }
      if (!isNonEmpty(expectation?.text) &&
          !(isNonEmpty(expectation?.attribute) && typeof expectation?.value === 'string')) {
        errors.push(
          `${expectPrefix} requires text, or an attribute and string value.`
        );
      }
    }
  }
  if (!directions.has('ltr') || !directions.has('rtl')) {
    errors.push('locales must include at least one LTR and one RTL verification locale.');
  }
  if (spec.representativeLocaleIds !== undefined) {
    if (!spec.representativeLocaleIds ||
        typeof spec.representativeLocaleIds !== 'object' ||
        Array.isArray(spec.representativeLocaleIds)) {
      errors.push('representativeLocaleIds must be an object when provided.');
    } else {
      for (const direction of ['ltr', 'rtl']) {
        const localeId = spec.representativeLocaleIds[direction];
        if (localeId === undefined) continue;
        const locale = locales.find((candidate) => candidate.id === localeId);
        if (!locale) {
          errors.push(
            `representativeLocaleIds.${direction} references unknown locale "${localeId}".`
          );
        } else if (locale.direction !== direction) {
          errors.push(
            `representativeLocaleIds.${direction} must reference a ${direction} locale.`
          );
        }
      }
    }
  }
  if (spec.localeSmoke !== undefined) {
    if (!spec.localeSmoke ||
        typeof spec.localeSmoke !== 'object' ||
        Array.isArray(spec.localeSmoke)) {
      errors.push('localeSmoke must be an object when provided.');
    } else {
      if (!isNonEmpty(spec.localeSmoke.route) ||
          !spec.localeSmoke.route.startsWith('/')) {
        errors.push('localeSmoke.route must start with "/".');
      }
      if (!viewportNames.has(spec.localeSmoke.viewport)) {
        errors.push('localeSmoke.viewport must reference a configured viewport.');
      }
    }
  }
  if (verificationProfile === 'targeted') {
    validateStringArray(spec.targetCaseIds, 'targetCaseIds', errors, 1);
  } else if (spec.targetCaseIds !== undefined) {
    errors.push('targetCaseIds is valid only for targeted verification.');
  }

  if (spec.unavailableLocaleChecks !== undefined &&
      !Array.isArray(spec.unavailableLocaleChecks)) {
    errors.push('unavailableLocaleChecks must be an array when provided.');
  }
  const checkedUnavailableLocales = new Set();
  for (const [index, check] of unavailableLocaleChecks.entries()) {
    const prefix = `unavailableLocaleChecks[${index}]`;
    if (!isNonEmpty(check?.locale)) {
      errors.push(`${prefix}.locale is required.`);
    } else if (checkedUnavailableLocales.has(check.locale)) {
      errors.push(`${prefix}.locale must be unique.`);
    } else {
      checkedUnavailableLocales.add(check.locale);
    }
    validateStringArray(check?.selectors, `${prefix}.selectors`, errors, 1);
  }

  const componentIds = new Set();
  for (const [index, component] of components.entries()) {
    const prefix = `components[${index}]`;
    if (!isNonEmpty(component?.id)) errors.push(`${prefix}.id is required.`);
    if (componentIds.has(component?.id)) errors.push(`${prefix}.id must be unique.`);
    componentIds.add(component?.id);
    if (!isNonEmpty(component?.name)) errors.push(`${prefix}.name is required.`);
    if (!CLASSIFICATIONS.has(component?.classification)) {
      errors.push(`${prefix}.classification is invalid.`);
    }
    if (component?.risk !== undefined && !COMPONENT_RISKS.has(component.risk)) {
      errors.push(`${prefix}.risk must be low, medium, or high.`);
    }
    if (!isNonEmpty(component?.route) || !component.route.startsWith('/')) {
      errors.push(`${prefix}.route must start with "/".`);
    }
    if (!isNonEmpty(component?.selector)) errors.push(`${prefix}.selector is required.`);
    if (component?.classification === 'direction-fixed' && !isNonEmpty(component?.reason)) {
      errors.push(`${prefix}.reason is required for direction-fixed components.`);
    }
    const states = Array.isArray(component?.states) ? component.states : [];
    if (states.length === 0) errors.push(`${prefix}.states must not be empty.`);
    for (const [stateIndex, state] of states.entries()) {
      const statePrefix = `${prefix}.states[${stateIndex}]`;
      if (!isNonEmpty(state?.name)) errors.push(`${statePrefix}.name is required.`);
      validateActions(state?.setup, `${statePrefix}.setup`, errors);
      if (state?.isolation !== undefined &&
          !STATE_ISOLATION.has(state.isolation)) {
        errors.push(
          `${statePrefix}.isolation must be isolated, reload, or resettable.`
        );
      }
      validateActions(state?.reset, `${statePrefix}.reset`, errors);
      if (state?.isolation === 'resettable' &&
          (!Array.isArray(state.reset) || state.reset.length === 0)) {
        errors.push(
          `${statePrefix}.reset must contain at least one action for resettable states.`
        );
      }
      if (state?.isolation !== 'resettable' && state?.reset !== undefined) {
        errors.push(
          `${statePrefix}.reset is valid only when isolation is resettable.`
        );
      }
      if (state?.isolation === 'resettable' &&
          asArray(state.reset).some((action) =>
            ['activate-locale', 'navigate', 'set-document', 'use-current']
              .includes(action.type)
          )) {
        errors.push(
          `${statePrefix}.reset cannot navigate or change the active locale.`
        );
      }
      if (state?.targets !== undefined && !Array.isArray(state.targets)) {
        errors.push(`${statePrefix}.targets must be an array.`);
      }
      for (const [targetIndex, target] of asArray(state?.targets).entries()) {
        const targetPrefix = `${statePrefix}.targets[${targetIndex}]`;
        if (!isNonEmpty(target?.selector)) errors.push(`${targetPrefix}.selector is required.`);
        if (target?.expectedDirection &&
            !DIRECTIONS.has(target.expectedDirection) &&
            target.expectedDirection !== 'inherit') {
          errors.push(`${targetPrefix}.expectedDirection must be inherit, ltr, or rtl.`);
        }
        validateOptionalBoolean(target, 'expectVisible', targetPrefix, errors);
        validateOptionalBoolean(target, 'externalOpaque', targetPrefix, errors);
        validateOptionalBoolean(target, 'allowClipping', targetPrefix, errors);
        validateOptionalBoolean(target, 'allowOutsideViewport', targetPrefix, errors);
      }
      if (state?.computed !== undefined && !Array.isArray(state.computed)) {
        errors.push(`${statePrefix}.computed must be an array.`);
      }
      for (const [checkIndex, check] of asArray(state?.computed).entries()) {
        const checkPrefix = `${statePrefix}.computed[${checkIndex}]`;
        if (!isNonEmpty(check?.selector)) errors.push(`${checkPrefix}.selector is required.`);
        if (!isNonEmpty(check?.property)) errors.push(`${checkPrefix}.property is required.`);
        if (!check?.expected || typeof check.expected !== 'object') {
          errors.push(`${checkPrefix}.expected must provide direction-specific values.`);
        } else {
          for (const direction of ['ltr', 'rtl', 'default']) {
            if (check.expected[direction] !== undefined &&
                !isStringOrStringArray(check.expected[direction])) {
              errors.push(`${checkPrefix}.expected.${direction} must be a string or string array.`);
            }
          }
          if (check.expected.ltr === undefined &&
              check.expected.rtl === undefined &&
              check.expected.default === undefined) {
            errors.push(`${checkPrefix}.expected must define ltr, rtl, or default.`);
          }
        }
      }
      if (state?.attributes !== undefined &&
          !Array.isArray(state.attributes)) {
        errors.push(`${statePrefix}.attributes must be an array.`);
      }
      for (const [checkIndex, check] of asArray(state?.attributes).entries()) {
        const checkPrefix = `${statePrefix}.attributes[${checkIndex}]`;
        if (!isNonEmpty(check?.selector)) {
          errors.push(`${checkPrefix}.selector is required.`);
        }
        if (!isNonEmpty(check?.name)) {
          errors.push(`${checkPrefix}.name is required.`);
        }
        if (typeof check?.expected !== 'string') {
          errors.push(`${checkPrefix}.expected must be a string.`);
        }
      }
      if (state?.focusOrder !== undefined) {
        validateStringArray(state.focusOrder, `${statePrefix}.focusOrder`, errors, 2);
      }
      if (state?.nonOverlapping !== undefined && !Array.isArray(state.nonOverlapping)) {
        errors.push(`${statePrefix}.nonOverlapping must be an array.`);
      }
      for (const [pairIndex, pair] of asArray(state?.nonOverlapping).entries()) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some((item) => !isNonEmpty(item))) {
          errors.push(
            `${statePrefix}.nonOverlapping[${pairIndex}] must contain two selectors.`
          );
        }
      }
    }
    if (component?.manualChecks !== undefined) {
      validateStringArray(component.manualChecks, `${prefix}.manualChecks`, errors, 1);
    }
    const componentViewports = Array.isArray(component?.viewports)
      ? component.viewports
      : [];
    if (componentViewports.length === 0) errors.push(`${prefix}.viewports must not be empty.`);
    for (const viewportName of componentViewports) {
      if (!viewportNames.has(viewportName)) {
        errors.push(`${prefix}.viewports references unknown viewport "${viewportName}".`);
      }
    }
    if (component?.classification === 'unknown-third-party') {
      const hasTarget = states.some((state) =>
        Array.isArray(state.targets) && state.targets.length > 0
      );
      if (!hasTarget) {
        errors.push(`${prefix} must identify the rendered third-party targets.`);
      }
    }
  }

  const transitionSequences = [];
  for (const [index, transition] of (spec.transitions || []).entries()) {
    const prefix = `transitions[${index}]`;
    if (!isNonEmpty(transition?.name)) errors.push(`${prefix}.name is required.`);
    if (!Array.isArray(transition?.sequence) || transition.sequence.length < 2) {
      errors.push(`${prefix}.sequence must contain at least two locale IDs.`);
    } else {
      for (const localeId of transition.sequence) {
        if (!localeIds.has(localeId)) {
          errors.push(`${prefix}.sequence references unknown locale "${localeId}".`);
        }
      }
      transitionSequences.push(transition.sequence.join(','));
    }
    if (!isNonEmpty(transition?.route) || !transition.route.startsWith('/')) {
      errors.push(`${prefix}.route must start with "/".`);
    }
    if (transition?.viewport !== undefined && !viewportNames.has(transition.viewport)) {
      errors.push(`${prefix}.viewport references unknown viewport "${transition.viewport}".`);
    }
    if (transition?.preserve !== undefined) {
      if (!Array.isArray(transition.preserve)) {
        errors.push(`${prefix}.preserve must be an array.`);
      } else {
        for (const [preserveIndex, entry] of transition.preserve.entries()) {
          const preservePrefix = `${prefix}.preserve[${preserveIndex}]`;
          if (isNonEmpty(entry)) continue;
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push(`${preservePrefix} must be a selector or preservation object.`);
            continue;
          }
          if (!isNonEmpty(entry.selector)) {
            errors.push(`${preservePrefix}.selector is required.`);
          }
          if (!PRESERVATION_KINDS.has(entry.kind)) {
            errors.push(
              `${preservePrefix}.kind must be auto, value, checked, text, attribute, or property.`
            );
          }
          if ((entry.kind === 'attribute' || entry.kind === 'property') &&
              !isNonEmpty(entry.name)) {
            errors.push(`${preservePrefix}.name is required for ${entry.kind}.`);
          }
        }
      }
    }
    if (transition?.preserveFocus !== undefined &&
        !isNonEmpty(transition.preserveFocus)) {
      errors.push(`${prefix}.preserveFocus must be a non-empty selector.`);
    }
    if (transition?.preserveRoute !== undefined &&
        typeof transition.preserveRoute !== 'boolean') {
      errors.push(`${prefix}.preserveRoute must be boolean when provided.`);
    }
    validateActions(transition?.setup, `${prefix}.setup`, errors);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function validateOptionalBoolean(value, key, prefix, errors) {
    if (value?.[key] !== undefined && typeof value[key] !== 'boolean') {
      errors.push(`${prefix}.${key} must be boolean when provided.`);
    }
  }

  function validateStringArray(value, prefix, errors, minimumLength) {
    if (!Array.isArray(value) || value.length < minimumLength ||
        value.some((item) => !isNonEmpty(item))) {
      errors.push(
        `${prefix} must be an array of at least ${minimumLength} non-empty selector/string values.`
      );
    }
  }

  function isStringOrStringArray(value) {
    return isNonEmpty(value) ||
      (Array.isArray(value) && value.length > 0 && value.every(isNonEmpty));
  }
  if (localizationContext) {
    const expectedLocales = localizationContext.locales
      .filter((locale) => !unavailableLocales.has(locale))
      .sort();
    const actualLocales = locales
      .filter((locale) => !locale.pseudo)
      .map((locale) => locale.locale)
      .sort();
    if (JSON.stringify(expectedLocales) !== JSON.stringify(actualLocales)) {
      errors.push(
        'Real locales must exactly match the currently available localization ' +
        'manifest locales.'
      );
    }
    const expectedUnavailableChecks = [...unavailableLocales].sort();
    const actualUnavailableChecks = [...checkedUnavailableLocales].sort();
    if (JSON.stringify(expectedUnavailableChecks) !==
        JSON.stringify(actualUnavailableChecks)) {
      errors.push(
        'unavailableLocaleChecks must exactly match manifest unavailableLocales.'
      );
    }
    if (localizationContext.mode === 'runtime' && spec.runtimeSwitching !== true) {
      errors.push('Runtime localization manifests require runtimeSwitching: true.');
    }
    if (localizationContext.mode === 'static' && spec.runtimeSwitching === true) {
      errors.push('Static localization manifests require runtimeSwitching: false.');
    }
  }
  if (spec.runtimeSwitching === true) {
    if (locales.some((locale) =>
      asArray(locale.activate).some((action) => action.type === 'navigate')
    )) {
      errors.push('runtimeSwitching locale activation cannot use navigate.');
    }
    if (locales.some((locale) =>
      !locale.pseudo &&
      asArray(locale.activate).some((action) => action.type === 'use-current')
    )) {
      errors.push(
        'runtimeSwitching real locales require a reusable activation path; ' +
        'use-current cannot restore a locale during round trips.'
      );
    }
    const defaultLocale = locales.find(
      (locale) => locale.id === spec.defaultLocaleId
    );
    if (!isNonEmpty(spec.defaultLocaleId) || !defaultLocale) {
      errors.push('runtimeSwitching requires a valid defaultLocaleId.');
    } else if (defaultLocale.pseudo) {
      errors.push('runtimeSwitching defaultLocaleId must identify a real locale.');
    } else {
      if (localizationContext &&
          defaultLocale.locale !== localizationContext.defaultLocale) {
        errors.push(
          'runtimeSwitching defaultLocaleId must match the localization ' +
          'manifest defaultLocale.'
        );
      }
      const representatives = new Set(
        Object.values(resolveRepresentatives(spec, localizationContext))
      );
      for (const locale of locales.filter(
        (candidate) => !candidate.pseudo && candidate.id !== spec.defaultLocaleId
      )) {
        const outward = `${spec.defaultLocaleId},${locale.id},${spec.defaultLocaleId}`;
        const returnTrip = `${locale.id},${spec.defaultLocaleId},${locale.id}`;
        if (verificationProfile !== 'targeted' &&
            !transitionSequences.includes(outward)) {
          errors.push(
            `runtimeSwitching requires ${spec.defaultLocaleId} -> ${locale.id} -> ` +
            `${spec.defaultLocaleId}.`
          );
        }
        if (verificationProfile === 'extensive' &&
            !transitionSequences.includes(returnTrip)) {
          errors.push(
            `runtimeSwitching requires ${locale.id} -> ${spec.defaultLocaleId} -> ` +
            `${locale.id}.`
          );
        }
        if (verificationProfile === 'standard' &&
            representatives.has(locale.id) &&
            !transitionSequences.includes(returnTrip)) {
          errors.push(
            `standard runtimeSwitching requires representative locale ` +
            `${locale.id} -> ${spec.defaultLocaleId} -> ${locale.id}.`
          );
        }
      }
    }
  }
  if (verificationProfile === 'targeted' &&
      Array.isArray(spec.targetCaseIds)) {
    const knownCaseIds = new Set();
    for (const component of components) {
      for (const state of asArray(component.states)) {
        for (const viewportName of asArray(component.viewports)) {
          for (const locale of locales) {
            knownCaseIds.add(
              `${component.id}--${state.name}--${viewportName}--${locale.id}`
            );
          }
        }
      }
    }
    const smokeViewport =
      spec.localeSmoke?.viewport || viewports[0]?.name;
    for (const locale of locales.filter((candidate) => !candidate.pseudo)) {
      knownCaseIds.add(`locale-smoke--${smokeViewport}--${locale.id}`);
    }
    for (const transition of spec.transitions || []) {
      knownCaseIds.add(`transition--${transition.name}`);
    }
    for (const caseId of spec.targetCaseIds) {
      if (!knownCaseIds.has(caseId)) {
        errors.push(`targetCaseIds references unknown case "${caseId}".`);
      }
    }
  }
  return errors;
}

function validateActions(actions, prefix, errors) {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    errors.push(`${prefix} must be an array.`);
    return;
  }
  for (const [index, action] of actions.entries()) {
    const actionPrefix = `${prefix}[${index}]`;
    if (!ACTION_TYPES.has(action?.type)) {
      errors.push(`${actionPrefix}.type is invalid.`);
      continue;
    }
    if (action.type !== 'wait' && action.type !== 'set-document' &&
        action.type !== 'navigate' &&
        action.type !== 'use-current' &&
        !isNonEmpty(action.selector)) {
      errors.push(`${actionPrefix}.selector is required.`);
    }
    if (action.type === 'activate-locale') {
      if (!isNonEmpty(action.locale)) {
        errors.push(`${actionPrefix}.locale must be a non-empty string.`);
      }
      if (!['click', 'select'].includes(action.method)) {
        errors.push(`${actionPrefix}.method must be click or select.`);
      }
      if (action.method === 'select' && !isStringOrStringArray(action.value)) {
        errors.push(
          `${actionPrefix}.value must be a string or string array for select.`
        );
      }
    }
    if (action.type === 'wait' &&
        (!Number.isInteger(action.ms) || action.ms < 0 || action.ms > 10000)) {
      errors.push(`${actionPrefix}.ms must be an integer from 0 through 10000.`);
    }
    if (action.type === 'set-document' &&
        (!isNonEmpty(action.locale) || !DIRECTIONS.has(action.direction))) {
      errors.push(`${actionPrefix} requires locale and direction.`);
    }
    if (action.type === 'navigate' &&
        (!isNonEmpty(action.url) ||
         (!action.url.startsWith('/') && !/^https?:\/\//i.test(action.url)))) {
      errors.push(`${actionPrefix}.url must be an absolute or root-relative HTTP URL.`);
    }
    if (action.type === 'set-attribute' &&
        (!isNonEmpty(action.name) || typeof action.value !== 'string')) {
      errors.push(`${actionPrefix} requires name and string value.`);
    }
    if (action.type === 'fill' && typeof action.value !== 'string') {
      errors.push(`${actionPrefix}.value must be a string.`);
    }
    if (action.type === 'press' && !isNonEmpty(action.key)) {
      errors.push(`${actionPrefix}.key must be a non-empty string.`);
    }
    if (action.type === 'select' && !isStringOrStringArray(action.value)) {
      errors.push(`${actionPrefix}.value must be a string or string array.`);
    }
  }
}

function buildVerificationCases(spec, localizationContext = null) {
  const viewportMap = new Map(spec.viewports.map((viewport) => [viewport.name, viewport]));
  const localeMap = new Map(spec.locales.map((locale) => [locale.id, locale]));
  const representatives = resolveRepresentatives(spec, localizationContext);
  const cases = [];
  for (const component of spec.components) {
    const dimensions = selectComponentDimensions(
      component,
      spec,
      representatives
    );
    for (const state of dimensions.states) {
      for (const viewportName of dimensions.viewports) {
        for (const localeId of dimensions.localeIds) {
          const locale = localeMap.get(localeId);
          if (!locale) continue;
          cases.push({
            id: `${component.id}--${state.name}--${viewportName}--${locale.id}`,
            component,
            state,
            viewport: viewportMap.get(viewportName),
            locale,
            risk: dimensions.risk,
            spec,
          });
        }
      }
    }
  }
  if (resolveVerificationProfile(spec) !== 'targeted') return cases;
  const targetCaseIds = new Set(spec.targetCaseIds || []);
  return cases.filter((verificationCase) =>
    targetCaseIds.has(verificationCase.id)
  );
}

function buildLocaleSmokeCases(spec, localizationContext = null) {
  const profile = resolveVerificationProfile(spec);
  if (!['standard', 'targeted'].includes(profile)) return [];
  const representatives = new Set(
    Object.values(resolveRepresentatives(spec, localizationContext))
  );
  const route = spec.localeSmoke?.route || spec.components[0]?.route;
  const viewportName =
    spec.localeSmoke?.viewport || spec.viewports[0]?.name;
  const viewport = spec.viewports.find(
    (candidate) => candidate.name === viewportName
  );
  const targetCaseIds = new Set(spec.targetCaseIds || []);
  return spec.locales
    .filter((locale) =>
      !locale.pseudo &&
      (profile === 'targeted' || !representatives.has(locale.id))
    )
    .map((locale) => ({
      id: `locale-smoke--${viewportName}--${locale.id}`,
      route,
      viewport,
      locale,
      spec,
    }))
    .filter((smokeCase) =>
      profile !== 'targeted' || targetCaseIds.has(smokeCase.id)
    );
}

function buildVerificationGroups(verificationCases) {
  const groups = new Map();
  for (const verificationCase of verificationCases) {
    const { component, state, viewport, locale } = verificationCase;
    // Isolated states retain the old one-page-per-case behavior. Other states
    // can safely share a page object; reload remains the default preparation
    // unless the spec supplies a reset action that restores a known baseline.
    const key = state.isolation === 'isolated'
      ? `isolated:${verificationCase.id}`
      : [
          component.route,
          viewport.name,
          locale.id,
        ].join('\0');
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        route: component.route,
        viewport,
        locale,
        cases: [],
      });
    }
    groups.get(key).cases.push(verificationCase);
  }
  return [...groups.values()];
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => runWorker())
  );
  return results;
}

async function runRenderedBidirectionalAudit(options) {
  const errors = validateRunSpec(options.spec, options.localizationContext);
  if (errors.length > 0) {
    const error = new Error(`Invalid rendered bidirectional run specification:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_SPEC';
    throw error;
  }
  const baseUrl = options.url.replace(/\/$/, '');
  const requiredOrigin =
    Array.isArray(options.localizationContext?.verificationLocales) &&
    options.localizationContext.verificationLocales.length > 0
      ? new URL(baseUrl).origin
      : null;
  const browser = await options.chromium.launch({
    ...(options.browserLaunchOptions || {}),
    headless: true,
  });
  const findings = [];
  const results = [];
  const representatives = resolveRepresentatives(
    options.spec,
    options.localizationContext
  );
  const smokeCases = buildLocaleSmokeCases(
    options.spec,
    options.localizationContext
  );
  const verificationGroups = buildVerificationGroups(
    buildVerificationCases(options.spec, options.localizationContext)
  );
  const maxConcurrency =
    options.spec.maxConcurrency || DEFAULT_MAX_CONCURRENCY;

  try {
    const independentTasks = [
      ...smokeCases.map((smokeCase) => ({
        type: 'locale-smoke',
        value: smokeCase,
      })),
      ...verificationGroups.map((group) => ({
        type: 'component-group',
        value: group,
      })),
    ];
    const taskResults = await runWithConcurrency(
      independentTasks,
      maxConcurrency,
      async (task) => {
        if (task.type === 'locale-smoke') {
          return [await runLocaleSmokeCase(
            browser,
            baseUrl,
            task.value,
            options.evidenceDir,
            requiredOrigin
          )];
        }
        return runVerificationGroup(
          browser,
          baseUrl,
          task.value,
          options.evidenceDir,
          requiredOrigin
        );
      }
    );
    for (const taskResult of taskResults) {
      for (const result of taskResult) {
        results.push(result);
        findings.push(...result.findings);
      }
    }
    // Runtime transitions deliberately remain serial. They verify persistence,
    // request ordering, and state preservation, so overlapping sequences would
    // make timing-sensitive failures harder to attribute.
    const targetCaseIds = new Set(options.spec.targetCaseIds || []);
    for (const transition of options.spec.transitions || []) {
      const transitionId = `transition--${transition.name}`;
      if (resolveVerificationProfile(options.spec) === 'targeted' &&
          !targetCaseIds.has(transitionId)) {
        continue;
      }
      const result = await runTransitionCase(
        browser,
        baseUrl,
        transition,
        options.spec,
        options.evidenceDir,
        requiredOrigin
      );
      results.push(result);
      findings.push(...result.findings);
    }
  } finally {
    await browser.close();
  }

  return {
    url: baseUrl,
    runAt: new Date().toISOString(),
    verification: {
      profile: resolveVerificationProfile(options.spec),
      representativeLocaleIds: representatives,
      localeSmokeCount: results.filter(
        (result) => result.type === 'locale-smoke'
      ).length,
      componentCaseCount: results.filter(
        (result) => result.type === 'component-state'
      ).length,
      componentGroupCount: verificationGroups.length,
      maxConcurrency,
      transitionCaseCount: results.filter(
        (result) => result.type === 'locale-transition'
      ).length,
      manualReview: buildManualReviewChecklist(
        options.spec,
        representatives
      ),
    },
    summary: summarizeFindings(findings, results),
    findings,
    results,
  };
}

async function runLocaleSmokeCase(
  browser,
  baseUrl,
  smokeCase,
  evidenceDir,
  requiredOrigin
) {
  const { locale, route, viewport } = smokeCase;
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const findings = [];
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    await page.goto(`${baseUrl}${route}`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    await assertPageOrigin(page, requiredOrigin);
    await verifyUnavailableLocaleChecks(
      page,
      smokeCase.spec.unavailableLocaleChecks || [],
      smokeCase.id,
      findings
    );
    await executeActions(page, locale.activate || [], baseUrl, requiredOrigin);
    await page.waitForTimeout(100);
    await assertPageOrigin(page, requiredOrigin);
    await assertDocumentLocale(page, locale, findings, smokeCase.id);
    await assertLocaleEvidence(page, locale, findings, smokeCase.id);
    for (const message of consoleErrors) {
      findings.push(makeFinding(
        smokeCase.id,
        'browser-console-error',
        'error',
        message,
        'html'
      ));
    }
  } catch (error) {
    findings.push(makeFinding(
      smokeCase.id,
      'locale-smoke-failure',
      'error',
      error.message,
      'html'
    ));
  }

  const screenshot = findings.length > 0
    ? await captureEvidence(page, evidenceDir, smokeCase.id)
    : null;
  await page.close();
  return {
    id: smokeCase.id,
    type: 'locale-smoke',
    route,
    viewport: viewport.name,
    locale: locale.locale,
    direction: locale.direction,
    status: findings.some((finding) => finding.severity === 'error')
      ? 'failed'
      : findings.length > 0 ? 'review' : 'passed',
    screenshot,
    findings,
  };
}

async function runVerificationGroup(
  browser,
  baseUrl,
  group,
  evidenceDir,
  requiredOrigin
) {
  const page = await browser.newPage({
    viewport: {
      width: group.viewport.width,
      height: group.viewport.height,
    },
  });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const results = [];
  let reusableBaseline = false;

  try {
    for (const verificationCase of group.cases) {
      const consoleStart = consoleErrors.length;
      const canReset =
        verificationCase.state.isolation === 'resettable' &&
        !verificationCase.locale.pseudo;
      try {
        let initializationFindings = [];
        if (!reusableBaseline || !canReset) {
          initializationFindings = await initializeVerificationPage(
            page,
            baseUrl,
            verificationCase,
            requiredOrigin
          );
        }
        const outcome = await runVerificationCaseOnPage(
          page,
          baseUrl,
          verificationCase,
          evidenceDir,
          requiredOrigin,
          consoleErrors,
          consoleStart,
          initializationFindings
        );
        results.push(outcome.result);
        reusableBaseline = canReset && outcome.resetSucceeded;
      } catch (error) {
        const findings = [makeFinding(
          verificationCase.id,
          'rendered-case-failure',
          'error',
          error.message,
          verificationCase.component.selector
        )];
        const screenshot = await captureEvidence(
          page,
          evidenceDir,
          verificationCase.id
        );
        results.push(buildVerificationCaseResult(
          verificationCase,
          findings,
          screenshot
        ));
        reusableBaseline = false;
      }
    }
  } finally {
    await page.close();
  }
  return results;
}

async function initializeVerificationPage(
  page,
  baseUrl,
  verificationCase,
  requiredOrigin
) {
  const { component, locale } = verificationCase;
  await page.goto(`${baseUrl}${component.route}`, {
    waitUntil: 'networkidle',
    timeout: 20000,
  });
  await assertPageOrigin(page, requiredOrigin);
  const initializationFindings = [];
  await verifyUnavailableLocaleChecks(
    page,
    verificationCase.spec.unavailableLocaleChecks || [],
    verificationCase.id,
    initializationFindings
  );
  await executeActions(page, locale.activate || [], baseUrl, requiredOrigin);
  await verifyUnavailableLocaleChecks(
    page,
    verificationCase.spec.unavailableLocaleChecks || [],
    verificationCase.id,
    initializationFindings
  );
  return initializationFindings;
}

async function runVerificationCaseOnPage(
  page,
  baseUrl,
  verificationCase,
  evidenceDir,
  requiredOrigin,
  consoleErrors,
  consoleStart,
  initializationFindings
) {
  const { component, state, viewport, locale } = verificationCase;
  const findings = [...initializationFindings];
  let screenshot = null;
  let resetSucceeded = state.isolation !== 'resettable';

  try {
    await executeActions(page, state.setup || [], baseUrl, requiredOrigin);
    await verifyUnavailableLocaleChecks(
      page,
      verificationCase.spec.unavailableLocaleChecks || [],
      verificationCase.id,
      findings
    );
    if (locale.pseudo) await applyPseudoContent(page, locale.direction);
    await page.waitForTimeout(100);
    await assertPageOrigin(page, requiredOrigin);
    await assertDocumentLocale(page, locale, findings, verificationCase.id);
    await assertLocaleEvidence(page, locale, findings, verificationCase.id);

    const documentSnapshot = await inspectDocument(page);
    if (documentSnapshot.horizontalOverflow) {
      findings.push(makeFinding(
        verificationCase.id,
        'page-horizontal-overflow',
        'error',
        `The page is ${documentSnapshot.overflowPixels}px wider than the viewport.`,
        'html'
      ));
    }
    const targets = state.targets?.length
      ? state.targets
      : [{ selector: component.selector, expectedDirection: 'inherit' }];
    for (const target of targets) {
      const snapshot = await inspectTarget(page, target.selector);
      evaluateTarget(
        snapshot,
        target,
        component,
        locale,
        verificationCase.id,
        findings
      );
    }
    for (const check of state.computed || []) {
      await evaluateComputedCheck(page, check, locale, verificationCase.id, findings);
    }
    for (const check of state.attributes || []) {
      await evaluateAttributeCheck(page, check, verificationCase.id, findings);
    }
    if (state.focusOrder?.length) {
      await verifyFocusOrder(page, state.focusOrder, verificationCase.id, findings);
    }
    for (const pair of state.nonOverlapping || []) {
      await verifyNoOverlap(page, pair, verificationCase.id, findings);
    }
    for (const manualCheck of component.manualChecks || []) {
      findings.push(makeFinding(
        verificationCase.id,
        'rendered-semantic-review',
        'review',
        manualCheck,
        component.selector
      ));
    }
    await assertPageOrigin(page, requiredOrigin);
  } catch (error) {
    findings.push(makeFinding(
      verificationCase.id,
      'rendered-case-failure',
      'error',
      error.message,
      component.selector
    ));
  }

  if (findings.length > 0) {
    screenshot = await captureEvidence(
      page,
      evidenceDir,
      verificationCase.id
    );
  }
  if (state.isolation === 'resettable') {
    try {
      const findingCountBeforeReset = findings.length;
      await executeActions(
        page,
        state.reset,
        baseUrl,
        requiredOrigin
      );
      await verifyUnavailableLocaleChecks(
        page,
        verificationCase.spec.unavailableLocaleChecks || [],
        verificationCase.id,
        findings
      );
      await assertPageOrigin(page, requiredOrigin);
      await assertDocumentLocale(
        page,
        locale,
        findings,
        verificationCase.id
      );
      await assertLocaleEvidence(
        page,
        locale,
        findings,
        verificationCase.id
      );
      resetSucceeded = findings.length === findingCountBeforeReset;
      if (!resetSucceeded && !screenshot) {
        screenshot = await captureEvidence(
          page,
          evidenceDir,
          verificationCase.id
        );
      }
    } catch (error) {
      findings.push(makeFinding(
        verificationCase.id,
        'rendered-case-reset-failure',
        'error',
        `The declared state reset failed: ${error.message}`,
        component.selector
      ));
      if (!screenshot) {
        screenshot = await captureEvidence(
          page,
          evidenceDir,
          verificationCase.id
        );
      }
    }
  }
  for (const message of consoleErrors.slice(consoleStart)) {
    findings.push(makeFinding(
      verificationCase.id,
      'browser-console-error',
      'error',
      message,
      component.selector
    ));
  }
  if (state.isolation === 'resettable' &&
      findings.some((finding) => finding.rule === 'browser-console-error')) {
    resetSucceeded = false;
  }
  if (findings.length > 0 && !screenshot) {
    screenshot = await captureEvidence(
      page,
      evidenceDir,
      verificationCase.id
    );
  }
  return {
    resetSucceeded,
    result: buildVerificationCaseResult(
      verificationCase,
      findings,
      screenshot
    ),
  };
}

function buildVerificationCaseResult(verificationCase, findings, screenshot) {
  const { component, state, viewport, locale } = verificationCase;
  return {
    id: verificationCase.id,
    type: 'component-state',
    component: component.name,
    classification: component.classification,
    state: state.name,
    viewport: viewport.name,
    locale: locale.locale,
    direction: locale.direction,
    status: findings.some((finding) => finding.severity === 'error')
      ? 'failed'
      : findings.length > 0 ? 'review' : 'passed',
    screenshot,
    findings,
  };
}

async function executeActions(page, actions, baseUrl, requiredOrigin = null) {
  for (const action of actions) {
    if (action.type === 'wait') {
      await page.waitForTimeout(action.ms);
      await assertPageOrigin(page, requiredOrigin);
      continue;
    }
    if (action.type === 'use-current') continue;
    if (action.type === 'activate-locale') {
      const locator = page.locator(action.selector).first();
      if (action.method === 'select') {
        await locator.selectOption(action.value);
      } else {
        await locator.click();
      }
      await assertPageOrigin(page, requiredOrigin);
      const activeDocument = await page.evaluate(() => ({
        lang: document.documentElement.lang,
      }));
      if (activeDocument?.lang !== action.locale) {
        throw new Error(
          `Locale control ${action.selector} activated ` +
          `"${activeDocument?.lang || ''}" ` +
          `instead of "${action.locale}".`
        );
      }
      continue;
    }
    if (action.type === 'set-document') {
      await page.evaluate(({ locale, direction }) => {
        document.documentElement.lang = locale;
        document.documentElement.dir = direction;
      }, { locale: action.locale, direction: action.direction });
      continue;
    }
    if (action.type === 'navigate') {
      const target = /^https?:\/\//i.test(action.url)
        ? action.url
        : `${baseUrl}${action.url}`;
      await page.goto(target, { waitUntil: 'networkidle', timeout: 20000 });
      await assertPageOrigin(page, requiredOrigin);
      continue;
    }
    const locator = page.locator(action.selector).first();
    if (action.type === 'click') await locator.click();
    else if (action.type === 'fill') await locator.fill(action.value ?? '');
    else if (action.type === 'focus') await locator.focus();
    else if (action.type === 'hover') await locator.hover();
    else if (action.type === 'press') await locator.press(action.key);
    else if (action.type === 'select') await locator.selectOption(action.value);
    else if (action.type === 'check') await locator.check();
    else if (action.type === 'uncheck') await locator.uncheck();
    else if (action.type === 'set-attribute') {
      await locator.evaluate((element, attribute) => {
        element.setAttribute(attribute.name, attribute.value);
      }, { name: action.name, value: action.value });
    }
    await assertPageOrigin(page, requiredOrigin);
  }
}

async function assertLocaleEvidence(page, locale, findings, caseId) {
  for (const expectation of locale.expect || []) {
    const locator = page.locator(expectation.selector).first();
    if (await locator.count() === 0) {
      findings.push(makeFinding(
        caseId,
        'localized-content-target-missing',
        'error',
        'A target required to prove the real locale was activated was not found.',
        expectation.selector
      ));
      continue;
    }
    const actual = expectation.attribute
      ? await locator.getAttribute(expectation.attribute)
      : await locator.textContent();
    const expected = expectation.attribute ? expectation.value : expectation.text;
    if (expectation.exact ? actual !== expected : !String(actual || '').includes(expected)) {
      findings.push(makeFinding(
        caseId,
        'localized-content-mismatch',
        'error',
        `Expected localized content "${expected}" but found "${actual || ''}".`,
        expectation.selector
      ));
    }
  }
}

async function assertPageOrigin(page, requiredOrigin) {
  if (!requiredOrigin) return;
  if (typeof page.url !== 'function') {
    throw new Error('The browser page does not expose its current URL.');
  }
  const currentUrl = page.url();
  let currentOrigin;
  try {
    currentOrigin = new URL(currentUrl).origin;
  } catch {
    throw new Error(`The browser reported an invalid current URL: ${currentUrl}`);
  }
  if (currentOrigin !== requiredOrigin) {
    throw new Error(
      `Locale verification left the required loopback origin ` +
      `${requiredOrigin}: ${currentUrl}`
    );
  }
}

async function assertDocumentLocale(page, locale, findings, caseId) {
  const documentState = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    direction: getComputedStyle(document.documentElement).direction,
  }));
  if (documentState.lang.toLowerCase() !== locale.locale.toLowerCase()) {
    findings.push(makeFinding(
      caseId,
      'document-language-mismatch',
      'error',
      `Expected html lang "${locale.locale}" but found "${documentState.lang}".`,
      'html'
    ));
  }
  if (documentState.direction !== locale.direction) {
    findings.push(makeFinding(
      caseId,
      'document-direction-mismatch',
      'error',
      `Expected html direction "${locale.direction}" but found "${documentState.direction}".`,
      'html'
    ));
  }
}

async function inspectTarget(page, selector) {
  const locator = page.locator(selector).first();
  if (await locator.count() === 0) {
    return { exists: false, visible: false };
  }
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
    const clipsContent =
      /hidden|clip/.test(style.overflowX) || /hidden|clip/.test(style.overflowY);
    let clippedByAncestor = false;
    let ancestor = element.parentElement;
    while (ancestor) {
      const ancestorStyle = getComputedStyle(ancestor);
      if (/hidden|clip|auto|scroll/.test(
        `${ancestorStyle.overflowX} ${ancestorStyle.overflowY}`
      )) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const clientLeft = ancestorRect.left + ancestor.clientLeft;
        const clientTop = ancestorRect.top + ancestor.clientTop;
        const clientRight = clientLeft + ancestor.clientWidth;
        const clientBottom = clientTop + ancestor.clientHeight;
        if (rect.left < clientLeft - 1 ||
            rect.top < clientTop - 1 ||
            rect.right > clientRight + 1 ||
            rect.bottom > clientBottom + 1) {
          clippedByAncestor = true;
          break;
        }
      }
      const root = ancestor.getRootNode();
      ancestor = ancestor.parentElement || root.host || null;
    }
    return {
      exists: true,
      visible,
      direction: style.direction,
      textAlign: style.textAlign,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      clipped:
        clipsContent &&
        (element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1) ||
        clippedByAncestor,
      outsideViewport:
        rect.left < -1 ||
        rect.top < -1 ||
        rect.right > window.innerWidth + 1 ||
        rect.bottom > window.innerHeight + 1,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    };
  });
}

async function inspectDocument(page) {
  return page.evaluate(() => {
    const width = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0
    );
    return {
      horizontalOverflow: width > window.innerWidth + 1,
      overflowPixels: Math.max(0, width - window.innerWidth),
    };
  });
}

function evaluateTarget(snapshot, target, component, locale, caseId, findings) {
  const expectVisible = target.expectVisible !== false;
  if (!snapshot.exists && !expectVisible) return;
  if (snapshot.visible !== expectVisible) {
    findings.push(makeFinding(
      caseId,
      'rendered-visibility-mismatch',
      'error',
      `Expected visibility ${expectVisible} but rendered visibility was ${snapshot.visible}.`,
      target.selector
    ));
    return;
  }
  if (!snapshot.visible) return;
  if (target.externalOpaque) {
    findings.push(makeFinding(
      caseId,
      'unverifiable-third-party-surface',
      'error',
      'The visible external surface cannot be inspected for direction and must be adapted, restricted, replaced, or keep the locale unavailable.',
      target.selector
    ));
    return;
  }
  const expectedDirection =
    target.expectedDirection === 'inherit' || !target.expectedDirection
      ? locale.direction
      : target.expectedDirection;
  if (snapshot.direction !== expectedDirection) {
    findings.push(makeFinding(
      caseId,
      'computed-direction-mismatch',
      'error',
      `Expected computed direction "${expectedDirection}" but found "${snapshot.direction}".`,
      target.selector
    ));
  }
  if (snapshot.clipped && !target.allowClipping) {
    findings.push(makeFinding(
      caseId,
      'rendered-content-clipped',
      'error',
      'Rendered content exceeds a clipping container.',
      target.selector
    ));
  }
  if (snapshot.outsideViewport && !target.allowOutsideViewport) {
    findings.push(makeFinding(
      caseId,
      'rendered-outside-viewport',
      'error',
      'The rendered target extends outside the viewport.',
      target.selector
    ));
  }
  if (component.classification === 'direction-fixed' && !component.reason) {
    findings.push(makeFinding(
      caseId,
      'missing-fixed-direction-reason',
      'error',
      'Direction-fixed rendered content requires a semantic reason.',
      target.selector
    ));
  }
}

async function evaluateComputedCheck(page, check, locale, caseId, findings) {
  const actual = await page.locator(check.selector).first().evaluate(
    (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
    check.property
  );
  const expected = check.expected[locale.direction] ?? check.expected.default;
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(actual)) {
    findings.push(makeFinding(
      caseId,
      'computed-style-mismatch',
      'error',
      `Expected ${check.property} to be ${accepted.join(' or ')}, but found "${actual}".`,
      check.selector
    ));
  }
}

async function evaluateAttributeCheck(page, check, caseId, findings) {
  const actual = await page.locator(check.selector).first()
    .getAttribute(check.name);
  if (actual !== check.expected) {
    findings.push(makeFinding(
      caseId,
      'attribute-mismatch',
      'error',
      `Expected ${check.name}="${check.expected}" but found ` +
      `${actual === null ? 'no attribute' : `"${actual}"`}.`,
      check.selector
    ));
  }
}

async function verifyFocusOrder(page, selectors, caseId, findings) {
  await page.locator(selectors[0]).first().focus();
  for (let index = 1; index < selectors.length; index += 1) {
    await page.keyboard.press('Tab');
    const matches = await page.locator(selectors[index]).first().evaluate(
      (element) => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        return element === active;
      }
    );
    if (!matches) {
      findings.push(makeFinding(
        caseId,
        'focus-order-mismatch',
        'error',
        `Tab order did not reach expected target ${index + 1}.`,
        selectors[index]
      ));
      return;
    }
  }
}

async function verifyNoOverlap(page, pair, caseId, findings) {
  const [left, right] = await Promise.all([
    page.locator(pair[0]).first().boundingBox(),
    page.locator(pair[1]).first().boundingBox(),
  ]);
  const overlaps = !left || !right
    ? null
    : !(
      left.x + left.width <= right.x ||
      right.x + right.width <= left.x ||
      left.y + left.height <= right.y ||
      right.y + right.height <= left.y
    );
  if (overlaps === null) {
    findings.push(makeFinding(
      caseId,
      'overlap-target-missing',
      'error',
      'A target required for overlap verification was not found.',
      pair.join(' / ')
    ));
  } else if (overlaps) {
    findings.push(makeFinding(
      caseId,
      'unexpected-rendered-overlap',
      'error',
      'Targets that must remain separate overlap in this rendered state.',
      pair.join(' / ')
    ));
  }
}

async function applyPseudoContent(page, direction) {
  await page.evaluate((pseudoDirection) => {
    const transform = (value) => {
      if (!value || !value.trim()) return value;
      const expanded = `${value} ${value}`;
      return pseudoDirection === 'rtl'
        ? `\u27e6\u0646\u0635 ${expanded}\u27e7`
        : `\u27e6${expanded} extra\u27e7`;
    };
    const processRoot = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (parent && !/^(SCRIPT|STYLE|CODE|PRE|SVG)$/.test(parent.tagName)) {
          nodes.push(walker.currentNode);
        }
      }
      for (const node of nodes) node.nodeValue = transform(node.nodeValue);
      for (const element of root.querySelectorAll(
        'input[placeholder], textarea[placeholder], [aria-label], [title], ' +
        'input[type="button"][value], input[type="submit"][value], input[type="reset"][value]'
      )) {
        for (const attribute of ['placeholder', 'aria-label', 'title', 'value']) {
          if (attribute === 'value' &&
              !/^(button|submit|reset)$/i.test(element.getAttribute('type') || '')) {
            continue;
          }
          if (element.hasAttribute(attribute)) {
            element.setAttribute(attribute, transform(element.getAttribute(attribute)));
          }
        }
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) processRoot(element.shadowRoot);
      }
    };
    processRoot(document.body);
  }, direction);
}

async function runTransitionCase(
  browser,
  baseUrl,
  transition,
  spec,
  evidenceDir,
  requiredOrigin
) {
  const sequence = transition.sequence.map((localeId) =>
    spec.locales.find((locale) => locale.id === localeId)
  );
  const viewport = spec.viewports.find((candidate) =>
    candidate.name === (transition.viewport || spec.viewports[0].name)
  );
  const id = `transition--${transition.name}`;
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const findings = [];
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  try {
    await page.goto(`${baseUrl}${transition.route}`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    await assertPageOrigin(page, requiredOrigin);
    await verifyUnavailableLocaleChecks(
      page,
      spec.unavailableLocaleChecks || [],
      id,
      findings
    );
    await executeActions(
      page,
      sequence[0].activate || [],
      baseUrl,
      requiredOrigin
    );
    await verifyUnavailableLocaleChecks(
      page,
      spec.unavailableLocaleChecks || [],
      id,
      findings
    );
    await executeActions(
      page,
      transition.setup || [],
      baseUrl,
      requiredOrigin
    );
    await verifyUnavailableLocaleChecks(
      page,
      spec.unavailableLocaleChecks || [],
      id,
      findings
    );
    await assertPageOrigin(page, requiredOrigin);
    const baseline = await captureTransitionState(page, transition);
    await assertPageOrigin(page, requiredOrigin);
    addMissingTransitionTargets(baseline, id, findings);
    addUnsupportedTransitionTargets(baseline, id, findings);
    if (transition.preserveFocus && !baseline.focused) {
      findings.push(makeFinding(
        id,
        'locale-switch-focus-baseline-missing',
        'error',
        'The focus preservation target was not focused before switching.',
        transition.preserveFocus
      ));
    }
    await assertDocumentLocale(page, sequence[0], findings, id);
    await assertLocaleEvidence(page, sequence[0], findings, id);
    for (const locale of sequence.slice(1)) {
      await verifyUnavailableLocaleChecks(
        page,
        spec.unavailableLocaleChecks || [],
        id,
        findings
      );
      await executeActions(
        page,
        locale.activate || [],
        baseUrl,
        requiredOrigin
      );
      await verifyUnavailableLocaleChecks(
        page,
        spec.unavailableLocaleChecks || [],
        id,
        findings
      );
      await page.waitForTimeout(100);
      await assertPageOrigin(page, requiredOrigin);
      const current = await captureTransitionState(page, transition);
      addMissingTransitionTargets(current, id, findings);
      addUnsupportedTransitionTargets(current, id, findings);
      await assertDocumentLocale(page, locale, findings, id);
      await assertLocaleEvidence(page, locale, findings, id);
      if (baseline.timeOrigin !== current.timeOrigin) {
        findings.push(makeFinding(
          id,
          'locale-switch-reloaded-page',
          'error',
          'The runtime locale switch caused a page reload.',
          'html'
        ));
      }
      if (transition.preserveRoute !== false && baseline.route !== current.route) {
        findings.push(makeFinding(
          id,
          'locale-switch-lost-route',
          'error',
          `The route changed from "${baseline.route}" to "${current.route}".`,
          'html'
        ));
      }
      for (const [index, preserved] of baseline.preserved.entries()) {
        const currentPreserved = current.preserved[index];
        if (!preserved || preserved.unsupported || !currentPreserved ||
            currentPreserved.unsupported) {
          continue;
        }
        if (JSON.stringify(currentPreserved.value) !== JSON.stringify(preserved.value)) {
          findings.push(makeFinding(
            id,
            'locale-switch-lost-state',
            'error',
            `The preserved ${preserved.kind} state changed during locale switching.`,
            preserved.selector
          ));
        }
      }
      if (transition.preserveFocus && baseline.focused && !current.focused) {
        findings.push(makeFinding(
          id,
          'locale-switch-lost-focus',
          'error',
          'The focused control changed during locale switching.',
          transition.preserveFocus
        ));
      }
    }
    await assertPageOrigin(page, requiredOrigin);
  } catch (error) {
    findings.push(makeFinding(id, 'locale-switch-failure', 'error', error.message, 'html'));
  }
  for (const message of consoleErrors) {
    findings.push(makeFinding(
      id,
      'browser-console-error',
      'error',
      message,
      'html'
    ));
  }
  const screenshot = findings.length > 0
    ? await captureEvidence(page, evidenceDir, id)
    : null;
  await page.close();
  return {
    id,
    type: 'locale-transition',
    name: transition.name,
    sequence: sequence.map((locale) => locale.locale),
    status: findings.some((finding) => finding.severity === 'error') ? 'failed' : 'passed',
    screenshot,
    findings,
  };
}

async function verifyUnavailableLocaleChecks(page, checks, caseId, findings) {
  for (const check of checks) {
    for (const selector of check.selectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      let exposed = false;
      for (let index = 0; index < count && !exposed; index += 1) {
        const candidate = locator.nth(index);
        const elementType = await candidate.evaluate(
          (element) => element.tagName.toLowerCase()
        );
        if (elementType === 'option') {
          exposed = await candidate.evaluate((option) => {
            const select = option.closest('select');
            const optionGroup = option.closest('optgroup');
            if (!select || option.disabled || optionGroup?.disabled ||
                select.disabled) {
              return false;
            }
            if (typeof select.checkVisibility === 'function') {
              return select.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              });
            }
            const style = getComputedStyle(select);
            const rect = select.getBoundingClientRect();
            return !select.hidden &&
              select.getAttribute('aria-hidden') !== 'true' &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity) !== 0 &&
              rect.width > 0 &&
              rect.height > 0;
          });
        } else {
          exposed = await candidate.isVisible();
        }
      }
      if (exposed) {
        findings.push(makeFinding(
          caseId,
          'unavailable-locale-exposed',
          'error',
          `Unavailable locale ${check.locale} is exposed by a normal activation selector.`,
          selector
        ));
      }
    }
  }
}

async function captureTransitionState(page, transition) {
  const pageState = await page.evaluate(() => ({
    route: `${location.pathname}${location.search}${location.hash}`,
    timeOrigin: performance.timeOrigin,
  }));
  const preserved = [];
  const missing = [];
  const unsupported = [];
  for (const entry of transition.preserve || []) {
    const preservation = normalizePreservationEntry(entry);
    const locator = page.locator(preservation.selector).first();
    if (await locator.count() === 0) {
      missing.push(preservation.selector);
      preserved.push(null);
      continue;
    }
    const captured = await locator.evaluate((element, requested) => {
      let kind = requested.kind;
      if (kind === 'auto') {
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'input' &&
            (element.type === 'checkbox' || element.type === 'radio')) {
          kind = 'checked';
        } else if (tagName === 'input' || tagName === 'select' ||
                   tagName === 'textarea') {
          kind = 'value';
        } else {
          return { unsupported: true, kind };
        }
      }
      if (kind === 'checked') {
        if (!('checked' in element)) return { unsupported: true, kind };
        return { unsupported: false, kind, value: Boolean(element.checked) };
      }
      if (kind === 'value') {
        if (!('value' in element)) return { unsupported: true, kind };
        return { unsupported: false, kind, value: element.value };
      }
      if (kind === 'text') {
        return { unsupported: false, kind, value: element.textContent };
      }
      if (kind === 'attribute') {
        if (!element.hasAttribute(requested.name)) {
          return { unsupported: true, kind };
        }
        return {
          unsupported: false,
          kind,
          value: element.getAttribute(requested.name),
        };
      }
      if (!(requested.name in element)) return { unsupported: true, kind };
      const value = element[requested.name];
      return {
        unsupported:
          value === undefined ||
          (value !== null && (typeof value === 'object' || typeof value === 'function')),
        kind,
        value,
      };
    }, preservation);
    const result = {
      ...captured,
      selector: preservation.selector,
    };
    if (captured.unsupported) unsupported.push(preservation.selector);
    preserved.push(result);
  }
  let focused = null;
  if (transition.preserveFocus) {
    const locator = page.locator(transition.preserveFocus).first();
    if (await locator.count() === 0) {
      missing.push(transition.preserveFocus);
      focused = false;
    } else {
      focused = await locator.evaluate((element) => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        return element === active;
      });
    }
  }
  return { ...pageState, preserved, missing, unsupported, focused };
}

function addMissingTransitionTargets(state, caseId, findings) {
  for (const selector of new Set(state.missing)) {
    findings.push(makeFinding(
      caseId,
      'locale-switch-preservation-target-missing',
      'error',
      'A selector required for locale-switch preservation evidence was not found.',
      selector
    ));
  }
}

function addUnsupportedTransitionTargets(state, caseId, findings) {
  for (const selector of new Set(state.unsupported)) {
    findings.push(makeFinding(
      caseId,
      'locale-switch-preservation-unsupported',
      'error',
      'This preservation selector does not identify a form control. Specify text, attribute, or property evidence explicitly.',
      selector
    ));
  }
}

function normalizePreservationEntry(entry) {
  return typeof entry === 'string'
    ? { selector: entry, kind: 'auto' }
    : entry;
}

async function captureEvidence(page, evidenceDir, id) {
  if (!evidenceDir) return null;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const output = path.join(evidenceDir, `${sanitizeFileName(id)}.png`);
  await page.screenshot({ path: output, fullPage: true });
  return output;
}

function makeFinding(caseId, rule, severity, message, selector) {
  return { caseId, rule, severity, message, selector };
}

function summarizeFindings(findings, results) {
  return {
    cases: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    review: results.filter((result) => result.status === 'review').length,
    failed: results.filter((result) => result.status === 'failed').length,
    errors: findings.filter((finding) => finding.severity === 'error').length,
    reviewFindings: findings.filter((finding) => finding.severity === 'review').length,
  };
}

function sanitizeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 160);
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = {
  buildLocaleSmokeCases,
  buildVerificationGroups,
  buildVerificationCases,
  runRenderedBidirectionalAudit,
  runWithConcurrency,
  summarizeFindings,
  validateRunSpec,
};

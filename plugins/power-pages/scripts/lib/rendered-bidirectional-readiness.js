'use strict';

const fs = require('fs');
const path = require('path');

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

function validateRunSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['The rendered bidirectional run specification must be an object.'];
  }
  if (spec.version !== 1) errors.push('version must be 1.');
  if (spec.runtimeSwitching !== undefined &&
      typeof spec.runtimeSwitching !== 'boolean') {
    errors.push('runtimeSwitching must be boolean when provided.');
  }
  const viewports = Array.isArray(spec.viewports) ? spec.viewports : [];
  const locales = Array.isArray(spec.locales) ? spec.locales : [];
  const components = Array.isArray(spec.components) ? spec.components : [];
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
    if (!DIRECTIONS.has(locale?.direction)) {
      errors.push(`${prefix}.direction must be ltr or rtl.`);
    } else {
      directions.add(locale.direction);
    }
    validateActions(locale?.activate, `${prefix}.activate`, errors);
    if (locale?.pseudo !== undefined && typeof locale.pseudo !== 'boolean') {
      errors.push(`${prefix}.pseudo must be boolean when provided.`);
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

  const transitionDirections = [];
  for (const [index, transition] of (spec.transitions || []).entries()) {
    const prefix = `transitions[${index}]`;
    if (!isNonEmpty(transition?.name)) errors.push(`${prefix}.name is required.`);
    if (!Array.isArray(transition?.sequence) || transition.sequence.length < 2) {
      errors.push(`${prefix}.sequence must contain at least two locale IDs.`);
    } else {
      const sequenceDirections = [];
      for (const localeId of transition.sequence) {
        if (!localeIds.has(localeId)) {
          errors.push(`${prefix}.sequence references unknown locale "${localeId}".`);
        } else {
          sequenceDirections.push(
            locales.find((locale) => locale.id === localeId).direction
          );
        }
      }
      transitionDirections.push(sequenceDirections.join(','));
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
  if (spec.runtimeSwitching === true) {
    if (locales.some((locale) =>
      asArray(locale.activate).some((action) => action.type === 'navigate')
    )) {
      errors.push('runtimeSwitching locale activation cannot use navigate.');
    }
    if (!transitionDirections.includes('ltr,rtl,ltr')) {
      errors.push('runtimeSwitching requires an LTR -> RTL -> LTR transition.');
    }
    if (!transitionDirections.includes('rtl,ltr,rtl')) {
      errors.push('runtimeSwitching requires an RTL -> LTR -> RTL transition.');
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

function buildVerificationCases(spec) {
  const viewportMap = new Map(spec.viewports.map((viewport) => [viewport.name, viewport]));
  const cases = [];
  for (const component of spec.components) {
    for (const state of component.states) {
      for (const viewportName of component.viewports) {
        for (const locale of spec.locales) {
          cases.push({
            id: `${component.id}--${state.name}--${viewportName}--${locale.id}`,
            component,
            state,
            viewport: viewportMap.get(viewportName),
            locale,
          });
        }
      }
    }
  }
  return cases;
}

async function runRenderedBidirectionalAudit(options) {
  const errors = validateRunSpec(options.spec);
  if (errors.length > 0) {
    const error = new Error(`Invalid rendered bidirectional run specification:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_SPEC';
    throw error;
  }
  const baseUrl = options.url.replace(/\/$/, '');
  const browser = await options.chromium.launch({
    ...(options.browserLaunchOptions || {}),
    headless: true,
  });
  const findings = [];
  const results = [];

  try {
    for (const verificationCase of buildVerificationCases(options.spec)) {
      const result = await runVerificationCase(
        browser,
        baseUrl,
        verificationCase,
        options.evidenceDir
      );
      results.push(result);
      findings.push(...result.findings);
    }
    for (const transition of options.spec.transitions || []) {
      const result = await runTransitionCase(
        browser,
        baseUrl,
        transition,
        options.spec,
        options.evidenceDir
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
    summary: summarizeFindings(findings, results),
    findings,
    results,
  };
}

async function runVerificationCase(browser, baseUrl, verificationCase, evidenceDir) {
  const { component, state, viewport, locale } = verificationCase;
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
    await page.goto(`${baseUrl}${component.route}`, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });
    await executeActions(page, locale.activate || [], baseUrl);
    await executeActions(page, state.setup || [], baseUrl);
    if (locale.pseudo) await applyPseudoContent(page, locale.direction);
    await page.waitForTimeout(100);
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
    for (const message of consoleErrors) {
      findings.push(makeFinding(
        verificationCase.id,
        'browser-console-error',
        'error',
        message,
        component.selector
      ));
    }
  } catch (error) {
    findings.push(makeFinding(
      verificationCase.id,
      'rendered-case-failure',
      'error',
      error.message,
      component.selector
    ));
  }

  const screenshot = findings.length > 0
    ? await captureEvidence(page, evidenceDir, verificationCase.id)
    : null;
  await page.close();
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

async function executeActions(page, actions, baseUrl) {
  for (const action of actions) {
    if (action.type === 'wait') {
      await page.waitForTimeout(action.ms);
      continue;
    }
    if (action.type === 'use-current') continue;
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

async function runTransitionCase(browser, baseUrl, transition, spec, evidenceDir) {
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
    await executeActions(page, sequence[0].activate || [], baseUrl);
    await executeActions(page, transition.setup || [], baseUrl);
    const baseline = await captureTransitionState(page, transition);
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
      await executeActions(page, locale.activate || [], baseUrl);
      await page.waitForTimeout(100);
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
  buildVerificationCases,
  runRenderedBidirectionalAudit,
  summarizeFindings,
  validateRunSpec,
};

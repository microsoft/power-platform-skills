'use strict';

const VERIFICATION_PROFILES = new Set([
  'standard',
  'extensive',
  'targeted',
]);
const COMPONENT_RISKS = new Set(['low', 'medium', 'high']);

function resolveVerificationProfile(spec) {
  // Version 1 run specs predate profiles and represented the full Cartesian
  // matrix, so preserve that behavior unless a newer workflow opts into one.
  return spec?.verificationProfile || 'extensive';
}

function resolveComponentRisk(component) {
  if (COMPONENT_RISKS.has(component?.risk)) return component.risk;
  if (component?.classification === 'direction-neutral') return 'low';
  if (component?.classification === 'direction-aware') return 'medium';
  return 'high';
}

function selectRepresentativeLocales(locales, options = {}) {
  const targets = new Set(options.targetLocales || []);
  const defaultLocale = options.defaultLocale || null;
  const result = {};
  for (const direction of ['ltr', 'rtl']) {
    const candidates = locales
      .filter((locale) => locale?.direction === direction)
      .sort((left, right) =>
        compareCandidates(left, right, targets, defaultLocale)
      );
    if (candidates.length > 0) result[direction] = candidates[0].id;
  }
  return result;
}

function compareCandidates(left, right, targets, defaultLocale) {
  const leftRank = candidateRank(left, targets, defaultLocale);
  const rightRank = candidateRank(right, targets, defaultLocale);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) {
      return rightRank[index] - leftRank[index];
    }
  }
  return String(left.id).localeCompare(String(right.id));
}

function candidateRank(locale, targets, defaultLocale) {
  // A real target exercises the implementation being added. Text expansion
  // then chooses the candidate most likely to expose layout pressure; the
  // default locale is only the fallback baseline after those stronger signals.
  return [
    locale.pseudo === true ? 0 : 1,
    targets.has(locale.locale) ? 1 : 0,
    Number.isFinite(locale.textExpansion) ? locale.textExpansion : 0,
    locale.locale === defaultLocale ? 1 : 0,
  ];
}

function resolveRepresentatives(spec, localizationContext = null) {
  const selected = selectRepresentativeLocales(spec.locales || [], {
    targetLocales: localizationContext?.verificationLocales || [],
    defaultLocale: localizationContext?.defaultLocale || null,
  });
  return {
    ...selected,
    ...(spec.representativeLocaleIds || {}),
  };
}

function selectComponentDimensions(component, spec, representatives) {
  const profile = resolveVerificationProfile(spec);
  const risk = resolveComponentRisk(component);
  if (profile === 'extensive' || profile === 'targeted') {
    return {
      localeIds: spec.locales.map((locale) => locale.id),
      states: component.states,
      viewports: component.viewports,
      risk,
    };
  }

  const localeIds = [...new Set(
    ['ltr', 'rtl']
      .map((direction) => representatives[direction])
      .filter(Boolean)
  )];
  if (risk === 'low') {
    // Direction-neutral components still prove inheritance in both directions,
    // but repeating secondary states and viewports adds little layout evidence.
    return {
      localeIds,
      states: component.states.slice(0, 1),
      viewports: component.viewports.slice(0, 1),
      risk,
    };
  }
  return {
    localeIds,
    states: component.states,
    viewports: component.viewports,
    risk,
  };
}

function buildManualReviewChecklist(spec, representatives) {
  if (resolveVerificationProfile(spec) !== 'standard') return [];
  const representativeIds = new Set(Object.values(representatives));
  const remainingLocales = spec.locales.filter(
    (locale) => !locale.pseudo && !representativeIds.has(locale.id)
  );
  const complexComponents = spec.components.filter(
    (component) => resolveComponentRisk(component) === 'high'
  );
  const checks = [];
  for (const locale of remainingLocales) {
    for (const component of complexComponents) {
      checks.push({
        localeId: locale.id,
        locale: locale.locale,
        componentId: component.id,
        component: component.name,
        route: component.route,
        states: component.states.map((state) => state.name),
        viewports: [...component.viewports],
        review:
          'Verify translated labels and values, text expansion, formatting, ' +
          'visual clipping, and usability in the listed states and viewports.',
      });
    }
  }
  return checks;
}

module.exports = {
  COMPONENT_RISKS,
  VERIFICATION_PROFILES,
  buildManualReviewChecklist,
  resolveComponentRisk,
  resolveRepresentatives,
  resolveVerificationProfile,
  selectComponentDimensions,
  selectRepresentativeLocales,
};

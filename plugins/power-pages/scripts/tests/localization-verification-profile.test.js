'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildManualReviewChecklist,
  resolveComponentRisk,
  resolveRepresentatives,
  selectComponentDimensions,
  selectRepresentativeLocales,
} = require('../lib/localization-verification-profile');

const locales = [
  { id: 'en', locale: 'en-US', direction: 'ltr', textExpansion: 1 },
  { id: 'es', locale: 'es-ES', direction: 'ltr', textExpansion: 1.4 },
  { id: 'ar', locale: 'ar-SA', direction: 'rtl', textExpansion: 1.2 },
  {
    id: 'pseudo-rtl',
    locale: 'ar-XB',
    direction: 'rtl',
    pseudo: true,
    textExpansion: 3,
  },
];

test('prefers real target locales and then greater text expansion', () => {
  assert.deepEqual(selectRepresentativeLocales(locales, {
    targetLocales: ['es-ES', 'ar-SA'],
    defaultLocale: 'en-US',
  }), {
    ltr: 'es',
    rtl: 'ar',
  });
});

test('falls back to a pseudo direction only when no real locale exists', () => {
  assert.deepEqual(selectRepresentativeLocales(
    locales.filter((locale) => locale.id !== 'ar'),
    { targetLocales: ['es-ES'], defaultLocale: 'en-US' }
  ), {
    ltr: 'es',
    rtl: 'pseudo-rtl',
  });
});

test('uses explicit representative overrides after automatic selection', () => {
  const spec = {
    locales,
    representativeLocaleIds: { ltr: 'en' },
  };
  assert.deepEqual(resolveRepresentatives(spec, {
    verificationLocales: ['es-ES', 'ar-SA'],
    defaultLocale: 'en-US',
  }), {
    ltr: 'en',
    rtl: 'ar',
  });
});

test('maps component classifications to conservative default risks', () => {
  assert.equal(resolveComponentRisk({ classification: 'direction-neutral' }), 'low');
  assert.equal(resolveComponentRisk({ classification: 'direction-aware' }), 'medium');
  assert.equal(resolveComponentRisk({ classification: 'direction-fixed' }), 'high');
  assert.equal(resolveComponentRisk({ classification: 'unknown-third-party' }), 'high');
});

test('standard profile limits low-risk dimensions but keeps complex coverage', () => {
  const spec = {
    verificationProfile: 'standard',
    locales,
  };
  const representatives = { ltr: 'es', rtl: 'ar' };
  const low = {
    classification: 'direction-neutral',
    states: [{ name: 'default' }, { name: 'expanded' }],
    viewports: ['desktop', 'narrow'],
  };
  const high = {
    classification: 'unknown-third-party',
    states: [{ name: 'closed' }, { name: 'open' }],
    viewports: ['desktop', 'narrow'],
  };

  assert.deepEqual(selectComponentDimensions(low, spec, representatives), {
    localeIds: ['es', 'ar'],
    states: [{ name: 'default' }],
    viewports: ['desktop'],
    risk: 'low',
  });
  assert.deepEqual(selectComponentDimensions(high, spec, representatives), {
    localeIds: ['es', 'ar'],
    states: high.states,
    viewports: high.viewports,
    risk: 'high',
  });
});

test('manual review covers high-risk components in non-representative locales', () => {
  const spec = {
    verificationProfile: 'standard',
    locales,
    components: [{
      id: 'calendar',
      name: 'Calendar',
      classification: 'unknown-third-party',
      route: '/calendar',
      states: [{ name: 'closed' }, { name: 'open' }],
      viewports: ['desktop', 'narrow'],
    }],
  };

  assert.deepEqual(
    buildManualReviewChecklist(spec, { ltr: 'es', rtl: 'ar' })
      .map((entry) => [entry.locale, entry.componentId]),
    [
      ['en-US', 'calendar'],
    ]
  );
});

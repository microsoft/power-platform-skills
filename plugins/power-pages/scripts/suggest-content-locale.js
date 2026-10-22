#!/usr/bin/env node
'use strict';

const {
  getAuthToken,
  getEnvironmentUrl,
  makeRequest,
  odataGet,
} = require('./lib/validation-helpers');
const { resolveLocale } = require('./lib/localization-config');

const FALLBACK_LOCALE = Object.freeze({
  locale: 'en-US',
  language: 'English (United States)',
  direction: 'ltr',
  lcid: 1033,
  source: 'fallback',
});

function fallbackLocale() {
  return { ...FALLBACK_LOCALE };
}

function readableLanguage(row, locale) {
  for (const value of [row?.name, row?.language]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return locale;
}

async function suggestContentLocale(dependencies = {}) {
  const resolveEnvironmentUrl = dependencies.getEnvironmentUrl || getEnvironmentUrl;
  const resolveAuthToken = dependencies.getAuthToken || getAuthToken;
  const request = dependencies.makeRequest || makeRequest;
  const getOData = dependencies.odataGet || odataGet;
  const resolve = dependencies.resolveLocale || resolveLocale;

  try {
    const environmentUrl = resolveEnvironmentUrl();
    if (!environmentUrl) return fallbackLocale();

    const token = resolveAuthToken(environmentUrl);
    if (!token) return fallbackLocale();

    // `organization.languagecode` is the Dataverse base-language LCID.
    // `localeid` controls regional formatting and can differ, so it must not
    // determine the language used for site content.
    // See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/organization
    const organizationResponse = await getOData(
      `${environmentUrl}/api/data/v9.2/organizations?$select=languagecode&$top=1`,
      token,
      request
    );
    const lcid = Number(organizationResponse?.value?.[0]?.languagecode);
    if (!Number.isInteger(lcid) || lcid <= 0) return fallbackLocale();

    // Ask Dataverse for its LCID-to-BCP-47 mapping instead of maintaining a
    // separate Windows LCID table that could drift from the platform.
    // Example row:
    //   { "localeid": 1033, "code": "en-US", "name": "English (United States)" }
    // See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/languagelocale
    const languageResponse = await getOData(
      `${environmentUrl}/api/data/v9.2/languagelocale` +
        `?$select=localeid,code,language,name&$filter=localeid eq ${lcid}&$top=1`,
      token,
      request
    );
    const languageRow = languageResponse?.value?.[0];
    if (typeof languageRow?.code !== 'string' || !languageRow.code.trim()) {
      return fallbackLocale();
    }

    const resolved = resolve(languageRow.code.trim());
    if (!resolved.valid || !resolved.locale || !resolved.direction) {
      return fallbackLocale();
    }

    return {
      locale: resolved.locale,
      language: readableLanguage(languageRow, resolved.locale),
      direction: resolved.direction,
      lcid,
      source: 'dataverse',
    };
  } catch {
    // The lookup only improves a question default. Missing CLIs, expired auth,
    // inaccessible APIs, malformed responses, and unknown mappings must never
    // delay or prevent the maker from creating a site.
    return fallbackLocale();
  }
}

async function main() {
  const result = await suggestContentLocale();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(fallbackLocale())}\n`);
  });
}

module.exports = {
  FALLBACK_LOCALE,
  fallbackLocale,
  readableLanguage,
  suggestContentLocale,
};

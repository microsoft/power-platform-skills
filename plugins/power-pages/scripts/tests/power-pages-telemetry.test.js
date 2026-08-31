"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const telemetry = require("../lib/telemetry/power-pages-telemetry");

test("create-site telemetry keeps only the approved taxonomy", () => {
  const info = telemetry.buildCreateSiteEventInfo({
    framework: "React",
    siteContentLocale: "en-US-x-contoso",
    purpose: "Company Portal",
    audience: "Internal",
    choiceSource: "prompt",
    siteDirection: "ltr",
    siteContentLanguage: "en",
    siteName: "Contoso",
  });

  assert.deepEqual(info, {
    configurationType: "create-site",
    framework: "react",
    siteContentLocale: "en-US",
    purpose: "company-portal",
    audience: "internal",
    choiceSource: "prompt",
  });
});

test("localization telemetry strips locale extensions and removed count fields", () => {
  const info = telemetry.buildLocalizationEventInfo({
    framework: "angular",
    operation: "add-languages",
    invocationSource: "direct",
    existingLocalizationDetected: true,
    mode: "runtime",
    defaultLocale: "en-US",
    addedLocales: ["ar-SA-x-customer", "de-DE-u-co-phonebk"],
    resultingLocales: ["en-US", "ar-SA-x-customer", "de-DE-u-co-phonebk"],
    packageName: "@jsverse/transloco",
    packageVersion: "8.0.0",
    packageSelection: "recommended",
    packageVerification: "verified",
    translationMethod: "agent",
    addedLocaleCount: 2,
    resultingLocaleCount: 3,
    directionClassification: "mixed",
    introducesMixedDirection: true,
  });

  assert.deepEqual(info, {
    configurationType: "localization",
    framework: "angular",
    operation: "add-languages",
    invocationSource: "direct",
    existingLocalizationDetected: true,
    mode: "runtime",
    defaultLocale: "en-US",
    addedLocales: ["ar-SA", "de-DE"],
    resultingLocales: ["en-US", "ar-SA", "de-DE"],
    packageName: "@jsverse/transloco",
    packageVersion: "8.0.0",
    packageSelection: "recommended",
    packageVerification: "verified",
    translationMethod: "agent",
  });
});

test("package validation telemetry accepts only standardized failure codes", () => {
  const info = telemetry.buildPackageValidationEventInfo({
    framework: "react",
    operation: "create",
    intendedLocales: "en-US,fr-FR-x-private",
    packageName: "React-I18Next",
    resolvedVersion: "16.2.0",
    packageSelection: "alternative",
    mode: "runtime",
    validationStatus: "unsupported",
    failureCodes: [
      "framework-peer-incompatible",
      "raw npm error text",
      "framework-peer-incompatible",
    ],
    prerelease: false,
    unverifiedOverrideRequested: false,
  });

  assert.deepEqual(info, {
    framework: "react",
    operation: "create",
    intendedLocales: ["en-US", "fr-FR"],
    packageName: "react-i18next",
    resolvedVersion: "16.2.0",
    packageSelection: "alternative",
    mode: "runtime",
    validationStatus: "unsupported",
    failureCodes: ["framework-peer-incompatible"],
    prerelease: false,
    unverifiedOverrideRequested: false,
  });
});

test("private-use-only locale identifiers are not collected", () => {
  assert.equal(telemetry.sanitizeLocale("x-contoso"), null);
});

test("completion telemetry constrains readiness and count values", () => {
  assert.deepEqual(
    telemetry.buildLocalizationCompletionEventInfo({
      validationOutcome: "failed",
      bidirectionalReadiness: "customer-specific-value",
      unavailableLocaleCount: -2,
      configuredLocaleCount: 3.8,
      translationMethod: "blank",
    }),
    {
      validationOutcome: "failed",
      bidirectionalReadiness: "not-required",
      unavailableLocaleCount: 0,
      configuredLocaleCount: 3,
      translationMethod: "blank",
    }
  );
});

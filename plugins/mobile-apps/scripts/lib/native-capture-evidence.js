'use strict';

const OVERLAY_TEXT = /\b(?:refreshing(?:\.\.\.)?|disconnected|metro(?: bundler)?|packager|red\s*box|development error|dev(?:eloper)? menu|debug(?:ger)?|reload to retry|bundle failed)\b/i;

function captureText(capture) {
  return [
    capture?.ocrText,
    capture?.overlayText,
    capture?.notes,
    capture?.caption,
    capture?.visibleChrome,
  ].filter((value) => typeof value === 'string').join(' ');
}

function validateNativeCaptureCleanliness(capture, label = 'capture') {
  const issues = [];
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return [`${label} must be an object`];
  if (typeof capture.screenId !== 'string' || !capture.screenId.trim()) issues.push(`${label} requires screenId`);
  if (capture.captureState !== 'stable') issues.push(`${label} captureState must be stable`);
  const dimensions = capture.dimensions;
  if (!Number.isInteger(dimensions?.width) || dimensions.width < 240
    || !Number.isInteger(dimensions?.height) || dimensions.height < 320) {
    issues.push(`${label} requires native viewport dimensions`);
  }
  const cleanliness = capture.cleanliness;
  if (cleanliness?.metroOverlay !== 'absent') issues.push(`${label} must record Metro overlay absent`);
  if (cleanliness?.developmentErrorOverlay !== 'absent') issues.push(`${label} must record development error overlay absent`);
  if (cleanliness?.hostDebugChrome !== 'absent') issues.push(`${label} must record host debug chrome absent`);
  const text = captureText(capture);
  if (OVERLAY_TEXT.test(text)) issues.push(`${label} contains development/Metro overlay text`);
  return issues;
}

function isCleanNativeCapture(capture) {
  return validateNativeCaptureCleanliness(capture).length === 0;
}

module.exports = { OVERLAY_TEXT, captureText, isCleanNativeCapture, validateNativeCaptureCleanliness };

'use strict';

const GUID_TOPIC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIREBASE_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REQUEST_KEYS = ['body', 'deepLink', 'schemaVersion', 'title', 'topic', 'validateOnly'];
const FORBIDDEN_DEEP_LINK = /[\u0000-\u001f\\?#]|%(?:25|2e|2f|5c)/i;
const CUSTOM_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9/_-]*$/i;

class RequestError extends Error {
  constructor(field, message) {
    super(message);
    this.code = 'INVALID_REQUEST';
    this.field = field;
  }
}

function parseStringArray(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(value || '');
  } catch {
    throw new Error(`${name} must be a JSON string array.`);
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.some((entry) => typeof entry !== 'string' || !entry || entry.length > 500)
  ) {
    throw new Error(`${name} must be a non-empty JSON string array.`);
  }
  return [...new Set(parsed)];
}

function loadPolicy(env = process.env) {
  const firebaseProjectId = requiredSetting(env.FIREBASE_PROJECT_ID, 'FIREBASE_PROJECT_ID');
  if (!FIREBASE_PROJECT.test(firebaseProjectId)) {
    throw new Error('FIREBASE_PROJECT_ID is malformed.');
  }
  const deepLinkPrefixes = parseStringArray(
    env.ALLOWED_DEEP_LINK_PREFIXES,
    'ALLOWED_DEEP_LINK_PREFIXES',
  );
  for (const prefix of deepLinkPrefixes) {
    if (
      FORBIDDEN_DEEP_LINK.test(prefix)
      || prefix.includes('..')
      || (!prefix.startsWith('/') && !CUSTOM_SCHEME_PREFIX.test(prefix))
      || /^(?:https?|javascript):/i.test(prefix)
    ) {
      throw new Error('ALLOWED_DEEP_LINK_PREFIXES contains an unsafe prefix.');
    }
  }
  return {
    firebaseProjectId,
    deepLinkPrefixes,
    titles: parseStringArray(
      env.ALLOWED_NOTIFICATION_TITLES,
      'ALLOWED_NOTIFICATION_TITLES',
    ),
    bodies: parseStringArray(
      env.ALLOWED_NOTIFICATION_BODIES,
      'ALLOWED_NOTIFICATION_BODIES',
    ),
  };
}

function requiredSetting(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requireString(value, field, maxLength) {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || value.length > maxLength
  ) {
    throw new RequestError(field, `${field} is invalid.`);
  }
}

function prefixMatches(value, prefix) {
  if (prefix.endsWith('/')) return value.startsWith(prefix);
  return value === prefix || value.startsWith(`${prefix}/`);
}

function validateDeepLink(value, prefixes) {
  requireString(value, 'deepLink', 1000);
  if (
    /^(?:https?|javascript):/i.test(value)
    || FORBIDDEN_DEEP_LINK.test(value)
    || value.includes('..')
    || !prefixes.some((prefix) => prefixMatches(value, prefix))
  ) {
    throw new RequestError('deepLink', 'deepLink is not an approved internal route.');
  }
}

function validateRequest(input, policy) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestError('$', 'Request body must be an object.');
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== REQUEST_KEYS.length || keys.some((key, index) => key !== REQUEST_KEYS[index])) {
    throw new RequestError('$', 'Request fields do not match the endpoint contract.');
  }
  if (input.topic !== 'allUsers' && !GUID_TOPIC.test(input.topic || '')) {
    throw new RequestError('topic', 'topic must be allUsers or a lowercase Entra OID.');
  }
  requireString(input.title, 'title', 200);
  requireString(input.body, 'body', 2000);
  if (!policy.titles.includes(input.title) || !policy.bodies.includes(input.body)) {
    throw new RequestError('notification', 'Notification text is not approved generic content.');
  }
  if (input.schemaVersion !== '1') {
    throw new RequestError('schemaVersion', 'schemaVersion is unsupported.');
  }
  if (typeof input.validateOnly !== 'boolean') {
    throw new RequestError('validateOnly', 'validateOnly must be a Boolean.');
  }
  validateDeepLink(input.deepLink, policy.deepLinkPrefixes);
  return { ...input };
}

module.exports = {
  RequestError,
  loadPolicy,
  parseStringArray,
  validateDeepLink,
  validateRequest,
};

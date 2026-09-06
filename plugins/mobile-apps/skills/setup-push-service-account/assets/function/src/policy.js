'use strict';

const GUID_TOPIC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID_VALUE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const FIREBASE_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DESTINATION = /^[a-z][a-z0-9-]{0,63}$/;
const PARAMETER_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FORBIDDEN_PARAMETER_TEXT = /[\u0000-\u001f\u007f\\]/;
const REQUEST_KEYS = ['body', 'destination', 'params', 'schemaVersion', 'title', 'topic', 'validateOnly'];

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
  const navigationDestinations = parseNavigationDestinations(
    env.ALLOWED_NAVIGATION_DESTINATIONS,
  );
  return {
    firebaseProjectId,
    navigationDestinations,
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

function parseNavigationDestinations(value) {
  let parsed;
  try {
    parsed = JSON.parse(value || '');
  } catch {
    throw new Error('ALLOWED_NAVIGATION_DESTINATIONS must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ALLOWED_NAVIGATION_DESTINATIONS must be a JSON object.');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error('ALLOWED_NAVIGATION_DESTINATIONS must not be empty.');
  }
  for (const [destination, parameterSchema] of entries) {
    if (!DESTINATION.test(destination)
      || !parameterSchema
      || typeof parameterSchema !== 'object'
      || Array.isArray(parameterSchema)
      || Object.keys(parameterSchema).length > 16) {
      throw new Error('ALLOWED_NAVIGATION_DESTINATIONS contains an invalid destination.');
    }
    for (const [key, rule] of Object.entries(parameterSchema)) {
      if (!PARAMETER_KEY.test(key)
        || !rule
        || typeof rule !== 'object'
        || Array.isArray(rule)
        || !['string', 'guid', 'integer', 'enum'].includes(rule.type)
        || typeof rule.required !== 'boolean'
        || (rule.type === 'enum'
          && (!Array.isArray(rule.values)
            || rule.values.length === 0
            || rule.values.some((item) => typeof item !== 'string' || item.length > 500)))) {
        throw new Error('ALLOWED_NAVIGATION_DESTINATIONS contains an invalid parameter rule.');
      }
    }
  }
  return parsed;
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

function validateNavigation(destination, params, destinations) {
  requireString(destination, 'destination', 64);
  if (!DESTINATION.test(destination) || !Object.hasOwn(destinations, destination)) {
    throw new RequestError('destination', 'destination is not approved.');
  }
  requireString(params, 'params', 4096);
  if (Buffer.byteLength(params, 'utf8') > 4096) {
    throw new RequestError('params', 'params is too large.');
  }

  let parsed;
  try {
    parsed = JSON.parse(params);
  } catch {
    throw new RequestError('params', 'params must be canonical JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestError('params', 'params must be a JSON object.');
  }
  const keys = Object.keys(parsed);
  const canonical = Object.fromEntries([...keys].sort().map((key) => [key, parsed[key]]));
  // Canonical comparison also rejects whitespace, duplicate keys, and unstable key order.
  if (JSON.stringify(canonical) !== params || keys.length > 16) {
    throw new RequestError('params', 'params must be canonical JSON.');
  }

  const schema = destinations[destination];
  if (keys.some((key) => !Object.hasOwn(schema, key))
    || Object.entries(schema).some(([key, rule]) => rule.required && !Object.hasOwn(parsed, key))) {
    throw new RequestError('params', 'params do not match the destination contract.');
  }
  for (const [key, value] of Object.entries(parsed)) {
    const rule = schema[key];
    if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') > 500
      || FORBIDDEN_PARAMETER_TEXT.test(value)) {
      throw new RequestError('params', 'parameter values must be bounded strings.');
    }
    if (rule.type === 'guid' && !GUID_VALUE.test(value)) {
      throw new RequestError('params', `${key} must be a GUID.`);
    }
    if (rule.type === 'integer' && !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new RequestError('params', `${key} must be an integer.`);
    }
    if (rule.type === 'enum' && !rule.values.includes(value)) {
      throw new RequestError('params', `${key} is not an approved value.`);
    }
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
  validateNavigation(input.destination, input.params, policy.navigationDestinations);
  return { ...input };
}

module.exports = {
  RequestError,
  loadPolicy,
  parseNavigationDestinations,
  parseStringArray,
  validateNavigation,
  validateRequest,
};

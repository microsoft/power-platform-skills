'use strict';

class AuthoringError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthoringError';
    this.code = code;
  }
}

function publicError(error, token) {
  const message = error instanceof AuthoringError ? `${error.code}: ${error.message}`
    : error.name === 'AbortError' ? 'The authoring wait was cancelled'
      : error.code ? 'An authoring dependency or file could not be accessed safely'
        : error.message;
  return token ? String(message).split(token).join('[redacted]') : String(message);
}

module.exports = { AuthoringError, publicError };

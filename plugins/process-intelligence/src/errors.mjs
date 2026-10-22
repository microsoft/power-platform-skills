// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** An actionable, deliberately sanitized local failure. */
export class BridgeError extends Error {
  constructor(message, exitCode = 3, errorCode) {
    super(message);
    this.name = 'BridgeError';
    this.exitCode = exitCode;
    if (errorCode) {
      this.errorCode = errorCode;
    }
  }
}

export class TransportError extends Error {
  constructor(status, code = status === undefined ? 'NETWORK_FAILURE' : 'HTTP_FAILURE') {
    super('Remote transport failed; uncertain calls were not replayed.');
    this.status = status;
    this.errorCode = code;
  }
}

export const invalid = (message, code = 'INVALID_CONFIGURATION') =>
  new BridgeError(message, 2, code);

export const isObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function safeFailure(error) {
  if (error instanceof BridgeError || error instanceof TransportError) {
    return error.message;
  }
  if (error?.name === 'AbortError') {
    return 'Operation cancelled; uncertain tool calls were not replayed.';
  }
  return 'Local I/O or remote protocol failed. Check state permissions and connectivity; no fallback was used.';
}

export function abortable(pending, signal) {
  if (!signal) {
    return pending;
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

/** Serialize asynchronous operations without retaining errors or blocking cancellation of queued work. */
export class Gate {
  #tail = Promise.resolve();

  async run(operation, signal) {
    signal?.throwIfAborted();
    const previous = this.#tail;
    let release;
    this.#tail = new Promise(resolve => {
      release = resolve;
    });
    try {
      await abortable(previous, signal);
    } catch (error) {
      // Cancel the waiter promptly, but do not open the gate ahead of its predecessor.
      void previous.then(release);
      throw error;
    }
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }
}

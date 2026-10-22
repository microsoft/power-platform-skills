// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export class CorrelationSession {
  #storage = new AsyncLocalStorage();
  #owners = new WeakSet();
  #retired = new WeakSet();

  constructor() {
    this.clientSessionId = randomUUID();
    this.sessionOwner = Object.freeze({ clientSessionId: this.clientSessionId });
  }

  newRequest() {
    const owner = Object.freeze({
      clientSessionId: this.clientSessionId,
      clientRequestId: randomUUID()
    });
    this.#owners.add(owner);
    return owner;
  }

  async request(work) {
    const owner = this.newRequest();
    try {
      return await this.run(owner, work);
    } finally {
      this.retire(owner);
    }
  }

  run(owner, work) {
    return this.#storage.run(this.#owners.has(owner) ? owner : this.sessionOwner, work);
  }

  sessionOnly(work) {
    return this.#storage.run(this.sessionOwner, work);
  }

  capture() {
    const owner = this.#storage.getStore();
    return owner && this.#owners.has(owner) && !this.#retired.has(owner)
      ? owner
      : this.sessionOwner;
  }

  retire(owner) {
    if (this.#owners.has(owner)) {
      this.#retired.add(owner);
    }
  }
}

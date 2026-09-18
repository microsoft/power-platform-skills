'use strict';

const { sameSamplePhoto, validateSamplePhoto } = require('./prototype-images');

// Dependencies are injected from the installed AsyncStorage/FileSystem packages.
// This exact implementation also runs in the Node conformance tests.
function createLocalStore({
  domain, fixtures, storage, files, randomUUID, assertRules, core,
  preview = { previewKind: 'active', dataNamespace: 'active' }, transientEntityIds = [],
}) {
  const { RepositoryError, validateRecord, prepareWrite, validateQuery, queryRows } = core;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const entities = new Map(domain.entities.map((entity) => [entity.id, entity]));
  const safeNamespace = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value)) {
      throw new RepositoryError('namespace', 'Invalid data namespace');
    }
    return encodeURIComponent(value);
  };
  if (!['active', 'candidate'].includes(preview.previewKind)) throw new RepositoryError('namespace', 'Invalid preview kind');
  if (preview.previewKind === 'candidate' && preview.dataNamespace === (preview.baseDataNamespace || 'active')) {
    throw new RepositoryError('namespace', 'Candidate data must not use the active namespace');
  }
  const prefix = `mobile-local:${safeNamespace(domain.appInstanceId)}:v${domain.schemaVersionNumber}:`;
  const key = `${prefix}${safeNamespace(preview.dataNamespace)}`;
  const activeKey = `${prefix}${safeNamespace(preview.baseDataNamespace || 'active')}`;
  const mediaDirectory = files.documentDirectory
    ? `${files.documentDirectory}mobile-local/${safeNamespace(domain.appInstanceId)}/v${domain.schemaVersionNumber}/${safeNamespace(preview.dataNamespace)}/`
    : null;
  const globalKey = Symbol.for('power-apps.mobile.local.write-queues.v1');
  const queues = globalThis[globalKey] || (globalThis[globalKey] = new Map());
  const transient = new Map(transientEntityIds.map((entityId) => [entityId, clone(fixtures.entities[entityId] || [])]));
  const listeners = new Set();
  const initial = () => ({
    formatVersion: 1, appInstanceId: domain.appInstanceId, schemaVersionNumber: domain.schemaVersionNumber,
    entities: clone(fixtures.entities), receipts: {}, media: {},
  });
  const locked = (work) => {
    const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, next);
    return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  };
  const read = async () => {
    let raw;
    try { raw = await storage.getItem(key); } catch (error) {
      throw new RepositoryError('storage', 'Could not read local records', error);
    }
    let state;
    if (raw === null) {
      let base = null;
      if (preview.previewKind === 'candidate') {
        try { base = await storage.getItem(activeKey); } catch (error) {
          throw new RepositoryError('storage', 'Could not isolate candidate records', error);
        }
      }
      try { state = base === null ? initial() : JSON.parse(base); } catch {
        throw new RepositoryError('storage-corrupt', 'Active records cannot be copied safely');
      }
    } else {
      try { state = JSON.parse(raw); } catch {
        throw new RepositoryError('storage-corrupt', 'Local records are corrupt; explicit recovery is required');
      }
    }
    if (state.formatVersion !== 1 || state.appInstanceId !== domain.appInstanceId
      || state.schemaVersionNumber !== domain.schemaVersionNumber || !state.entities || !state.receipts || !state.media) {
      throw new RepositoryError('schema-mismatch', 'Local records need an explicit schema migration');
    }
    for (const entity of entities.values()) {
      if (!Array.isArray(state.entities[entity.id])) throw new RepositoryError('schema-mismatch', `Missing local entity ${entity.id}`);
      for (const record of state.entities[entity.id]) {
        validateRecord(entity, record);
        for (const field of entity.fields.filter((entry) => entry.type === 'photo')) {
          const photo = record[field.id];
          if (photo && (photo.sample || photo.uri.startsWith('https://'))) {
            try { validateSamplePhoto(photo, { recordId: record.id, field: field.id }); } catch (error) {
              throw new RepositoryError('media', 'Stored sample image provenance is invalid; explicit recovery is required', error);
            }
          }
        }
      }
    }
    // Fork on the first read as well as the first write. Later screen publication
    // cannot silently refresh a candidate from an active dataset that has changed.
    if (raw === null) await persist(state);
    for (const [entityId, rows] of transient) state.entities[entityId] = clone(rows);
    return state;
  };
  const persist = async (state) => {
    const durable = clone(state);
    for (const entityId of transient.keys()) durable.entities[entityId] = [];
    try { await storage.setItem(key, JSON.stringify(durable)); } catch (error) {
      throw new RepositoryError('storage', 'Local save failed; your change was not committed', error);
    }
    for (const entityId of transient.keys()) transient.set(entityId, clone(state.entities[entityId] || []));
  };
  const operationKey = (operationId) => {
    if (operationId === undefined) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(operationId)) throw new RepositoryError('validation', 'Invalid operation ID');
    return operationId;
  };
  const checkLinks = (state, entity, record) => {
    for (const field of entity.fields.filter((entry) => entry.type === 'lookup')) {
      const value = record[field.id];
      if (value && !state.entities[field.targetEntityId]?.some((entry) => entry.id === value)) {
        throw new RepositoryError('relationship', `${field.label} references a missing record`, { fieldId: field.id });
      }
    }
  };
  const checkMedia = async (entity, record, current) => {
    for (const field of entity.fields.filter((entry) => entry.type === 'photo')) {
      const value = record[field.id];
      if (value && (value.sample || value.uri.startsWith('https://'))) {
        try { validateSamplePhoto(value, { recordId: record.id, field: field.id }); } catch (error) {
          throw new RepositoryError('media', 'Use a canonical scenario image with its exact photo binding and provenance', error);
        }
        const canonical = fixtures.entities[entity.id]?.find((row) => row.id === record.id)?.[field.id];
        // Existing rows (including forked candidates) retain their original
        // provenance when canonical facts change. Never silently reseed them.
        if (!sameSamplePhoto(value, canonical) && !sameSamplePhoto(value, current?.[field.id])) {
          throw new RepositoryError('media', 'Sample images must come from this exact canonical record field');
        }
      } else if (value) {
        let info;
        try { info = await files.getInfoAsync(value.uri); } catch (error) {
          throw new RepositoryError('media', 'Could not verify captured photo', error);
        }
        if (!info.exists || info.isDirectory) throw new RepositoryError('media', 'Captured photo is no longer available');
      }
    }
  };
  const mutate = (entity, operation, id, values, options = {}) => locked(async () => {
    const state = await read();
    const receiptId = operationKey(options.operationId);
    const fingerprint = JSON.stringify([entity.id, operation, id ?? null, values ?? null]);
    if (receiptId && Object.prototype.hasOwnProperty.call(state.receipts, receiptId)) {
      const receipt = state.receipts[receiptId];
      if (receipt.fingerprint !== fingerprint) throw new RepositoryError('conflict', 'Operation ID was reused with different input');
      return clone(receipt.result);
    }
    const rows = state.entities[entity.id];
    const current = id ? rows.find((record) => record.id === id) : null;
    let result;
    if (operation === 'delete') {
      if (!current) throw new RepositoryError('not-found', 'Record no longer exists');
      for (const other of entities.values()) for (const field of other.fields.filter((entry) => entry.type === 'lookup' && entry.targetEntityId === entity.id)) {
        if (state.entities[other.id].some((record) => record[field.id] === id)) {
          throw new RepositoryError('relationship', `Record is still referenced by ${other.label}`);
        }
      }
      state.entities[entity.id] = rows.filter((record) => record.id !== id);
      result = null;
    } else {
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RepositoryError('validation', 'Expected record values');
      const input = operation === 'create' ? { ...values, id: values.id || randomUUID() } : values;
      result = prepareWrite(entity, current, input, operation, assertRules);
      if (operation === 'create' && rows.some((record) => record.id === result.id)) throw new RepositoryError('conflict', 'Record ID already exists');
      checkLinks(state, entity, result);
      await checkMedia(entity, result, current);
      state.entities[entity.id] = operation === 'create' ? [...rows, result] : rows.map((record) => record.id === id ? result : record);
    }
    if (receiptId) state.receipts[receiptId] = { fingerprint, result };
    await persist(state);
    for (const listener of listeners) listener(entity.id);
    return clone(result);
  });
  const repositories = {};
  for (const entity of entities.values()) {
    const allow = (operation) => {
      if (!entity.operations.includes(operation)) throw new RepositoryError('unsupported', `${entity.label} does not support ${operation}`);
    };
    repositories[entity.id] = {
      async list(query = {}) {
        allow('list');
        const normalized = validateQuery(entity, query);
        return locked(async () => queryRows((await read()).entities[entity.id], normalized));
      },
      async get(id) {
        allow('get');
        return locked(async () => clone((await read()).entities[entity.id].find((record) => record.id === id) || null));
      },
      async create(values, options) { allow('create'); return mutate(entity, 'create', null, values, options); },
      async update(id, values, options) { allow('update'); return mutate(entity, 'update', id, values, options); },
      async delete(id, options) { allow('delete'); await mutate(entity, 'delete', id, null, options); },
    };
  }
  return {
    namespace: key,
    repositories,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async importPhoto(input) {
      const inline = typeof input?.uri === 'string' && /^data:image\/(png|jpeg|webp);base64,/.exec(input.uri);
      const base64 = inline ? input.uri.slice(inline[0].length) : null;
      if (inline && (!base64 || base64.length > 14 * 1024 * 1024
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))) {
        throw new RepositoryError('media', 'Captured image data is invalid or exceeds the local import limit');
      }
      if (!input || (!inline && !/^(file:\/\/|content:\/\/)\S+$/.test(input.uri || ''))) throw new RepositoryError('media', 'Choose a captured local photo');
      if (inline && input.mimeType && input.mimeType !== `image/${inline[1]}`) throw new RepositoryError('media', 'Captured image MIME type does not match its data URI');
      if (inline && (typeof files.writeAsStringAsync !== 'function' || typeof files.readAsStringAsync !== 'function')) {
        throw new RepositoryError('unsupported', 'Persistent signature import is unavailable on this platform');
      }
      if (!mediaDirectory) throw new RepositoryError('unsupported', 'Persistent photo capture is unavailable on this platform');
      return locked(async () => {
        const state = await read();
        const receiptId = operationKey(input.operationId);
        const source = inline ? inline[0] : input.uri;
        if (receiptId && Object.prototype.hasOwnProperty.call(state.media, receiptId)) {
          const prior = state.media[receiptId];
          if (prior.source !== source) throw new RepositoryError('conflict', 'Photo operation ID was reused');
          if (inline) {
            let saved;
            try { saved = await files.readAsStringAsync(prior.reference.uri, { encoding: 'base64' }); } catch (error) {
              throw new RepositoryError('media', 'Previously persisted signature is unavailable', error);
            }
            if (saved !== base64) throw new RepositoryError('conflict', 'Photo operation ID was reused');
          }
          return clone(prior.reference);
        }
        const id = randomUUID();
        const uri = `${mediaDirectory}${encodeURIComponent(id)}`;
        try {
          if (!inline) {
            const capture = await files.getInfoAsync(input.uri);
            if (!capture.exists || capture.isDirectory) throw new Error('Capture is missing');
          }
          await files.makeDirectoryAsync(mediaDirectory, { intermediates: true });
          if (inline) await files.writeAsStringAsync(uri, base64, { encoding: 'base64' });
          else await files.copyAsync({ from: input.uri, to: uri });
          const saved = await files.getInfoAsync(uri);
          if (!saved.exists || saved.isDirectory) throw new Error('Photo copy failed');
        } catch (error) {
          await files.deleteAsync(uri, { idempotent: true }).catch(() => {});
          throw new RepositoryError('media', 'Photo could not be persisted; retry capture', error);
        }
        const mimeType = inline ? `image/${inline[1]}` : input.mimeType;
        const reference = { status: 'ready', id, uri, ...(mimeType ? { mimeType } : {}), ...(input.fileName ? { fileName: input.fileName } : {}) };
        if (receiptId) state.media[receiptId] = { source, reference };
        try { await persist(state); } catch (error) {
          await files.deleteAsync(uri, { idempotent: true }).catch(() => {});
          throw error;
        }
        return reference;
      });
    },
    async discardCandidate() {
      if (preview.previewKind !== 'candidate') throw new RepositoryError('unsupported', 'Only a candidate namespace can be discarded');
      return locked(async () => {
        // Shared references copied from active are never physically removed.
        if (mediaDirectory) await files.deleteAsync(mediaDirectory, { idempotent: true });
        await storage.removeItem(key);
      });
    },
  };
}

module.exports = { createLocalStore };

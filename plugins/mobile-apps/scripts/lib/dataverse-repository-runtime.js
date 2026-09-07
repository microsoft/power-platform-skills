'use strict';

function createDataverseRepositories({ domain, mapping, services, core, assertRules, storage, randomUUID, media, preview, localRepositories, candidateWritePermission = null }) {
  const { RepositoryError, prepareWrite, validateQuery } = core;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
  const fingerprintOf = (value) => JSON.stringify(canonical(value));
  // This is only a bounded storage key, not a trust/approval digest. Its full
  // input is persisted and compared, so a collision fails instead of replaying.
  const requestKey = (value) => {
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
    return hash.toString(16);
  };
  const entities = new Map(domain.entities.map((entity) => [entity.id, entity]));
  const guid = (value) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')) throw new RepositoryError('validation', 'Dataverse requires a real GUID record ID');
    return value;
  };
  const unwrap = (result, operation) => {
    if (!result || result.success !== true) {
      throw new RepositoryError('remote', `${operation} did not succeed`, result?.error);
    }
    return result.data;
  };
  const literal = (value, field) => {
    if (value === null) return 'null';
    if (field.type === 'choice') {
      if (field.choiceMap[value] === undefined) throw new RepositoryError('validation', 'Unknown choice ID');
      return String(field.choiceMap[value]);
    }
    if (field.type === 'lookup' || field.fieldId === 'id') return guid(value);
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (field.type === 'datetime') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  };
  const queuesKey = Symbol.for('power-apps.mobile.dataverse.write-queues.v1');
  const queues = globalThis[queuesKey] || (globalThis[queuesKey] = new Map());
  const journalPrefix = `mobile-real:${domain.appInstanceId}:v${domain.schemaVersionNumber}:${mapping.environmentKey}:`;
  const testPermission = () => {
    if (preview.previewKind !== 'candidate') return null;
    const permission = candidateWritePermission;
    if (!permission) throw new RepositoryError('approval-required', 'Connected preview is read-only. Real-data test writes need separate explicit approval.');
    if (permission.schemaVersion !== 1 || permission.appInstanceId !== domain.appInstanceId
      || permission.mappingRevision !== mapping.mappingRevision || permission.environmentKey !== mapping.environmentKey
      || permission.permissionId !== permission.scopeId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(permission.permissionId || '')
      || !Number.isFinite(Date.parse(permission.expiresAt)) || Date.parse(permission.expiresAt) <= Date.now()
      || !Array.isArray(permission.records) || !permission.records.length || permission.records.length > 10) {
      throw new RepositoryError('approval-required', 'Controlled test-write permission is expired or does not match this app/mapping');
    }
    return permission;
  };
  const scopeWrite = async (permission, entry, operation, requestedId, operationId) => {
    const key = `${journalPrefix}test-scope:${permission.permissionId}`;
    const raw = await storage.getItem(key);
    const ledger = raw === null ? { scopeRevision: permission.scopeRevision, records: {} } : JSON.parse(raw);
    if (ledger.scopeRevision !== permission.scopeRevision) throw new RepositoryError('approval-required', 'A test scope cannot change its approved records');
    const allowed = permission.records.filter((record) => record.entityId === entry.entityId && record.operations.includes(operation));
    const target = requestedId ? allowed.find((record) => record.recordId === requestedId)
      : allowed.find((record) => !ledger.records[record.recordId] || ledger.records[record.recordId].operationId === operationId);
    if (!target) throw new RepositoryError('approval-required', 'The approved disposable test-record scope is exhausted or does not allow this record');
    guid(target.recordId);
    const prior = ledger.records[target.recordId];
    if (operation === 'create' ? prior && prior.operationId !== operationId : prior?.state !== 'created') {
      throw new RepositoryError('approval-required', 'Only records created by this approved test scope may be changed');
    }
    return { key, ledger, recordId: target.recordId };
  };
  const completeScope = async (journal) => {
    if (!journal.testPermissionKey) return;
    if (journal.state !== 'complete') throw new RepositoryError('storage', 'Test-record ownership requires a verified completed operation');
    if (!journal.testPermissionKey.startsWith(`${journalPrefix}test-scope:`)) throw new RepositoryError('storage', 'Invalid test-write journal binding');
    const raw = await storage.getItem(journal.testPermissionKey);
    const ledger = raw === null ? null : JSON.parse(raw);
    if (!ledger?.records[journal.recordId]) throw new RepositoryError('storage', 'Controlled test-write ownership ledger is missing');
    if (journal.operation === 'create') ledger.records[journal.recordId].state = 'created';
    if (journal.operation === 'delete') ledger.records[journal.recordId].state = 'deleted';
    await storage.setItem(journal.testPermissionKey, JSON.stringify(ledger));
  };
  const locked = (key, work) => {
    const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, next);
    return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  };
  const repositories = { ...localRepositories };
  for (const entry of mapping.entities) {
    if (entry.owner !== 'dataverse') {
      if (!repositories[entry.entityId]) throw new RepositoryError('unsupported', `Existing adapter is missing for ${entry.entityId}`);
      if (entry.owner.startsWith('connector:')) {
        const repository = repositories[entry.entityId];
        const entity = entities.get(entry.entityId);
        const guard = (operation) => {
          if (!entity.operations.includes(operation)) throw new RepositoryError('unsupported', `Operation ${operation} is not declared for ${entity.id}`);
          if (preview.previewKind === 'candidate') {
            throw new RepositoryError('approval-required', 'Real connector writes need separate explicit approval');
          }
        };
        repositories[entry.entityId] = {
          ...repository,
          list: (query) => repository.list(query),
          get: (id) => repository.get(id),
          async create(values, options) {
            guard('create');
            return repository.create(prepareWrite(entity, null, values, 'create', assertRules), options);
          },
          async update(id, patch, options) {
            guard('update');
            const record = prepareWrite(entity, await repository.get(id), patch, 'update', assertRules);
            const { id: storedId, ...values } = record;
            return repository.update(id, values, options);
          },
          async delete(id, options) { guard('delete'); await repository.delete(id, options); },
        };
      }
      continue;
    }
    const entity = entities.get(entry.entityId);
    const service = services[entry.entityId];
    const select = [entry.primaryId, ...entry.fields.map((field) => field.readColumn)];
    const mapRow = async (row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new RepositoryError('remote-shape', 'Service did not return a record');
      const result = { id: guid(row[entry.primaryId]) };
      for (const field of entry.fields) {
        const value = row[field.readColumn];
        if (value === undefined || value === null) { result[field.fieldId] = null; continue; }
        if (field.type === 'choice') {
          const matched = Object.entries(field.choiceMap).find(([, numeric]) => numeric === value);
          if (!matched) throw new RepositoryError('mapping', `Unknown Dataverse choice value in ${field.fieldId}`);
          result[field.fieldId] = matched[0];
        } else if (field.type === 'photo') {
          result[field.fieldId] = await media.fromBase64(entry.entityId, result.id, field.fieldId, value, field.maxSizeInKB);
        } else result[field.fieldId] = value;
      }
      return result;
    };
    const get = async (id) => {
      let response;
      try { response = await service.get(guid(id), { select }); } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
      if (response?.success === false && response.error?.status === 404) return null;
      const data = unwrap(response, 'Read');
      return data === null ? null : mapRow(data);
    };
    const payload = async (record, prior = null) => {
      const result = {};
      for (const field of entry.fields) {
        const value = record[field.fieldId];
        if (value === undefined) continue;
        // The same stored reference is not reuploaded by unrelated taught rules
        // or edits. An explicit null is an explicit approved evidence removal.
        if (prior && JSON.stringify(value) === JSON.stringify(prior[field.fieldId])) continue;
        if (field.type === 'lookup') {
          result[`${field.navigationProperty}@odata.bind`] = value === null ? null : `/${field.targetEntitySet}(${guid(value)})`;
        } else if (field.type === 'choice') {
          result[field.column] = value === null ? null : field.choiceMap[value];
        } else if (field.type === 'photo') {
          result[field.column] = value === null ? null : await media.toBase64(value, field.maxSizeInKB);
        } else result[field.column] = value;
      }
      return result;
    };
    const write = async (operation, id, input, options = {}) => {
      const permission = testPermission();
      if (options.operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(options.operationId)) {
        return Promise.reject(new RepositoryError('validation', 'Invalid stable operationId'));
      }
      return locked(journalPrefix, async () => {
        const fingerprint = fingerprintOf([operation, id ?? null, input ?? null]);
        const pendingKey = options.operationId === undefined
          ? `${journalPrefix}${entry.entityId}:pending:${requestKey(fingerprint)}` : null;
        let operationId = options.operationId;
        if (pendingKey) {
          const pendingRaw = await storage.getItem(pendingKey);
          const pending = pendingRaw === null ? { operationId: randomUUID(), fingerprint } : JSON.parse(pendingRaw);
          if (pending.fingerprint !== fingerprint) throw new RepositoryError('conflict', 'Pending request-key collision; supply a distinct operationId');
          operationId = pending.operationId;
          await storage.setItem(pendingKey, JSON.stringify(pending));
        }
        const key = `${journalPrefix}${entry.entityId}:${operationId}`;
        const raw = await storage.getItem(key);
        const journal = raw === null ? { state: 'prepared', operation, fingerprint, recordId: id || null } : JSON.parse(raw);
        if (journal.fingerprint !== fingerprint) throw new RepositoryError('conflict', 'Operation ID was reused with different input');
        if (journal.state === 'complete') {
          await completeScope(journal);
          if (pendingKey) await storage.removeItem(pendingKey);
          return clone(journal.result);
        }
        if (journal.state === 'in-flight') {
          // A network exception cannot tell whether Dataverse committed. Never
          // blindly replay it, especially a create/delete; reconcile explicitly.
          throw new RepositoryError('uncertain-write', 'A prior write may have committed. Reconcile this operation before retrying.', { operationId, recordId: journal.recordId });
        }
        const scoped = permission ? await scopeWrite(permission, entry, operation, journal.recordId, operationId) : null;
        journal.recordId = scoped?.recordId || journal.recordId || randomUUID();
        const prior = operation === 'create' ? null : await get(journal.recordId);
        const record = operation === 'delete' ? null
          : prepareWrite(entity, prior, { ...input, id: journal.recordId }, operation, assertRules);
        if (operation === 'delete' && !prior) throw new RepositoryError('not-found', 'Record no longer exists');
        if (scoped && operation === 'create' && await get(journal.recordId)) {
          throw new RepositoryError('approval-required', 'A disposable test ID already exists; existing live records will not be overwritten');
        }
        const data = record ? await payload(record, prior) : null;
        for (const field of entry.fields.filter((field) => field.type === 'photo')) {
          if (data?.[field.column]) {
            // Keep immutable remote-operation evidence outside the discardable
            // local-candidate capture directory before a remote write starts.
            record[field.fieldId] = await media.fromBase64(entry.entityId, journal.recordId, field.fieldId, data[field.column], field.maxSizeInKB);
          }
        }
        journal.expected = record;
        journal.previous = prior;
        if (scoped) {
          journal.testPermissionKey = scoped.key;
          if (operation === 'create') scoped.ledger.records[journal.recordId] = { entityId: entry.entityId, operationId, state: 'in-flight' };
          await storage.setItem(scoped.key, JSON.stringify(scoped.ledger));
        }
        journal.state = 'in-flight';
        await storage.setItem(key, JSON.stringify(journal));
        const response = operation === 'create'
          ? await service.create({ ...data, [entry.primaryId]: guid(journal.recordId) })
          : operation === 'update' ? await service.update(guid(journal.recordId), data) : await service.delete(guid(journal.recordId));
        unwrap(response, operation);
        // A successful 204 create is not a returned record. Keep the journal
        // uncertain until the exact ID is refetched and decoded successfully.
        const result = operation === 'delete' ? null : await get(journal.recordId);
        if (operation !== 'delete' && !result) throw new RepositoryError('remote-shape', 'Committed record could not be read back');
        journal.state = 'complete';
        journal.result = result;
        await storage.setItem(key, JSON.stringify(journal));
        await completeScope(journal);
        if (pendingKey) await storage.removeItem(pendingKey);
        return clone(result);
      });
    };
    const allow = (operation) => {
      if (!entry.operations.includes(operation)) throw new RepositoryError('unsupported', `Operation ${operation} is not declared for ${entity.id}`);
    };
    repositories[entry.entityId] = {
      async list(input = {}) {
        allow('list');
        const query = validateQuery(entity, input);
        const fieldFor = (id) => id === 'id' ? { fieldId: 'id', readColumn: entry.primaryId, type: 'text' }
          : entry.fields.find((field) => field.fieldId === id);
        const expressions = query.where.map(({ fieldId, operator, value }) => {
          const field = fieldFor(fieldId);
          const column = field.readColumn;
          if (operator === 'contains') return `contains(${column},${literal(value, field)})`;
          if (operator === 'in') return `(${value.map((item) => `${column} eq ${literal(item, field)}`).join(' or ')})`;
          return `${column} ${{ equals: 'eq', 'not-equals': 'ne', gte: 'ge', lte: 'le' }[operator]} ${literal(value, field)}`;
        });
        const orderBy = query.orderBy.map((order) => `${fieldFor(order.fieldId).readColumn} ${order.direction}`);
        if (!query.orderBy.some((order) => order.fieldId === 'id')) orderBy.push(`${entry.primaryId} asc`);
        const result = await service.getAll({
          select, orderBy, maxPageSize: query.pageSize,
          ...(expressions.length ? { filter: expressions.join(' and ') } : {}),
          ...(query.cursor ? { skipToken: query.cursor } : {}),
        });
        const rows = unwrap(result, 'List');
        if (!Array.isArray(rows)) throw new RepositoryError('remote-shape', 'getAll did not return the SDK data array');
        return { items: await Promise.all(rows.map(mapRow)), ...(result.skipToken ? { nextCursor: result.skipToken } : {}) };
      },
      async get(id) { allow('get'); return get(id); },
      async create(values, options) {
        allow('create');
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RepositoryError('validation', 'Expected record values');
        return write('create', values.id, values, options);
      },
      async update(id, patch, options) { allow('update'); return write('update', id, patch, options); },
      async delete(id, options) { allow('delete'); await write('delete', id, null, options); },
      async reconcileWrite(operationId) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(operationId || '')) throw new RepositoryError('validation', 'Invalid operation ID');
        const key = `${journalPrefix}${entry.entityId}:${operationId}`;
        return locked(journalPrefix, async () => {
          const raw = await storage.getItem(key);
          if (raw === null) throw new RepositoryError('not-found', 'Operation journal is missing');
          const journal = JSON.parse(raw);
          if (journal.state === 'complete') {
            await completeScope(journal);
            return { status: 'committed', recordId: journal.recordId };
          }
          if (journal.state !== 'in-flight') return { status: 'not-committed', recordId: journal.recordId };
          const current = await get(journal.recordId);
          const equal = async (left, right) => {
            if (!left || !right) return left === right;
            // Compare decoded domain values, including photo bytes, rather than
            // assuming two different device cache URIs mean different evidence.
            const normalized = (record) => Object.fromEntries(entry.fields.map((field) => [
              field.fieldId, field.type === 'text' && record[field.fieldId] === '' ? null : record[field.fieldId] ?? null,
            ]));
            return JSON.stringify(await payload(normalized(left))) === JSON.stringify(await payload(normalized(right)));
          };
          if ((journal.operation === 'delete' && current === null)
            || (journal.operation !== 'delete' && await equal(current, journal.expected))) {
            journal.state = 'complete';
            journal.result = current;
            await storage.setItem(key, JSON.stringify(journal));
            await completeScope(journal);
            return { status: 'committed', recordId: journal.recordId };
          }
          if ((journal.operation === 'create' && current === null)
            || (journal.operation !== 'create' && await equal(current, journal.previous))) {
            journal.state = 'prepared';
            await storage.setItem(key, JSON.stringify(journal));
            return { status: 'not-committed', recordId: journal.recordId };
          }
          return { status: 'conflict', recordId: journal.recordId };
        });
      },
    };
  }
  return repositories;
}

module.exports = { createDataverseRepositories };

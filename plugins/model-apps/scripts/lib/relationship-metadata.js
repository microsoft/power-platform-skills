'use strict';
// Narrow relationship metadata reads shared by the build and by verify.
//
// These selects are scalars only — no DisplayName / LocalizedLabels — so they do not trip the
// broad-read → labelled-create hazard documented on relationshipExists (AB#6686428). A label-bearing
// read immediately before createRelationship makes Dataverse keep only the base-language label.
//
// Live response shapes (measured; names shown with a contoso placeholder):
//   GET RelationshipDefinitions(SchemaName='contoso_project_contoso_task')?$select=SchemaName,RelationshipType
//   → 200 {"@odata.type":"#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
//          "SchemaName":"contoso_project_contoso_task","RelationshipType":"OneToManyRelationship"}
//   N:N uses ManyToManyRelationshipMetadata / RelationshipType "ManyToManyRelationship".
//   Cast …/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute → 200
//   Cast …/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$select=SchemaName,Entity1LogicalName,Entity2LogicalName → 200
//   Unknown name → 404 {"error":{"code":"0x80060888","message":"RelationshipMetadataBase With Id = SchemaName='…' does not exist."}}
//   Wrong cast → 404 {"error":{"code":"0x80060888","message":"OneToManyRelationshipMetadata With Id = SchemaName='…' does not exist."}}
//   The SchemaName alternate key is CASE-SENSITIVE: a differently-cased spelling of an existing name is a 404.
//   A derived property in $select without the matching cast → 400, which is why each collection select
//   below omits the entity the collection is already scoped to and the caller stamps that end.
// Some Web API surfaces capitalize the error envelope as "Error", so both spellings are read.
//
// An N:N is read with three properties more than the three measured above — IntersectEntityName, Entity1IntersectAttribute and Entity2IntersectAttribute —
// because its identity is not its two tables: it is the table that holds the links and the column each table has in it (MANY_TO_MANY_SELECT).
// They are documented properties of ManyToManyRelationshipMetadata, in the collection and in the cast alike, and are read here like the others (scalars):
//   …/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName,Entity1IntersectAttribute,Entity2IntersectAttribute → 200
//   {"value":[{"SchemaName":"contoso_project_contoso_task","Entity1LogicalName":"contoso_project","Entity2LogicalName":"contoso_task",
//              "IntersectEntityName":"contoso_project_task_links","Entity1IntersectAttribute":"contoso_projectid","Entity2IntersectAttribute":"contoso_taskid"}]}
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/manytomanyrelationshipmetadata
// (documented, not yet measured live.)

const { odataLit } = require('./odata.js');

// The properties that say which N:N a row is. The name and the two tables alone do not say it: the create names the intersect table too — `relationships[].intersectEntityName`,
// or the lower-cased schema name when the spec names none — so a relationship under the same name and tables with another intersect table is not the one the spec asked
// for. The two columns are the key each table has in the intersect table (typically `<table>id`).
const MANY_TO_MANY_SELECT = 'SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName,Entity1IntersectAttribute,Entity2IntersectAttribute';

const COLLECTION = {
  OneToMany: {
    segment: 'OneToManyRelationships',
    select: 'SchemaName,ReferencingEntity,ReferencingAttribute',
  },
  ManyToOne: {
    segment: 'ManyToOneRelationships',
    select: 'SchemaName,ReferencedEntity,ReferencingAttribute',
  },
  ManyToMany: {
    segment: 'ManyToManyRelationships',
    select: MANY_TO_MANY_SELECT,
  },
};

// The lookup-details read of a table's ManyToOne relationships (scripts/get-lookup-metadata.js, lib/lookup-metadata.js): the
// default select plus the two scalars that say how a page reaches each target of a lookup — the target's key and the
// navigation property of the referencing table. Still scalars only (no DisplayName / LocalizedLabels), and still no derived
// ReferencingEntity (the collection is scoped to it; selecting it without a cast is a 400):
//   GET /EntityDefinitions(LogicalName='opportunity')/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute,
//       ReferencedAttribute,ReferencingEntityNavigationPropertyName
//   → 200 { "value": [ { "SchemaName": "opportunity_customer_accounts", "ReferencedEntity": "account", "ReferencingAttribute": "customerid",
//            "ReferencedAttribute": "accountid", "ReferencingEntityNavigationPropertyName": "customerid_account" }, … ],
//           "@odata.nextLink": "…" (when the platform pages the answer) }
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/onetomanyrelationshipmetadata
// The SDK's fetchEntityMetadata projection keeps ReferencedEntity and ReferencedAttribute of these rows but neither the source
// lookup column nor the navigation property, so this supplemental read exists; an SDK projection that carried both would retire it.
const LOOKUP_DETAILS_SELECT = 'SchemaName,ReferencedEntity,ReferencingAttribute,ReferencedAttribute,ReferencingEntityNavigationPropertyName';

function lc(v) {
  return String(v || '').toLowerCase();
}

function errorMessage(res) {
  const body = res && res.body;
  const envelope = body && typeof body === 'object' && (body.error || body.Error);
  if (envelope && envelope.message) return String(envelope.message);
  if (res && res.thrown) return String((res.thrown && res.thrown.message) || res.thrown);
  return `HTTP ${res && res.status}`;
}

// A failed read is reported by value — `{ ok: false, status, error }`, `{ found: null, status, error }` — and the halt the relationship step raises around it (lib/entity-provision.js) hands the
// service's code to the build's retry, as the SDK's ConnectionError does (lib/retry-policy.js, serviceFailure's `answered`). So the OData `error` of the answer rides along:
//   HTTP 500  { "error": { "code": "0x80044151", "message": "SQL timeout expired." } }
// on the result as `answered`, NOT enumerable, so a result prints, caches and compares as it did; only an `error` that is an object is one, and the rule reads nothing of it but its code and message.
function withAnswer(result, answered) {
  if (answered && typeof answered === 'object' && !Array.isArray(answered)) Object.defineProperty(result, 'answered', { value: answered, enumerable: false });
  return result;
}
const answeredOf = (res) => (res && res.body && typeof res.body === 'object' ? res.body.error : undefined);

async function get(client, path) {
  if (!client || typeof client.get !== 'function') {
    return { status: 0, body: null, thrown: new Error('no metadata client') };
  }
  try {
    const res = await client.get(path);
    return res || { status: 0, body: null };
  } catch (err) {
    return { status: (err && (err.statusCode || err.status)) || 0, body: null, thrown: err };
  }
}

// What a read of an N:N states of the table that holds its links and the column each table has in it. Absent (or empty) is kept as it came: it is what
// compareRelationship reads as "not stated". The two spellings are the Web API's (`IntersectEntityName`) and the normalized holder's.
function intersectOf(raw) {
  return {
    intersectEntityName: raw && (raw.IntersectEntityName || raw.intersectEntityName),
    entity1IntersectAttribute: raw && (raw.Entity1IntersectAttribute || raw.entity1IntersectAttribute),
    entity2IntersectAttribute: raw && (raw.Entity2IntersectAttribute || raw.entity2IntersectAttribute),
  };
}

function mapCollectionRow(raw, kind, entityLogical) {
  const schemaName = raw && (raw.SchemaName || raw.schemaName);
  if (kind === 'ManyToMany') {
    return {
      schemaName,
      type: 'ManyToMany',
      entity1: raw && (raw.Entity1LogicalName || raw.entity1),
      entity2: raw && (raw.Entity2LogicalName || raw.entity2),
      ...intersectOf(raw),
    };
  }
  if (kind === 'ManyToOne') {
    // The collection is already the referencing table. Selecting ReferencingEntity here is a derived
    // property without a cast and 400s, so stamp the entity this read was scoped to.
    return {
      schemaName,
      type: 'OneToMany',
      referencedEntity: raw && (raw.ReferencedEntity || raw.referencedEntity),
      referencingEntity: entityLogical,
      referencingAttribute: raw && (raw.ReferencingAttribute || raw.referencingAttribute),
    };
  }
  return {
    schemaName,
    type: 'OneToMany',
    referencedEntity: entityLogical,
    referencingEntity: raw && (raw.ReferencingEntity || raw.referencingEntity),
    referencingAttribute: raw && (raw.ReferencingAttribute || raw.referencingAttribute),
  };
}

async function readRelationshipsOf(client, entityLogical, kind, cache, options) {
  const spec = COLLECTION[kind];
  if (!spec) return { ok: false, status: 0, error: `unknown relationship kind '${kind}'` };
  if (options && options.lookupDetails) {
    if (kind !== 'ManyToOne') return { ok: false, status: 0, error: `lookup details are read from ManyToOne relationships, not '${kind}'` };
    return readLookupDetails(client, lc(entityLogical), cache);
  }
  const logical = lc(entityLogical);
  // A plan probes many relationships on the same tables. Keyed by table and kind so the typed
  // probe and the case-insensitive fallback share one read.
  const cacheKey = cache && (logical + '|' + kind);
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const path = `/EntityDefinitions(LogicalName='${odataLit(logical)}')/${spec.segment}?$select=${spec.select}`;
  const res = await get(client, path);
  const finish = (result) => {
    if (cacheKey) cache.set(cacheKey, result);
    return result;
  };
  if (res.status === 404) return finish({ ok: true, rows: [], tableMissing: true });
  if (!res.status || res.status < 200 || res.status >= 300) {
    return finish(withAnswer({ ok: false, status: res.status, error: errorMessage(res) }, answeredOf(res)));
  }
  // A collection read is `{ "value": [ ... ] }`, and an empty collection is `"value": []`. A 200
  // whose body is not that shape (a table read that happened to share the URL prefix, a truncated
  // body) is not "this table has no relationships" — reporting it as empty would skip the
  // fetchEntityMetadata fallback and recreate a relationship that already exists.
  const value = res.body && res.body.value;
  if (!Array.isArray(value)) return finish({ ok: false, status: res.status, error: 'relationship collection response had no value array' });
  return finish({ ok: true, rows: value.filter(Boolean).map((raw) => mapCollectionRow(raw, kind, logical)) });
}

// readRelationshipsOf's lookup-details mode, for lookup discovery only. Differences from the default read, each deliberate:
//   - every page of the collection is read (lib/app-components.js collectionRows: absolute continuations through getAbsolute, a
//     repeated or malformed link and a failed or malformed page refused), because a lookup's candidate paths are proven complete
//     only by the whole answer — one failed page fails the read, never a shorter list;
//   - a 404 for the table is a FAILURE (`tableMissing: true` beside `ok: false`): the default read's "no such table, no
//     relationships" answer would let discovery report a lookup with no targets;
//   - every row must state the two added scalars, as non-empty strings: a service that omitted them would otherwise shrink the
//     candidate paths silently;
//   - its own cache key (`|lookup-details`), so a cached default read can never answer as a detailed one, or the reverse.
// The answer is converted here as the default read's is: the service's own message from either envelope (`error` or `Error`),
// its OData error riding along as `answered`.
async function readLookupDetails(client, logical, cache) {
  const cacheKey = cache && `${logical}|ManyToOne|lookup-details`;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const finish = (result) => {
    if (cacheKey) cache.set(cacheKey, result);
    return result;
  };
  // Required here rather than at the top: only lookup discovery pages a relationship collection, and the default read's callers
  // (the build, verify) need not load the app-component readers for it.
  const { collectionRows } = require('./app-components.js');
  // The last answer collectionRows was given, so a refusal is reported in the platform's words (both envelopes) and with its code.
  let last = null;
  const settle = async (request) => {
    try {
      last = (await request()) || { status: 0, body: null };
    } catch (err) {
      last = { status: (err && (err.statusCode || err.status)) || 0, body: null, thrown: err };
    }
    return last;
  };
  const recording = {
    get: (p) => settle(() => (client && typeof client.get === 'function' ? client.get(p) : Promise.reject(new Error('no metadata client')))),
    ...(client && typeof client.getAbsolute === 'function' ? { getAbsolute: (url) => settle(() => client.getAbsolute(url)) } : {}),
    ...(client && typeof client.apiUrl === 'function' ? { apiUrl: (p) => client.apiUrl(p) } : {}),
  };
  const path = `/EntityDefinitions(LogicalName='${odataLit(logical)}')/${COLLECTION.ManyToOne.segment}?$select=${LOOKUP_DETAILS_SELECT}`;
  let rows;
  try {
    rows = await collectionRows(recording, path, `the ManyToOne relationships of ${logical}`, { code: 'LOOKUP_RELATIONSHIPS_UNREADABLE' });
  } catch (err) {
    const refused = last && (last.thrown || !last.status || last.status < 200 || last.status >= 300);
    const status = last ? last.status : 0;
    const result = withAnswer({ ok: false, status, error: refused ? errorMessage(last) : String((err && err.message) || err) }, refused ? answeredOf(last) : undefined);
    if (status === 404) result.tableMissing = true;
    return finish(result);
  }
  const mapped = [];
  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const missing = ['SchemaName', 'ReferencedEntity', 'ReferencingAttribute', 'ReferencedAttribute', 'ReferencingEntityNavigationPropertyName']
      .filter((field) => typeof row[field] !== 'string' || !row[field]);
    if (missing.length) {
      return finish({ ok: false, status: last ? last.status : 200, error: `a ManyToOne relationship of ${logical} (${row.SchemaName || 'unnamed'}) does not state ${missing.join(', ')}` });
    }
    mapped.push({
      ...mapCollectionRow(row, 'ManyToOne', logical),
      referencedAttribute: row.ReferencedAttribute,
      navigationProperty: row.ReferencingEntityNavigationPropertyName,
    });
  }
  return finish({ ok: true, rows: mapped });
}

function castKind(body) {
  const type = String((body && body.RelationshipType) || '');
  const odata = String((body && body['@odata.type']) || '');
  if (type === 'ManyToManyRelationship' || odata.indexOf('ManyToManyRelationship') !== -1) return 'ManyToMany';
  if (type === 'OneToManyRelationship' || odata.indexOf('OneToManyRelationship') !== -1) return 'OneToMany';
  return null;
}

function holderFromCast(body, kind) {
  // The body is taken as it is. A 200 that carries none of the selected properties (`{}`) gives a holder with nothing stated:
  // the name is known to be held, and nothing about whose it is — which compareRelationship reads as unproven, never as the declared one.
  if (kind === 'ManyToMany') {
    return {
      schemaName: body && body.SchemaName,
      type: 'ManyToMany',
      entity1: body && body.Entity1LogicalName,
      entity2: body && body.Entity2LogicalName,
      ...intersectOf(body),
    };
  }
  return {
    schemaName: body && body.SchemaName,
    type: 'OneToMany',
    referencedEntity: body && body.ReferencedEntity,
    referencingEntity: body && body.ReferencingEntity,
    referencingAttribute: body && body.ReferencingAttribute,
  };
}

async function readExact(client, schemaName) {
  const key = `/RelationshipDefinitions(SchemaName='${odataLit(schemaName)}')`;
  const base = await get(client, `${key}?$select=SchemaName,RelationshipType`);
  if (base.status === 404) return { found: false };
  if (!base.status || base.status < 200 || base.status >= 300) {
    return withAnswer({ found: null, status: base.status, error: errorMessage(base) }, answeredOf(base));
  }
  const kind = castKind(base.body);
  if (!kind) return { found: null, status: base.status, error: 'relationship type was not in the base read' };
  const select = kind === 'ManyToMany'
    ? MANY_TO_MANY_SELECT
    : 'SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute';
  const castName = kind === 'ManyToMany' ? 'ManyToManyRelationshipMetadata' : 'OneToManyRelationshipMetadata';
  const cast = await get(client, `${key}/Microsoft.Dynamics.CRM.${castName}?$select=${select}`);
  if (!cast.status || cast.status < 200 || cast.status >= 300) {
    // The name exists (the base read succeeded). A failed cast means we could not read the
    // endpoints, not that the name is free — do not report found:false.
    return withAnswer({ found: null, status: cast.status, error: errorMessage(cast) }, answeredOf(cast));
  }
  return { found: true, holder: holderFromCast(cast.body, kind) };
}

async function findRelationshipHolder(client, schemaName, opts) {
  const candidates = (opts && opts.candidates) || [];
  if (!schemaName) return { found: false };
  if (!client || typeof client.get !== 'function') {
    return { found: null, error: 'no metadata client' };
  }
  // The plan already 404'd the exact spelling. skipExact avoids a second identical read.
  if (!(opts && opts.skipExact)) {
    const exact = await readExact(client, schemaName);
    // 404 is the only "this spelling is absent" answer. 429/500 must not fall through to a search
    // that could then report the name free.
    if (exact.found !== false) return exact;
  }
  const want = lc(schemaName);
  const seen = new Set();
  let failed = null;
  for (const entity of candidates) {
    const logical = lc(entity);
    if (!logical || seen.has(logical)) continue;
    seen.add(logical);
    for (const kind of ['OneToMany', 'ManyToOne', 'ManyToMany']) {
      const read = await readRelationshipsOf(client, logical, kind, opts && opts.cache);
      if (!read.ok) {
        failed = read;
        continue;
      }
      const hit = (read.rows || []).find((r) => lc(r && r.schemaName) === want);
      if (hit) return { found: true, holder: hit };
    }
  }
  if (failed) return withAnswer({ found: null, status: failed.status, error: failed.error }, failed.answered);
  return { found: false };
}

// The SDK fetchEntityMetadata projection is not the Web API row. OneToMany carries the lookup
// (relatedAttribute = ReferencingAttribute). ManyToOne carries the parent's primary key
// (relatedAttribute = ReferencedAttribute) — treating that as the lookup makes a self-reference
// look like a different relationship. Prefer OneToMany, then ManyToMany, among same-name rows.
function projectionRank(type) {
  if (type === 'OneToMany') return 0;
  if (type === 'ManyToMany') return 1;
  if (type === 'ManyToOne') return 2;
  return 3;
}

function pickProjectionRow(rows, schemaName) {
  const want = lc(schemaName);
  const hits = (rows || []).filter((r) => r && lc(r.schemaName) === want);
  hits.sort((a, b) => projectionRank(a.type) - projectionRank(b.type));
  return hits[0] || null;
}

function projectionHolder(row, probedEntity) {
  const probed = lc(probedEntity);
  if (!row) return null;
  // A row with no type (a test double that lists names) says nothing of its ends. Inventing OneToMany
  // ends from the probed entity made that row a false conflict, so only its name is kept — which
  // compareRelationship reads as unproven, neither the declared relationship nor another's. The
  // vendored projection always sets type.
  if (row.type !== 'OneToMany' && row.type !== 'ManyToOne' && row.type !== 'ManyToMany') {
    return { schemaName: row.schemaName };
  }
  if (row.type === 'ManyToMany') {
    // The projection lists an N:N as { schemaName, type: 'ManyToMany', relatedEntity: <the other table>, relatedAttribute: '' }: nothing of its
    // intersect table or of the column each table has in it. So its holder states neither, and compareRelationship reads it as unproven: the
    // projection can say an N:N of this name exists, never that it is the declared one.
    return { schemaName: row.schemaName, type: 'ManyToMany', entity1: probed, entity2: row.relatedEntity };
  }
  if (row.type === 'ManyToOne') {
    // relatedAttribute is the parent's primary key, not the lookup. Leave it off so a compare
    // cannot treat the key as a conflicting lookup attribute.
    return { schemaName: row.schemaName, type: 'OneToMany', referencedEntity: row.relatedEntity, referencingEntity: probed };
  }
  return {
    schemaName: row.schemaName,
    type: 'OneToMany',
    referencedEntity: probed,
    referencingEntity: row.relatedEntity,
    referencingAttribute: row.relatedAttribute,
  };
}

function kindOf(r) {
  const t = lc(r && (r.type || r.RelationshipType));
  if (t === 'manytomany' || t === 'manytomanyrelationship' || t === 'n:n' || t === 'nn') return 'nn';
  if (t === 'onetomany' || t === 'onetomanyrelationship' || t === 'manytoone' || t === '1:n' || t === '1n') return '1n';
  if (r && (r.entity1 || r.entity2 || r.Entity1LogicalName || r.entity1LogicalName)) return 'nn';
  if (r && (r.referenced || r.referencing || r.referencedEntity || r.lookup)) return '1n';
  return '';
}

// Two pairs of table names are the same pair whichever order they are written in.
function sameTables(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x[0] === y[0] && x[1] === y[1];
}

// Is this holder — what the environment says a schema name belongs to — the relationship the spec declares?
//
//   { state: 'same',       missing: [] }       every part of its identity is stated, and equals the declaration
//   { state: 'different',  missing: [] }       a part it states contradicts the declaration, whatever else it states or leaves out
//   { state: 'incomplete', missing: [parts] }  nothing it states contradicts, but it does not state every part
//
// The identity of a relationship is its schema name, its type and its two tables, and for a 1:N the lookup column, for an N:N the intersect
// table and the column each table has in it. The holder has to STATE all of them: a part that is absent from a successful answer (a
// collection row without its ReferencingAttribute, a typed read that answers 200 with `{}`, the empty string the vendored SDK's
// projection writes for a value it lacked) is a part nobody checked.
// Reading "absent" as "nothing contradicts" certified a relationship on its name alone — the build skipped the create of a
// relationship it could not identify, and verify passed it — and the name is the one thing a different relationship can share: a 1:N
// and an N:N between the same two tables derive the same one, and two lookups of a self-reference differ only in the column.
// So an incomplete holder is UNPROVEN: neither reused nor refused as another's, but looked at again, and reported as it is.
//
// The declaration is compared on the parts it states (the build's and verify's declared relationships always state all of them, except
// the intersect table of an N:N, which a spec may leave to the platform — see below).
function compareRelationship(declared, holder) {
  const d = declared && typeof declared === 'object' ? declared : {};
  const h = holder && typeof holder === 'object' ? holder : {};
  const missing = [];
  let differs = false;
  const part = (label, stated, declaredValue) => {
    if (!stated) missing.push(label);
    else if (declaredValue && stated !== declaredValue) differs = true;
  };
  part('schema name', lc(h.schemaName || h.SchemaName), lc(d.schemaName || d.effectiveName));
  const dKind = kindOf(d);
  const hKind = kindOf(h);
  if (dKind && hKind && dKind !== hKind) differs = true;
  if (!hKind) missing.push('relationship type');
  if ((dKind || hKind) === 'nn') {
    const e1 = h.entity1 || h.Entity1LogicalName || h.entity1LogicalName;
    const e2 = h.entity2 || h.Entity2LogicalName || h.entity2LogicalName;
    if (!e1) missing.push('first table');
    if (!e2) missing.push('second table');
    const declaredTables = [lc(d.entity1), lc(d.entity2)].filter(Boolean);
    const holderTables = [lc(e1), lc(e2)].filter(Boolean);
    if (declaredTables.length === 2 && holderTables.length === 2) {
      // The pair is unordered, and a self-referencing N:N names the same table twice.
      if (!sameTables(declaredTables, holderTables)) differs = true;
    } else if (declaredTables.length === 2) {
      // The holder names one table or none: what it names must still be one of the declared two.
      if (holderTables.some((table) => !declaredTables.includes(table))) differs = true;
    } else if (holderTables.length === 2) {
      // The declaration names fewer than two tables: each it names must be one of the holder's.
      if (declaredTables.some((table) => !holderTables.includes(table))) differs = true;
    }
    // The table that holds the links is part of what an N:N is, and the answer has to state it (and the column each table has in it) like the
    // tables. It is compared only with what the spec states: `intersectEntityName` is optional — the reference calls an unnamed one "auto-named",
    // a download never writes it, and a relationship adopted from the environment (`existing: true`) has the intersect table its maker chose — so a
    // spec that names none is held to none, and a spec that names one is held to it (without regard to case, as every name compared here). The two
    // columns are the key each table has in the intersect table: the spec cannot say them and the platform derives them, so they are required,
    // not compared.
    part('intersect table', lc(h.intersectEntityName || h.IntersectEntityName), lc(d.intersectEntityName));
    part('first intersect column', lc(h.entity1IntersectAttribute || h.Entity1IntersectAttribute), '');
    part('second intersect column', lc(h.entity2IntersectAttribute || h.Entity2IntersectAttribute), '');
  } else {
    part('referenced table', lc(h.referencedEntity || h.ReferencedEntity || h.referenced), lc(d.referenced));
    part('referencing table', lc(h.referencingEntity || h.ReferencingEntity || h.referencing), lc(d.referencing));
    part('lookup column', lc(h.referencingAttribute || h.ReferencingAttribute), lc(d.lookup && d.lookup.schemaName));
  }
  if (differs) return { state: 'different', missing: [] };
  return missing.length ? { state: 'incomplete', missing } : { state: 'same', missing: [] };
}

// True only when the holder is PROVEN to be the declared relationship (compareRelationship says 'same'). `false` is not "another
// relationship": it is also an answer that left out a part of its identity, so a caller that must tell those apart asks
// compareRelationship.
function sameRelationship(declared, holder) {
  return compareRelationship(declared, holder).state === 'same';
}

// What an incomplete answer left out, in the words every message about it uses:
//   the environment's answer for it is incomplete (it does not state its referencing table and its lookup column)
function describeIncomplete(missing) {
  const parts = (missing || []).map((part) => `its ${part}`);
  const list = parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `the environment's answer for it is incomplete (it does not state ${list})`;
}

function describeRelationship(r) {
  if (!r || typeof r !== 'object') return 'unknown relationship';
  if (kindOf(r) === 'nn') {
    const a = r.entity1 || r.Entity1LogicalName || r.entity1LogicalName;
    const b = r.entity2 || r.Entity2LogicalName || r.entity2LogicalName;
    // The intersect table when there is one to name — the declaration's when the spec names it, the holder's when its answer stated it — so a
    // refusal that is only about the intersect table does not read as two identical relationships.
    const intersect = lc(r.intersectEntityName || r.IntersectEntityName);
    return intersect ? `N:N ${lc(a)} <-> ${lc(b)} (intersect ${intersect})` : `N:N ${lc(a)} <-> ${lc(b)}`;
  }
  const referenced = r.referenced || r.referencedEntity || r.ReferencedEntity;
  const referencing = r.referencing || r.referencingEntity || r.ReferencingEntity;
  const lookup = (r.lookup && r.lookup.schemaName) || r.referencingAttribute || r.ReferencingAttribute;
  const ends = `${lc(referenced)} -> ${lc(referencing)}`;
  return lookup ? `1:N ${ends} (lookup ${lc(lookup)})` : `1:N ${ends}`;
}

// What to tell the maker when the name is held by an N:N that is the declared one in every part but the intersect table the spec names. Reusing it is
// one edit away — name its intersect table, or name none — and so is making another (an explicit schema name), which is why the generic "give it an
// explicit schemaName" is not enough here. '' for any other difference: another table or another type cannot be reused by changing the intersect table.
function intersectRemedy(declared, holder) {
  const d = declared && typeof declared === 'object' ? declared : {};
  if (!lc(d.intersectEntityName)) return '';
  if (compareRelationship(Object.assign({}, d, { intersectEntityName: undefined }), holder).state !== 'same') return '';
  const held = lc(holder.intersectEntityName || holder.IntersectEntityName);
  return `Set "intersectEntityName" to '${held}' (or leave it out) to reuse that relationship, or give the declared one an explicit "schemaName" to create another.`;
}

module.exports = {
  readRelationshipsOf,
  findRelationshipHolder,
  readExact,
  pickProjectionRow,
  projectionHolder,
  compareRelationship,
  sameRelationship,
  describeRelationship,
  describeIncomplete,
  intersectRemedy,
};

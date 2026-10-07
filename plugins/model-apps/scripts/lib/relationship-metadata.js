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

const { odataLit } = require('./odata.js');

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
    select: 'SchemaName,Entity1LogicalName,Entity2LogicalName',
  },
};

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

function mapCollectionRow(raw, kind, entityLogical) {
  const schemaName = raw && (raw.SchemaName || raw.schemaName);
  if (kind === 'ManyToMany') {
    return {
      schemaName,
      type: 'ManyToMany',
      entity1: raw && (raw.Entity1LogicalName || raw.entity1),
      entity2: raw && (raw.Entity2LogicalName || raw.entity2),
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

async function readRelationshipsOf(client, entityLogical, kind, cache) {
  const spec = COLLECTION[kind];
  if (!spec) return { ok: false, status: 0, error: `unknown relationship kind '${kind}'` };
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
    return finish({ ok: false, status: res.status, error: errorMessage(res) });
  }
  // A collection read is `{ "value": [ ... ] }`, and an empty collection is `"value": []`. A 200
  // whose body is not that shape (a table read that happened to share the URL prefix, a truncated
  // body) is not "this table has no relationships" — reporting it as empty would skip the
  // fetchEntityMetadata fallback and recreate a relationship that already exists.
  const value = res.body && res.body.value;
  if (!Array.isArray(value)) return finish({ ok: false, status: res.status, error: 'relationship collection response had no value array' });
  return finish({ ok: true, rows: value.filter(Boolean).map((raw) => mapCollectionRow(raw, kind, logical)) });
}

function castKind(body) {
  const type = String((body && body.RelationshipType) || '');
  const odata = String((body && body['@odata.type']) || '');
  if (type === 'ManyToManyRelationship' || odata.indexOf('ManyToManyRelationship') !== -1) return 'ManyToMany';
  if (type === 'OneToManyRelationship' || odata.indexOf('OneToManyRelationship') !== -1) return 'OneToMany';
  return null;
}

function holderFromCast(body, kind) {
  if (kind === 'ManyToMany') {
    return {
      schemaName: body && body.SchemaName,
      type: 'ManyToMany',
      entity1: body && body.Entity1LogicalName,
      entity2: body && body.Entity2LogicalName,
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
    return { found: null, status: base.status, error: errorMessage(base) };
  }
  const kind = castKind(base.body);
  if (!kind) return { found: null, status: base.status, error: 'relationship type was not in the base read' };
  const select = kind === 'ManyToMany'
    ? 'SchemaName,Entity1LogicalName,Entity2LogicalName'
    : 'SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute';
  const castName = kind === 'ManyToMany' ? 'ManyToManyRelationshipMetadata' : 'OneToManyRelationshipMetadata';
  const cast = await get(client, `${key}/Microsoft.Dynamics.CRM.${castName}?$select=${select}`);
  if (!cast.status || cast.status < 200 || cast.status >= 300) {
    // The name exists (the base read succeeded). A failed cast means we could not read the
    // endpoints, not that the name is free — do not report found:false.
    return { found: null, status: cast.status, error: errorMessage(cast) };
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
  if (failed) return { found: null, status: failed.status, error: failed.error };
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
  // A name-only test double has no type. Inventing OneToMany ends from the probed entity made
  // that row a false conflict. The vendored projection always sets type; without it, compare by name.
  if (row.type !== 'OneToMany' && row.type !== 'ManyToOne' && row.type !== 'ManyToMany') {
    return { schemaName: row.schemaName };
  }
  if (row.type === 'ManyToMany') {
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

function pairOf(a, b) {
  if (!a || !b) return null;
  return [lc(a), lc(b)].sort();
}

function sameRelationship(declared, holder) {
  if (!declared || !holder || typeof declared !== 'object' || typeof holder !== 'object') return false;
  const dName = lc(declared.schemaName || declared.effectiveName);
  const hName = lc(holder.schemaName || holder.SchemaName);
  if (dName && hName && dName !== hName) return false;
  const dKind = kindOf(declared);
  const hKind = kindOf(holder);
  if (dKind && hKind && dKind !== hKind) return false;
  if (dKind === 'nn' || hKind === 'nn') {
    const declaredPair = pairOf(declared.entity1, declared.entity2);
    const holderPair = pairOf(
      holder.entity1 || holder.Entity1LogicalName || holder.entity1LogicalName,
      holder.entity2 || holder.Entity2LogicalName || holder.entity2LogicalName,
    );
    if (declaredPair && holderPair) return declaredPair[0] === holderPair[0] && declaredPair[1] === holderPair[1];
    return !holderPair;
  }
  const ref = lc(declared.referenced);
  const ring = lc(declared.referencing);
  const lookup = lc(declared.lookup && declared.lookup.schemaName);
  const hRef = lc(holder.referencedEntity || holder.ReferencedEntity || holder.referenced);
  const hRing = lc(holder.referencingEntity || holder.ReferencingEntity || holder.referencing);
  const hLookup = lc(holder.referencingAttribute || holder.ReferencingAttribute);
  if (hRef && ref && hRef !== ref) return false;
  if (hRing && ring && hRing !== ring) return false;
  if (hLookup && lookup && hLookup !== lookup) return false;
  return true;
}

function describeRelationship(r) {
  if (!r || typeof r !== 'object') return 'unknown relationship';
  if (kindOf(r) === 'nn') {
    const a = r.entity1 || r.Entity1LogicalName || r.entity1LogicalName;
    const b = r.entity2 || r.Entity2LogicalName || r.entity2LogicalName;
    return `N:N ${lc(a)} <-> ${lc(b)}`;
  }
  const referenced = r.referenced || r.referencedEntity || r.ReferencedEntity;
  const referencing = r.referencing || r.referencingEntity || r.ReferencingEntity;
  const lookup = (r.lookup && r.lookup.schemaName) || r.referencingAttribute || r.ReferencingAttribute;
  const ends = `${lc(referenced)} -> ${lc(referencing)}`;
  return lookup ? `1:N ${ends} (lookup ${lc(lookup)})` : `1:N ${ends}`;
}

module.exports = {
  readRelationshipsOf,
  findRelationshipHolder,
  readExact,
  pickProjectionRow,
  projectionHolder,
  sameRelationship,
  describeRelationship,
};

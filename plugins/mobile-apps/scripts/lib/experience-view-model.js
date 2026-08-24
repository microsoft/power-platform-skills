'use strict';

function assetKeyFor(entity, index) {
  return `asset://experience/${entity.logicalName}-${index + 1}.png`;
}

function firstField(entity, predicate) {
  return entity.fields.find(predicate)?.name || null;
}

function presentationFields(entity) {
  return {
    idField: entity.primaryKey,
    nameField: firstField(entity, (field) => field.primaryName)
      || firstField(entity, (field) => field.type === 'string')
      || entity.primaryKey,
    priceField: firstField(entity, (field) => field.type === 'number' && /amount|total|cost|price|budget|revenue/i.test(field.name)),
    categoryField: firstField(entity, (field) => /category|type|segment/i.test(field.name)),
    availabilityField: firstField(entity, (field) => /available|availability|status|state|phase/i.test(field.name)),
    imageField: firstField(entity, (field) => field.type === 'image'),
    imageUrlField: firstField(entity, (field) => /(?:image|photo|media).*url|url.*(?:image|photo|media)/i.test(field.name)),
    imageAltTextField: firstField(entity, (field) => /(?:image|photo|media).*(?:alt|description)|(?:alt|description).*(?:image|photo|media)/i.test(field.name)),
    imageCacheKeyField: firstField(entity, (field) => /(?:image|photo|media).*(?:cache|key)|(?:cache|key).*(?:image|photo|media)/i.test(field.name) && !/(?:asset|fallback)/i.test(field.name)),
    imageAssetKeyField: firstField(entity, (field) => /(?:image|photo|media).*(?:asset|fallback)|(?:asset|fallback).*(?:image|photo|media)/i.test(field.name)),
  };
}

function fieldString(row, fieldName) {
  if (!fieldName || row[fieldName] === null || row[fieldName] === undefined || row[fieldName] === '') return null;
  return String(row[fieldName]);
}

function illustrationFamily(value) {
  const semantic = String(value || '').toLowerCase();
  if (/beauty|skin|care|cosmetic/.test(semantic)) return 'beauty';
  if (/watch|time|clock/.test(semantic)) return 'watch';
  if (/travel|bag|accessor|journey|luggage/.test(semantic)) return 'travel';
  if (/food|grocery|pantry|drink|coffee/.test(semantic)) return 'food';
  if (/health|wellness|care|fitness/.test(semantic)) return 'wellness';
  return 'product';
}

function buildExperienceAssetManifest(entities, rowsByEntity, experienceContract) {
  const assets = {};
  const fallbacks = {};
  const mediaRecords = {};
  const mediaPolicy = experienceContract?.assetPolicy?.media || 'local-first';
  for (const entity of entities) {
    const fields = presentationFields(entity);
    fallbacks[entity.logicalName] = {
      keyPattern: `asset://experience/${entity.logicalName}/<record-id>`,
      kind: 'local-illustration',
      family: illustrationFamily(entity.displayName),
      label: entity.displayName,
      category: null,
    };
    const rows = rowsByEntity.get(entity.logicalName) || [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const key = assetKeyFor(entity, index);
      const title = String(row[fields.nameField] || entity.displayName);
      const category = fields.categoryField ? String(row[fields.categoryField] || '') : '';
      const recordId = String(row[entity.primaryKey]);
      const rawImage = fieldString(row, fields.imageField);
      const imageAssetKey = fieldString(row, fields.imageAssetKeyField)
        || (rawImage?.startsWith('asset://') ? rawImage : null)
        || key;
      assets[key] = {
        key,
        kind: 'local-illustration',
        family: illustrationFamily(`${entity.displayName} ${title} ${category}`),
        label: title,
        category: category || null,
      };
      mediaRecords[`${entity.logicalName}:${recordId}`] = {
        imageUrl: fieldString(row, fields.imageUrlField)
          || (rawImage && !rawImage.startsWith('asset://') ? rawImage : null),
        imageAltText: fieldString(row, fields.imageAltTextField) || `${title} product image`,
        imageCacheKey: fieldString(row, fields.imageCacheKeyField) || `experience:${entity.logicalName}:${recordId}`,
        imageAssetKey,
      };
    }
  }
  return {
    schemaVersion: 1,
    generator: 'experience-view-model',
    assetPolicy: mediaPolicy,
    assets,
    fallbacks,
    media: {
      policy: mediaPolicy,
      approvedHosts: mediaPolicy === 'remote-cdn-cached' ? ['images.unsplash.com'] : [],
      fields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
      records: mediaRecords,
    },
  };
}

function buildExperienceViewModel(entities, rowsByEntity, assetManifestPath, assetManifest) {
  const adapters = {};
  for (const entity of entities) {
    const fields = presentationFields(entity);
    const assetKeys = {};
    const rows = rowsByEntity.get(entity.logicalName) || [];
    for (let index = 0; index < rows.length; index += 1) {
      assetKeys[String(rows[index][entity.primaryKey])] = assetKeyFor(entity, index);
    }
    adapters[entity.logicalName] = {
      ...fields,
      assetKeys,
      fallbackAssetKeyPrefix: `asset://experience/${entity.logicalName}/`,
    };
  }
  return {
    schemaVersion: 1,
    assetManifestPath,
    mediaPolicy: assetManifest.assetPolicy,
    entities: adapters,
    assets: assetManifest.assets,
  };
}

function renderExperienceViewModel(viewModel) {
  return `// Generated by experience-view-model.js
// Canonical presentation adapter. Every list, detail, and bag screen derives
// display data from this stable record ID mapping instead of screen-local copy.

export type ExperienceAssetRecipe = {
  key: string;
  kind: 'local-illustration';
  family: string;
  label: string;
  category: string | null;
};

export type ExperienceEntityAdapter = {
  idField: string;
  nameField: string;
  priceField: string | null;
  categoryField: string | null;
  availabilityField: string | null;
  imageField: string | null;
  imageUrlField: string | null;
  imageAltTextField: string | null;
  imageCacheKeyField: string | null;
  imageAssetKeyField: string | null;
  assetKeys: Record<string, string>;
  fallbackAssetKeyPrefix: string;
};

export type ExperienceRecord = {
  id: string;
  entity: string;
  name: string;
  price: number | null;
  category: string | null;
  availability: string | null;
  imageUrl: string | null;
  imageAltText: string;
  imageCacheKey: string;
  imageAssetKey: string;
  assetKey: string | null;
  source: Record<string, unknown>;
};

export type ResolvedExperienceMedia = Pick<
  ExperienceRecord,
  'imageUrl' | 'imageAltText' | 'imageCacheKey' | 'imageAssetKey'
>;

type ExperienceViewModel = {
  schemaVersion: 1;
  assetManifestPath: string;
  mediaPolicy: string;
  entities: Record<string, ExperienceEntityAdapter>;
  assets: Record<string, ExperienceAssetRecipe>;
};

export const EXPERIENCE_VIEW_MODEL: ExperienceViewModel = ${JSON.stringify(viewModel, null, 2)};

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toExperienceRecord(entity: string, record: Record<string, unknown>): ExperienceRecord {
  const adapter = EXPERIENCE_VIEW_MODEL.entities[entity];
  if (!adapter) throw new Error(\`No experience view-model adapter for \${entity}.\`);
  const id = stringValue(record[adapter.idField]);
  if (!id) throw new Error(\`Experience record is missing \${adapter.idField}.\`);
  const rawImage = adapter.imageField ? stringValue(record[adapter.imageField]) : null;
  const imageUrl = adapter.imageUrlField
    ? stringValue(record[adapter.imageUrlField])
    : rawImage && !rawImage.startsWith('asset://') ? rawImage : null;
  const fallbackAssetKey = adapter.assetKeys[id] || \`\${adapter.fallbackAssetKeyPrefix}\${id}\`;
  const imageAssetKey = (adapter.imageAssetKeyField ? stringValue(record[adapter.imageAssetKeyField]) : null)
    || (rawImage && rawImage.startsWith('asset://') ? rawImage : null)
    || fallbackAssetKey;
  return {
    id,
    entity,
    name: stringValue(record[adapter.nameField]) || id,
    price: adapter.priceField ? numberValue(record[adapter.priceField]) : null,
    category: adapter.categoryField ? stringValue(record[adapter.categoryField]) : null,
    availability: adapter.availabilityField ? stringValue(record[adapter.availabilityField]) : null,
    imageUrl,
    imageAltText: (adapter.imageAltTextField ? stringValue(record[adapter.imageAltTextField]) : null) || \`\${stringValue(record[adapter.nameField]) || id} product image\`,
    imageCacheKey: (adapter.imageCacheKeyField ? stringValue(record[adapter.imageCacheKeyField]) : null) || \`experience:\${entity}:\${id}\`,
    imageAssetKey,
    assetKey: imageAssetKey,
    source: record,
  };
}

export function getExperienceAsset(assetKey: string | null | undefined): ExperienceAssetRecipe | null {
  if (!assetKey) return null;
  return EXPERIENCE_VIEW_MODEL.assets[assetKey] || {
    key: assetKey,
    kind: 'local-illustration',
    family: 'product',
    label: 'Local illustration',
    category: null,
  };
}

export function resolveExperienceMedia(record: ExperienceRecord): ResolvedExperienceMedia {
  return {
    imageUrl: record.imageUrl,
    imageAltText: record.imageAltText,
    imageCacheKey: record.imageCacheKey,
    imageAssetKey: record.imageAssetKey,
  };
}
`;
}

module.exports = {
  assetKeyFor,
  buildExperienceAssetManifest,
  buildExperienceViewModel,
  illustrationFamily,
  presentationFields,
  renderExperienceViewModel,
};
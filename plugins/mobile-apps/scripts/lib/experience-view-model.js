'use strict';

const { approvedMediaUrl, semanticMediaFamily } = require('./experience-media');

function assetKeyFor(entity, index) {
  return `asset://experience/${entity.logicalName}-${index + 1}.png`;
}

function firstField(entity, predicate) {
  return entity.fields.find(predicate)?.name || null;
}

function presentationFields(entity) {
  const relationshipFields = Object.fromEntries(entity.fields
    .filter((field) => field.type === 'lookup' && field.lookupTarget)
    .map((field) => [field.name, field.lookupTarget]));
  return {
    idField: entity.primaryKey,
    nameField: firstField(entity, (field) => field.primaryName)
      || firstField(entity, (field) => field.type === 'string')
      || entity.primaryKey,
    priceField: firstField(entity, (field) => field.type === 'number' && /amount|total|cost|price|budget|revenue/i.test(field.name)),
    currencyField: firstField(entity, (field) => /(?:currency).*code|code.*(?:currency)/i.test(field.name)),
    categoryField: firstField(entity, (field) => /category|type|segment/i.test(field.name)),
    availabilityField: firstField(entity, (field) => /available|availability|inventory|stock/i.test(field.name)),
    imageField: firstField(entity, (field) => field.type === 'image'),
    imageUrlField: firstField(entity, (field) => /(?:image|photo|media).*url|url.*(?:image|photo|media)/i.test(field.name)),
    imageAltTextField: firstField(entity, (field) => /(?:image|photo|media).*(?:alt|description)|(?:alt|description).*(?:image|photo|media)/i.test(field.name)),
    imageCacheKeyField: firstField(entity, (field) => /(?:image|photo|media).*(?:cache|key)|(?:cache|key).*(?:image|photo|media)/i.test(field.name) && !/(?:asset|fallback)/i.test(field.name)),
    imageAssetKeyField: firstField(entity, (field) => /(?:image|photo|media).*(?:asset|fallback)|(?:asset|fallback).*(?:image|photo|media)/i.test(field.name)),
    relationshipFields,
  };
}

function fieldString(row, fieldName) {
  if (!fieldName || row[fieldName] === null || row[fieldName] === undefined || row[fieldName] === '') return null;
  return String(row[fieldName]);
}

function illustrationFamily(value) {
  return semanticMediaFamily(value);
}

function resolveLookupEntity(field, entities) {
  if (!field?.lookupTarget) return null;
  const target = String(field.lookupTarget).toLowerCase();
  return entities.find((entity) => String(entity.logicalName).toLowerCase() === target) || null;
}

function categoryLabelForRow(entity, row, fields, entities, rowsByEntity) {
  if (!fields.categoryField) return '';
  const categoryField = entity.fields.find((field) => field.name === fields.categoryField);
  const rawCategory = row[fields.categoryField];
  if (categoryField?.type !== 'lookup') return rawCategory === null || rawCategory === undefined ? '' : String(rawCategory);
  const target = resolveLookupEntity(categoryField, entities);
  const targetRow = target
    ? (rowsByEntity.get(target.logicalName) || []).find((candidate) => String(candidate[target.primaryKey]) === String(rawCategory))
    : null;
  if (!targetRow || !target) return '';
  const targetFields = presentationFields(target);
  return String(targetRow[targetFields.nameField] || '');
}

function entityNeedsExperienceMedia(entity, fields, experienceContract) {
  if (fields.imageField || fields.imageUrlField || fields.imageAssetKeyField) return true;
  const contractNeedsMedia = experienceContract?.mediaIntent?.criticality === 'required'
    || (experienceContract?.contentModel || []).some((kind) => ['media', 'products'].includes(kind))
    || experienceContract?.primarySurface === 'product-led-discovery';
  if (!contractNeedsMedia) return false;
  const semanticName = `${entity.logicalName} ${entity.displayName}`.toLowerCase();
  if (/cart|order|line item|transaction|category|collection/.test(semanticName)) return false;
  return /product|inventory item|catalog item|listing|merchandise|content|article|course/.test(semanticName);
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
    if (!entityNeedsExperienceMedia(entity, fields, experienceContract)) continue;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const key = assetKeyFor(entity, index);
      const title = String(row[fields.nameField] || entity.displayName);
      const category = categoryLabelForRow(entity, row, fields, entities, rowsByEntity);
      const recordId = String(row[entity.primaryKey]);
      const rawImage = fieldString(row, fields.imageField);
      const family = semanticMediaFamily(entity.displayName, title, category, experienceContract?.primaryJob);
      const imageAssetKey = fieldString(row, fields.imageAssetKeyField)
        || (rawImage?.startsWith('asset://') ? rawImage : null)
        || key;
      assets[key] = {
        key,
        kind: 'bundled-raster',
        family,
        label: title,
        category: category || null,
        materialized: false,
      };
      mediaRecords[`${entity.logicalName}:${recordId}`] = {
        imageUrl: fieldString(row, fields.imageUrlField)
          || (rawImage && /^https:\/\//i.test(rawImage) ? rawImage : null)
          || approvedMediaUrl(family, `${entity.logicalName}:${title}:${category}:${recordId}`),
        imageAltText: fieldString(row, fields.imageAltTextField) || `${title} product image`,
        imageCacheKey: fieldString(row, fields.imageCacheKeyField) || `experience:${entity.logicalName}:${recordId}`,
        imageAssetKey,
        source: 'approved-cdn-with-bundled-fallback',
        delivery: mediaPolicy === 'local-first' ? 'bundled-first' : 'remote-cached-with-bundled-fallback',
      };
    }
  }
  return {
    schemaVersion: 2,
    generator: 'experience-view-model',
    assetPolicy: mediaPolicy,
    assets,
    fallbacks,
    media: {
      policy: mediaPolicy,
      approvedHosts: ['images.unsplash.com'],
      fields: ['imageUrl', 'imageAltText', 'imageCacheKey', 'imageAssetKey'],
      critical: experienceContract?.mediaIntent?.criticality === 'required'
        || (experienceContract?.contentModel || []).some((kind) => ['media', 'products'].includes(kind)),
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
      const assetKey = assetKeyFor(entity, index);
      if (assetManifest.assets[assetKey]) assetKeys[String(rows[index][entity.primaryKey])] = assetKey;
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
    mediaRecords: assetManifest.media?.records || {},
  };
}

function renderExperienceViewModel(viewModel) {
  const assetSourceEntries = Object.entries(viewModel.assets || {})
    .filter(([, recipe]) => recipe?.materialized && recipe.localPath)
    .map(([assetKey, recipe]) => {
      const requirePath = `../../${String(recipe.localPath).replace(/\\/g, '/')}`;
      return `  ${JSON.stringify(assetKey)}: require(${JSON.stringify(requirePath)}),`;
    })
    .join('\n');
  return `// Generated by experience-view-model.js
// Canonical presentation adapter. Every list, detail, and bag screen derives
// display data from this stable record ID mapping instead of screen-local copy.

import type { ImageSourcePropType } from 'react-native';

export type ExperienceAssetRecipe = {
  key: string;
  kind: 'bundled-raster' | 'local-illustration';
  family: string;
  label: string;
  category: string | null;
  source?: string;
  localPath?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  sha256?: string;
  materialized?: boolean;
};

export type ExperienceMediaRecord = {
  imageUrl: string | null;
  imageAltText: string;
  imageCacheKey: string;
  imageAssetKey: string;
  source?: string;
  imageLocalPath?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageByteLength?: number;
  imageSha256?: string;
  delivery?: 'bundled-first' | 'remote-cached-with-bundled-fallback';
};

export type ExperienceEntityAdapter = {
  idField: string;
  nameField: string;
  priceField: string | null;
  currencyField: string | null;
  categoryField: string | null;
  availabilityField: string | null;
  imageField: string | null;
  imageUrlField: string | null;
  imageAltTextField: string | null;
  imageCacheKeyField: string | null;
  imageAssetKeyField: string | null;
  relationshipFields: Record<string, string>;
  assetKeys: Record<string, string>;
  fallbackAssetKeyPrefix: string;
};

export type ExperienceAvailabilityState = 'available' | 'unavailable' | 'unknown';

export type ExperienceRecord = {
  id: string;
  entity: string;
  name: string;
  price: number | null;
  currencyCode: string | null;
  category: string | null;
  availability: string | null;
  availabilityState: ExperienceAvailabilityState;
  relationships: Record<string, string | null>;
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
> & {
  /** Primary source. Remote policies resolve a HTTPS source here. */
  imageSource: ImageSourcePropType | null;
  /** Metro-bundled source used after a remote error or offline cache miss. */
  fallbackSource: ImageSourcePropType | null;
  sourcePriority: 'local' | 'remote';
};

type ExperienceViewModel = {
  schemaVersion: 1;
  assetManifestPath: string;
  mediaPolicy: string;
  entities: Record<string, ExperienceEntityAdapter>;
  assets: Record<string, ExperienceAssetRecipe>;
  mediaRecords: Record<string, ExperienceMediaRecord>;
};

export const EXPERIENCE_VIEW_MODEL: ExperienceViewModel = ${JSON.stringify(viewModel, null, 2)};

// Static require calls are required for Metro to bundle offline fallbacks.
export const EXPERIENCE_ASSET_SOURCES: Record<string, ImageSourcePropType> = {
${assetSourceEntries}
};

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function availabilityState(value: string | null): ExperienceAvailabilityState {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (/\\b(?:unavailable|not available|out[ -]of[ -]stock|sold[ -]out|inactive|disabled|closed|blocked|fully[ -]booked)\\b/.test(normalized)) return 'unavailable';
  if (/\\b(?:available|in[ -]stock|active|open|ready|limited)\\b/.test(normalized)) return 'available';
  return 'unknown';
}

function httpsImageSource(imageUrl: string | null): ImageSourcePropType | null {
  if (!imageUrl) return null;
  return /^https:\\/\\//i.test(imageUrl) ? { uri: imageUrl } : null;
}

export function toExperienceRecord(entity: string, record: Record<string, unknown>): ExperienceRecord {
  const adapter = EXPERIENCE_VIEW_MODEL.entities[entity];
  if (!adapter) throw new Error(\`No experience view-model adapter for \${entity}.\`);
  const id = stringValue(record[adapter.idField]);
  if (!id) throw new Error(\`Experience record is missing \${adapter.idField}.\`);
  const manifestMedia = EXPERIENCE_VIEW_MODEL.mediaRecords[\`\${entity}:\${id}\`];
  const rawImage = adapter.imageField ? stringValue(record[adapter.imageField]) : null;
  const imageUrl = (adapter.imageUrlField ? stringValue(record[adapter.imageUrlField]) : null)
    || (rawImage && /^https:\\/\\//i.test(rawImage) ? rawImage : null)
    || manifestMedia?.imageUrl
    || null;
  const fallbackAssetKey = adapter.assetKeys[id] || \`\${adapter.fallbackAssetKeyPrefix}\${id}\`;
  const imageAssetKey = (adapter.imageAssetKeyField ? stringValue(record[adapter.imageAssetKeyField]) : null)
    || (rawImage && rawImage.startsWith('asset://') ? rawImage : null)
    || manifestMedia?.imageAssetKey
    || fallbackAssetKey;
  const availability = adapter.availabilityField ? stringValue(record[adapter.availabilityField]) : null;
  const relationships = Object.fromEntries(Object.keys(adapter.relationshipFields)
    .map((field) => [field, stringValue(record[field])]));
  return {
    id,
    entity,
    name: stringValue(record[adapter.nameField]) || id,
    price: adapter.priceField ? numberValue(record[adapter.priceField]) : null,
    currencyCode: adapter.currencyField ? stringValue(record[adapter.currencyField]) : null,
    category: adapter.categoryField ? stringValue(record[adapter.categoryField]) : null,
    availability,
    availabilityState: availabilityState(availability),
    relationships,
    imageUrl,
    imageAltText: (adapter.imageAltTextField ? stringValue(record[adapter.imageAltTextField]) : null) || manifestMedia?.imageAltText || \`\${stringValue(record[adapter.nameField]) || id} product image\`,
    imageCacheKey: (adapter.imageCacheKeyField ? stringValue(record[adapter.imageCacheKeyField]) : null) || manifestMedia?.imageCacheKey || \`experience:\${entity}:\${id}\`,
    imageAssetKey,
    assetKey: imageAssetKey,
    source: record,
  };
}

export function isExperienceRecordActionable(record: ExperienceRecord): boolean {
  return record.availabilityState !== 'unavailable';
}

export function relatedExperienceRecords(
  parent: ExperienceRecord,
  candidates: ExperienceRecord[],
): ExperienceRecord[] {
  return candidates.filter((candidate) => {
    const adapter = EXPERIENCE_VIEW_MODEL.entities[candidate.entity];
    if (!adapter) return false;
    return Object.entries(candidate.relationships).some(([field, value]) => (
      value === parent.id && adapter.relationshipFields[field] === parent.entity
    ));
  });
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

export function resolveExperienceMedia(
  record: ExperienceRecord,
  relatedRecords: ExperienceRecord[] = [],
): ResolvedExperienceMedia {
  const relatedMedia = relatedExperienceRecords(record, relatedRecords)
    .find((candidate) => candidate.imageUrl || EXPERIENCE_ASSET_SOURCES[candidate.imageAssetKey]);
  const mediaRecord = relatedMedia || record;
  const fallbackSource = EXPERIENCE_ASSET_SOURCES[mediaRecord.imageAssetKey] || null;
  const remoteSource = EXPERIENCE_VIEW_MODEL.mediaPolicy === 'local-first'
    ? null
    : httpsImageSource(mediaRecord.imageUrl);
  return {
    imageUrl: mediaRecord.imageUrl,
    imageAltText: mediaRecord.imageAltText,
    imageCacheKey: mediaRecord.imageCacheKey,
    imageAssetKey: mediaRecord.imageAssetKey,
    imageSource: remoteSource || fallbackSource,
    fallbackSource,
    sourcePriority: remoteSource ? 'remote' : 'local',
  };
}
`;
}

module.exports = {
  assetKeyFor,
  buildExperienceAssetManifest,
  buildExperienceViewModel,
  illustrationFamily,
  entityNeedsExperienceMedia,
  presentationFields,
  renderExperienceViewModel,
};

'use strict';

// Shared by canonical compilation and the app-owned local/image runtime. This
// boundary validates declarations only: it never fetches, verifies or seeds URLs.
const ASSET_KEYS = ['key', 'source', 'alt', 'fallback', 'aspectRatio', 'fit', 'focalPoint', 'provenance'];
const PROVENANCE_KEYS = ['sourcePage', 'license', 'licenseUrl', 'creator', 'attribution', 'attributionRequired', 'changes'];
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

function stableId(value) {
  return typeof value === 'string' && STABLE_ID.test(value);
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has an invalid shape`);
}

function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} requires bounded plain text`);
}

function publicHttps(value, label, { image = false } = {}) {
  text(value, 2048, label);
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(value);
  if (!parts || /[\s\\]/.test(value) || !parts[1].split('.').every((part) => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)
  ))) throw new Error(`${label} requires an absolute public HTTPS URL without credentials, fragments or private hosts`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} requires an absolute public HTTPS URL`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:'
    || url.username || url.password || url.hash || url.port
    || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) {
    throw new Error(`${label} requires a public HTTPS URL without credentials, fragments or private hosts`);
  }
  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((key) => (
    /^(?:token|access_token|auth|authorization|key|api[-_]?key|sig|signature|x-amz-.+|x-goog-.+)$/i.test(key)
  ))) throw new Error(`${label} must not contain signed or credential-bearing URL parameters`);
  // The installed React Native URL implementation appends a slash to some
  // paths. Check fixed-image identity against the supplied path, never that
  // normalized value, and preserve the original URL byte-for-byte.
  let pathname;
  try { pathname = decodeURIComponent(parts[2] || '/'); } catch { throw new Error(`${label} has invalid URL encoding`); }
  if (image && (
    /(?:^|\.)(?:source\.unsplash\.com|picsum\.photos|loremflickr\.com|lorempixel\.com|placeimg\.com)$/.test(host)
    || /\/(?:random|random-image|random-photo)(?:\/|$)/i.test(pathname)
    || queryKeys.some((key) => /^random$/i.test(key))
    || (host === 'images.unsplash.com' && !/^\/photo-[a-z0-9-]+$/.test(pathname))
  )) throw new Error(`${label} must identify a fixed image, not a random/source endpoint`);
  return value;
}

function validateImageAsset(asset) {
  object(asset, ASSET_KEYS, 'Sample image');
  if (!stableId(asset.key)) throw new Error('Sample image requires a bounded stable key');
  object(asset.source, ['kind', 'value'], 'Sample image source');
  if (asset.source.kind !== 'cdn') throw new Error('Sample photo fields require a canonical CDN image');
  publicHttps(asset.source.value, 'Sample image source', { image: true });
  text(asset.alt, 300, 'Sample image alt');
  text(asset.fallback, 300, 'Sample image fallback');
  if (asset.aspectRatio !== undefined && (typeof asset.aspectRatio !== 'number'
    || !Number.isFinite(asset.aspectRatio) || asset.aspectRatio < 0.1 || asset.aspectRatio > 10)) {
    throw new Error('Sample image aspectRatio must be between 0.1 and 10');
  }
  if (asset.fit !== undefined && !['cover', 'contain'].includes(asset.fit)) throw new Error('Sample image fit must be cover or contain');
  if (asset.focalPoint !== undefined && asset.focalPoint !== 'center') throw new Error('Sample images support a centered focalPoint');
  object(asset.provenance, PROVENANCE_KEYS, 'Sample image provenance');
  const provenance = asset.provenance;
  publicHttps(provenance.sourcePage, 'Sample image sourcePage');
  publicHttps(provenance.licenseUrl, 'Sample image licenseUrl');
  text(provenance.license, 120, 'Sample image license');
  text(provenance.creator, 200, 'Sample image creator');
  text(provenance.attribution, 600, 'Sample image attribution');
  text(provenance.changes, 400, 'Sample image changes');
  if (typeof provenance.attributionRequired !== 'boolean') throw new Error('Sample image attributionRequired must be explicit');
  return asset;
}

function isMediaAssetReference(value) {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'mediaAssetKey');
}

function referencedMediaKeys(record) {
  return Object.values(record?.fields || {}).filter(isMediaAssetReference).map((value) => value.mediaAssetKey);
}

function validateScenarioImages(records, mediaAssets) {
  const errors = [];
  const add = (code, message, pointer) => errors.push({ code, message, pointer });
  if (!Array.isArray(records) || !Array.isArray(mediaAssets) || mediaAssets.length > 200) {
    return [{ code: 'scenario-media-invalid', message: 'Scenario images require records and at most 200 mediaAssets' }];
  }
  const assets = new Map();
  const recordMediaKeys = new Set(records.flatMap(referencedMediaKeys));
  for (const [index, asset] of mediaAssets.entries()) {
    if (!asset || typeof asset !== 'object' || !stableId(asset.key) || assets.has(asset.key)) {
      add('media-asset-invalid', 'Media assets require unique bounded keys', `mediaAssets[${index}]`);
      continue;
    }
    assets.set(asset.key, asset);
    // Keep legacy presentation-only media compatible; record-backed photos and
    // assets opting into provenance must satisfy the complete sample contract.
    if (asset.source?.kind === 'cdn' && (recordMediaKeys.has(asset.key) || asset.provenance !== undefined)) {
      try { validateImageAsset(asset); } catch (error) {
        add('media-provenance-invalid', error.message, `mediaAssets[${index}]`);
      }
    }
  }
  for (const [index, record] of records.entries()) {
    for (const [field, value] of Object.entries(record?.fields || {})) {
      const pointer = `records[${index}].fields.${field}`;
      if (!isMediaAssetReference(value)) {
        if (value && typeof value === 'object' && (value.sample || /^https?:\/\//i.test(value.uri || ''))) {
          add('media-reference-required', 'Remote fixture photos must use only { mediaAssetKey } from canonical mediaAssets', pointer);
        }
        continue;
      }
      if (Object.keys(value).length !== 1 || !stableId(value.mediaAssetKey)
        || !stableId(record.id) || !stableId(record.conceptId)
        || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field)) {
        add('media-reference-invalid', 'Image references require an exact record, concept, field and mediaAssetKey without duplicate photo data', pointer);
        continue;
      }
      const asset = assets.get(value.mediaAssetKey);
      if (!asset) add('media-asset-missing', `Photo field references missing media asset ${value.mediaAssetKey}`, pointer);
      else if (asset.source?.kind !== 'cdn') add('media-source-invalid', 'Sample photo fields require a licensed HTTPS CDN image, not a generated/local placeholder', pointer);
    }
  }
  return errors;
}

function projectSamplePhoto(asset, { recordId, conceptId, field }) {
  validateImageAsset(asset);
  return {
    status: 'ready', id: asset.key, uri: asset.source.value,
    sample: { recordId, conceptId, field, asset: JSON.parse(JSON.stringify(asset)) },
  };
}

function validateSamplePhoto(photo, { recordId, field } = {}) {
  const sample = photo?.sample;
  object(sample, ['recordId', 'conceptId', 'field', 'asset'], 'Sample photo binding');
  const asset = validateImageAsset(sample.asset);
  if (photo.status !== 'ready' || photo.id !== asset.key || photo.uri !== asset.source.value
    || !stableId(sample.recordId) || !stableId(sample.conceptId)
    || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(sample.field || '')
    || (recordId !== undefined && sample.recordId !== recordId)
    || (field !== undefined && sample.field !== field)) {
    throw new Error('Sample photo must preserve its exact canonical source, record, concept and field binding');
  }
  return photo;
}

function sameSamplePhoto(left, right) {
  if (!left?.sample || !right?.sample) return false;
  const stable = (value) => value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function resolveImagePresentation(photo, alt, fallback) {
  const result = {
    uri: null, asset: null,
    alt: typeof alt === 'string' && alt.trim() ? alt : 'Photo',
    fallback: typeof fallback === 'string' && fallback.trim() ? fallback : 'Image unavailable',
  };
  if (photo?.status !== 'ready') return result;
  if (photo.sample || /^https:\/\//.test(photo.uri || '')) {
    try {
      validateSamplePhoto(photo);
      return { uri: photo.uri, asset: photo.sample.asset, alt: photo.sample.asset.alt, fallback: photo.sample.asset.fallback };
    } catch { return result; }
  }
  if (/^(?:file|content):\/\/\S+$/.test(photo.uri || '')) result.uri = photo.uri;
  return result;
}

module.exports = {
  isMediaAssetReference, referencedMediaKeys, validateImageAsset, validateScenarioImages,
  projectSamplePhoto, validateSamplePhoto, sameSamplePhoto, resolveImagePresentation,
};

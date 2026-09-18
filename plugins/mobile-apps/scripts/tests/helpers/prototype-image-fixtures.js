'use strict';

// Public licensed URL fixture, not an automatic sample population. Tests are
// offline; the observed source/license checks are documented in prototype-images.md.
function sampleImageAsset(key = 'fronalpstock-panorama') {
  return {
    key,
    source: {
      kind: 'cdn',
      value: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Fronalpstock_big.jpg/960px-Fronalpstock_big.jpg',
    },
    alt: 'Panoramic view from Fronalpstock in Switzerland',
    fallback: 'Mountain panorama unavailable',
    aspectRatio: 2.23,
    fit: 'contain',
    focalPoint: 'center',
    provenance: {
      sourcePage: 'https://commons.wikimedia.org/wiki/File:Fronalpstock_big.jpg',
      license: 'CC BY-SA 3.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      creator: 'Hannes Röst',
      attribution: 'Fronalpstock panorama',
      attributionRequired: true,
      changes: 'Wikimedia thumbnail resized from the original; no other edits.',
    },
  };
}

module.exports = { sampleImageAsset };

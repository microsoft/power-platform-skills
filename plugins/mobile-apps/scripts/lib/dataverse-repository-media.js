'use strict';

function createLiveMedia({ files, digest, namespace, RepositoryError }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,479}$/.test(namespace || '')) throw new RepositoryError('media', 'Invalid live media namespace');
  const directory = files.documentDirectory
    ? `${files.documentDirectory}mobile-real-media/${encodeURIComponent(namespace)}/` : null;
  const checked = (value, maxSizeInKB) => {
    if (!Number.isInteger(maxSizeInKB) || maxSizeInKB < 1
      || typeof value !== 'string' || !value.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new RepositoryError('mapping', 'The Image column did not provide valid bounded base64 image data');
    }
    const size = value.length * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
    if (size > maxSizeInKB * 1024) throw new RepositoryError('media', 'Image exceeds the verified Dataverse column limit');
    return size;
  };
  return {
    async fromBase64(entityId, recordId, fieldId, value, maxSizeInKB = 30720) {
      if (!directory) throw new RepositoryError('unsupported', 'Persistent image files are unavailable on this platform');
      const size = checked(value, maxSizeInKB);
      const hash = await digest(value);
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new RepositoryError('media', 'Image digest is unavailable');
      const mime = value.startsWith('/9j/') ? ['jpg', 'image/jpeg']
        : value.startsWith('iVBORw0KGgo') ? ['png', 'image/png']
          : value.startsWith('R0lGOD') ? ['gif', 'image/gif'] : ['img', null];
      const id = `${entityId}-${recordId}-${fieldId}-${hash}`;
      const uri = `${directory}${encodeURIComponent(id)}.${mime[0]}`;
      await files.makeDirectoryAsync(directory, { intermediates: true });
      const prior = await files.getInfoAsync(uri);
      if (!prior.exists || prior.size !== size) {
        await files.writeAsStringAsync(uri, value, { encoding: files.EncodingType.Base64 });
        const info = await files.getInfoAsync(uri);
        if (!info.exists || info.isDirectory || (info.size !== undefined && info.size !== size)) {
          throw new RepositoryError('media', 'The image cache write was not completed');
        }
      }
      return { status: 'ready', id, uri, ...(mime[1] ? { mimeType: mime[1] } : {}) };
    },
    async toBase64(value, maxSizeInKB) {
      if (value?.status !== 'ready' || !/^(file:\/\/|content:\/\/)\S+$/.test(value.uri || '')) {
        throw new RepositoryError('media-not-ready', 'Persist a captured local image before saving');
      }
      const info = await files.getInfoAsync(value.uri);
      if (!info.exists || info.isDirectory || (info.size !== undefined && info.size > maxSizeInKB * 1024)) {
        throw new RepositoryError('media', 'Image is missing or exceeds the verified Dataverse column limit');
      }
      const content = await files.readAsStringAsync(value.uri, { encoding: files.EncodingType.Base64 });
      checked(content, maxSizeInKB);
      return content;
    },
  };
}

module.exports = { createLiveMedia };

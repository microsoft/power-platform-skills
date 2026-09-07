'use strict';

function createPhotoCapture({ picker, allowedSources, persist }) {
  let busy = false;
  return async function capturePhoto(source, options = {}) {
    if (!['camera', 'library'].includes(source) || !allowedSources.includes(source)) {
      return { status: 'failed', message: 'This capture source is not an approved native capability' };
    }
    if (busy) return { status: 'pending' };
    busy = true;
    try {
      const permissionMethod = source === 'camera' ? 'requestCameraPermissionsAsync' : 'requestMediaLibraryPermissionsAsync';
      const launchMethod = source === 'camera' ? 'launchCameraAsync' : 'launchImageLibraryAsync';
      if (typeof picker?.[permissionMethod] !== 'function' || typeof picker?.[launchMethod] !== 'function') {
        return { status: 'failed', message: 'The installed runtime cannot use this capture source' };
      }
      const permission = await picker[permissionMethod]();
      if (permission.granted !== true) return { status: 'failed', message: 'Photo permission was not granted' };
      const selected = await picker[launchMethod]({
        mediaTypes: ['images'], quality: 0.8, allowsEditing: false, exif: false,
        ...(source === 'library' ? { allowsMultipleSelection: false } : {}),
      });
      if (selected.canceled === true) return { status: 'cancelled' };
      const asset = selected.assets?.[0];
      if (!asset || typeof asset.uri !== 'string') return { status: 'failed', message: 'Capture did not return an image' };
      return await persist({
        uri: asset.uri, mimeType: asset.mimeType ?? undefined,
        fileName: asset.fileName ?? undefined, operationId: options.operationId,
      });
    } catch {
      return { status: 'failed', message: 'The photo could not be captured and persisted. Keep existing evidence and try again.' };
    } finally {
      busy = false;
    }
  };
}

module.exports = { createPhotoCapture };

import { normalizeDataverseGuid } from './dataverse';

export type ImageResolution = 'thumbnail' | 'full';

type ImageDownloadResult = {
  success: boolean;
  data?: Uint8Array;
  error?: unknown;
};

export type ImageDownloader<Column extends string> =
  (id: string, column: Column, fullSize: boolean) => Promise<ImageDownloadResult>;

/** Generated image downloads default to thumbnails; require an explicit resolution choice. */
export async function readDataverseImage<Column extends string>(
  download: ImageDownloader<Column>,
  options: { id: string; column: Column; resolution: ImageResolution },
): Promise<Uint8Array> {
  const id = normalizeDataverseGuid(options.id);
  if (!id) throw new Error('A valid record ID is required to load its image');
  if (!options.column.trim()) throw new Error('An image column is required');
  if (options.resolution !== 'thumbnail' && options.resolution !== 'full') {
    throw new Error('Choose thumbnail or full image resolution');
  }
  const result = await download(id, options.column, options.resolution === 'full');
  if (!result.success) {
    throw Object.assign(new Error('Image download failed'), { cause: result.error });
  }
  if (!result.data || result.data.byteLength === 0) {
    throw new Error('No image bytes were returned');
  }
  return result.data;
}

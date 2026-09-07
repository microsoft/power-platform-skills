import type { PhotoReference, SampleImageAsset } from '../model';

export function resolveImagePresentation(photo: PhotoReference | null | undefined, alt: string, fallback?: string): {
  uri: string | null;
  asset: SampleImageAsset | null;
  alt: string;
  fallback: string;
};

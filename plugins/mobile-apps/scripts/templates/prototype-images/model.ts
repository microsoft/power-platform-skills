export interface SampleImageProvenance {
  sourcePage: string;
  license: string;
  licenseUrl: string;
  creator: string;
  attribution: string;
  attributionRequired: boolean;
  changes: string;
}
export interface SampleImageAsset {
  key: string;
  source: { kind: 'cdn'; value: string };
  alt: string;
  fallback: string;
  aspectRatio?: number;
  fit?: 'cover' | 'contain';
  focalPoint?: 'center';
  provenance: SampleImageProvenance;
}
export interface SampleImageBinding {
  recordId: string;
  conceptId: string;
  field: string;
  asset: SampleImageAsset;
}
export type PhotoReference =
  | { status: 'ready'; id: string; uri: string; mimeType?: string; fileName?: string; sample?: SampleImageBinding }
  | { status: 'pending' | 'cancelled' | 'failed'; id?: string; uri?: string; message?: string };

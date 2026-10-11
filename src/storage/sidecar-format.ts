import { fingerprint } from './fingerprint';
import { safePath } from './safety';

/** Historical locations are read-only evidence; no parser/importer is exposed. */
export const SIDECAR_FOLDER = 'Reading/Metadata';
export const sidecarPath = (path: string): string => SIDECAR_FOLDER + '/' + fingerprint(safePath(path, true)) + '.json';
export const isSidecarPath = (path: string): boolean => {
  const folded = path.toLowerCase();
  return folded === 'reading/metadata' || folded.startsWith('reading/metadata/') ||
    folded === 'reading/pullman metadata' || folded.startsWith('reading/pullman metadata/');
};

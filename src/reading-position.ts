/** A short visible-text bookmark. Empty marker means the beginning of the article. */
export interface ReadingPosition {
  marker: string;
}

/** Ignore malformed synced scalar state rather than letting it drive DOM ranges. */
export function readingPosition(value: unknown): ReadingPosition | undefined {
  return typeof value === 'string' ? validReadingPosition({ marker: value }) : undefined;
}

/** Validate the in-memory position shape used by reader/UI APIs. */
export function validReadingPosition(value: unknown): ReadingPosition | undefined {
  const marker = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).marker : undefined;
  if (typeof marker !== 'string' || marker.length > 256 ||
      marker !== marker.trim() ||
      (marker !== '' && marker.split(/\s+/u).length > 5)) return;
  return { marker };
}

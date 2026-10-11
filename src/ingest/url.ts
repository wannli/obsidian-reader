const MAX_URL_LENGTH = 8192;

function webUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error('Invalid URL: too long or contains control characters.');
  }
  const value = input.trim();
  if (!/^https?:\/\//i.test(value)) throw new Error('Only absolute HTTP(S) URLs are supported.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid HTTP(S) URL.'); }
  if (!url.hostname || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(value)) {
    throw new Error('URL credentials are not allowed.');
  }
  return url;
}

/** Stable identity: preserve query parameters, path case and trailing slash; remove fragments. */
export function normalizeUrl(url: string): string {
  const parsed = webUrl(url);
  parsed.hash = '';
  return parsed.href;
}

/** Resolve a publisher link without losing its fragment (unlike article identity). */
export function resolveWebUrl(value: string, base: string): string {
  if (!value.trim() || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Invalid publisher URL.');
  }
  // Validate explicit authorities before URL's parser erases empty credentials.
  if (/^https?:/i.test(value.trim())) return webUrl(value).href;
  if (value.trim().startsWith('//') && /^\/\/[^/?#]*@/.test(value.trim())) {
    throw new Error('URL credentials are not allowed.');
  }
  return webUrl(new URL(value, webUrl(base)).href).href;
}

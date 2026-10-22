import { webUrl } from './model';

/** Parse a pasted list of URLs, not a CSV document with columns. */
export function csvUrls(source: string): string[] {
  const urls = new Set<string>();
  for (const entry of source.split(/[,;\r\n]+/)) {
    const value = entry.trim().replace(/^\uFEFF/, '');
    if (!value) continue;
    try {
      // Browser-style www links have no scheme; use HTTPS before store validation.
      urls.add(webUrl(value.startsWith('www.') ? `https://${value}` : value));
    } catch {
      throw new Error(`Invalid article URL: ${value}`);
    }
  }
  if (!urls.size) throw new Error('Enter at least one article URL.');
  return [...urls];
}

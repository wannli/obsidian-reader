/** Validate the URL field only: article/Comments text may legitimately discuss templates. */
export function isAcquisitionUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const source = value.trim();
  if (!/^https?:\/\//i.test(source) || /[\s\u0000-\u001f\u007f]/.test(source)) return false;
  if (/%(?![0-9a-f]{2})/i.test(source)) return false;
  let decoded = source;
  // Inspection only: decode percent octets without reparsing a decoded literal "%".
  // ASCII placeholder markers remain detectable even beside Unicode or nested escapes.
  for (let pass = 0; pass < 2; pass++) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_escape, octet: string) => String.fromCharCode(parseInt(octet, 16)));
    if (next === decoded) break; decoded = next;
  }
  if (/\{\{|\}\}|<%|%>|\$\{|<[^>]*>|\b(?:INSERT_URL|YOUR_URL|URL_HERE)\b/i.test(decoded)) return false;
  try { const url = new URL(source); return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname && !/[{}<>]/.test(url.hostname); }
  catch { return false; }
}

import { requestUrl } from 'obsidian';
import { normalizeUrl } from './ingest/url';
import type { HttpGet } from './types';
export const obsidianGet: HttpGet = async (url, headers = {}) => {
  const normalized = normalizeUrl(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      requestUrl({ url: normalized, headers, method: 'GET', throw: false }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out after 20 seconds. Try again while online.')), 20000); }),
    ]);
    if (response.arrayBuffer.byteLength > 8 * 1024 * 1024) throw new Error('Response exceeds the 8 MB limit.');
    return { status: response.status, text: response.text, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value])) };
  } finally { if (timer) clearTimeout(timer); }
};

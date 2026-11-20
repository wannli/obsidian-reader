import { isSourceLinkPlaceholder } from './capture-placeholder';
import { text, type ArticleInfo, type Properties } from './model';

export type AttentionReason = 'Video without saved text' | 'Text extraction failed';

/** Recognize actual video destinations, not every page on a video publisher's domain. */
export function isVideoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return /^\/[\w-]+\/?$/.test(url.pathname);
    if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host))
      return (
        (url.pathname === '/watch' && !!url.searchParams.get('v')) ||
        /^\/(?:shorts|embed|live)\/[\w-]+\/?$/.test(url.pathname)
      );
    if (host === 'vimeo.com') return /^\/\d+\/?$/.test(url.pathname);
    if (host === 'player.vimeo.com') return /^\/video\/\d+\/?$/.test(url.pathname);
    return /\.(?:mp4|webm|mov|m4v|ogv)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** A conservative shortlist lets ordinary Inbox rows stay metadata-only. */
export function mayNeedAttention(properties: Properties): boolean {
  return (
    properties.type === 'article' &&
    properties.status === 'inbox' &&
    (!!text(properties.error).trim() || isVideoUrl(text(properties.url)))
  );
}

export function attentionCandidate(article: ArticleInfo): boolean {
  return mayNeedAttention({
    type: 'article',
    status: article.status,
    url: article.url,
    error: article.error,
  });
}

/** Never infer failure from length: even a short authored note is useful saved text. */
export function hasSavedText(body: string, url: unknown): boolean {
  const content = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .trim();
  if (!content || isSourceLinkPlaceholder(content, url) || content === text(url).trim())
    return false;
  // Media-only captures aren't transcripts. Everything else is protected as readable.
  const withoutMedia = content
    .replace(/<(?:iframe|video|audio)\b[^>]*>[\s\S]*?<\/(?:iframe|video|audio)>/gi, '')
    .replace(/!\[[^\]\r\n]*\]\([^\r\n]*?\)/g, '')
    .replace(/!\[\[[^\]\r\n]+\]\]/g, '')
    .trim();
  return !!withoutMedia;
}

/** Derived only from current bytes; never persisted as a status or readiness flag. */
export function attentionReason(properties: Properties, body: string): AttentionReason | undefined {
  if (!mayNeedAttention(properties) || hasSavedText(body, properties.url)) return;
  return isVideoUrl(text(properties.url)) ? 'Video without saved text' : 'Text extraction failed';
}

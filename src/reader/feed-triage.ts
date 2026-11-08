export const triageFlags = ['feedPreviews', 'feedTouchActions'] as const;
export type TriageFlag = (typeof triageFlags)[number];
export type TriageFlags = Record<TriageFlag, boolean>;
const key = (flag: TriageFlag) => `obsidian-reader:experimental:${flag}`;
export function readTriageFlags(): TriageFlags {
  const enabled = (flag: TriageFlag) => {
    try {
      return localStorage.getItem(key(flag)) === '1';
    } catch {
      return false;
    }
  };
  return { feedPreviews: enabled('feedPreviews'), feedTouchActions: enabled('feedTouchActions') };
}
export function saveTriageFlag(flag: TriageFlag, enabled: boolean): void {
  localStorage.setItem(key(flag), enabled ? '1' : '0');
}

/** A bounded, inert excerpt of saved text, never rendered as HTML or fetched. */
export function feedExcerpt(body: string): string {
  return body
    .slice(0, 8000)
    .replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/\^[\w-]+\s*$/gm, '')
    .replace(/[*_`=]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}
export function feedAge(published: string | undefined, now = Date.now()): string {
  if (!published) return '';
  const time = Date.parse(published);
  if (!Number.isFinite(time)) return '';
  const days = Math.floor((now - time) / 86_400_000);
  return days < 0
    ? published.slice(0, 10)
    : days === 0
      ? 'Today'
      : days === 1
        ? '1 day ago'
        : `${days} days ago`;
}

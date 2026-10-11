import { resolveWebUrl } from '../ingest/url';
import { safePath } from './safety';

export function linkTarget(input: string): string {
  let target = input.trim();
  if (target.startsWith('[[') && target.endsWith(']]')) target = target.slice(2, -2);
  if (/^https?:\/\//i.test(target)) return resolveWebUrl(target, target);
  if (!target || /[\x00-\x1f\x7f\[\]|<>\x60:]/.test(target) || target.startsWith('//')) throw new Error('Use a safe note name or an HTTP(S) URL');
  const [path, ...fragment] = target.split('#');
  safePath(path);
  if (fragment.length > 1 || (fragment.length && !fragment[0])) throw new Error('Invalid note heading link');
  return target;
}

// Entities preserve literal punctuation inside both Markdown labels and wiki aliases.
function encodeLabel(value: string): string {
  return value.replace(/[&\\\[\]|\x60*_<>]/g, char => char === '&' ? '&amp;' : '&#' + char.charCodeAt(0) + ';');
}
function decodeLabel(value: string): string {
  return value.replace(/&(?:amp|#(\d+));/g, (match, number?: string) => number ? String.fromCharCode(Number(number)) : '&');
}

export function linkedQuote(quote: string, link?: string): string {
  if (!link) return quote;
  const target = linkTarget(link), web = /^https?:\/\//i.test(target);
  const destination = /[()]/.test(target) ? '<' + target + '>' : target;
  if (!web && target === quote && !/[\/#^]/.test(target) && !/\.md$/i.test(target)) return '[[' + target + ']]';
  return quote.split('\n').map(line => !line ? '' : web
    ? '[' + encodeLabel(line) + '](' + destination + ')'
    : '[[' + target + '|' + encodeLabel(line) + ']]').join('\n');
}

/** Only metadata's boolean encoding flag is stored; the target itself lives in Markdown. */
export function readLinkedQuote(raw: string, linked: boolean): { quote: string; link?: string } {
  if (!linked) return { quote: raw };
  let target: string | undefined;
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) { lines.push(''); continue; }
    const wiki = /^\[\[([^|\]]+)(?:\|([^\]]*))?\]\]$/.exec(line);
    const web = /^\[([^\]]*)\]\((https?:\/\/[^\s]+|<https?:\/\/[^<>\s]+>)\)$/.exec(line);
    if (!wiki && !web) return { quote: raw }; // A person may remove the link in Markdown.
    const next = linkTarget(wiki ? wiki[1] : web![2].replace(/^<|>$/g, ''));
    if (target && target !== next) throw new Error('Highlight lines have different link targets');
    // Bare destinations are literal names, not entity-encoded alias labels.
    target = next; lines.push(wiki && wiki[2] === undefined ? wiki[1] : decodeLabel(wiki ? wiki[2] : web![1]));
  }
  return { quote: lines.join('\n'), ...(target ? { link: target } : {}) };
}

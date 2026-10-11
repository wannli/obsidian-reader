import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { InlineMarkdownError } from './types';
import { HIGHLIGHT_COLORS } from '../typed-highlights';

export function escapeHTML(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Decode exactly once using HTML attribute rules, matching marked's passive output. */
export function decodeMarkdownDestination(value: string): string {
  const holder = document.createElement('template');
  // Literal delimiters cannot escape the fixed attribute. Entity-decoded quotes stay
  // inside that attribute and are never reparsed as markup. No source HTML is trusted.
  const attribute = value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  holder.innerHTML = `<a href="${attribute}"></a>`;
  return holder.content.firstElementChild!.getAttribute('href')!;
}
/** Reject encoded protocol tricks, credentials, network paths, traversal and Markdown control syntax. */
export function safeTarget(target: string): string | undefined {
  if (!target || target !== target.trim() || /[\u0000-\u001f\u007f<>"\\\[\]|]/u.test(target)) return;
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return; }
  if (/[\u0000-\u001f\u007f<>"\\\[\]|]/u.test(decoded) || decoded.startsWith('//')) return;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(decoded);
  if (scheme) {
    if (!/^(https?|mailto)$/i.test(scheme[1])) return;
    if (/^https?:/i.test(decoded)) {
      if (!/^https?:\/\/[^\s/]+/i.test(decoded)) return;
      try {
        const url = new URL(target), decodedURL = new URL(decoded);
        if (!url.hostname || !decodedURL.hostname || url.username || url.password || decodedURL.username || decodedURL.password) return;
      } catch { return; }
    }
  } else if (decoded.startsWith('/') || decoded.split(/[\/#?]/).some(part => part === '..') || decoded.includes(':')) return;
  return target;
}
export function requireTarget(target: string): string {
  const safe = safeTarget(target);
  if (!safe) throw new InlineMarkdownError('unsafe-target', 'This link target is unsafe or uses unsupported syntax.');
  return safe;
}
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea',
      'select', 'option', 'optgroup', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'autofocus', 'contenteditable', 'tabindex'],
  });
}
export const inlineMarked = new Marked({ gfm: true, breaks: false, extensions: [
  {
    name: 'reader_embed', level: 'inline',
    start: (src: string) => src.indexOf('![['),
    tokenizer(src) {
      const match = /^!\[\[[^\[\]\n]+\]\]/.exec(src);
      if (match) return { type: 'reader_embed', raw: match[0] };
    },
    renderer(token) { return escapeHTML(token.raw); },
  },
  {
    name: 'reader_highlight', level: 'inline',
    start: (src: string) => src.indexOf('=='),
    tokenizer(src) {
      const match = /^==([^\n]+?)==(?!=)/.exec(src);
      if (!match || match[1] !== match[1].trim() || match[1].startsWith('=') || match[1].endsWith('=') || match[1].includes('==')) return;
      const color = HIGHLIGHT_COLORS.find(color => match[1].startsWith(color));
      const text = color ? match[1].slice(color.length) : match[1];
      return { type: 'reader_highlight', raw: match[0], text, color, contentOffset: 2 + (color?.length ?? 0), tokens: this.lexer.inlineTokens(text) };
    },
    renderer(token) { return `<mark${token.color ? ` class="r2-color-${HIGHLIGHT_COLORS.indexOf(token.color)}"` : ''}>${this.parser.parseInline(token.tokens!)}</mark>`; },
  },
  {
    name: 'reader_wiki', level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenizer(src) {
      const match = /^\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/.exec(src);
      if (!match) return;
      return { type: 'reader_wiki', raw: match[0], target: match[1], text: match[2] ?? match[1],
        labelOffset: match[2] === undefined ? 2 : 3 + match[1].length };
    },
    renderer(token) {
      const target = safeTarget(token.target);
      return target ? `<a class="internal-link" href="${escapeHTML(target)}">${escapeHTML(token.text)}</a>` : escapeHTML(token.text);
    },
  },
] });

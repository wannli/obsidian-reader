import DOMPurify from 'dompurify';
import { parseHtml } from './bounds';
import { resolveWebUrl } from './url';

const TAGS = 'a abbr article b blockquote br caption code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img li main ol p pre s section small span strong summary table tbody td th thead tr u ul'.split(' ');
const DROP = 'script style iframe frame frameset object embed applet svg math form input button textarea select option template noscript canvas audio video source track link meta base title nav footer aside'.split(' ');
const ATTRS = ['href', 'src', 'alt', 'class', 'id', 'start', 'data-src', 'data-original', 'data-lang', 'data-language'];
// Unknown labels render as ordinary code, not executable Obsidian plugin blocks (e.g. dataviewjs).
const CODE_LANGUAGES = new Set('text plaintext html xml css scss less javascript js jsx typescript ts tsx json jsonc yaml yml toml ini bash sh shell zsh powershell python py ruby rb rust rs go java kotlin swift c cpp csharp cs php sql r lua perl diff dockerfile makefile markdown md'.split(' '));

export function plainTitle(value: string | null | undefined, fallback: string): string {
  // Title markup is inert; active subtrees and comments never become metadata text.
  const doc = parseHtml((value ?? '').slice(0, 8192));
  for (const node of doc.body.querySelectorAll(DROP.join(','))) node.remove();
  return (doc.body.textContent ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500) || fallback;
}

/** Strict passive-HTML allowlist. No style, events, forms, embeds, SVG, MathML or raw HTML escape hatches. */
export function sanitizeBody(doc: Document, base: string, forExtraction = false): HTMLElement {
  const body = doc.body;
  // Drop rather than unwrap active/boilerplate subtrees, including their fallback text.
  for (const node of body.querySelectorAll(DROP.join(','))) node.remove();
  for (const node of body.querySelectorAll('[hidden],[aria-hidden="true"],[style]')) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute('style') ?? '')) node.remove();
  }
  DOMPurify.sanitize(body, {
    IN_PLACE: true, ALLOWED_TAGS: [...TAGS, 'body'], ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, ALLOWED_NAMESPACES: ['http://www.w3.org/1999/xhtml'],
    FORBID_CONTENTS: DROP,
  });
  for (const node of body.querySelectorAll('*')) {
    const tag = node.localName;
    if (tag === 'a') {
      try { node.setAttribute('href', resolveWebUrl(node.getAttribute('href') ?? '', base)); }
      catch { node.removeAttribute('href'); }
    }
    if (tag === 'img') {
      let src: string | undefined;
      for (const attr of ['src', 'data-src', 'data-original']) {
        try { src = resolveWebUrl(node.getAttribute(attr) ?? '', base); break; } catch { /* Try a safe lazy image. */ }
      }
      if (!src) { node.replaceWith(doc.createTextNode(node.getAttribute('alt') ?? '')); continue; }
      node.setAttribute('src', src);
    }
    const language = [node.getAttribute('data-lang'), node.getAttribute('data-language'),
      node.getAttribute('class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1]].find(value => value && /^[\w+-]{1,32}$/.test(value));
    for (const attr of [...node.attributes]) {
      const keep = (tag === 'a' && attr.name === 'href') || (tag === 'img' && ['src', 'alt'].includes(attr.name)) ||
        (tag === 'ol' && attr.name === 'start' && /^\d{1,6}$/.test(attr.value)) ||
        (forExtraction && ['class', 'id'].includes(attr.name));
      if (!keep) node.removeAttribute(attr.name);
    }
    if ((tag === 'pre' || tag === 'code') && language && CODE_LANGUAGES.has(language.toLowerCase())) {
      node.setAttribute('data-language', language.toLowerCase());
    }
  }
  return body;
}

export function safeContent(html: string, base: string): HTMLElement {
  return sanitizeBody(parseHtml(html), base);
}

export function visibleText(node: Node): string {
  return (node.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

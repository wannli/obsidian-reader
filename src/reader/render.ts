import { Marked, type Token } from 'marked';
import { fragment } from '../content/html';
import { VisibleText } from './text';
import { imageViewer } from './images';

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
type Inline = Token & { target: string; label: string; tokens: Token[] };
const markdown = new Marked({ gfm: true, breaks: false });
markdown.use({
  renderer: {
    html: (token) => escape(token.text),
    link(token) {
      const internal = !/^[a-z][\w+.-]*:|^\/\/|^#/i.test(token.href);
      return `<a${internal ? ' class="internal-link"' : ''} href="${escape(token.href)}">${this.parser.parseInline(token.tokens)}</a>`;
    },
  },
  extensions: [
    {
      name: 'readerWiki',
      level: 'inline',
      start: (source) => source.indexOf('[['),
      tokenizer(source) {
        const match = /^\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/.exec(source);
        if (match)
          return {
            type: 'readerWiki',
            raw: match[0],
            target: match[1],
            label: match[2] ?? match[1].replace(/\.md$/, '').split('/').pop()!,
          };
      },
      renderer(token) {
        const link = token as Inline;
        return `<a class="internal-link" href="${escape(encodeURI(link.target))}">${escape(link.label)}</a>`;
      },
    },
    {
      name: 'readerHighlight',
      level: 'inline',
      start: (source) => source.indexOf('=='),
      tokenizer(source) {
        const match = /^==([^\n]+?)==/.exec(source);
        if (match)
          return {
            type: 'readerHighlight',
            raw: match[0],
            tokens: this.lexer.inlineTokens(match[1]),
          };
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline((token as Inline).tokens)}</mark>`;
      },
    },
  ],
});

const imageFailures = new Map<string, number>();
export function renderBody(body: string, root: HTMLElement, base: string): () => void {
  const html = markdown.parse(body, { async: false });
  root.replaceChildren(fragment(html, base || 'https://example.invalid/', true));
  const headings = new Map<string, number>();
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const slug = (heading.textContent ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
    const count = headings.get(slug) ?? 0;
    headings.set(slug, count + 1);
    heading.id = count ? `${slug}-${count}` : slug;
  }
  let active = true;
  const load = (image: HTMLImageElement): boolean => {
    const url = image.dataset.readerSrc;
    if (!active || !root.isConnected || root.ownerDocument.visibilityState === 'hidden' || !url)
      return false;
    if ((imageFailures.get(url) ?? 0) > Date.now()) return true;
    image.addEventListener(
      'error',
      () => {
        if (!active) return;
        imageFailures.delete(url);
        imageFailures.set(url, Date.now() + 60_000);
        if (imageFailures.size > 200) imageFailures.delete(imageFailures.keys().next().value!);
        image.removeAttribute('src');
        image.alt ||= 'Image unavailable';
      },
      { once: true },
    );
    image.src = url;
    delete image.dataset.readerSrc;
    return true;
  };
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              if (entry.isIntersecting && load(entry.target as HTMLImageElement))
                observer!.unobserve(entry.target);
          },
          { root: root.parentElement, rootMargin: '160px' },
        );
  const images = [...root.querySelectorAll<HTMLImageElement>('img')];
  for (const image of images) {
    if (observer) observer.observe(image);
    else load(image); // Hosts without IntersectionObserver retain native loading="lazy".
  }
  const disposeViewer = imageViewer(root);
  const visible = () => {
    if (active && root.ownerDocument.visibilityState === 'visible')
      for (const image of images)
        if (image.dataset.readerSrc) {
          if (observer) {
            observer.unobserve(image);
            observer.observe(image);
          } else load(image);
        }
  };
  root.ownerDocument.addEventListener('visibilitychange', visible);
  return () => {
    active = false;
    disposeViewer();
    observer?.disconnect();
    root.ownerDocument.removeEventListener('visibilitychange', visible);
    for (const image of images) image.removeAttribute('src');
  };
}
export function selectedPassage(
  root: HTMLElement,
): { range: Range; quote: string; before: string; after: string } | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = root.ownerDocument.createRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return {
    range: range.cloneRange(),
    quote: selection.toString(),
    before: before.toString().slice(-120),
    after: after.toString().slice(0, 120),
  };
}
export function textBookmark(
  root: HTMLElement,
  viewport: HTMLElement,
  index = new VisibleText(root),
): string {
  const frame = viewport.getBoundingClientRect();
  const doc = root.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const left = Math.max(
    frame.left + 12,
    Math.min(root.getBoundingClientRect().left + 24, frame.right - 12),
  );
  const caret = doc.caretRangeFromPoint?.(left, frame.top + 12);
  if (
    caret &&
    root.contains(caret.startContainer) &&
    caret.startContainer.nodeType === Node.TEXT_NODE
  ) {
    const marker = index.marker(caret.startContainer, caret.startOffset);
    if (marker) return marker;
  }
  const nodes = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = nodes.nextNode())) {
    if (!node.textContent?.trim()) continue;
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(node);
    if (
      ![...range.getClientRects()].some(
        (rect) =>
          rect.bottom > frame.top + 8 &&
          rect.top < frame.bottom &&
          rect.right > frame.left &&
          rect.left < frame.right,
      )
    )
      continue;
    const marker = index.marker(node, 0);
    if (marker) return marker;
  }
  return '';
}
export function bookmarkRange(
  root: HTMLElement,
  marker: string,
  index = new VisibleText(root),
): Range | undefined {
  return index.range(marker);
}

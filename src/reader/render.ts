import type { Token } from 'marked';
import { readerMarkdown, visibleMarkdown } from '../core/markdown';
import { nativeCitations, passageFragments, passages } from '../core/annotations';
import { paragraphAnchors } from '../core/hosted-highlights';
import { fragment } from '../content/html';
import { readerDecoration, readerRangeText, VisibleText } from './text';
import { imageViewer } from './images';

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
type Inline = Token & { target: string; label: string; tokens: Token[] };
let decorationPrefix = '';
let decorationHtml: readonly string[] = [];
const markdown = readerMarkdown();
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
      name: 'readerDecoration',
      level: 'inline',
      start: (source) => (decorationPrefix ? source.indexOf(decorationPrefix) : -1),
      tokenizer(source) {
        if (!decorationPrefix || !source.startsWith(decorationPrefix)) return;
        const match = /^(\d+)\uE001/.exec(source.slice(decorationPrefix.length));
        if (match && decorationHtml[Number(match[1])] !== undefined)
          return {
            type: 'readerDecoration',
            raw: decorationPrefix + match[0],
            index: Number(match[1]),
          };
      },
      renderer(token) {
        return decorationHtml[(token as Token & { index: number }).index];
      },
    },
    {
      name: 'readerWiki',
      renderer(token) {
        const link = token as Inline;
        return `<a class="internal-link" href="${escape(encodeURI(link.target))}">${escape(link.label)}</a>`;
      },
    },
    {
      name: 'readerHighlight',
      renderer(token) {
        return `<mark>${this.parser.parseInline((token as Inline).tokens)}</mark>`;
      },
    },
  ],
});

function hideParagraphAnchors(root: HTMLElement): void {
  for (const marker of root.querySelectorAll<HTMLElement>('.reader-paragraph-anchor')) {
    const id = marker.textContent!.slice(1);
    marker.dataset.readerDecoration = 'paragraph-anchor';
    marker.hidden = true;
    const block = marker.closest<HTMLElement>('p,li,blockquote,h1,h2,h3,h4,h5,h6');
    if (!block) continue;
    if (/^H[1-6]$/.test(block.tagName)) marker.id = `^${id}`;
    else block.id = `^${id}`;
    block.dataset.readerParagraph = id;
  }
}

/** Host-owned public Fileclass icon painting; the Markdown renderer stays platform-neutral. */
export type ReferenceIcon = (target: string, element: HTMLElement) => void;

const imageFailures = new Map<string, number>();
export function renderBody(
  body: string,
  root: HTMLElement,
  base: string,
  referenceIcon?: ReferenceIcon,
): () => void {
  const citations = nativeCitations(body);
  // Replace only parser-proven source spans with render-local tokens. Matching
  // rendered strings would also hide an escaped/code literal identical to a real ID.
  // The collision-free tokens never enter Markdown storage or source-selection maps.
  const decorations = citations
    .map(({ from, to }) => {
      const links = [
        ...body.slice(from, to).matchAll(/\[\[([^\[\]|\r\n]+)(?:\|([^\[\]\r\n]+))?\]\]/g),
      ]
        .map((match) => {
          const label = match[2] ?? match[1].replace(/\.md$/, '').split('/').pop()!;
          return `<a class="internal-link" href="${escape(encodeURI(match[1]))}">${escape(label)}</a>`;
        })
        .join(' ');
      return {
        from,
        to,
        html: `<span class="reader-reference-group">${links}</span>`,
      };
    })
    .concat(
      paragraphAnchors(body).map(({ anchor, blockId }) => ({
        ...anchor,
        html: `<span class="reader-paragraph-anchor">^${escape(blockId)}</span>`,
      })),
    );
  let prefix = '\uE000reader-decoration:';
  while (body.includes(prefix)) prefix += ':';
  decorationPrefix = prefix;
  decorationHtml = decorations.map((item) => item.html);
  let display = body;
  for (const { from, to, index } of decorations
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.from - a.from))
    display =
      display.slice(0, from) +
      (/^[ \t]+/.exec(body.slice(from, to))?.[0] ?? '') +
      `${prefix}${index}\uE001` +
      display.slice(to);
  let html: string;
  try {
    html = markdown.parse(visibleMarkdown(display), { async: false });
  } finally {
    decorationPrefix = '';
    decorationHtml = [];
  }
  root.replaceChildren(fragment(html, base || 'https://example.invalid/', true));
  const references = [...root.querySelectorAll<HTMLElement>('.reader-reference-group')];
  for (const reference of references) {
    // Data attributes are installed only after sanitization, never accepted from Markdown.
    reference.dataset.readerDecoration = 'reference';
    reference.setAttribute('aria-label', 'Highlight notes');
    for (const link of reference.querySelectorAll<HTMLAnchorElement>('a')) {
      link.classList.add('reader-reference-pill');
      const name = link.textContent ?? 'note';
      link.title = `Edit highlight notes · ${name} (Enter when focused)`;
      const label = root.ownerDocument.createElement('span');
      label.className = 'reader-reference-label';
      label.append(...link.childNodes);
      link.append(label);
    }
    // Keep real spaces between independently clickable destinations inside the
    // one shared reference pill. Its citation marker stays in Markdown only.
  }
  if (referenceIcon)
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a.internal-link')) {
      const icon = root.ownerDocument.createElement('span');
      icon.className = 'reader-node-icon';
      if (link.classList.contains('reader-reference-pill'))
        icon.classList.add('reader-reference-icon');
      icon.setAttribute('aria-hidden', 'true');
      // Only the icon is decoration: an ordinary note link's authored label remains prose.
      icon.dataset.readerDecoration = 'reference';
      try {
        referenceIcon(decodeURI(link.getAttribute('href') ?? ''), icon);
        if (icon.hasChildNodes()) {
          const label = link.querySelector('.reader-reference-label');
          if (label) label.before(icon);
          else link.prepend(icon);
          link.classList.add('reader-typed-link');
        }
      } catch {
        // A reloaded/unavailable provider must not hide the native reference or article.
      }
    }
  const source = passages(body),
    marks = [...root.querySelectorAll<HTMLElement>('mark')].filter(
      (mark) => !readerDecoration(mark),
    );
  if (
    source.reduce((count, passage) => count + passageFragments(passage).length, 0) === marks.length
  ) {
    let index = 0;
    source.forEach((passage, passageIndex) => {
      for (const _fragment of passageFragments(passage))
        marks[index++].dataset.readerPassage = String(passageIndex);
      const citation = citations.findIndex(
        (item) => item.from === passage.citation?.from && item.to === passage.citation.to,
      );
      if (citation >= 0 && references.length === citations.length)
        references[citation].dataset.readerPassage = String(passageIndex);
    });
  }
  hideParagraphAnchors(root);
  // A defined-but-empty CSS custom property does NOT use var()'s fallback.
  // Scope this fallback to Reader; leave a usable theme highlight color intact.
  const highlight = root.ownerDocument.defaultView
    ?.getComputedStyle(root)
    .getPropertyValue('--text-highlight-bg')
    .trim();
  root.classList.toggle('reader-highlight-fallback', !highlight);
  const headings = new Map<string, number>();
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const slug = new VisibleText(heading).text
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
/** Containment-only probe: never serialize article text on live selection events. */
export function selectionRange(root: HTMLElement): Range | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (
    root.contains(range.startContainer) &&
    root.contains(range.endContainer) &&
    !readerDecoration(range.startContainer) &&
    !readerDecoration(range.endContainer)
  )
    return range;
}

/** Read only the adjacent 120 UTF-16 units, preserving Range.toString() text semantics. */
function selectionContext(
  root: HTMLElement,
  container: Node,
  offset: number,
  before: boolean,
): string {
  const descend = (node: Node): Node => {
    let child: ChildNode | null;
    while (!readerDecoration(node) && (child = before ? node.lastChild : node.firstChild))
      node = child;
    return node;
  };
  const adjacent = (node: Node): Node | undefined => {
    while (node !== root) {
      const sibling = before ? node.previousSibling : node.nextSibling;
      if (sibling) return descend(sibling);
      if (!node.parentNode) return;
      node = node.parentNode;
    }
  };
  let value = '',
    node: Node | undefined;
  if (container.nodeType === Node.TEXT_NODE && !readerDecoration(container)) {
    const text = container.nodeValue ?? '';
    value = before
      ? text.slice(Math.max(0, offset - 120), offset)
      : text.slice(offset, offset + 120);
    node = adjacent(container);
  } else {
    const child = container.childNodes[before ? offset - 1 : offset];
    node = child ? descend(child) : adjacent(container);
  }
  while (node && value.length < 120) {
    if (node.nodeType === Node.TEXT_NODE && !readerDecoration(node)) {
      const text = node.nodeValue ?? '',
        remaining = 120 - value.length;
      value = before ? text.slice(-remaining) + value : value + text.slice(0, remaining);
    }
    node = adjacent(node);
  }
  return value;
}

export function selectedPassage(
  root: HTMLElement,
  explicitRange?: Range,
): { range: Range; quote: string; before: string; after: string } | undefined {
  const range = explicitRange ?? selectionRange(root);
  if (!range) return;
  if (readerDecoration(range.startContainer) || readerDecoration(range.endContainer)) return;
  const quote = readerRangeText(range);
  if (
    explicitRange &&
    (range.collapsed ||
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer) ||
      !quote.trim())
  )
    return;
  return {
    range: range.cloneRange(),
    quote,
    before: selectionContext(root, range.startContainer, range.startOffset, true),
    after: selectionContext(root, range.endContainer, range.endOffset, false),
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
    if (!node.textContent?.trim() || readerDecoration(node)) continue;
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

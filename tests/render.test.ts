// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderBody as renderMarkdown, selectedPassage } from '../src/reader/render';

const disposers: (() => void)[] = [];
function renderBody(...args: Parameters<typeof renderMarkdown>): () => void {
  const dispose = renderMarkdown(...args);
  disposers.push(dispose);
  return dispose;
}
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

it('renders ordinary Markdown, inline highlights and wiki-links', () => {
  const root = document.createElement('article');
  document.body.append(root);
  const dispose = renderBody(
    '## Heading\n\nAn ==[[Nodes/Example.md|important passage]]== and **emphasis**.',
    root,
    'https://example.com',
  );
  expect(root.querySelector('h2')?.textContent).toBe('Heading');
  expect(root.querySelector('mark a')?.textContent).toBe('important passage');
  expect(root.querySelector('a')?.getAttribute('href')).toBe('Nodes/Example.md');
  expect(root.querySelector('strong')?.textContent).toBe('emphasis');
  dispose();
});

it('resolves protocol-relative publisher links while preserving vault links and anchors', () => {
  const root = document.createElement('article');
  renderBody('[publisher](//publisher.test/story) [note](Notes/Local.md) [section](#heading)', root, 'https://source.test/article');
  const [web, note, anchor] = [...root.querySelectorAll('a')];
  expect(web.getAttribute('href')).toBe('https://publisher.test/story');
  expect(web.classList.contains('internal-link')).toBe(false);
  expect(note.getAttribute('href')).toBe('Notes/Local.md');
  expect(note.classList.contains('internal-link')).toBe(true);
  expect(anchor.getAttribute('href')).toBe('#heading');
});

it('keeps code literal and does not execute user-authored raw HTML', () => {
  const root = document.createElement('article');
  renderBody(
    '`==not a highlight==`\n\n<script>bad()</script>\n\n<img src="https://evil.invalid/image">',
    root,
    'https://example.com',
  );
  expect(root.querySelector('mark,script,img')).toBeNull();
  expect(root.textContent).toContain('==not a highlight==');
});

it('loads images only when observed, and never after the view is disposed', () => {
  let notify!: (entries: { isIntersecting: boolean; target: Element }[]) => void;
  const disconnect = vi.fn(),
    unobserve = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe() {}
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const root = document.createElement('article');
  document.body.append(root);
  const dispose = renderBody(
    '![first](https://example.com/one.png)\n\n![second](https://example.com/two.png)',
    root,
    'https://example.com',
  );
  const images = [...root.querySelectorAll('img')];
  expect(images).toHaveLength(2);
  expect(images.every((image) => !image.hasAttribute('src'))).toBe(true);
  notify([{ isIntersecting: true, target: images[0] }]);
  expect(images[0].getAttribute('src')).toBe('https://example.com/one.png');
  expect(images[1].hasAttribute('src')).toBe(false);
  dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  notify([{ isIntersecting: true, target: images[1] }]);
  expect(images[1].hasAttribute('src')).toBe(false);
});

it('preserves formatted vault links, encoded wiki paths and stable heading anchors', () => {
  const root = document.createElement('article');
  renderBody(
    '## A useful heading\n\n==[**Formatted** words](/Notes/Some%20Note.md)== and [[Notes/100%20Literal.md|literal]].\n\n## A useful heading',
    root,
    'https://example.com/article',
  );
  expect(root.querySelector('mark strong')?.textContent).toBe('Formatted');
  expect(root.querySelector('mark a')?.getAttribute('href')).toBe('/Notes/Some%20Note.md');
  expect(root.querySelectorAll('a')[1].getAttribute('href')).toBe('Notes/100%2520Literal.md');
  expect([...root.querySelectorAll('h2')].map((heading) => heading.id)).toEqual([
    'a-useful-heading',
    'a-useful-heading-1',
  ]);
});

it('backs off failed image URLs across rerenders without retrying disposed views', () => {
  const root = document.createElement('article');
  document.body.append(root);
  const dispose = renderBody(
    '![unavailable](https://example.com/failure.png)',
    root,
    'https://example.com',
  );
  const image = root.querySelector('img')!;
  expect(image.hasAttribute('src')).toBe(true);
  image.dispatchEvent(new Event('error'));
  expect(image.hasAttribute('src')).toBe(false);
  dispose();
  renderBody('![unavailable](https://example.com/failure.png)', root, 'https://example.com');
  expect(root.querySelector('img')!.hasAttribute('src')).toBe(false);
  dispose();
  root.ownerDocument.dispatchEvent(new Event('visibilitychange'));
  expect(image.hasAttribute('src')).toBe(false);
});

it('selection capture includes context but excludes UI outside the article', () => {
  const root = document.createElement('article');
  root.textContent = 'Before selected words after.';
  document.body.append(root);
  const range = document.createRange();
  range.setStart(root.firstChild!, 7);
  range.setEnd(root.firstChild!, 21);
  document.getSelection()!.addRange(range);
  expect(selectedPassage(root)).toMatchObject({
    quote: 'selected words',
    before: 'Before ',
    after: ' after.',
  });
  const button = document.createElement('button');
  button.textContent = 'UI text';
  document.body.append(button);
  range.setEnd(button.firstChild!, 2);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  expect(selectedPassage(root)).toBeUndefined();
});

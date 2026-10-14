// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderBody as renderMarkdown, selectedPassage } from '../src/reader/render';
import {
  addHighlight,
  changePassage,
  hasAnnotations,
  locateSelection,
  passages,
  UnmappableSelection,
} from '../src/core/annotations';

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

it('resolves protocol-relative publisher links while preserving vault links and anchors', () => {
  const root = document.createElement('article');
  renderBody(
    '[publisher](//publisher.test/story) [note](Notes/Local.md) [section](#heading)',
    root,
    'https://source.test/article',
  );
  const [web, note, anchor] = [...root.querySelectorAll('a')];
  expect(web.getAttribute('href')).toBe('https://publisher.test/story');
  expect(web.classList.contains('internal-link')).toBe(false);
  expect(note.classList.contains('internal-link')).toBe(true);
  expect(note.getAttribute('href')).toBe('Notes/Local.md');
  expect(anchor.getAttribute('href')).toBe('#heading');
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

it.each([
  '> ==first\n> second==',
  '- ==first\n  second==',
  '> ==first\r\n> second==',
  '- ==first\r\n  second==',
  '123. ==first\n     second==',
  '123. ==first\r\n     second==',
  '> - ==first\n>   second==',
  '- > ==first\n  > second==',
  '- outer\n  - ==first\n    second==',
  '- outer\r\n  - ==first\r\n    second==',
  '- [x] ==first\n  second==',
  '>> ==first\n>> second==',
  '> ==first\nsecond==',
  '- ==first\nsecond==',
  '> ==**first\n> second**==',
  '- ==**first\r\n  second**==',
  '> ==first\n> second==\n> ---',
  '- ==first\r\n  second==\r\n  ---',
  '123. ==first\n     second==\n     ---',
])(
  'recognizes rendered container highlights, preserves action bytes, and retains annotations: %j',
  (body) => {
    const root = document.createElement('article');
    renderBody(body, root, '');
    expect(root.querySelector('mark')?.textContent).toBe('first\nsecond');
    const found = passages(body);
    expect(found).toHaveLength(root.querySelectorAll('mark').length);
    expect(hasAnnotations(body, {})).toBe(true);
    expect(changePassage(body, found[0], 'remove')).toBe(body.replace(/==/g, ''));
    expect(changePassage(body, found[0], 'unlink')).toBe(body);
    expect(() => changePassage(body, found[0], 'link', 'Notes/One.md')).toThrow('wiki-link label');
  },
);

it.each([
  '==first\n    second==',
  '==first\n\tsecond==',
  '==first\r\n    second==',
  '==first\r\n\tsecond==',
  '==first\n    second==\n---',
  '==first\n\tsecond==\n---',
  '==first\r\n    second==\r\n---',
  '==first\r\n\tsecond==\r\n---',
])('recognizes indented top-level paragraph/heading continuations: %j', (body) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(
    root
      .querySelector(body.endsWith('---') ? 'h2 mark' : 'p mark')
      ?.textContent?.replace(/\s+/g, ' '),
  ).toBe('first second');
  const found = passages(body);
  expect(found).toHaveLength(1);
  expect(root.querySelectorAll('mark')).toHaveLength(found.length);
  expect(hasAnnotations(body, {})).toBe(true);
  expect(changePassage(body, found[0], 'remove')).toBe(body.replace(/==/g, ''));
  expect(changePassage(body, found[0], 'unlink')).toBe(body);
  expect(() => changePassage(body, found[0], 'link', 'Notes/One.md')).toThrow('wiki-link label');
});

it.each(['- ==first\n\tsecond==', '- ==first\r\n\tsecond==', '- [ ] ==first\n\tsecond=='])(
  'maps tab-expanded list continuations without rewriting source indentation: %j',
  (body) => {
    const root = document.createElement('article');
    renderBody(body, root, '');
    expect(root.querySelector('mark')?.textContent?.replace(/\s+/g, ' ')).toBe('first second');
    const found = passages(body);
    expect(found).toHaveLength(1);
    expect(hasAnnotations(body, {})).toBe(true);
    expect(changePassage(body, found[0], 'remove')).toBe(body.replace(/==/g, ''));
  },
);

it.each(['> ==first\n> `second`==', '- ==first\r\n  `second`=='])(
  'retains rendered marks with protected interiors without making them editable: %j',
  (body) => {
    const root = document.createElement('article');
    renderBody(body, root, '');
    expect(root.querySelectorAll('mark')).toHaveLength(1);
    expect(passages(body)).toEqual([]);
    expect(hasAnnotations(body, {})).toBe(true);
    expect(() => locateSelection(body.replace(/==/g, ''), 'first second')).toThrow();
  },
);

it('keeps mixed source/DOM passage order and removes only the chosen nested highlight', () => {
  const body = '==start==\n\n> ==first\n> second==\n\n- ==third\n  fourth==\n\n`==literal==`';
  const root = document.createElement('article');
  renderBody(body, root, '');
  const found = passages(body);
  expect([...root.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'start',
    'first\nsecond',
    'third\nfourth',
  ]);
  expect(found.map((passage) => passage.text)).toEqual([
    'start',
    'first\n> second',
    'third\n  fourth',
  ]);
  expect(changePassage(body, found[1], 'remove')).toBe(
    body.replace('> ==first\n> second==', '> first\n> second'),
  );
});

it.each(['\n', '\r\n'])(
  'unlinks a nested soft-wrapped native link without losing quote prefixes (%j)',
  (newline) => {
    const body = `> ==[first${newline}> second](/Notes/One.md)==`;
    const root = document.createElement('article');
    renderBody(body, root, '');
    expect(root.querySelector('mark a')?.textContent).toBe('first\nsecond');
    const found = passages(body);
    expect(found).toHaveLength(1);
    expect(found[0].target).toBe('Notes/One.md');
    expect(changePassage(body, found[0], 'unlink')).toBe(`> ==first${newline}> second==`);
    expect(changePassage(body, found[0], 'remove')).toBe(`> first${newline}> second`);
  },
);

it.each(['first\nsecond', '**first\nsecond**', 'first\nsecond\nthird', 'first\r\nsecond'])(
  'maps, recognizes and renders soft-wrapped paragraph highlights: %s',
  (raw) => {
    const body = `Before ${raw} after.`,
      quote = raw.replace(/\*\*/g, '').replace(/\r?\n/g, ' ');
    const range = locateSelection(body, quote),
      saved = addHighlight(body, range.from, range.to);
    const [passage] = passages(saved);
    expect(passage.text).toBe(body.slice(range.from, range.to));
    expect(changePassage(saved, passage, 'remove')).toBe(body);
    expect(() => changePassage(saved, passage, 'link', 'Notes/One.md')).toThrow('wiki-link label');
    const root = document.createElement('article');
    renderBody(saved, root, '');
    expect(root.querySelectorAll('mark')).toHaveLength(1);
    expect(root.querySelector('mark')!.textContent?.replace(/\s+/g, ' ')).toBe(quote);
    expect(() => locateSelection(saved, quote)).toThrow(UnmappableSelection);
  },
);

it.each([
  ['first\n\nsecond', '==first\n\nsecond=='],
  ['# first\nsecond', '# ==first\nsecond=='],
  ['first  \nsecond', '==first  \nsecond=='],
  ['first\\\nsecond', '==first\\\nsecond=='],
  ['first\n- second', '==first\n- second=='],
])('never converts unsafe cross-block/hard-break source to a highlight: %s', (body, authored) => {
  expect(() => locateSelection(body, 'first second')).toThrow(UnmappableSelection);
  expect(passages(authored)).toEqual([]);
  const root = document.createElement('article');
  renderBody(authored, root, '');
  expect(root.querySelector('mark')).toBeNull();
});

it.each([
  '> ==first\n>\n> second==',
  '- ==first\n- second==',
  '- ==first\n\n  second==',
  '> ==first  \n> second==',
  '- ==first\\\n  second==',
  '> # ==first\n> second==',
  '> `==literal==`',
  '- `==literal==`',
  '> ```\n> ==literal==\n> ```',
  '- prose\n\n      ==literal==',
  '- prose\n\n\t\t==literal==',
  '>     ==literal==',
  '> ==first  \r\n> second==',
  '- ==first\r\n- second==',
  '> \\==literal\\==',
  '- \\==literal\\==',
])('keeps container block boundaries, hard breaks, escapes and code protected: %j', (body) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelector('mark')).toBeNull();
  expect(passages(body)).toEqual([]);
  expect(hasAnnotations(body, {})).toBe(false);
});

it.each([
  '    ==literal==',
  '\t==literal==',
  'first\n\n    ==literal==',
  'first\r\n\r\n\t==literal==',
  'before\n    `==literal==` after',
  'before\r\n\t`==literal==` after',
  'first\n    `==literal==`\n---',
  'first\r\n\t`==literal==`\r\n---',
  '<!--\n==first\n    second==\n-->',
  '==first\n\n    second==',
])('retains block and inline protection after restoring top-level prose: %j', (body) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelector('mark')).toBeNull();
  expect(passages(body)).toEqual([]);
  expect(hasAnnotations(body, {})).toBe(false);
});

it('does not undo cross-paragraph comment masks when restoring prose', () => {
  const body = '%%\n\n==first\n    second==\n\n%%';
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelector('mark')).toBeNull();
  expect(root.textContent?.trim()).toBe('');
  expect(passages(body)).toEqual([]);
  expect(hasAnnotations(body, {})).toBe(false);
});

it.each([0, 1, 2, 3, 4, 5])(
  'uses inline-token backtick escaping evidence (%i backslashes)',
  (escapes) => {
    const tick = '\\'.repeat(escapes) + '`',
      body = tick + '==keep==' + tick;
    const root = document.createElement('article');
    renderBody(body, root, '');
    const count = escapes % 2;
    expect(root.querySelectorAll('mark')).toHaveLength(count);
    expect(passages(body)).toHaveLength(count);
    expect(hasAnnotations(body, {})).toBe(!!count);
    if (count) expect(changePassage(body, passages(body)[0], 'remove')).toBe(tick + 'keep' + tick);
  },
);

it.each([
  ['before `==keep==`` after', 1],
  ['before ``==keep==` after', 1],
  ['before ``==keep==``` after', 1],
  ['before `a `` ==hidden== ` after', 0],
  ['before ``a ` ==hidden== `` after', 0],
  ['`==hidden==\\`', 0],
  ['**\\`==keep==\\`**', 1],
  ['==before `literal== after`', 1],
] as const)('agrees on mixed inline delimiter runs: %j', (body, count) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelectorAll('mark')).toHaveLength(count);
  expect(passages(body)).toHaveLength(count);
  expect(hasAnnotations(body, {})).toBe(!!count);
});

it.each([
  '%% ==hidden== %%',
  'before %% ==hidden== %% after',
  '%% hidden\n\n==hidden==\n\n%%',
  '%% hidden\r\n\r\n==hidden==\r\n\r\n%%',
  '> %% ==hidden== %%',
  '- %% ==hidden== %%',
  '%% ==hidden==',
  '\\`%% ==hidden== %%\\`',
])('hides protected Obsidian comments in actual rendered output: %j', (body) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelector('mark')).toBeNull();
  expect(root.textContent).not.toContain('hidden');
  expect(root.textContent).not.toContain('%%');
  expect(passages(body)).toEqual([]);
  expect(hasAnnotations(body, {})).toBe(false);
});

it.each([
  '`%% ==literal== %%`',
  '``%% ` ==literal== %%``',
  '```md\n%% ==literal== %%\n```',
  '~~~md\r\n%% ==literal== %%\r\n~~~',
  '    %% ==literal== %%',
  '> `%% ==literal== %%`',
  '- `%% ==literal== %%`',
  '| code |\n| --- |\n| `%% ==literal== %%` |',
  '| code |\n| --- |\n| `%% a\\|b ==literal== %%` |',
  '[A \\] `%% ==literal== %%`](https://example.com)',
])('keeps percent-delimiter code literals visible and non-annotated: %j', (body) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelector('code')?.textContent).toContain('%%');
  expect(root.querySelector('code')?.textContent).toContain('==literal==');
  expect(root.querySelector('mark')).toBeNull();
  expect(passages(body)).toEqual([]);
  expect(hasAnnotations(body, {})).toBe(false);
});

it('does not treat percent delimiters in a native-link target as prose comments', () => {
  const body = '==[[Notes/100%% complete.md|keep]]==';
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelector('mark a')?.textContent).toBe('keep');
  expect(decodeURI(root.querySelector('a')!.getAttribute('href')!)).toBe('Notes/100%% complete.md');
  expect(passages(body)[0].target).toBe('Notes/100%% complete.md');
  expect(hasAnnotations(body, {})).toBe(true);
});

it.each([
  '%% hidden %% ==keep==',
  '%% hidden\n\nsecret %% ==keep==',
  '%% ` hidden\n\nsecret %% ==keep== ` %% hidden %%',
  '==keep %% hidden  \nsecret %% visible==',
])('every visible mark retains the article across comment removal: %j', (body) => {
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(root.querySelectorAll('mark')).toHaveLength(1);
  expect(root.textContent).not.toContain('hidden');
  expect(root.textContent).not.toContain('secret');
  expect(hasAnnotations(body, {})).toBe(true);
});

it('does not let an unmatched opener consume a later valid highlight in another paragraph', () => {
  const body = '==Unclosed opener.\n\nA ==valid highlight== remains.';
  const root = document.createElement('article');
  renderBody(body, root, '');
  expect(passages(body).map((passage) => passage.text)).toEqual(['valid highlight']);
  expect([...root.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'valid highlight',
  ]);
});

it.each(['', '   ', 'rgba(1, 2, 3, 0.4)'])(
  'uses a local fallback only when the theme highlight property is empty: %j',
  (color) => {
    const root = document.createElement('article');
    document.body.append(root);
    root.style.setProperty('--text-highlight-bg', color);
    const before = root.style.getPropertyValue('--text-highlight-bg');
    renderBody('==visible==', root, '');
    expect(root.querySelector('mark')?.textContent).toBe('visible');
    expect(root.classList.contains('reader-highlight-fallback')).toBe(!color.trim());
    expect(root.style.getPropertyValue('--text-highlight-bg')).toBe(before);
  },
);

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

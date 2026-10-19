// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TapText } from '../src/reader/tap-text';
import { addHighlight, locateSelection } from '../src/core/annotations';

function article(html: string): HTMLElement {
  const root = document.createElement('article');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
const text = (element: Element): Text => element.firstChild as Text;
const rect = (x: number, y: number, width = 8, height = 20): DOMRect =>
  new DOMRect(x, y, width, height);
const documentProperties = [
  'elementFromPoint',
  'caretPositionFromPoint',
  'caretRangeFromPoint',
] as const;
const originals = new Map(
  documentProperties.map((property) => [
    property,
    Object.getOwnPropertyDescriptor(document, property),
  ]),
);
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
function documentMethod(name: (typeof documentProperties)[number], value: unknown): void {
  Object.defineProperty(document, name, { configurable: true, value });
}

/** Synthetic glyph geometry, not a native rendering/device acceptance test. */
function geometry(
  root: HTMLElement,
  position = (offset: number) => rect(10 + offset * 10, 10),
): void {
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 600, 120));
  documentMethod(
    'elementFromPoint',
    vi.fn(() => root.querySelector('p') ?? root),
  );
  const starts = new Map<Node, number>(),
    nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null,
    length = 0;
  while ((node = nodes.nextNode())) {
    starts.set(node, length);
    length += node.nodeValue!.length;
  }
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      const start = starts.get(this.startContainer),
        end = starts.get(this.endContainer);
      if (start === undefined || end === undefined) return [];
      return Array.from({ length: end + this.endOffset - start - this.startOffset }, (_, offset) =>
        position(start + this.startOffset + offset),
      );
    },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const property of documentProperties) {
    const original = originals.get(property);
    if (original) Object.defineProperty(document, property, original);
    else Reflect.deleteProperty(document, property);
  }
  if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  document.body.replaceChildren();
});

describe('TapText DOM ranges', () => {
  it('joins word fragments across emphasis, links, marks and plain text', () => {
    const root = article('<p>inter<strong>na<em>tion</em></strong><a>al</a> agreement!</p>'),
      tap = new TapText(root),
      word = tap.word(text(root.querySelector('em')!), 2)!;
    expect(word.toString()).toBe('international');
    expect(word.startContainer).toBe(text(root.querySelector('p')!));
    expect(word.startOffset).toBe(0);
    expect(word.endContainer).toBe(text(root.querySelector('a')!));
    expect(word.endOffset).toBe(2);
    expect(tap.word(root.querySelector('p')!.lastChild!, 6)?.toString()).toBe('agreement!');
  });

  it('includes opening/closing quotes, commas and final punctuation in word ranges', () => {
    const root = article('<p>“Hello,” <em>world</em>!</p>'),
      tap = new TapText(root),
      first = tap.word(text(root.querySelector('p')!), 3)!,
      last = tap.word(text(root.querySelector('em')!), 4)!;
    expect(first.toString()).toBe('“Hello,”');
    expect(last.toString()).toBe('world!');
    expect(tap.between(first, last)?.toString()).toBe('“Hello,” world!');
    expect(tap.between(last, first)?.toString()).toBe('“Hello,” world!');
    expect(tap.between(last, last)?.toString()).toBe('world!');
  });

  it('keeps apostrophes, decomposed accents and UTF-16 emoji intact', () => {
    const root = article("<p>Don't stop 👩‍💻. cafe\u0301 naïve.</p>"),
      node = text(root.querySelector('p')!),
      tap = new TapText(root);
    expect(tap.word(node, 3)?.toString()).toBe("Don't");
    expect(tap.word(node, node.data.indexOf('👩') + 1)?.toString()).toBe('👩‍💻.');
    expect(tap.word(node, node.data.indexOf('cafe') + 4)?.toString()).toBe('cafe\u0301');
    expect(tap.word(node, node.data.indexOf('naïve') + 2)?.toString()).toBe('naïve.');
  });

  it('segments scripts without whitespace and retains adjacent sentence punctuation', () => {
    const root = article('<p lang="ja">日本語。次です！</p>'),
      node = text(root.querySelector('p')!),
      tap = new TapText(root),
      first = tap.word(node, 1)!;
    expect(first.toString()).toBe('日本語。');
    expect(tap.sentence(first)?.toString()).toBe('日本語。');
    expect(tap.sentence(tap.word(node, 4)!)?.toString()).toBe('次です！');
    expect(tap.between(first, tap.word(node, node.length)!)?.toString()).toBe(node.data);
  });

  it('resolves either side of cross-inline caret boundaries without truncating a word', () => {
    const root = article('<p>inter<em>nation</em>al</p>'),
      tap = new TapText(root),
      emphasis = text(root.querySelector('em')!);
    expect(tap.word(emphasis, 0)?.toString()).toBe('international');
    expect(tap.word(emphasis, emphasis.length)?.toString()).toBe('international');
    expect(tap.word(root.querySelector('p')!.lastChild!, 2)?.toString()).toBe('international');
  });

  it('finds the containing sentence across formatting and trims only its outer whitespace', () => {
    const root = article('<p>  “First <em>sentence</em>!”  Next <strong>one</strong>? End.</p>'),
      tap = new TapText(root);
    expect(tap.sentence(tap.word(text(root.querySelector('em')!), 3)!)?.toString()).toBe(
      '“First sentence!”',
    );
    expect(tap.sentence(tap.word(text(root.querySelector('strong')!), 1)!)?.toString()).toBe(
      'Next one?',
    );
    expect(tap.sentence(tap.word(root.querySelector('p')!.lastChild!, 4)!)?.toString()).toBe(
      'End.',
    );
  });

  it('selects a whole paragraph with soft newlines but not the following paragraph', () => {
    const root = article('<p>  Alpha\n <em>beta.</em>\n Gamma!  </p><p>Unrelated.</p>'),
      tap = new TapText(root),
      word = tap.word(text(root.querySelector('em')!), 2)!;
    expect(tap.paragraph(word)?.toString()).toBe('Alpha\n beta.\n Gamma!');
    expect(tap.sentence(word)?.toString()).toBe('Alpha\n beta.');
  });

  it('treats adjacent blocks as separate words and refuses a multi-block range', () => {
    const root = article('<p>inter</p><p>national!</p>'),
      [first, last] = Array.from(root.children, (p) => text(p)),
      tap = new TapText(root),
      firstWord = tap.word(first, 2)!,
      lastWord = tap.word(last, 3)!;
    expect(firstWord.toString()).toBe('inter');
    expect(lastWord.toString()).toBe('national!');
    expect(tap.between(firstWord, lastWord)).toBeUndefined();
    expect(tap.between(lastWord, firstWord)).toBeUndefined();
    expect(tap.sentence(firstWord)?.toString()).toBe('inter');
  });

  it('handles direct root text and list/heading prose without including nested list blocks', () => {
    const root = article(
        'Direct <em>word.</em><h2>Heading!</h2><ul><li>Outer<ul><li>Nested.</li></ul>end.</li></ul>',
      ),
      tap = new TapText(root),
      outer = root.querySelector('li')!;
    expect(tap.word(text(root.querySelector('em')!), 1)?.toString()).toBe('word.');
    expect(tap.paragraph(tap.word(text(root.querySelector('h2')!), 2)!)?.toString()).toBe(
      'Heading!',
    );
    expect(tap.word(text(outer), 2)?.toString()).toBe('Outer');
    expect(tap.paragraph(tap.word(text(outer), 2)!)).toBeUndefined();
    expect(tap.sentence(tap.word(text(outer.querySelector('li')!), 2)!)?.toString()).toBe(
      'Nested.',
    );
  });

  it.each([
    '<img src="x">',
    '<input value="x">',
    '<br>',
    '<code>protected</code>',
    '<span hidden>hidden</span>',
  ])('uses a barrier at %s rather than fabricating a cross-element word or paragraph', (middle) => {
    const root = article(`<p>before${middle}after.</p>`),
      p = root.querySelector('p')!,
      tap = new TapText(root),
      first = tap.word(text(p), 2)!,
      last = tap.word(p.lastChild!, 2)!;
    expect(first.toString()).toBe('before');
    expect(last.toString()).toBe('after.');
    expect(tap.between(first, last)).toBeUndefined();
    expect(tap.paragraph(first)).toBeUndefined();
    expect(tap.sentence(last)?.toString()).toBe('after.');
  });

  it.each(['button', 'textarea', 'select', 'pre', 'code', 'script', 'style', 'svg'])(
    'ignores text inside %s',
    (tag) => {
      const root = article(`<${tag}>Not prose.</${tag}>`),
        tap = new TapText(root);
      expect(tap.word(text(root.firstElementChild!), 2)).toBeUndefined();
    },
  );

  it('ignores hidden, editable, foreign and invalid text-node boundaries', () => {
    const root = article(
        '<p>Word.</p><p aria-hidden="true">Hidden</p><div contenteditable>Editable</div>',
      ),
      tap = new TapText(root),
      node = text(root.querySelector('p')!);
    for (const offset of [-1, 0.5, node.length + 1, NaN, Infinity])
      expect(tap.word(node, offset)).toBeUndefined();
    expect(tap.word(text(root.children[1]), 1)).toBeUndefined();
    expect(tap.word(text(root.children[2]), 1)).toBeUndefined();
    expect(tap.word(document.createTextNode('foreign'), 1)).toBeUndefined();
    expect(tap.word(root, 0)).toBeUndefined();
    expect(
      new TapText(article(' \t\n ')).word(document.body.lastChild!.firstChild!, 1),
    ).toBeUndefined();
  });

  it('rejects empty, protected and foreign ranges passed to range-expansion methods', () => {
    const root = article('<p>Prose <code>code</code></p>'),
      foreign = article('Foreign.'),
      tap = new TapText(root),
      empty = document.createRange(),
      code = document.createRange();
    empty.setStart(text(root.querySelector('p')!), 2);
    code.selectNodeContents(root.querySelector('code')!);
    const foreignWord = new TapText(foreign).word(text(foreign), 1)!;
    for (const range of [empty, code, foreignWord]) {
      expect(tap.sentence(range)).toBeUndefined();
      expect(tap.paragraph(range)).toBeUndefined();
      expect(tap.between(range, range)).toBeUndefined();
    }
  });

  it('reindexes the current block after text changes instead of using a stale cached index', () => {
    const root = article('<p>Old <em>word</em>.</p>'),
      tap = new TapText(root),
      node = text(root.querySelector('em')!);
    expect(tap.word(node, 2)?.toString()).toBe('word.');
    node.data = 'replacement';
    expect(tap.word(node, 2)?.toString()).toBe('replacement.');
  });

  it('reads only the containing block and bounds pathological block text/node counts', () => {
    const root = article('<p>Ignored.</p><p>Target <em>word</em>.</p>'),
      ignored = text(root.querySelector('p')!);
    Object.defineProperty(ignored, 'nodeValue', {
      get: () => {
        throw new Error('Unrelated block read');
      },
    });
    const tap = new TapText(root),
      node = text(root.querySelector('em')!);
    expect(tap.paragraph(tap.word(node, 2)!)?.toString()).toBe('Target word.');
    const long = article(`<p>${'a'.repeat(100_001)}</p>`);
    expect(new TapText(long).word(text(long.querySelector('p')!), 1)).toBeUndefined();
    const dense = article('<p>word</p>'),
      p = dense.firstElementChild!;
    for (let i = 0; i < 4096; i++) p.append(document.createTextNode(''));
    expect(new TapText(dense).word(text(p), 1)).toBeUndefined();
  });

  it('segments only the touched token in a long whitespace-delimited paragraph', () => {
    const root = article(`<p>${'before '.repeat(2000)}needle! ${'after '.repeat(2000)}</p>`),
      node = text(root.querySelector('p')!),
      tap = new TapText(root),
      segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
    expect(tap.word(node, node.data.indexOf('needle') + 2)?.toString()).toBe('needle!');
    expect(segment.mock.calls.map(([input]) => input)).toEqual(['needle!']);
  });

  it('falls back to Unicode whitespace tokens and sentence delimiters without Intl.Segmenter', () => {
    vi.stubGlobal('Intl', { Segmenter: undefined });
    const root = article('<p>  First <em>sentence</em>! Next café.</p>'),
      tap = new TapText(root),
      first = tap.word(text(root.querySelector('em')!), 2)!;
    expect(first.toString()).toBe('sentence!');
    expect(tap.sentence(first)?.toString()).toBe('First sentence!');
    expect(tap.sentence(tap.word(root.querySelector('p')!.lastChild!, 8)!)?.toString()).toBe(
      'Next café.',
    );
  });

  it('tolerates invalid inherited language tags', () => {
    const root = article('<p>Word.</p>');
    root.lang = 'not_a_locale';
    expect(new TapText(root).word(text(root.querySelector('p')!), 2)?.toString()).toBe('Word.');
  });

  it('feeds an ordinary, punctuation-inclusive range through the existing guarded source mapping', () => {
    const root = article('<p>First inter<strong>national</strong> agreement!</p>'),
      tap = new TapText(root),
      first = tap.word(text(root.querySelector('strong')!), 2)!,
      last = tap.word(root.querySelector('p')!.lastChild!, 5)!,
      quote = tap.between(first, last)!.toString(),
      source = 'First inter**national** agreement!',
      located = locateSelection(source, quote);
    expect(quote).toBe('international agreement!');
    expect(addHighlight(source, located.from, located.to)).toBe(
      'First ==inter**national** agreement!==',
    );
  });
});

describe('TapText point hit testing', () => {
  it('uses Firefox caret positions, including cross-inline words, without touching Selection/DOM', () => {
    const root = article('<p>inter<strong>nation</strong>al final.</p>'),
      node = text(root.querySelector('strong')!),
      original = root.innerHTML;
    geometry(root);
    const selection = vi.spyOn(document, 'getSelection');
    documentMethod(
      'caretPositionFromPoint',
      vi.fn(() => ({ offsetNode: node, offset: 3 })),
    );
    expect(new TapText(root).wordAt(85, 20)?.toString()).toBe('international');
    expect(selection).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe(original);
  });

  it('uses Chromium/WebKit caret ranges when caretPositionFromPoint is unavailable or null', () => {
    const root = article('<p>First last!</p>'),
      node = text(root.querySelector('p')!),
      caret = document.createRange();
    geometry(root);
    caret.setStart(node, node.length);
    documentMethod(
      'caretPositionFromPoint',
      vi.fn(() => null),
    );
    const chromium = vi.fn(() => caret);
    documentMethod('caretRangeFromPoint', chromium);
    expect(new TapText(root).wordAt(115, 20)?.toString()).toBe('last!');
    expect(chromium).toHaveBeenCalledWith(115, 20);
  });

  it('checks both sides when the caret is exactly between adjoining script words', () => {
    const root = article('<p>日本語。次です！</p>'),
      node = text(root.querySelector('p')!);
    geometry(root);
    documentMethod('caretPositionFromPoint', () => ({ offsetNode: node, offset: 4 }));
    expect(new TapText(root).wordAt(45, 20)?.toString()).toBe('日本語。');
  });

  it('falls back to rect-verified hit-block text when both caret APIs are absent', () => {
    const root = article('<p>inter<em>nation</em>al final!</p>');
    geometry(root);
    expect(new TapText(root).wordAt(85, 20)?.toString()).toBe('international');
    expect(new TapText(root).wordAt(185, 20)?.toString()).toBe('final!');
  });

  it('falls back when a native caret is outside the root instead of selecting foreign text', () => {
    const root = article('<p>Local word.</p>'),
      foreign = article('Foreign.');
    geometry(root);
    documentMethod('caretPositionFromPoint', () => ({ offsetNode: text(foreign), offset: 2 }));
    expect(new TapText(root).wordAt(25, 20)?.toString()).toBe('Local');
  });

  it('rejects nearest-word margin, padding, inter-word whitespace and line-gap taps', () => {
    const root = article('<p>First last!</p>'),
      node = text(root.querySelector('p')!);
    geometry(root);
    documentMethod('caretPositionFromPoint', () => ({ offsetNode: node, offset: 5 }));
    const tap = new TapText(root);
    for (const [x, y] of [
      [300, 20],
      [4, 20],
      [64, 20],
      [20, 60],
      [20, 5],
    ])
      expect(tap.wordAt(x, y)).toBeUndefined();
  });

  it('uses individual word rects, not the bounding box between wrapped inline fragments', () => {
    const root = article('<p>inter<em>national</em></p>'),
      node = text(root.querySelector('em')!);
    geometry(root, (offset) =>
      offset < 5 ? rect(10 + offset * 10, 10) : rect(10 + (offset - 5) * 10, 70),
    );
    documentMethod('caretPositionFromPoint', () => ({ offsetNode: node, offset: 3 }));
    expect(new TapText(root).wordAt(25, 50)).toBeUndefined();
    expect(new TapText(root).wordAt(25, 80)?.toString()).toBe('international');
  });

  it('ignores padded inline element boxes and verifies only text-node glyph rects', () => {
    const root = article('<p>inter<em>national</em></p>'),
      node = text(root.querySelector('em')!);
    geometry(root);
    const glyphRects = Range.prototype.getClientRects;
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        return this.startContainer === this.endContainer
          ? glyphRects.call(this)
          : [rect(0, 0, 300, 100)];
      },
    });
    documentMethod('caretPositionFromPoint', () => ({ offsetNode: node, offset: 3 }));
    const tap = new TapText(root);
    expect(tap.wordAt(250, 20)).toBeUndefined();
    expect(tap.wordAt(85, 20)?.toString()).toBe('international');
  });

  it('handles reversed glyph geometry in bidirectional prose using DOM-ordered ranges', () => {
    const root = article('<p>مرحبا <em>بالعالم</em>!</p>'),
      node = text(root.querySelector('em')!);
    geometry(root, (offset) => rect(180 - offset * 10, 10));
    documentMethod('caretPositionFromPoint', () => ({ offsetNode: node, offset: 2 }));
    const tap = new TapText(root),
      last = tap.wordAt(105, 20)!;
    expect(last.toString()).toBe('بالعالم!');
    expect(tap.between(last, tap.word(text(root.querySelector('p')!), 1)!)?.toString()).toBe(
      'مرحبا بالعالم!',
    );
  });

  it('refuses outside-root, nonfinite and overlay hits before querying native carets', () => {
    const root = article('<p>Word.</p>');
    geometry(root);
    const native = vi.fn(() => ({ offsetNode: text(root.querySelector('p')!), offset: 2 }));
    documentMethod('caretPositionFromPoint', native);
    const tap = new TapText(root);
    for (const [x, y] of [
      [-1, 20],
      [601, 20],
      [20, 121],
      [NaN, 20],
      [20, Infinity],
    ])
      expect(tap.wordAt(x, y)).toBeUndefined();
    documentMethod('elementFromPoint', () => document.body);
    expect(tap.wordAt(25, 20)).toBeUndefined();
    documentMethod('elementFromPoint', () => null);
    expect(tap.wordAt(25, 20)).toBeUndefined();
    expect(native).not.toHaveBeenCalled();
  });

  it.each([
    '<button>Action</button>',
    '<img alt="Image">',
    '<input>',
    '<code>Code</code>',
    '<span hidden>Hidden</span>',
  ])('refuses a hit on %s even if the native caret points to nearby prose', (element) => {
    const root = article(`<p>Word.${element}</p>`),
      node = text(root.querySelector('p')!);
    geometry(root);
    documentMethod('elementFromPoint', () => root.querySelector('p')!.firstElementChild);
    const native = vi.fn(() => ({ offsetNode: node, offset: 2 }));
    documentMethod('caretPositionFromPoint', native);
    expect(new TapText(root).wordAt(25, 20)).toBeUndefined();
    expect(native).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { changePassage, hasAnnotations, passages } from '../src/core/annotations';
import { renderBody } from '../src/reader/render';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();
function render(body: string): HTMLElement {
  const root = document.createElement('article');
  document.body.append(root);
  disposers.push(renderBody(body, root, ''));
  return root;
}
const marks = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('mark')].map((mark) => normalized(mark.textContent ?? ''));
const tickPair = (backslashes: number, word: string): string => {
  const delimiter = '\\'.repeat(backslashes) + '`';
  return `${delimiter}==${word}==${delimiter}`;
};

type Fixture = {
  name: string;
  body: string;
  marks: string[];
  editable?: boolean;
  hidden?: string[];
  code?: string;
};

// All comments here have explicit paired delimiters. Unclosed/escaped comment
// delimiters and comments crossing code-block boundaries need separate contract decisions.
// No links or frontmatter: retention in this matrix must come from real highlights alone.
const fixtures: Fixture[] = [
  {
    name: 'one backslash escapes literal backticks in ordinary prose',
    body: tickPair(1, 'odd'),
    marks: ['odd'],
  },
  {
    name: 'three backslashes escape literal backticks in a quote',
    body: `> ${tickPair(3, 'odd nested')}`,
    marks: ['odd nested'],
  },
  {
    name: 'a shorter unmatched opener does not consume a longer closing run',
    body: 'prefix `==short==`` suffix',
    marks: ['short'],
  },
  {
    name: 'a longer unmatched opener does not consume a shorter closing run',
    body: 'prefix ``==long==` suffix',
    marks: ['long'],
  },
  {
    name: 'four-space paragraph continuation with LF',
    body: '==first\n    second==',
    marks: ['first second'],
  },
  {
    name: 'tab paragraph continuation with CRLF',
    body: '==first\r\n\tsecond==',
    marks: ['first second'],
  },
  {
    name: 'quote continuation with CRLF',
    body: '> ==first\r\n> second==',
    marks: ['first second'],
  },
  {
    name: 'list continuation with a tab and LF',
    body: '- ==first\n\tsecond==',
    marks: ['first second'],
  },
  {
    name: 'ordered-list indentation with CRLF',
    body: '123. ==first\r\n     second==',
    marks: ['first second'],
  },
  {
    name: 'top-level Setext heading with a tab and LF',
    body: '==first\n\tsecond==\n---',
    marks: ['first second'],
  },
  {
    name: 'nested Setext heading with CRLF',
    body: '> ==first\r\n> second==\r\n> ---',
    marks: ['first second'],
  },
  {
    name: 'inline comment before an identical visible highlight',
    body: '%% comment-only ==same== %% ==same==',
    marks: ['same'],
    hidden: ['comment-only', '%%'],
  },
  {
    name: 'cross-paragraph CRLF comment between real highlights',
    body: '==left==\r\n\r\n%% comment-only\r\n\r\n==same==\r\n\r\n%%\r\n\r\n==same==',
    marks: ['left', 'same'],
    hidden: ['comment-only', '%%'],
  },
  {
    name: 'a nested comment does not mask subsequent prose',
    body: '> %% secret ==ignored== %%\n>\n> ==kept==',
    marks: ['kept'],
    hidden: ['secret', 'ignored', '%%'],
  },
  {
    name: 'two backslashes leave a genuine code-span opener',
    body: tickPair(2, 'even'),
    marks: [],
    code: '==even==',
  },
  {
    name: 'four backslashes leave a genuine code span in a list',
    body: `- ${tickPair(4, 'even nested')}`,
    marks: [],
    code: '==even nested==',
  },
  {
    name: 'ordinary inline code keeps highlight delimiters literal',
    body: '`==literal==`',
    marks: [],
    code: '==literal==',
  },
  {
    name: 'matching double ticks contain a literal single tick',
    body: '``==literal ` inner==``',
    marks: [],
    code: '==literal ` inner==',
  },
  {
    name: 'a backtick fence with CRLF keeps highlight delimiters literal',
    body: '```text\r\n==literal==\r\n```',
    marks: [],
    code: '==literal==',
  },
  {
    name: 'a nested tilde fence keeps highlight delimiters literal',
    body: '> ~~~\n> ==literal==\n> ~~~',
    marks: [],
    code: '==literal==',
  },
  {
    name: 'a genuine indented code block is not paragraph continuation',
    body: '    ==literal==',
    marks: [],
    code: '==literal==',
  },
  {
    name: 'an inline comment alone contributes no mark or annotation',
    body: 'before %% hidden ==ignored== %% after',
    marks: [],
    hidden: ['hidden', 'ignored', '%%'],
  },
  {
    name: 'a cross-paragraph comment alone contributes no mark or annotation',
    body: 'before\n\n%%\n\nhidden ==ignored==\n\n%%\n\nafter',
    marks: [],
    hidden: ['hidden', 'ignored', '%%'],
  },
  {
    name: 'percent delimiters inside inline code remain visible literals',
    body: '`%% ==literal== %%`',
    marks: [],
    code: '%% ==literal== %%',
  },
  {
    name: 'percent delimiters inside a fence remain visible literals',
    body: '~~~text\n%% ==literal== %%\n~~~',
    marks: [],
    code: '%% ==literal== %%',
  },
  {
    name: 'a backslash inside code does not escape its closing delimiter',
    body: '`==literal==\\`',
    marks: [],
    code: '==literal==\\',
  },
  {
    name: 'a mark enclosing inline code is retained but not editable',
    body: '==before `literal` after==',
    marks: ['before literal after'],
    editable: false,
  },
  {
    name: 'a nested mark enclosing a comment is retained but not editable',
    body: '> ==before\r\n> %% secret %% after==',
    marks: ['before after'],
    editable: false,
    hidden: ['secret', '%%'],
  },
];

it.each(fixtures)('$name', (fixture) => {
  const { body } = fixture,
    root = render(body);
  expect(marks(root)).toEqual(fixture.marks);
  expect(hasAnnotations(body, {})).toBe(fixture.marks.length > 0);
  for (const hidden of fixture.hidden ?? []) expect(root.textContent).not.toContain(hidden);
  if (fixture.code !== undefined)
    expect(root.querySelector('code')?.textContent).toContain(fixture.code);

  const source = passages(body);
  if (fixture.editable === false) {
    expect(source).toEqual([]);
    return;
  }
  expect(source).toHaveLength(fixture.marks.length);
  for (const [index, passage] of source.entries()) {
    expect(Number.isInteger(passage.from)).toBe(true);
    expect(Number.isInteger(passage.to)).toBe(true);
    expect(passage.from).toBeGreaterThanOrEqual(index ? source[index - 1].to : 0);
    expect(passage.to).toBeGreaterThan(passage.from);
    expect(passage.to).toBeLessThanOrEqual(body.length);
    expect(body.slice(passage.from, passage.to)).toBe(`==${passage.text}==`);
    expect(changePassage(body, passage, 'unlink')).toBe(body);

    const removed = changePassage(body, passage, 'remove');
    expect(removed).toBe(body.slice(0, passage.from) + passage.text + body.slice(passage.to));
    // Removing a mapped passage must affect the corresponding visible mark, not
    // an identical string inside a comment, nor any other mark or container bytes.
    const remaining = fixture.marks.filter((_, at) => at !== index);
    expect(marks(render(removed))).toEqual(remaining);
    expect(hasAnnotations(removed, {})).toBe(remaining.length > 0);
    if (/[\r\n]/.test(passage.text))
      expect(() => changePassage(body, passage, 'link', 'Notes/Target.md')).toThrow(
        'wiki-link label',
      );
  }
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { renderBody } from '../src/reader/render';

const css = readFileSync('src/reader/styles.css', 'utf8');
const selector = css.match(/^(\.reader-document\s+> :is\(p, h1,[^{]+)\{/m)![1]!.trim();
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

function proseBlocks(markdown: string): string[] {
  const root = document.createElement('article');
  root.className = 'reader-document markdown-rendered';
  document.body.append(root);
  disposers.push(renderBody(markdown, root, 'https://example.com/article'));
  return [...root.querySelectorAll(selector)].map((block) => block.tagName);
}

it('bounds top-level prose without inserting wrappers or changing authored text', () => {
  expect(
    proseBlocks(
      '# Heading\n\nOrdinary **prose** with [a link](https://example.com).\n\n- A list\n- More\n\n> A quotation',
    ),
  ).toEqual(['H1', 'P', 'UL', 'BLOCKQUOTE']);
  expect(document.querySelector('article')?.textContent).toContain('Ordinary prose with a link.');
  expect(document.querySelector('article')?.children).toHaveLength(4);
});

it.each([
  ['standalone image', '![Figure](https://example.com/image.png)'],
  ['linked image', '[![Figure](https://example.com/image.png)](https://example.com)'],
  ['mixed image and text', 'Before ![Figure](https://example.com/image.png) after'],
  ['image in list', '- Text\n- ![Figure](https://example.com/image.png)'],
  ['image in quotation', '> Text\n>\n> ![Figure](https://example.com/image.png)'],
  ['code', '```js\nconst example = "wide code";\n```'],
  ['code in list', '- Example\n\n  ```js\n  const example = "wide code";\n  ```'],
  ['code in quotation', '> ```js\n> const example = "wide code";\n> ```'],
  ['table', '| A | B |\n| - | - |\n| one | two |'],
  ['table in quotation', '> | A | B |\n> | - | - |\n> | one | two |'],
])('leaves %s and its containing block unbounded', (_name, markdown) => {
  expect(proseBlocks(markdown)).toEqual([]);
  expect(document.querySelector('article')?.children.length).toBeGreaterThan(0);
});

it('uses a body-size measure for prose and headings without narrowing paged geometry', () => {
  expect(css).toContain('--reader-prose-width: calc(var(--font-text-size) * 35);');
  const proseRule = css.slice(css.indexOf(selector)).split('}')[0]!;
  expect(proseRule).toContain('box-sizing: border-box;');
  expect(proseRule).toContain('max-inline-size: var(--reader-prose-width);');
  expect(proseRule).toContain('margin-inline: auto;');
  const titleRule = css
    .split('.reader-article-title,\n.reader-article-topics {')[1]!
    .split('}')[0]!;
  expect(titleRule).toContain(
    'max-inline-size: calc(var(--reader-prose-width) + var(--reader-scrollbar-clearance));',
  );
  expect(titleRule).toContain('padding-inline-end: var(--reader-scrollbar-clearance);');
  for (const unbounded of ['.reader-article', '.reader-view .reader-document.markdown-rendered']) {
    const rule = css.split(`${unbounded} {`)[1]!.split('}')[0]!;
    expect(rule).toContain('width: 100%;');
    expect(rule).toContain('max-width: none;');
    expect(rule).not.toContain('reader-prose-width');
  }
});

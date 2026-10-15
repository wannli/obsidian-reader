// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { renderBody } from '../src/reader/render';

// CSS/DOM contracts only; paragraph margin collapse is checked in a browser.
const css = readFileSync(new FileURL('../src/reader/styles.css', import.meta.url), 'utf8');
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.getSelection()?.removeAllRanges();
  document.head.querySelectorAll('style').forEach((style) => style.remove());
  document.body.replaceChildren();
});

it.each([
  ['image-only paragraph', '![Diagram](https://example.com/image.png)\n\nFirst prose.', 2],
  ['same-paragraph prose', '![Diagram](https://example.com/image.png)\nFirst prose.', 1],
  [
    'linked image with prose',
    '[![Diagram](https://example.com/image.png)](https://example.com)\nFirst prose.',
    1,
  ],
  ['image amid prose', 'Before ![Diagram](https://example.com/image.png) after.', 1],
] as const)(
  'spaces %s without changing Markdown text or native selection',
  (_, markdown, paragraphs) => {
    const root = document.createElement('article');
    root.className = 'reader-document markdown-rendered';
    document.body.append(root);
    disposers.push(renderBody(markdown, root, 'https://example.com'));
    const image = root.querySelector('img')!;
    const before = root.innerHTML;
    const text = root.querySelectorAll('p')[paragraphs - 1].lastChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()!.addRange(range);
    const quote = document.getSelection()!.toString();
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);

    const rule = [...style.sheet!.cssRules].find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText === '.reader-document img',
    )!;
    expect(rule.style.getPropertyValue('margin-block-end')).toBe('var(--p-spacing, 1em)');
    expect(rule.style.getPropertyValue('margin-inline')).toBe('auto');
    expect(rule.style.getPropertyValue('display')).toBe('block');
    expect(rule.style.getPropertyValue('max-height')).toBe('var(--reader-image-height, 30vh)');
    expect(rule.style.getPropertyValue('margin-block-start')).toBe('');
    expect(root.querySelectorAll('p')).toHaveLength(paragraphs);
    expect(root.innerHTML).toBe(before);
    expect(root.querySelector('img')).toBe(image);
    expect(document.getSelection()!.getRangeAt(0)).toBe(range);
    expect(document.getSelection()!.toString()).toBe(quote);
    expect(quote).not.toBe('');
    if (markdown.startsWith('[!')) expect(image.parentElement?.tagName).toBe('A');
  },
);

it('keeps the image gap scoped to Reader instead of changing paragraph margins or other images', () => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const outside = document.createElement('img');
  document.body.append(outside);
  expect(getComputedStyle(outside).marginBlockEnd).not.toBe('var(--p-spacing, 1em)');
  const paragraphRules = [...style.sheet!.cssRules].filter(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule && rule.selectorText === '.reader-document p',
  );
  expect(paragraphRules).toHaveLength(0);
});

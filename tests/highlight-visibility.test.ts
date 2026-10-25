// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderBody } from '../src/reader/render';

// CSS/DOM contracts only: jsdom does not prove wrapping, painting or e-ink contrast.
const css = readFileSync(new FileURL('../src/reader/styles.css', import.meta.url), 'utf8');
const markdown =
  'Plain text. ==saved passage== and ==[**first**\nsecond](Notes/Linked.md)==, plus [ordinary link](Notes/Other.md).';
const themes = [
  { theme: 'light', foreground: 'rgb(34, 34, 34)', background: 'rgb(255, 255, 255)' },
  { theme: 'dark', foreground: 'rgb(238, 238, 238)', background: 'rgb(30, 30, 30)' },
];
const fills = [
  { fill: 'missing fallback', value: undefined },
  { fill: 'removed theme property fallback', value: '' },
  { fill: 'transparent', value: 'transparent' },
  { fill: 'pale', value: 'rgba(250, 240, 160, 0.08)' },
  { fill: 'theme color', value: 'rgba(105, 160, 240, 0.45)' },
];
let style: HTMLStyleElement;
const disposers: (() => void)[] = [];
beforeEach(() => {
  style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.getSelection()?.removeAllRanges();
  style.remove();
  document.body.replaceChildren();
});
function fixture(paged = false, theme = themes[0], fill?: string) {
  const view = document.createElement('div');
  view.className = `reader-view theme-${theme.theme}`;
  view.style.color = theme.foreground;
  view.style.backgroundColor = theme.background;
  const viewport = document.createElement('div');
  viewport.className = `reader-viewport${paged ? ' reader-paged' : ''}`;
  const root = document.createElement('article');
  root.className = 'reader-document markdown-rendered';
  if (fill !== undefined) root.style.setProperty('--text-highlight-bg', fill);
  root.style.setProperty('--color-yellow-rgb', '180, 140, 50');
  viewport.append(root);
  view.append(viewport);
  document.body.append(view);
  disposers.push(renderBody(markdown, root, ''));
  return root;
}
function rule(selector: string) {
  const found = [...style.sheet!.cssRules].find(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === selector,
  );
  expect(found, selector).toBeDefined();
  return found!.style;
}
function expectCue(mark: HTMLElement) {
  const computed = getComputedStyle(mark);
  expect(computed.textDecorationLine).toBe('underline');
  expect(computed.textDecorationStyle).toBe('solid');
  // Newer jsdom resolves currentColor to the actual foreground value.
  expect(['currentcolor', computed.color.toLowerCase()]).toContain(
    computed.textDecorationColor.toLowerCase(),
  );
  expect(computed.textDecorationThickness).toBe('2px');
  expect(['0.12em', '1.92px']).toContain(computed.textUnderlineOffset);
}

it.each(
  themes.flatMap((theme) =>
    [false, true].flatMap((paged) =>
      fills.map((fill) => ({ ...theme, ...fill, paged, mode: paged ? 'paged' : 'flow' })),
    ),
  ),
)('shows an unfocused static cue in $theme / $mode / $fill', (test) => {
  const root = fixture(test.paged, test, test.value);
  const marks = [...root.querySelectorAll('mark')];
  const palette = getComputedStyle(root.closest('.reader-view')!);
  expect(palette.color).toBe(test.foreground);
  expect(palette.backgroundColor).toBe(test.background);
  expect(marks).toHaveLength(2);
  expect(root.classList.contains('reader-highlight-fallback')).toBe(!test.value?.trim());
  expect(root.style.getPropertyValue('--text-highlight-bg')).toBe(test.value ?? '');
  expect(root.style.getPropertyValue('--color-yellow-rgb')).toBe('180, 140, 50');
  for (const mark of marks) {
    expect(mark).not.toBe(document.activeElement);
    expect(mark.hasAttribute('style')).toBe(false);
    expectCue(mark);
  }
  // Soft-wrapped, formatted linked text remains normal inline Markdown output.
  const link = marks[1].querySelector('a')!;
  expect(link.getAttribute('href')).toBe('Notes/Linked.md');
  expect(link.classList.contains('internal-link')).toBe(true);
  expect(link.querySelector('strong')?.textContent).toBe('first');
  expect(link.textContent?.replace(/\s+/g, ' ')).toBe('first second');
  expect(root.querySelector('p > a')?.getAttribute('href')).toBe('Notes/Other.md');
  expect(document.getSelection()?.isCollapsed).toBe(true);
});

it('retains the existing theme fill, foreground and link color contracts without box changes', () => {
  const mark = rule('.reader-document mark');
  // jsdom retains inherit/var/currentColor tokens; browser checks resolve actual colors.
  expect(mark.getPropertyValue('color')).toBe('inherit');
  expect(mark.getPropertyValue('background')).toBe(
    'var(--text-highlight-bg, rgba(var(--color-yellow-rgb, 224, 172, 0), 0.4))',
  );
  expect(
    rule('.reader-document.reader-highlight-fallback mark').getPropertyValue('background'),
  ).toBe('rgba(var(--color-yellow-rgb, 224, 172, 0), 0.4)');
  expect(rule('.reader-document mark a').getPropertyValue('color')).toBe('inherit');
  // Decoration only: no padding/borders/line-height/opacity, generated content or transforms.
  expect(Array.from({ length: mark.length }, (_, index) => mark[index]).sort()).toEqual(
    [
      'color',
      'background',
      'text-decoration-line',
      'text-decoration-style',
      'text-decoration-color',
      'text-decoration-thickness',
      'text-underline-offset',
    ].sort(),
  );
});

it('does not add the mark cue to unhighlighted text or marks outside Reader documents', () => {
  const root = fixture();
  const outside = document.createElement('mark');
  outside.textContent = 'Other plugin or native preview';
  document.body.append(outside);
  expect(getComputedStyle(outside).textDecorationLine).not.toBe('underline');
  expect(getComputedStyle(root.querySelector('p')!).textDecorationLine).not.toBe('underline');
  expectCue(root.querySelector('mark')!);
});

it.each([false, true])(
  'adds the cue without replacing text or disturbing a selection (paged=%s)',
  (paged) => {
    style.remove();
    const root = fixture(paged);
    const mark = root.querySelector('mark')!;
    const text = mark.firstChild!;
    const before = root.innerHTML;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const selection = document.getSelection()!;
    selection.addRange(range);
    document.head.append(style);
    expectCue(mark);
    expect(root.innerHTML).toBe(before);
    expect(mark.firstChild).toBe(text);
    expect(selection.getRangeAt(0)).toBe(range);
    expect(selection.toString()).toBe('saved');
  },
);

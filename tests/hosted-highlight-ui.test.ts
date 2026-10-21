// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { renderBody, selectedPassage } from '../src/reader/render';
import { passages } from '../src/core/annotations';
import { VisibleText } from '../src/reader/text';
import { TapText } from '../src/reader/tap-text';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

it('excludes reference controls from visible text and cross-inline bookmarks', () => {
  const root = document.createElement('article');
  root.innerHTML =
    '<p>First <mark>original <strong>words</strong></mark><span data-reader-decoration="reference"> (※ <a href="Notes/Host.md">Host</a>)</span> after.</p>';
  document.body.append(root);
  const index = new VisibleText(root);
  expect(index.text).toBe('First original words after.');
  expect(index.range('Host')).toBeUndefined();
  expect(index.marker(root.querySelector('a')!.firstChild!, 0)).toBe('');
  const range = index.range('words after')!;
  expect(selectedPassage(root, range)).toMatchObject({
    quote: 'words after',
    before: 'First original ',
    after: '.',
  });
});

it('excludes reference text from native selection context, and rejects reference endpoints', () => {
  const root = document.createElement('article');
  root.innerHTML =
    '<p>Before<span data-reader-decoration="reference"> (※ Host)</span> selected <em>words</em><span data-reader-decoration="reference"> (※ Other)</span> after.</p>';
  document.body.append(root);
  const range = document.createRange();
  range.setStart(root.querySelector('p')!.childNodes[2], 1);
  range.setEnd(root.querySelector('em')!.firstChild!, 5);
  expect(selectedPassage(root, range)).toMatchObject({
    quote: 'selected words',
    before: 'Before ',
    after: ' after.',
  });
  range.setEnd(root.querySelector('[data-reader-decoration]')!.firstChild!, 3);
  expect(selectedPassage(root, range)).toBeUndefined();
});

it('renders one logical passage across native formatting, with uniform excluded references and a hidden paragraph anchor', () => {
  const body =
    'Before ==one ==**==two==** (※ [[Nodes/Topic.md]], [[Nodes/Project.md]]) after. ^reader-example';
  const root = document.createElement('article');
  document.body.append(root);
  disposers.push(renderBody(body, root, 'https://publisher.test/article'));
  expect(passages(body)).toHaveLength(1);
  const marks = [...root.querySelectorAll<HTMLElement>('mark')];
  expect(marks.map((mark) => mark.dataset.readerPassage)).toEqual(['0', '0']);
  expect(root.querySelector('strong mark')?.textContent).toBe('two');
  expect(root.querySelectorAll('.reader-reference-group')).toHaveLength(1);
  expect(
    [...root.querySelectorAll('.reader-reference-pill')].map((link) => link.textContent),
  ).toEqual(['Topic', 'Project']);
  expect(
    [...root.querySelectorAll('.reader-reference-label')].map((label) => label.textContent),
  ).toEqual(['Topic', 'Project']);
  expect(root.querySelector('.reader-reference-prefix')).toBeNull();
  const references = root.querySelector('.reader-reference-group')!;
  expect(references.getAttribute('data-reader-decoration')).toBe('reference');
  expect(references.textContent).not.toContain('※');
  expect(root.querySelector('[data-reader-paragraph]')?.id).toBe('^reader-example');
  expect(
    root.querySelector('[data-reader-decoration="paragraph-anchor"]')?.hasAttribute('hidden'),
  ).toBe(true);
  expect(new VisibleText(root).text.trim()).toBe('Before one two after.');
});

it('preserves publisher hrefs and partial-label marks next to destination pills', () => {
  const root = document.createElement('article');
  document.body.append(root);
  disposers.push(
    renderBody(
      '[before ==selected== after](https://publisher.test/report?q=1) (※ [[Nodes/Host.md]]) ^reader-publisher',
      root,
      'https://source.test',
    ),
  );
  expect(root.querySelector('a:not(.internal-link)')?.getAttribute('href')).toBe(
    'https://publisher.test/report?q=1',
  );
  expect(root.querySelector<HTMLElement>('a:not(.internal-link) mark')?.dataset.readerPassage).toBe(
    '0',
  );
  expect(new VisibleText(root).text.trim()).toBe('before selected after');
});

it('hides only the source-native anchor, not an escaped or code literal with the same spelling', () => {
  const root = document.createElement('article');
  disposers.push(
    renderBody(
      'Anchored. ^native-existing\n\nLiteral \\^native-existing\n\n`^native-existing`',
      root,
      '',
    ),
  );
  expect(root.querySelectorAll('[data-reader-paragraph]')).toHaveLength(1);
  expect(new VisibleText(root).text).toContain('Literal ^native-existing');
  expect(new VisibleText(root).text).toContain('^native-existing');
  expect(root.querySelector('code')?.textContent).toBe('^native-existing');
});

it('retains heading slugs when hiding a native block target in a heading', () => {
  const root = document.createElement('article');
  disposers.push(renderBody('## Original heading ^native-heading', root, ''));
  expect(root.querySelector('h2')?.id).toBe('original-heading');
  expect(root.querySelector('.reader-paragraph-anchor')?.id).toBe('^native-heading');
  expect(new VisibleText(root).text.trim()).toBe('Original heading');
});

it('never hides reference-shaped literals or paragraph markers inside code', () => {
  const root = document.createElement('article');
  disposers.push(renderBody('`(※ [[Nodes/Host.md]]) ^reader-code`', root, ''));
  expect(root.querySelector('.reader-reference-group')).toBeNull();
  expect(root.querySelector('[data-reader-decoration]')).toBeNull();
  expect(new VisibleText(root).text).toContain('^reader-code');
});

it('never treats reference labels as tappable prose', () => {
  const root = document.createElement('article');
  root.innerHTML =
    '<p>Original words<span data-reader-decoration="reference"> (※ <a>Host</a>)</span> after.</p>';
  document.body.append(root);
  const picker = new TapText(root);
  const range = document.createRange();
  range.selectNodeContents(root.querySelector('a')!);
  expect(picker.paragraph(range)).toBeUndefined();
});

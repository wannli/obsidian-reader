// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  addHighlight,
  changePassage,
  locateSelection,
  passages,
  UnmappableSelection,
} from '../src/core/annotations';
import { blockProjection } from '../src/core/projection';
import { renderBody, selectedPassage } from '../src/reader/render';
import { VisibleText } from '../src/reader/text';

const disposers: (() => void)[] = [];
function render(body: string): HTMLElement {
  const root = document.createElement('article');
  document.body.append(root);
  disposers.push(renderBody(body, root, 'https://example.com'));
  return root;
}
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

it.each([
  '> first\n> second',
  '> first\r\n> second',
  '>> first\n>> second',
  '> - first\n>   second',
  '- > first\n  > second',
  '- first\n  second',
  '123. first\n     second',
  '- [x] first\n  second',
  '- first\n\tsecond',
  '> first\nsecond',
  '> **first\n> second**',
  '> ***first\r\n> second***',
  '- ~~first\n  second~~',
  '**first\nsecond**',
])('creates a source-preserving highlight from rendered wrapped prose: %j', (body) => {
  const root = render(body),
    originalHTML = root.innerHTML,
    nativeRange = new VisibleText(root).range('first second')!;
  expect(nativeRange).toBeDefined();
  document.getSelection()!.addRange(nativeRange);
  const selected = selectedPassage(root)!;
  const range = locateSelection(body, selected.quote, selected.before, selected.after);
  const saved = addHighlight(body, range.from, range.to);
  expect(saved.replace(/==/g, '')).toBe(body);
  const painted = render(saved);
  expect(painted.querySelectorAll('mark')).toHaveLength(1);
  expect(painted.querySelector('mark')!.textContent!.replace(/\s+/g, ' ')).toBe('first second');
  const mark = painted.querySelector('mark')!;
  mark.replaceWith(...mark.childNodes);
  expect(painted.innerHTML).toBe(originalHTML);
  expect(passages(saved)).toHaveLength(1);
  expect(changePassage(saved, passages(saved)[0], 'remove')).toBe(body);
});

it.each([
  ['Before **important words** after.', 'important words'],
  ['Before **important words** after.', 'important'],
  ['Before **important words** after.', 'Before important words'],
  ['Before **important words** after.', 'important words after.'],
  ['Before ***important words*** after.', 'important words'],
  ['# **important words**', 'important words'],
  ['Before **important** *words* after.', 'important words'],
  ['Before **outer *important words* outer** after.', 'important words'],
  ['Before ***important words*** after.', 'Before important words'],
  ['| important words | other |\n| --- | --- |\n| value | other |', 'important words'],
  ['| a\\|b | other |\n| --- | --- |', '|'],
  ['| \\| | other |\n| --- | --- |', '|'],
  ['> | a\\|b | other |\n> | --- | --- |', '|'],
])('preserves complete and interior emphasis selections: %j / %j', (body, quote) => {
  const root = render(body),
    html = root.innerHTML,
    range = locateSelection(body, quote),
    saved = addHighlight(body, range.from, range.to),
    painted = render(saved),
    mark = painted.querySelector('mark')!;
  expect(mark.textContent).toBe(quote);
  mark.replaceWith(...mark.childNodes);
  expect(painted.innerHTML).toBe(html);
  expect(changePassage(saved, passages(saved)[0], 'remove')).toBe(body);
});

it.each(['Before important', 'words after.'])(
  'preserves crossing partial emphasis as one logical passage: %s',
  (quote) => {
    const body = 'Before **important words** after.';
    const root = render(body),
      html = root.innerHTML;
    const range = locateSelection(body, quote);
    const saved = addHighlight(body, range.from, range.to);
    const painted = render(saved);
    const marks = [...painted.querySelectorAll('mark')];
    expect(marks.map((mark) => mark.textContent).join('')).toBe(quote);
    marks.forEach((mark) => mark.replaceWith(...mark.childNodes));
    expect(painted.innerHTML).toBe(html);
    expect(passages(saved)).toHaveLength(1);
    expect(changePassage(saved, passages(saved)[0], 'remove')).toBe(body);
  },
);

it('disambiguates repeated quote text with rendered container-free context', () => {
  const body = '> Alpha same words omega.\n\n> Beta same words delta.';
  expect(() => locateSelection(body, 'same words')).toThrow(UnmappableSelection);
  const range = locateSelection(body, 'same words', 'Alpha same words omega. Beta ', ' delta.');
  expect(range.from).toBe(body.lastIndexOf('same words'));
  expect(addHighlight(body, range.from, range.to)).toBe(
    '> Alpha same words omega.\n\n> Beta ==same words== delta.',
  );
});

it.each([
  ['> first\n>\n> second', 'first second'],
  ['> first  \n> second', 'first second'],
  ['> first\\\n> second', 'first second'],
  ['> first\n> - second', 'first second'],
  ['- first\n- second', 'first second'],
  ['> `first second`', 'first second'],
  ['> ```\n> first second\n> ```', 'first second'],
  ['>     first second', 'first second'],
  ['> first `second`', 'first second'],
  ['> first [[Notes/Second.md|second]]', 'first second'],
  ['> first %%hidden%% second', 'first second'],
  ['> ==first second==', 'first second'],
  ['![literal text]\n\n[literal text]: https://example.com/image.png', 'literal text'],
  ['**![literal text]**\n\n[literal text]: https://example.com/image.png', 'literal text'],
  ['![literal text][]\n\n[literal text]: https://example.com/image.png', 'literal text'],
  ['| first | second |\n| --- | --- |', 'first second'],
])('does not make protected or cross-block content editable: %j', (body, quote) => {
  expect(() => locateSelection(body, quote)).toThrow(UnmappableSelection);
});

it.each([
  ['> first [second](https://example.com)', 'first second'],
  ['[literal text]\n\n[literal text]: https://example.com', 'literal text'],
  ['[literal text][]\n\n[literal text]: https://example.com', 'literal text'],
  ['[literal text][ref]\n\n[ref]: https://example.com', 'literal text'],
  ['**[literal text]**\n\n[literal text]: https://example.com', 'literal text'],
  [
    '| [literal text] | other |\n| --- | --- |\n\n[literal text]: https://example.com',
    'literal text',
  ],
])('preserves publisher links and reference definitions in exact selections: %j', (body, quote) => {
  const root = render(body),
    html = root.innerHTML;
  const range = locateSelection(body, quote);
  const saved = addHighlight(body, range.from, range.to);
  const painted = render(saved);
  const marks = [...painted.querySelectorAll('mark')];
  expect(marks.map((mark) => mark.textContent).join('')).toBe(quote);
  marks.forEach((mark) => mark.replaceWith(...mark.childNodes));
  expect(painted.innerHTML).toBe(html);
  expect(changePassage(saved, passages(saved)[0], 'remove')).toBe(body);
});

it('keeps formatted linking, change, unlink and removal on the existing passage path', () => {
  const body = 'Before **important words** after.',
    range = locateSelection(body, 'important words after.'),
    saved = addHighlight(body, range.from, range.to),
    linked = changePassage(saved, passages(saved)[0], 'link', 'Notes/One.md'),
    changed = changePassage(linked, passages(linked)[0], 'link', 'Notes/Two.md');
  expect(render(changed).querySelector('mark a strong')?.textContent).toBe('important words');
  expect(passages(changed)[0].target).toBe('Notes/Two.md');
  expect(changePassage(changed, passages(changed)[0], 'unlink')).toBe(saved);
  expect(changePassage(changed, passages(changed)[0], 'remove')).toBe(body);
});

it('maps original UTF-16 source columns through CRLF and nested containers', () => {
  const body = '> - **A 😀\r\n>   café**',
    projected = blockProjection(body);
  expect(projected.text).toBe('A 😀 café');
  expect(projected.starts[projected.text.indexOf('c')]).toBe(body.indexOf('café'));
  expect(projected.slice(body.indexOf('**'), body.length)).toBe('**A 😀\ncafé**');
  expect(projected.slice(0, body.length)).toBeUndefined();
});

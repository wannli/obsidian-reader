// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { addHighlight, locateSelection } from '../src/core/annotations';
import { renderBody, selectedPassage } from '../src/reader/render';

const cleanup: (() => void)[] = [];
function render(markdown: string) {
  const root = document.createElement('article');
  document.body.append(root);
  cleanup.push(renderBody(markdown, root, 'https://example.com'));
  return root;
}
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

it('maps an explicit tap range without creating a native selection', () => {
  const markdown = 'Before **important words** after.';
  const root = render(markdown);
  const range = document.createRange();
  range.selectNodeContents(root.querySelector('strong')!);
  const selected = selectedPassage(root, range)!;
  expect(selected.quote).toBe('important words');
  expect(document.getSelection()?.rangeCount).toBe(0);
  const mapped = locateSelection(markdown, selected.quote, selected.before, selected.after);
  expect(addHighlight(markdown, mapped.from, mapped.to)).toBe(
    'Before **==important words==** after.',
  );
});

it('disambiguates an exact repeated paragraph word without using first text match', () => {
  const markdown = 'Alpha same words omega.\n\nBeta same words delta.';
  const root = render(markdown);
  const node = root.querySelectorAll('p')[1].firstChild!;
  const range = document.createRange();
  range.setStart(node, 5);
  range.setEnd(node, 15);
  const selected = selectedPassage(root, range)!;
  expect(selected.quote).toBe('same words');
  const mapped = locateSelection(markdown, selected.quote, selected.before, selected.after);
  expect(mapped.from).toBe(markdown.lastIndexOf('same words'));
});

it('does not disturb an unrelated native selection and clones its write range', () => {
  const root = render('First words.\n\nSecond words.');
  const native = document.createRange();
  native.selectNodeContents(root.querySelectorAll('p')[0]);
  document.getSelection()!.addRange(native);
  const explicit = document.createRange();
  explicit.selectNodeContents(root.querySelectorAll('p')[1]);
  const selected = selectedPassage(root, explicit)!;
  explicit.collapse(true);
  expect(selected.range.toString()).toBe('Second words.');
  expect(document.getSelection()!.toString()).toBe('First words.');
});

it('refuses collapsed, whitespace-only, or external explicit ranges', () => {
  const root = render('One paragraph.');
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(true);
  expect(selectedPassage(root, range)).toBeUndefined();
  const outside = document.createElement('p');
  outside.textContent = 'Outside';
  document.body.append(outside);
  range.selectNodeContents(outside);
  expect(selectedPassage(root, range)).toBeUndefined();
  const whitespace = document.createTextNode('  ');
  root.append(whitespace);
  range.selectNodeContents(whitespace);
  expect(selectedPassage(root, range)).toBeUndefined();
});

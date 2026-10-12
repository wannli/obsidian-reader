import { afterEach, expect, it, vi } from 'vitest';
import { captureSelection } from '../src/highlights/selection';
import { createAnchor } from '../src/highlights/selectors';

afterEach(() => {
  document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks();
});

it('indexes the article once per capture while preserving anchors and the native range', () => {
  const root = document.createElement('article'); root.innerHTML = '<p>  😀<em>alpha</em> beta  </p>';
  document.body.append(root);
  const range = document.createRange(); range.setStart(root.querySelector('p')!.firstChild!, 3);
  range.setEnd(root.querySelector('p')!.lastChild!, 7);
  const selection = document.getSelection()!; selection.addRange(range);
  const expected = createAnchor(root, range, 'v1');
  const styles = vi.spyOn(window, 'getComputedStyle');
  const snapshot = captureSelection(root, 'v1')!;
  expect(snapshot.anchor).toEqual(expected);
  expect(snapshot.anchor.quote.exact).toBe('😀alpha beta');
  expect(snapshot.range.toString()).toBe('😀alpha beta');
  expect(snapshot.range).not.toBe(range); expect(selection.getRangeAt(0)).toBe(range);
  // Each eligible element is visited once, not once for anchor and again for range.
  expect(styles.mock.calls.map(([element]) => element)).toEqual([root, root.querySelector('p'), root.querySelector('em')]);
});

it('rebuilds the index for each capture instead of reusing stale text or visibility', () => {
  const root = document.createElement('article'); root.innerHTML = '<span>before </span><b>target</b>';
  document.body.append(root);
  const range = document.createRange(); range.selectNodeContents(root.querySelector('b')!);
  document.getSelection()!.addRange(range);
  expect(captureSelection(root, 'v1')!.anchor.position).toEqual({ start: 7, end: 13 });
  root.querySelector('span')!.style.display = 'none';
  expect(captureSelection(root, 'v2')!.anchor.position).toEqual({ start: 0, end: 6 });
  root.querySelector('b')!.firstChild!.textContent = 'changed';
  range.selectNodeContents(root.querySelector('b')!);
  expect(captureSelection(root, 'v3')!.anchor.quote.exact).toBe('changed');
});

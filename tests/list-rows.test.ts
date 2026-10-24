// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ListRows } from '../src/reader/list-rows';

afterEach(() => document.body.replaceChildren());
const article = (path: string) => ({ path, title: path });
function fixture() {
  const list = document.body.appendChild(document.createElement('div'));
  const open = vi.fn(),
    more = vi.fn();
  const rows = new ListRows(list, {
    open,
    more,
    button: (label, action) => {
      const button = list.appendChild(document.createElement('button'));
      button.textContent = label;
      button.onclick = () => {
        void action();
      };
      return button;
    },
  });
  return { list, rows, open, more };
}
it('retains row/evidence identity on expansion and chooses a nearby row when focus is removed', () => {
  const f = fixture();
  f.rows.update(['A', 'B'].map(article), true, 'Empty');
  const [a, b] = [...f.rows.rows.keys()];
  const evidence = a.appendChild(document.createElement('span'));
  b.focus();
  f.list.scrollTop = 50;
  f.rows.update(['A', 'B', 'C'].map(article), true, 'Empty');
  expect([...f.rows.rows.keys()].slice(0, 2)).toEqual([a, b]);
  expect(a.contains(evidence)).toBe(true);
  f.rows.update(['A', 'C'].map(article), false, 'Empty');
  expect(document.activeElement?.textContent).toBe('C');
  expect(f.list.scrollTop).toBe(50);
});
it('preserves the Show more control and transfers focus when it disappears', () => {
  const f = fixture();
  f.rows.update([article('A')], true, 'Empty');
  const more = f.list.lastElementChild as HTMLButtonElement;
  more.focus();
  more.click();
  expect(f.more).toHaveBeenCalledOnce();
  f.rows.update(['A', 'B'].map(article), true, 'Empty');
  expect(f.list.lastElementChild).toBe(more);
  expect(document.activeElement).toBe(more);
  f.rows.update(['A', 'B', 'C'].map(article), false, 'Empty');
  expect(document.activeElement?.textContent).toBe('C');
});
it('reuses renamed rows, removes stale collisions and opens the current path', () => {
  const f = fixture();
  f.rows.update(['Old', 'New'].map(article), false, 'Empty');
  const first = [...f.rows.rows.keys()][0] as HTMLButtonElement;
  f.rows.rename('Old', 'New');
  f.rows.update([{ path: 'New', title: 'Current' }], false, 'Empty');
  expect([...f.rows.rows.keys()]).toEqual([first]);
  expect(f.list.querySelectorAll('.reader-list-item')).toHaveLength(1);
  first.click();
  expect(f.open).toHaveBeenCalledWith('New');
});

import { afterEach, expect, it, vi } from 'vitest';
import { watchEinkKeys } from '../src/ui/eink-input';
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(stop => stop()); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function fixture() {
  const root = document.createElement('section'); root.tabIndex = 0; root.innerHTML = '<p>Article selection</p><input><textarea></textarea><select><option>One</option></select>';
  document.body.append(root); root.focus(); let active = true, reverse = false, activeChanged = () => {};
  const turn = vi.fn(() => true), stopActive = vi.fn();
  const stop = watchEinkKeys(root, { active: () => active, reverse: () => reverse, turn,
    onActiveChange: fn => { activeChanged = fn; return stopActive; } }); cleanup.push(stop);
  const key = (type = 'keydown', props: KeyboardEventInit = {}, target: EventTarget = root) => {
    const event = new KeyboardEvent(type, { key: 'PageDown', code: 'PageDown', bubbles: true, cancelable: true, ...props }); target.dispatchEvent(event); return event;
  };
  return { root, turn, key, stop, stopActive, active: (value: boolean) => { active = value; activeChanged(); }, reverse: () => { reverse = true; } };
}
it('turns once per press, suppresses repeats and respects reverse mapping', () => {
  const f = fixture(); expect(f.key().defaultPrevented).toBe(true); f.key('keydown', { repeat: true }); f.key();
  expect(f.turn).toHaveBeenCalledTimes(1); expect(f.turn).toHaveBeenLastCalledWith(1);
  f.key('keyup'); f.reverse(); f.key(); expect(f.turn).toHaveBeenLastCalledWith(-1);
});
it('accepts Boox key-only PageUp/PageDown events', () => {
  const f = fixture(); f.key('keydown', { key: 'PageUp', code: '' }); expect(f.turn).toHaveBeenCalledWith(-1);
});
it('consumes boundary keys without allowing native scrolling to an ancestor', () => {
  const f = fixture(); f.turn.mockReturnValue(false); expect(f.key().defaultPrevented).toBe(true);
});
it('does not capture other article shortcuts, arrows, modified keys or composition', () => {
  const f = fixture(); for (const props of [{ key: 'j' }, { key: 'ArrowDown' }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) expect(f.key('keydown', props).defaultPrevented).toBe(false);
  expect(f.turn).not.toHaveBeenCalled();
});
for (const selector of ['input', 'textarea', 'select']) it('never hijacks ' + selector, () => {
  const f = fixture(), field = f.root.querySelector<HTMLElement>(selector)!; field.focus();
  expect(f.key('keydown', {}, field).defaultPrevented).toBe(false); expect(f.turn).not.toHaveBeenCalled();
});
it('guards editable descendants and native dialogs/menus', () => {
  const f = fixture(), editor = document.createElement('div'); editor.contentEditable = 'true'; editor.setAttribute('contenteditable', 'true');
  const span = document.createElement('span'); editor.append(span); f.root.append(editor);
  expect(f.key('keydown', {}, span).defaultPrevented).toBe(false);
  const menu = document.createElement('div'); menu.className = 'menu'; menu.getClientRects = () => [{ width: 100, height: 100 }] as unknown as DOMRectList; document.body.append(menu);
  expect(f.key().defaultPrevented).toBe(false); expect(f.turn).not.toHaveBeenCalled();
});
it('preserves native selections and ignores all page keys while selected', () => {
  const f = fixture(), range = document.createRange(); range.selectNodeContents(f.root.querySelector('p')!);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const text = selection.toString();
  expect(f.key().defaultPrevented).toBe(false); expect(selection.toString()).toBe(text); expect(f.turn).not.toHaveBeenCalled();
});
it('requires both an active reader and reader-owned or neutral focus/origin', () => {
  const f = fixture(), outside = document.createElement('button'); document.body.append(outside);
  expect(f.key('keydown', {}, outside).defaultPrevented).toBe(false);
  outside.focus(); expect(f.key('keydown', {}, document.body).defaultPrevented).toBe(false);
  f.root.focus(); f.active(false); expect(f.key().defaultPrevented).toBe(false);
  expect(f.turn).not.toHaveBeenCalled(); f.active(true); f.root.blur();
  expect(f.key('keydown', {}, document.body).defaultPrevented).toBe(true);
});
it('resets held keys on leaf changes and blur without requiring keyup', () => {
  const f = fixture(); f.key(); f.active(false); f.active(true); f.key();
  window.dispatchEvent(new Event('blur')); f.key(); expect(f.turn).toHaveBeenCalledTimes(3);
});
it('removes all handlers and active-leaf subscription on disposal', () => {
  const f = fixture(); f.stop(); expect(f.key().defaultPrevented).toBe(false); expect(f.stopActive).toHaveBeenCalled(); expect(f.turn).not.toHaveBeenCalled();
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchReaderKeys } from '../src/ui/keyboard';

const queueKeys = [['h', -1, false], ['l', 1, false], ['H', -1, true], ['L', 1, true]] as const;
const shortcuts = ['j', 'k', ...queueKeys.map(([key]) => key)];
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(stop => stop()); vi.restoreAllMocks(); document.body.replaceChildren(); });

function fixture(mobile = false, withQueue = true) {
  const root = document.createElement('div');
  document.body.append(root);
  const active = vi.fn(() => true), navigate = vi.fn(), queueAction = vi.fn(() => true), canNavigate = vi.fn((_delta: number) => true);
  const stop = withQueue ? watchReaderKeys(root, active, navigate, mobile, queueAction, canNavigate) : watchReaderKeys(root, active, navigate);
  cleanup.push(stop);
  return { root, active, navigate, queueAction, canNavigate, stop };
}
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}, prevented = false) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init });
  if (prevented) event.preventDefault();
  const consume = vi.spyOn(event, 'preventDefault');
  target.dispatchEvent(event);
  return { event, consume };
}
function checkAll(f: ReturnType<typeof fixture>, allowed: boolean, target: EventTarget = f.root, init: KeyboardEventInit = {}, prevented = false) {
  for (const key of shortcuts) {
    const { event, consume } = press(target, key, { shiftKey: key === key.toUpperCase(), ...init }, prevented);
    expect(consume, key).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(event.defaultPrevented, key).toBe(allowed || prevented);
  }
  expect(f.navigate.mock.calls).toEqual(allowed ? [[1], [-1]] : []);
  expect(f.queueAction.mock.calls).toEqual(allowed ? queueKeys.map(([, delta, move]) => [delta, move]) : []);
}

it.each([['j', 1], ['k', -1]] as const)('%s uses the navigation boundary callback without toolbar DOM', (key, delta) => {
  const f = fixture(); f.canNavigate.mockImplementation(direction => direction === delta);
  expect(f.root.querySelector('button')).toBeNull();
  expect(press(f.root, key).event.defaultPrevented).toBe(true);
  expect(f.navigate.mock.calls).toEqual([[delta]]); expect(f.canNavigate).toHaveBeenLastCalledWith(delta);
  f.canNavigate.mockReturnValue(false);
  const boundary = press(f.root, key);
  expect(boundary.consume).not.toHaveBeenCalled(); expect(boundary.event.defaultPrevented).toBe(false);
  expect(f.navigate.mock.calls).toEqual([[delta]]); expect(f.queueAction).not.toHaveBeenCalled();
});

describe.each([true, false])('article navigation available: %s', available => {
  it.each(queueKeys)('%s routes delta %s / move %s and consumes only acceptance', (key, delta, move) => {
    const f = fixture(); f.canNavigate.mockReturnValue(available);
    const accepted = press(f.root, key, { shiftKey: move });
    expect(accepted.consume).toHaveBeenCalledTimes(1); expect(accepted.event.defaultPrevented).toBe(true);
    f.queueAction.mockReturnValue(false);
    const rejected = press(f.root, key, { shiftKey: move });
    expect(rejected.consume).not.toHaveBeenCalled(); expect(rejected.event.defaultPrevented).toBe(false);
    expect(f.queueAction.mock.calls).toEqual([[delta, move], [delta, move]]);
    expect(f.navigate).not.toHaveBeenCalled();
  });
});

it('preserves the three-argument API and leaves queue shortcuts unconsumed without a callback', () => {
  const f = fixture(false, false);
  for (const key of ['j', 'k']) expect(press(f.root, key).event.defaultPrevented).toBe(true);
  for (const [key, , move] of queueKeys) {
    const result = press(f.root, key, { shiftKey: move });
    expect(result.consume).not.toHaveBeenCalled(); expect(result.event.defaultPrevented).toBe(false);
  }
  expect(f.navigate.mock.calls).toEqual([[1], [-1]]); expect(f.queueAction).not.toHaveBeenCalled();
});

it.each(['inactive', 'disconnected', 'mobile', 'defaultPrevented'])('guards every shortcut when %s', guard => {
  const f = fixture(guard === 'mobile');
  if (guard === 'inactive') f.active.mockReturnValue(false);
  if (guard === 'disconnected') f.root.remove();
  // Dispatch on the document's body so a detached root cannot hide a missing connection guard.
  checkAll(f, false, document.body, {}, guard === 'defaultPrevented');
  if (guard === 'inactive') { f.active.mockReturnValue(true); checkAll(f, true); }
});
it.each<KeyboardEventInit>([{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { metaKey: true }])('guards every shortcut for %j', init => {
  checkAll(fixture(), false, document.body, init);
});
it.each(['j', 'k', 'J', 'K'])('ignores shifted %s', key => {
  const f = fixture(), result = press(f.root, key, { shiftKey: true });
  expect(result.consume).not.toHaveBeenCalled(); expect(result.event.defaultPrevented).toBe(false);
  expect(f.navigate).not.toHaveBeenCalled(); expect(f.queueAction).not.toHaveBeenCalled();
});
it.each(['x', 'ArrowRight', 'Escape'])('ignores unrelated key %s', key => {
  const f = fixture(), result = press(f.root, key);
  expect(result.consume).not.toHaveBeenCalled(); expect(result.event.defaultPrevented).toBe(false);
  expect(f.navigate).not.toHaveBeenCalled(); expect(f.queueAction).not.toHaveBeenCalled();
});

describe.each(['inside', 'outside'])('editable target %s Reader', location => {
  it.each([
    '<input>', '<textarea></textarea>', '<select><option>One</option></select>',
    '<div contenteditable="true"></div>', '<div contenteditable></div>', '<div contenteditable="plaintext-only"></div>',
    '<div contenteditable="true"><section><span data-target>Nested editor</span></section></div>',
    '<div role="textbox"></div>', '<div role="textbox"><span data-target>Nested textbox</span></div>',
  ])('ignores all shortcuts in %s', markup => {
    const f = fixture(), wrapper = document.createElement('div'); wrapper.innerHTML = markup;
    (location === 'inside' ? f.root : document.body).append(wrapper);
    checkAll(f, false, wrapper.querySelector('[data-target]') ?? wrapper.firstElementChild!);
  });
});
it('allows shortcuts in explicitly noneditable article content', () => {
  const f = fixture(), content = document.createElement('div');
  content.setAttribute('contenteditable', 'false'); content.innerHTML = '<span>Article text</span>'; f.root.append(content);
  checkAll(f, true, content.firstElementChild!);
});

describe.each(['modal-container', 'prompt', 'menu', 'dialog'])('native %s outside Reader', kind => {
  it.each(['visible', 'display-none', 'hidden', 'visibility-hidden'])('honors %s visibility for every shortcut', visibility => {
    const f = fixture(), overlay = document.createElement('div');
    if (kind === 'dialog') overlay.setAttribute('role', 'dialog'); else overlay.className = kind;
    overlay.hidden = visibility === 'hidden';
    if (visibility === 'display-none') overlay.style.display = 'none';
    if (visibility === 'visibility-hidden') overlay.style.visibility = 'hidden';
    document.body.append(overlay);
    // jsdom has no layout: visible (including visibility:hidden) boxes need explicit client rects.
    const rects = visibility === 'hidden' || visibility === 'display-none' ? [] : [new DOMRect(0, 0, 100, 100)];
    vi.spyOn(overlay, 'getClientRects').mockReturnValue(rects as unknown as DOMRectList);
    checkAll(f, visibility !== 'visible');
  });
});
it.each(['r2-highlight-menu', 'r2-dialog-shade', 'r2-sidebar'])('blocks every shortcut while local .%s exists, then resumes', className => {
  const f = fixture(), overlay = document.createElement('div'); overlay.className = className; f.root.append(overlay);
  checkAll(f, false); overlay.remove(); checkAll(f, true);
});
it('does not block shortcuts for a hidden local sidebar', () => {
  const f = fixture(), sidebar = document.createElement('div'); sidebar.className = 'r2-sidebar'; sidebar.hidden = true; f.root.append(sidebar);
  checkAll(f, true);
});
it.each(['r2-highlight-menu', 'r2-dialog-shade', 'r2-sidebar'])('does not treat another Reader\'s .%s as a local overlay', className => {
  const f = fixture(), other = document.createElement('div'); other.className = className; document.body.append(other);
  checkAll(f, true);
});

it.each([['H', -1], ['L', 1], ['h', -1], ['l', 1]] as const)('suppresses auto-repeat for shifted %s moves', (key, delta) => {
  const f = fixture();
  expect(press(f.root, key, { shiftKey: true }).event.defaultPrevented).toBe(true);
  for (let i = 0; i < 2; i++) {
    const repeated = press(f.root, key, { shiftKey: true, repeat: true });
    expect(repeated.consume).not.toHaveBeenCalled(); expect(repeated.event.defaultPrevented).toBe(false);
  }
  expect(f.queueAction.mock.calls).toEqual([[delta, true]]); expect(f.navigate).not.toHaveBeenCalled();
});
it.each([['j', 1], ['k', -1], ['h', -1], ['l', 1]] as const)('permits repeated plain %s navigation', (key, delta) => {
  const f = fixture();
  for (let i = 0; i < 2; i++) expect(press(f.root, key, { repeat: true }).event.defaultPrevented).toBe(true);
  const article = key === 'j' || key === 'k';
  expect(f.navigate.mock.calls).toEqual(article ? [[delta], [delta]] : []);
  expect(f.queueAction.mock.calls).toEqual(article ? [] : [[delta, false], [delta, false]]);
});
it('cleanup removes every shortcut while the Reader remains active and connected', () => {
  const f = fixture(); f.stop(); checkAll(f, false);
});

// @vitest-environment node
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TapHighlighter, type TapToolbarAction } from '../src/reader/tap-highlighter';
import { setIcon, setTooltip } from 'obsidian';

// Obsidian ships declarations only. Resolve its mock server-side and install a
// local jsdom, matching the Reader lifecycle/dialog component tests.
const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));

const picker = vi.hoisted(() => ({
  created: vi.fn<(body: HTMLElement) => void>(),
  wordAt: vi.fn<(x: number, y: number) => Range | undefined>(),
  between: vi.fn<(first: Range, last: Range) => Range | undefined>(),
  sentence: vi.fn<(word: Range) => Range | undefined>(),
  paragraph: vi.fn<(word: Range) => Range | undefined>(),
}));
vi.mock('obsidian', () => ({
  setIcon: vi.fn((element: HTMLElement, icon: string) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-icon', icon);
    element.replaceChildren(svg);
  }),
  setTooltip: vi.fn(),
}));
// Text hit-testing and sentence boundaries have their own tests. Keep controller
// regressions independent of that module, including its browser geometry APIs.
vi.mock('../src/reader/tap-text', () => ({
  TapText: class {
    constructor(body: HTMLElement) {
      picker.created(body);
    }
    wordAt = picker.wordAt;
    between = picker.between;
    sentence = picker.sentence;
    paragraph = picker.paragraph;
  },
}));

const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const disposers: (() => void)[] = [];
let wordRects: DOMRect[];
beforeEach(() => {
  vi.resetAllMocks();
  wordRects = [new DOMRect(10, 20, 45, 18)];
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: vi.fn(() => wordRects),
  });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

function fixture({
  active = true,
  canUndo = false,
  passageActions,
  onPassage,
  clearPassage,
}: {
  active?: boolean;
  canUndo?: boolean;
  passageActions?: () => readonly TapToolbarAction[] | undefined;
  onPassage?: (word: Range, event: MouseEvent) => boolean;
  clearPassage?: (intent: boolean) => void;
} = {}) {
  const host = document.createElement('section');
  const viewport = document.createElement('div');
  const body = document.createElement('article');
  body.innerHTML =
    '<p>Alpha <strong>bravo</strong> charlie. Delta echo.</p><p>Other paragraph.</p>';
  viewport.append(body);
  const toolbar = document.createElement('nav');
  const previous = document.createElement('button');
  previous.textContent = 'Previous';
  const previousClicked = vi.fn();
  previous.addEventListener('click', previousClicked);
  toolbar.append(
    document.createTextNode(' '),
    previous,
    document.createComment('original actions'),
  );
  const original = [...toolbar.childNodes];
  host.append(viewport, toolbar);
  document.body.append(host);
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
  const first = document.createRange();
  first.setStart(body.querySelector('p')!.firstChild!, 0);
  first.setEnd(first.startContainer, 5);
  const last = document.createRange();
  last.setStart(body.querySelector('p')!.lastChild!, 1);
  last.setEnd(last.startContainer, 8);
  const inclusive = document.createRange();
  inclusive.setStart(first.startContainer, first.startOffset);
  inclusive.setEnd(last.endContainer, last.endOffset);
  const sentence = inclusive.cloneRange();
  sentence.setEnd(last.endContainer, 9);
  const paragraph = document.createRange();
  paragraph.selectNodeContents(body.querySelector('p')!);
  picker.wordAt.mockImplementation((x) => (x === 20 ? first : x === 80 ? last : undefined));
  picker.between.mockReturnValue(inclusive);
  picker.sentence.mockReturnValue(sentence);
  picker.paragraph.mockReturnValue(paragraph);
  const options = {
    active,
    canUndo,
    modeChanged: vi.fn<(active: boolean) => void>(),
    save: vi.fn<(range: Range) => Promise<void>>().mockResolvedValue(undefined),
    undo: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    notify: vi.fn<(error: unknown) => void>(),
    passageActions,
    onPassage,
    clearPassage,
  };
  const controller = new TapHighlighter(viewport, body, toolbar, options);
  disposers.push(() => controller.dispose());
  const preview = host.querySelector<HTMLElement>('.reader-tap-highlight-preview')!;
  return {
    host,
    viewport,
    body,
    toolbar,
    original,
    previous,
    previousClicked,
    first,
    last,
    inclusive,
    sentence,
    paragraph,
    options,
    controller,
    preview,
    get hint() {
      return host.querySelector<HTMLElement>('[role="status"]')!;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function passageAction(id = 'link', label = 'Link to note', icon = 'link') {
  return { id, label, icon, run: vi.fn<() => void | Promise<unknown>>() };
}
function markedWord(f: Fixture) {
  const strong = f.body.querySelector('strong')!;
  const mark = document.createElement('mark');
  strong.replaceWith(mark);
  mark.append(strong);
  const word = document.createRange();
  word.selectNodeContents(strong);
  return { mark, word };
}
function button(toolbar: HTMLElement, label: string): HTMLButtonElement {
  const found = [...toolbar.querySelectorAll('button')].find(
    (element) => element.textContent === label || element.getAttribute('aria-label') === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
function pointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {},
): MouseEvent {
  // jsdom lacks PointerEvent. Use the same small explicit event fixture as Surface.
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 20,
    clientY: 30,
    ...init,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true },
  });
  target.dispatchEvent(event);
  return event;
}
function clickAt(target: EventTarget, x = 20, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    clientX: x,
    clientY: 30,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
function tap(f: Fixture, x = 20, target: EventTarget = f.body.querySelector('p')!): MouseEvent {
  pointer(target, 'pointerdown', { clientX: x });
  pointer(target, 'pointerup', { clientX: x });
  return clickAt(target, x);
}
function escape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
}

it('switches the same toolbar contextually and restores the exact original actions on Done', () => {
  const f = fixture({ active: false });
  const normal = [...f.toolbar.childNodes];
  const trigger = button(f.toolbar, 'Highlight mode');
  for (const [action, key] of [
    [trigger, 'H'],
    [button(f.toolbar, 'Link or create note'), 'C'],
  ] as const) {
    expect(action.hasAttribute('title')).toBe(false);
    expect(action.getAttribute('aria-keyshortcuts')).toBe(key);
    expect(setTooltip).toHaveBeenCalledWith(
      action,
      `${action.getAttribute('aria-label')} (${key})`,
    );
  }
  expect(f.controller.active).toBe(false);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  expect(f.host.querySelector('[role="status"]')).toBeNull();
  expect(picker.created).toHaveBeenCalledExactlyOnceWith(f.body);
  trigger.click();
  expect(f.controller.active).toBe(true);
  expect(f.host.querySelectorAll('nav')).toHaveLength(1);
  expect(f.toolbar.querySelectorAll('button')).toHaveLength(4);
  expect(f.toolbar.contains(f.previous)).toBe(false);
  expect(f.body.classList.contains('reader-tap-highlight-mode')).toBe(true);
  expect(f.toolbar.classList.contains('reader-tap-highlight-toolbar')).toBe(true);
  const hint = f.hint;
  expect(hint.getAttribute('aria-live')).toBe('polite');
  button(f.toolbar, 'Done').click();
  expect([...f.toolbar.childNodes]).toEqual(normal);
  expect(button(f.toolbar, 'Highlight mode')).toBe(trigger);
  expect(f.controller.active).toBe(false);
  expect(f.body.classList.contains('reader-tap-highlight-mode')).toBe(false);
  expect(f.toolbar.classList.contains('reader-tap-highlight-toolbar')).toBe(false);
  expect(hint.isConnected).toBe(false);
  f.previous.click();
  expect(f.previousClicked).toHaveBeenCalledOnce();
  expect(f.options.modeChanged.mock.calls).toEqual([[true], [false]]);
  expect(f.options.save).not.toHaveBeenCalled();
});

it('creates a node through the same two-tap and sentence ranges without invoking highlight actions', async () => {
  const action = passageAction();
  const f = fixture({ active: false, canUndo: true, passageActions: () => [action] });
  button(f.toolbar, 'Link or create note').click();
  expect(f.controller.active).toBe(true);
  expect(f.toolbar.classList.contains('reader-tap-node-toolbar')).toBe(true);
  expect(f.host.querySelector('.reader-tap-node-preview')).not.toBeNull();
  expect(f.toolbar.querySelector('[data-action="link"]')).toBeNull();
  expect(button(f.toolbar, 'Undo').hidden).toBe(true);
  tap(f);
  tap(f, 80);
  await Promise.resolve();
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive, 'node');
  tap(f);
  button(f.toolbar, 'Sentence').click();
  await Promise.resolve();
  expect(f.options.save).toHaveBeenLastCalledWith(f.sentence, 'node');
  expect(action.run).not.toHaveBeenCalled();
  expect(f.body.querySelector('mark')).toBeNull();
  button(f.toolbar, 'Done').click();
  expect(f.toolbar.classList.contains('reader-tap-node-toolbar')).toBe(false);
  expect(button(f.toolbar, 'Highlight mode')).toBeDefined();
});

it('keeps Done responsive while node creation is waiting on an uncooperative picker', async () => {
  const f = fixture({ active: false, canUndo: false });
  let resolve!: () => void;
  const pending = new Promise<void>((settle) => {
    resolve = settle;
  });
  f.options.save.mockReturnValueOnce(pending);
  button(f.toolbar, 'Link or create note').click();
  tap(f);
  tap(f, 80);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive, 'node');
  expect(button(f.toolbar, 'Done').disabled).toBe(false);
  button(f.toolbar, 'Done').click();
  expect(f.controller.active).toBe(false);
  resolve();
  await pending;
});

it('balances seven passage actions into narrow rows without stranding Done', () => {
  const layout = document.createElement('div');
  const viewport = document.createElement('div');
  const body = document.createElement('div');
  const toolbar = document.createElement('nav');
  viewport.append(body);
  layout.append(viewport, toolbar);
  document.body.append(layout);
  let width = 320;
  Object.defineProperty(layout, 'clientWidth', { get: () => width });
  const actions = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    label: 'Action ' + index,
    icon: 'link',
    run: vi.fn(),
  }));
  const controller = new TapHighlighter(viewport, body, toolbar, {
    active: true,
    canUndo: true,
    passageActions: () => actions,
    modeChanged: vi.fn(),
    save: async () => {},
    undo: async () => {},
    notify: vi.fn(),
  });
  try {
    const panel = toolbar.querySelector<HTMLElement>('.reader-tap-highlight-actions')!;
    expect(panel.querySelectorAll('button:not([hidden])')).toHaveLength(7);
    expect(panel.style.maxWidth).toBe('188px');
    width = 390;
    window.dispatchEvent(new window.Event('resize'));
    expect(panel.style.maxWidth).toBe('332px');
  } finally {
    controller.dispose();
    layout.remove();
  }
});

it('uses icon-only actions with accessible names and tooltips instead of a visible explainer', () => {
  const f = fixture();
  for (const [label, icon, key] of [
    ['Sentence', 'text-select', 'S'],
    ['Paragraph', 'pilcrow', 'P'],
    ['Undo', 'undo-2', 'U'],
    ['Done', 'check', 'D'],
  ]) {
    const action = button(f.toolbar, label);
    expect(action.textContent).toBe('');
    expect(action.classList.contains('reader-icon-button')).toBe(true);
    expect(action.getAttribute('aria-label')).toBe(label);
    expect(action.hasAttribute('title')).toBe(false);
    expect(action.getAttribute('aria-keyshortcuts')).toBe(key);
    expect(action.querySelector('svg')?.getAttribute('data-icon')).toBe(icon);
    expect(action.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(setIcon).toHaveBeenCalledWith(action, icon);
    expect(setTooltip).toHaveBeenCalledWith(action, `${label} (${key})`);
  }
  expect(f.toolbar.querySelector('.reader-tap-highlight-hint')).toBeNull();
  expect(f.hint.classList.contains('reader-tap-highlight-status')).toBe(true);
  expect(f.hint.getAttribute('aria-live')).toBe('polite');
});

it('renders generic icon-only passage actions, Undo and Done in the same panel', () => {
  const f = fixture({ canUndo: true });
  const panel = f.toolbar.firstElementChild;
  const undo = button(f.toolbar, 'Undo');
  const done = button(f.toolbar, 'Done');
  const actions = [
    passageAction('open', 'Open note', 'arrow-up-right'),
    passageAction('link', 'Link to note', 'link'),
    passageAction('change', 'Change link', 'replace'),
    passageAction('create', 'Create note', 'file-plus'),
    passageAction('unlink', 'Remove link', 'unlink'),
    passageAction('remove', 'Remove highlight', 'eraser'),
  ];
  f.options.passageActions = () => actions;
  f.controller.refreshActions();
  expect(f.toolbar.firstElementChild).toBe(panel);
  expect(f.host.querySelectorAll('nav')).toHaveLength(1);
  expect(
    [...f.toolbar.querySelectorAll('[data-action]')].map((element) =>
      element.getAttribute('data-action'),
    ),
  ).toEqual(actions.map((action) => action.id));
  expect(button(f.toolbar, 'Undo')).toBe(undo);
  expect(undo.hidden).toBe(false);
  expect(button(f.toolbar, 'Done')).toBe(done);
  expect(f.toolbar.querySelector('[aria-label="Sentence"]')).toBeNull();
  expect(f.toolbar.querySelector('[aria-label="Paragraph"]')).toBeNull();
  for (const action of actions) {
    const element = button(f.toolbar, action.label);
    expect(element.textContent).toBe('');
    expect(element.classList.contains('reader-icon-button')).toBe(true);
    expect(element.getAttribute('aria-label')).toBe(action.label);
    const shortcut = { unlink: 'X', 'remove-highlight': 'R' }[action.id];
    const tooltip = shortcut
      ? `${action.label} (${shortcut})`
      : `${action.label} (Enter when focused)`;
    expect(element.hasAttribute('title')).toBe(false);
    expect(element.querySelector('svg')?.getAttribute('data-icon')).toBe(action.icon);
    expect(element.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(setTooltip).toHaveBeenCalledWith(element, tooltip);
    element.click();
    expect(action.run).toHaveBeenCalledOnce();
  }
  expect(f.hint.classList.contains('reader-tap-highlight-status')).toBe(true);
  expect(f.hint.getAttribute('aria-live')).toBe('polite');
  expect(f.hint.textContent).toBe('Highlight selected');
  expect(f.toolbar.querySelector('.reader-tap-highlight-hint')).toBeNull();
});

it('labels multiple note destinations with working keys and a focused Enter fallback', () => {
  const actions = [
    passageAction('open-note', 'Open first'),
    passageAction('open-note-1', 'Open second'),
    passageAction('open-note-9', 'Open tenth'),
    passageAction('open-note-10', 'Open eleventh'),
  ];
  const f = fixture({ passageActions: () => actions });
  for (const [index, action] of actions.entries()) {
    const key = ['O', '1', '9', undefined][index];
    const element = button(f.toolbar, action.label);
    expect(element.hasAttribute('title')).toBe(false);
    expect(setTooltip).toHaveBeenCalledWith(
      element,
      key ? `${action.label} (${key})` : `${action.label} (Enter when focused)`,
    );
    expect(element.getAttribute('aria-keyshortcuts')).toBe(key ?? null);
    expect(element.dataset.readerKey).toBe(key?.toLowerCase());
  }
});

it('reuses the current action set and buttons across refresh, Undo availability and layout changes', () => {
  const actions = [passageAction()];
  const f = fixture({ passageActions: () => actions });
  const panel = f.toolbar.firstElementChild;
  const element = button(f.toolbar, 'Link to note');
  const icons = vi.mocked(setIcon).mock.calls.length;
  const tooltips = vi.mocked(setTooltip).mock.calls.length;
  f.controller.refreshActions();
  f.controller.setUndoAvailable(true);
  f.viewport.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('resize'));
  f.controller.refreshActions();
  expect(f.toolbar.firstElementChild).toBe(panel);
  expect(button(f.toolbar, 'Link to note')).toBe(element);
  expect(vi.mocked(setIcon).mock.calls).toHaveLength(icons);
  expect(vi.mocked(setTooltip).mock.calls).toHaveLength(tooltips);
  f.options.passageActions = () => [];
  f.controller.refreshActions();
  expect(f.toolbar.firstElementChild).toBe(panel);
  expect(f.toolbar.querySelector('[data-action]')).toBeNull();
  expect(button(f.toolbar, 'Sentence').disabled).toBe(true);
  expect(button(f.toolbar, 'Paragraph').disabled).toBe(true);
  expect(button(f.toolbar, 'Undo').hidden).toBe(false);
  expect(f.hint.textContent).toBe('Tap the first word');
});

it('delegates a verified marked word with no endpoint to the View without staging or altering text', () => {
  const f = fixture();
  const { mark, word } = markedWord(f);
  const actions = [passageAction()];
  const onPassage = vi.fn((range: Range) => {
    expect(range).toBe(word);
    f.options.passageActions = () => actions;
    return true;
  });
  const clearPassage = vi.fn();
  f.options.onPassage = onPassage;
  f.options.clearPassage = clearPassage;
  picker.wordAt.mockReturnValueOnce(word);
  const html = f.body.innerHTML;
  const event = tap(f, 20, mark);
  expect(event.defaultPrevented).toBe(true);
  expect(onPassage).toHaveBeenCalledExactlyOnceWith(word, event);
  expect(clearPassage).not.toHaveBeenCalled();
  expect(f.preview.children).toHaveLength(0);
  expect(picker.between).not.toHaveBeenCalled();
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.body.innerHTML).toBe(html);
  expect(f.hint.textContent).toBe('Highlight selected');
  expect(button(f.toolbar, 'Link to note').disabled).toBe(false);
});

it('clears passage intent before staging a plain word for the next normal selection', async () => {
  let actions: readonly TapToolbarAction[] | undefined = [passageAction()];
  const onPassage = vi.fn(() => false);
  const clearPassage = vi.fn(() => {
    expect(f.preview.children).toHaveLength(0);
    actions = undefined;
  });
  const f = fixture({ passageActions: () => actions, onPassage, clearPassage });
  const event = tap(f);
  expect(onPassage).toHaveBeenCalledExactlyOnceWith(f.first, event);
  expect(clearPassage).toHaveBeenCalledExactlyOnceWith(true);
  expect(onPassage.mock.invocationCallOrder[0]).toBeLessThan(
    clearPassage.mock.invocationCallOrder[0],
  );
  expect(f.toolbar.querySelector('[data-action]')).toBeNull();
  expect(f.preview.children).toHaveLength(1);
  expect(button(f.toolbar, 'Sentence').disabled).toBe(false);
  expect(f.hint.textContent).toBe('Tap the last word, or choose below');
  tap(f, 80);
  expect(onPassage).toHaveBeenCalledOnce();
  expect(clearPassage).toHaveBeenCalledOnce();
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, f.last);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  await Promise.resolve();
});

it('keeps a marked second word on the endpoint-completion path instead of opening passage actions', async () => {
  const onPassage = vi.fn(() => false);
  const clearPassage = vi.fn();
  const f = fixture({ onPassage, clearPassage });
  const { mark, word } = markedWord(f);
  tap(f);
  onPassage.mockClear();
  clearPassage.mockClear();
  picker.wordAt.mockReturnValueOnce(word);
  tap(f, 80, mark);
  expect(onPassage).not.toHaveBeenCalled();
  expect(clearPassage).not.toHaveBeenCalled();
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, word);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  await Promise.resolve();
});

it.each([
  'drag',
  'scroll',
  'pointercancel',
  'multitouch',
  'contextmenu',
  'root replacement',
  'non-text',
  'outside',
])('never delegates a %s gesture to onPassage', (gesture) => {
  const onPassage = vi.fn(() => true);
  const clearPassage = vi.fn();
  const f = fixture({ onPassage, clearPassage });
  const { mark, word } = markedWord(f);
  picker.wordAt.mockReturnValue(word);
  pointer(mark, 'pointerdown');
  if (gesture === 'drag') pointer(document, 'pointermove', { clientX: 29 });
  if (gesture === 'scroll') f.viewport.dispatchEvent(new Event('scroll'));
  if (gesture === 'pointercancel') pointer(document, 'pointercancel');
  if (gesture === 'multitouch') pointer(mark, 'pointerdown', { pointerId: 2, isPrimary: false });
  if (gesture === 'contextmenu')
    mark.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  if (gesture === 'root replacement') f.body.replaceChildren(document.createElement('p'));
  if (gesture === 'non-text') picker.wordAt.mockReturnValue(undefined);
  pointer(document, 'pointerup');
  clickAt(gesture === 'outside' ? f.viewport : f.body);
  expect(onPassage).not.toHaveBeenCalled();
  expect(clearPassage).not.toHaveBeenCalled();
  expect(f.preview.children).toHaveLength(0);
  expect(f.options.save).not.toHaveBeenCalled();
});

it.each([
  { button: 2 },
  { altKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
])('never delegates a non-primary or modified tap to onPassage: %j', (init) => {
  const onPassage = vi.fn(() => true);
  const clearPassage = vi.fn();
  const f = fixture({ onPassage, clearPassage });
  pointer(f.body, 'pointerdown', init);
  pointer(f.body, 'pointerup', init);
  clickAt(f.body, 20, init);
  expect(picker.wordAt).not.toHaveBeenCalled();
  expect(onPassage).not.toHaveBeenCalled();
  expect(clearPassage).not.toHaveBeenCalled();
});

it('never delegates a long press or an off-mode tap to onPassage', () => {
  const onPassage = vi.fn(() => true);
  const f = fixture({ onPassage });
  const down = pointer(f.body, 'pointerdown');
  const up = new MouseEvent('pointerup', { bubbles: true, button: 0 });
  Object.defineProperties(up, {
    pointerId: { value: 1 },
    timeStamp: { value: down.timeStamp + 701 },
  });
  document.dispatchEvent(up);
  clickAt(f.body);
  expect(picker.wordAt).not.toHaveBeenCalled();
  expect(onPassage).not.toHaveBeenCalled();
  button(f.toolbar, 'Done').click();
  tap(f);
  expect(onPassage).not.toHaveBeenCalled();
});

it('leaves Done, Undo and superseding actions usable while a generic picker promise never settles', async () => {
  const pickerAction = passageAction();
  pickerAction.run.mockReturnValue(new Promise<unknown>(() => {}));
  const superseding = passageAction('remove', 'Remove highlight', 'eraser');
  const actions = [pickerAction, superseding];
  const f = fixture({ canUndo: true, passageActions: () => actions });
  button(f.toolbar, 'Link to note').click();
  expect(pickerAction.run).toHaveBeenCalledOnce();
  for (const label of ['Remove highlight', 'Undo', 'Done']) {
    expect(button(f.toolbar, label).disabled).toBe(false);
  }
  expect(f.hint.textContent).toBe('Highlight selected');
  button(f.toolbar, 'Remove highlight').click();
  expect(superseding.run).toHaveBeenCalledOnce();
  button(f.toolbar, 'Undo').click();
  expect(f.options.undo).toHaveBeenCalledOnce();
  await Promise.resolve();
  button(f.toolbar, 'Done').click();
  expect(f.controller.active).toBe(false);
  expect(f.options.modeChanged).toHaveBeenCalledExactlyOnceWith(false);
});

it.each(['synchronous', 'rejected'] as const)(
  'reports a %s generic action failure without locking controls',
  async (kind) => {
    const action = passageAction();
    const error = new Error('picker failed');
    if (kind === 'synchronous')
      action.run.mockImplementationOnce(() => {
        throw error;
      });
    else action.run.mockRejectedValueOnce(error);
    const actions = [action];
    const f = fixture({ passageActions: () => actions });
    button(f.toolbar, 'Link to note').click();
    await Promise.resolve();
    expect(f.options.notify).toHaveBeenCalledExactlyOnceWith(error);
    expect(button(f.toolbar, 'Link to note').disabled).toBe(false);
    expect(button(f.toolbar, 'Done').disabled).toBe(false);
    button(f.toolbar, 'Link to note').click();
    expect(action.run).toHaveBeenCalledTimes(2);
  },
);

it('keeps generic actions guarded during a dispatched Undo write', async () => {
  const action = passageAction();
  const actions = [action];
  const onPassage = vi.fn(() => true);
  const f = fixture({ canUndo: true, passageActions: () => actions, onPassage });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.options.undo.mockReturnValueOnce(pending);
  button(f.toolbar, 'Undo').click();
  expect(button(f.toolbar, 'Link to note').disabled).toBe(true);
  button(f.toolbar, 'Link to note').click();
  tap(f);
  expect(action.run).not.toHaveBeenCalled();
  expect(onPassage).not.toHaveBeenCalled();
  expect(button(f.toolbar, 'Done').disabled).toBe(true);
  release();
  await pending;
  expect(button(f.toolbar, 'Link to note').disabled).toBe(false);
});

it('clears passage with explicit intent before Done reports mode exit', () => {
  let actions: readonly TapToolbarAction[] | undefined = [passageAction()];
  const clearPassage = vi.fn(() => {
    actions = undefined;
  });
  const f = fixture({ passageActions: () => actions, clearPassage });
  const done = button(f.toolbar, 'Done');
  done.click();
  expect(clearPassage).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.options.modeChanged).toHaveBeenCalledExactlyOnceWith(false);
  expect(clearPassage.mock.invocationCallOrder[0]).toBeLessThan(
    f.options.modeChanged.mock.invocationCallOrder[0],
  );
  expect(f.controller.active).toBe(false);
  done.click();
  expect(clearPassage).toHaveBeenCalledOnce();
});

it('resets passage with background intent only, without exiting mode or cancelling creation intent', () => {
  let actions: readonly TapToolbarAction[] | undefined = [passageAction()];
  const clearPassage = vi.fn((intent: boolean) => {
    expect(intent).toBe(false);
    actions = undefined;
  });
  const f = fixture({ passageActions: () => actions, clearPassage });
  f.controller.reset();
  expect(clearPassage).toHaveBeenCalledExactlyOnceWith(false);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  expect(f.controller.active).toBe(true);
  expect(f.hint.textContent).toBe('Tap the first word');
  expect(button(f.toolbar, 'Sentence').disabled).toBe(true);
});

it('preserves View passage context when activating mode', () => {
  const actions = [passageAction()];
  const clearPassage = vi.fn();
  const f = fixture({ active: false, passageActions: () => actions, clearPassage });
  clearPassage.mockClear();
  button(f.toolbar, 'Highlight mode').click();
  expect(clearPassage).not.toHaveBeenCalled();
  expect(f.hint.textContent).toBe('Highlight selected');
  expect(button(f.toolbar, 'Link to note').disabled).toBe(false);
});

it('exits a selected passage without a first endpoint on one Escape', () => {
  const actions = [passageAction()];
  const clearPassage = vi.fn();
  const f = fixture({ passageActions: () => actions, clearPassage });
  expect(escape().defaultPrevented).toBe(true);
  expect(f.controller.active).toBe(false);
  expect(clearPassage).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.options.modeChanged).toHaveBeenCalledExactlyOnceWith(false);
});

it.each(['.modal-container', '[role="dialog"]'])(
  'leaves selected-passage Escape to the picker inside %s',
  (selector) => {
    const actions = [passageAction()];
    const clearPassage = vi.fn();
    const f = fixture({ passageActions: () => actions, clearPassage });
    const modal = document.createElement('div');
    if (selector === '.modal-container') modal.className = 'modal-container';
    else modal.setAttribute('role', 'dialog');
    const target = modal.appendChild(document.createElement('button'));
    document.body.append(modal);
    const pickerEscape = vi.fn((event: Event) => {
      event.preventDefault();
    });
    target.addEventListener('keydown', pickerEscape);
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(pickerEscape).toHaveBeenCalledOnce();
    expect(f.controller.active).toBe(true);
    expect(clearPassage).not.toHaveBeenCalled();
    expect(f.options.modeChanged).not.toHaveBeenCalled();
  },
);

it('rejects old action intent before refresh, after replacement, off-mode and after disposal', () => {
  const oldAction = passageAction();
  let actions: readonly TapToolbarAction[] | undefined = [oldAction];
  const f = fixture({ passageActions: () => actions });
  const oldButton = button(f.toolbar, 'Link to note');
  const nextAction = passageAction();
  actions = [nextAction];
  oldButton.click(); // The View has superseded the context before its next refresh.
  expect(oldAction.run).not.toHaveBeenCalled();
  f.controller.refreshActions();
  const current = button(f.toolbar, 'Link to note');
  expect(current).not.toBe(oldButton);
  expect(oldButton.isConnected).toBe(false);
  oldButton.click();
  expect(oldAction.run).not.toHaveBeenCalled();
  current.click();
  expect(nextAction.run).toHaveBeenCalledOnce();
  button(f.toolbar, 'Done').click();
  current.click();
  expect(nextAction.run).toHaveBeenCalledOnce();
  f.controller.dispose();
  current.click();
  expect(nextAction.run).toHaveBeenCalledOnce();
});

it('ignores a generic picker rejection after disposal and never clears View intent from dispose', async () => {
  const action = passageAction();
  let reject!: (error: Error) => void;
  action.run.mockReturnValue(
    new Promise<unknown>((_, fail) => {
      reject = fail;
    }),
  );
  const actions = [action];
  const clearPassage = vi.fn();
  const f = fixture({ passageActions: () => actions, clearPassage });
  button(f.toolbar, 'Link to note').click();
  f.controller.dispose();
  reject(new Error('late picker failure'));
  await Promise.resolve();
  f.controller.reset();
  f.controller.refreshActions();
  expect(f.options.notify).not.toHaveBeenCalled();
  expect(clearPassage).not.toHaveBeenCalled();
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  expect([...f.toolbar.childNodes]).toEqual(f.original);
});

it('reserves only the menu bar height, never space for the screen-reader status', () => {
  const f = fixture();
  Object.defineProperty(f.toolbar, 'offsetHeight', { value: 52 });
  Object.defineProperty(f.hint, 'offsetHeight', {
    get: () => {
      throw new Error('Status must not affect layout');
    },
  });
  window.dispatchEvent(new window.Event('resize'));
  expect(f.viewport.parentElement?.style.getPropertyValue('--reader-controls-clearance')).toBe(
    'calc(64px + var(--reader-controls-bottom))',
  );
});

it('marks only the first word without saving or changing authored article nodes', () => {
  const f = fixture();
  const html = f.body.innerHTML;
  const text = f.first.startContainer;
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  expect(f.hint.textContent).toBe('Tap the first word');
  expect(button(f.toolbar, 'Sentence').disabled).toBe(true);
  expect(button(f.toolbar, 'Paragraph').disabled).toBe(true);
  tap(f);
  expect(picker.wordAt).toHaveBeenCalledExactlyOnceWith(20, 30);
  expect(f.options.save).not.toHaveBeenCalled();
  expect(picker.between).not.toHaveBeenCalled();
  expect(f.preview.getAttribute('aria-hidden')).toBe('true');
  expect(f.preview.children).toHaveLength(1);
  expect(f.preview.firstElementChild?.getAttribute('style')).toContain('width: 45px');
  expect(f.hint.textContent).toBe('Tap the last word, or choose below');
  expect(button(f.toolbar, 'Sentence').disabled).toBe(false);
  expect(button(f.toolbar, 'Paragraph').disabled).toBe(false);
  expect(f.body.innerHTML).toBe(html);
  expect(f.first.startContainer).toBe(text);
});

it.each(['Sentence', 'Paragraph'] as const)(
  'enables %s only after a word and saves the exact expanded Range',
  async (label) => {
    const f = fixture();
    const action = button(f.toolbar, label);
    action.click();
    expect(picker.sentence).not.toHaveBeenCalled();
    expect(picker.paragraph).not.toHaveBeenCalled();
    expect(f.options.save).not.toHaveBeenCalled();
    tap(f);
    action.click();
    const kind = label === 'Sentence' ? 'sentence' : 'paragraph';
    expect(picker[kind]).toHaveBeenCalledExactlyOnceWith(f.first);
    expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f[kind]);
    expect(f.options.save.mock.calls[0][0].toString()).toBe(
      kind === 'sentence' ? 'Alpha bravo charlie.' : 'Alpha bravo charlie. Delta echo.',
    );
    await Promise.resolve();
    expect(f.controller.active).toBe(true);
    expect(action.disabled).toBe(true);
    expect(f.preview.children).toHaveLength(0);
    expect(f.hint.textContent).toBe('Tap the first word');
  },
);

it('saves the inclusive two-endpoint Range once, then remains ready for another highlight', async () => {
  const f = fixture();
  tap(f);
  tap(f, 80);
  clickAt(f.body, 80); // A duplicate click while the first save is pending cannot write twice.
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, f.last);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  expect(f.options.save.mock.calls[0][0].toString()).toBe('Alpha bravo charlie');
  expect(picker.wordAt).toHaveBeenCalledTimes(2);
  expect(f.hint.textContent).toBe('Saving…');
  await Promise.resolve();
  expect(f.controller.active).toBe(true);
  expect(f.hint.textContent).toBe('Tap the first word');
  expect(f.preview.children).toHaveLength(0);
  tap(f, 80);
  expect(f.options.save).toHaveBeenCalledOnce();
  tap(f);
  expect(picker.between).toHaveBeenLastCalledWith(f.last, f.first);
  expect(f.options.save).toHaveBeenCalledTimes(2);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  await Promise.resolve();
});

it('accepts a second tap on the same word as a one-word highlight', async () => {
  const f = fixture();
  picker.between.mockReturnValue(f.first);
  tap(f);
  tap(f);
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, f.first);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.first);
  expect(f.options.save.mock.calls[0][0].toString()).toBe('Alpha');
  await Promise.resolve();
});

it('keeps the first endpoint when the text picker rejects a cross-paragraph range', async () => {
  const f = fixture();
  picker.between.mockReturnValueOnce(undefined);
  tap(f);
  tap(f, 80);
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.hint.textContent).toMatch(/same paragraph/);
  expect(f.options.notify).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: expect.stringContaining('same paragraph') }),
  );
  expect(f.preview.children).toHaveLength(1);
  tap(f, 80);
  expect(picker.between).toHaveBeenLastCalledWith(f.first, f.last);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  await Promise.resolve();
});

it('hides unavailable Undo and delegates available Undo without making a new highlight', async () => {
  const unavailable = fixture();
  expect(button(unavailable.toolbar, 'Undo').hidden).toBe(true);
  unavailable.controller.dispose();
  const f = fixture({ canUndo: true });
  const undo = button(f.toolbar, 'Undo');
  expect(undo.hidden).toBe(false);
  tap(f);
  undo.click();
  expect(f.options.undo).toHaveBeenCalledOnce();
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.preview.children).toHaveLength(0);
  expect(undo.disabled).toBe(true);
  await Promise.resolve();
  expect(undo.disabled).toBe(false);
  expect(f.controller.active).toBe(true);
  expect(f.hint.textContent).toBe('Tap the first word');
});

it('updates Undo availability in place without losing a pending endpoint', async () => {
  const f = fixture();
  const panel = f.toolbar.firstElementChild;
  const undo = button(f.toolbar, 'Undo');
  tap(f);
  f.controller.setUndoAvailable(true);
  expect(undo.hidden).toBe(false);
  expect(f.toolbar.firstElementChild).toBe(panel);
  expect(f.preview.children).toHaveLength(1);
  f.controller.setUndoAvailable(false);
  expect(undo.hidden).toBe(true);
  tap(f, 80);
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, f.last);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  await Promise.resolve();
  f.controller.setUndoAvailable(true);
  undo.click();
  expect(f.options.undo).toHaveBeenCalledOnce();
  await Promise.resolve();
});

it.each([
  [320, 7, 5],
  [390, 7, 5],
  [1280, 7, 9],
  [320, 9, 6],
  [390, 9, 6],
  [1280, 9, 11],
])(
  'balances the normal toolbar at pane width %i with %i existing actions',
  (width, existing, columns) => {
    const column = document.createElement('div');
    const viewport = column.appendChild(document.createElement('div'));
    const body = viewport.appendChild(document.createElement('article'));
    const toolbar = column.appendChild(document.createElement('div'));
    Object.defineProperty(column, 'clientWidth', { value: width - 24 });
    for (let i = 0; i < existing; i++) toolbar.appendChild(document.createElement('button'));
    toolbar.style.setProperty('grid-template-columns', 'repeat(2, 44px)', 'important');
    document.body.appendChild(column);
    const controller = new TapHighlighter(viewport, body, toolbar, {
      active: false,
      canUndo: false,
      modeChanged: vi.fn(),
      save: vi.fn(async () => {}),
      undo: vi.fn(async () => {}),
      notify: vi.fn(),
    });
    try {
      expect(toolbar.querySelectorAll('button')).toHaveLength(existing + 2);
      expect(toolbar.style.gridTemplateColumns).toBe(`repeat(${columns}, 44px)`);
    } finally {
      controller.dispose();
      expect(toolbar.style.gridTemplateColumns).toBe('repeat(2, 44px)');
      expect(toolbar.style.getPropertyPriority('grid-template-columns')).toBe('important');
      column.remove();
    }
  },
);

it('Done cancels a pending endpoint and exits in one press without saving', () => {
  const f = fixture();
  tap(f);
  button(f.toolbar, 'Done').click();
  expect(f.controller.active).toBe(false);
  expect(f.options.modeChanged).toHaveBeenCalledExactlyOnceWith(false);
  expect(f.preview.children).toHaveLength(0);
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.options.undo).not.toHaveBeenCalled();
});

it('Escape first cancels a pending endpoint, then exits mode without saving', () => {
  const f = fixture();
  tap(f);
  escape();
  expect(f.controller.active).toBe(true);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  expect(f.preview.children).toHaveLength(0);
  expect(button(f.toolbar, 'Sentence').disabled).toBe(true);
  expect(f.hint.textContent).toBe('Tap the first word');
  escape();
  expect(f.controller.active).toBe(false);
  expect(f.options.modeChanged).toHaveBeenCalledExactlyOnceWith(false);
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.options.undo).not.toHaveBeenCalled();
});

it('consumes active Escape but leaves unrelated keys and off-mode Escape alone', () => {
  const f = fixture();
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  document.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(f.controller.active).toBe(true);
  expect(escape().defaultPrevented).toBe(true);
  expect(escape().defaultPrevented).toBe(false);
});

it.each([
  '<input>',
  '<textarea></textarea>',
  '<select><option>Choice</option></select>',
  '<div contenteditable="true">Editor</div>',
  '<div class="modal-container"><button>Modal action</button></div>',
  '<div role="dialog"><button>Dialog action</button></div>',
])('does not steal Escape from an editor or modal: %s', (markup) => {
  const f = fixture();
  tap(f);
  const container = document.createElement('div');
  container.innerHTML = markup;
  document.body.append(container);
  const target = container.querySelector('input, textarea, select, [contenteditable], button')!;
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(f.controller.active).toBe(true);
  expect(f.preview.children).toHaveLength(1);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
});

it('honors an Escape event already consumed by another interaction', () => {
  const f = fixture();
  tap(f);
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  event.preventDefault();
  document.dispatchEvent(event);
  expect(f.controller.active).toBe(true);
  expect(f.preview.children).toHaveLength(1);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
});

it.each(['drag', 'scroll', 'pointercancel', 'multitouch'])(
  'ignores a %s gesture and accepts a fresh discrete tap afterward',
  (gesture) => {
    const f = fixture();
    pointer(f.body, 'pointerdown');
    if (gesture === 'drag') pointer(document, 'pointermove', { clientX: 29 });
    if (gesture === 'scroll') f.viewport.dispatchEvent(new Event('scroll'));
    if (gesture === 'pointercancel') pointer(document, 'pointercancel');
    if (gesture === 'multitouch') {
      pointer(f.body, 'pointerdown', { pointerId: 2, isPrimary: false });
    }
    pointer(document, 'pointerup');
    clickAt(f.body);
    expect(picker.wordAt).not.toHaveBeenCalled();
    expect(f.options.save).not.toHaveBeenCalled();
    expect(f.preview.children).toHaveLength(0);
    tap(f);
    expect(picker.wordAt).toHaveBeenCalledExactlyOnceWith(20, 30);
    expect(f.preview.children).toHaveLength(1);
    expect(f.options.save).not.toHaveBeenCalled();
  },
);

it('does not complete a pending highlight from a dragged or cancelled last-word gesture', async () => {
  const f = fixture();
  tap(f);
  pointer(f.body, 'pointerdown', { clientX: 80 });
  pointer(document, 'pointermove', { clientX: 100 });
  pointer(document, 'pointerup', { clientX: 100 });
  clickAt(f.body, 80);
  pointer(f.body, 'pointerdown', { clientX: 80 });
  pointer(document, 'pointercancel');
  clickAt(f.body, 80);
  expect(picker.wordAt).toHaveBeenCalledOnce();
  expect(picker.between).not.toHaveBeenCalled();
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.preview.children).toHaveLength(1);
  tap(f, 80);
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, f.last);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  await Promise.resolve();
});

it('allows small pointer jitter rather than treating every pointermove as a drag', () => {
  const f = fixture();
  pointer(f.body, 'pointerdown');
  pointer(document, 'pointermove', { clientX: 23, clientY: 34 });
  pointer(document, 'pointerup');
  clickAt(f.body);
  expect(f.preview.children).toHaveLength(1);
  expect(f.options.save).not.toHaveBeenCalled();
});

it.each([{ button: 2 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }])(
  'does not treat a non-primary or modified click as an endpoint: %j',
  (init) => {
    const f = fixture();
    pointer(f.body, 'pointerdown', init);
    clickAt(f.body, 20, init);
    expect(picker.wordAt).not.toHaveBeenCalled();
    expect(f.preview.children).toHaveLength(0);
    expect(f.options.save).not.toHaveBeenCalled();
  },
);

it('ignores outside article events and non-text hits without losing a pending endpoint', async () => {
  const f = fixture();
  const outside = document.createElement('aside');
  outside.textContent = 'Outside Reader text';
  f.host.append(outside);
  tap(f, 20, outside);
  expect(picker.wordAt).not.toHaveBeenCalled();
  tap(f, 200); // The picker returns undefined for whitespace/protected/non-text content.
  expect(f.preview.children).toHaveLength(0);
  tap(f);
  tap(f, 200);
  expect(f.preview.children).toHaveLength(1);
  expect(f.options.save).not.toHaveBeenCalled();
  tap(f, 80);
  expect(picker.between).toHaveBeenCalledExactlyOnceWith(f.first, f.last);
  expect(f.options.save).toHaveBeenCalledExactlyOnceWith(f.inclusive);
  await Promise.resolve();
});

it.each(['save', 'undo'] as const)(
  'reports a rejected %s through the visible-error callback and allows retry',
  async (action) => {
    const f = fixture({ canUndo: true });
    const error = new Error(`${action} failed`);
    f.options[action].mockRejectedValueOnce(error);
    const invoke = () => {
      if (action === 'save') {
        tap(f);
        tap(f, 80);
      } else button(f.toolbar, 'Undo').click();
    };
    invoke();
    expect(f.hint.textContent).toBe('Saving…');
    await Promise.resolve();
    expect(f.options.notify).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.controller.active).toBe(true);
    expect(f.hint.textContent).toBe('Tap the first word');
    expect(button(f.toolbar, 'Done').disabled).toBe(false);
    invoke();
    await Promise.resolve();
    expect(f.options[action]).toHaveBeenCalledTimes(2);
    expect(f.options.notify).toHaveBeenCalledOnce();
    expect(f.controller.active).toBe(true);
  },
);

it('reports a synchronously thrown save and releases the busy controls', () => {
  const f = fixture();
  const error = new Error('write guard failed');
  f.options.save.mockImplementationOnce(() => {
    throw error;
  });
  tap(f);
  tap(f, 80);
  expect(f.options.notify).toHaveBeenCalledExactlyOnceWith(error);
  expect(button(f.toolbar, 'Done').disabled).toBe(false);
  expect(f.hint.textContent).toBe('Tap the first word');
});

it('blocks duplicate writes, Undo and mode changes until the dispatched save settles', async () => {
  const f = fixture({ canUndo: true });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.options.save.mockReturnValueOnce(pending);
  tap(f);
  tap(f, 80);
  for (const label of ['Sentence', 'Paragraph', 'Undo', 'Done']) {
    expect(button(f.toolbar, label).disabled).toBe(true);
    button(f.toolbar, label).click();
  }
  tap(f);
  escape();
  expect(f.options.save).toHaveBeenCalledOnce();
  expect(f.options.undo).not.toHaveBeenCalled();
  expect(f.options.modeChanged).not.toHaveBeenCalled();
  expect(f.controller.active).toBe(true);
  release();
  await pending;
  expect(button(f.toolbar, 'Done').disabled).toBe(false);
  expect(button(f.toolbar, 'Undo').disabled).toBe(false);
  expect(f.hint.textContent).toBe('Tap the first word');
});

it('clips the transient marker to the viewport and repaints on scroll/resize', () => {
  const f = fixture();
  vi.mocked(f.viewport.getBoundingClientRect).mockReturnValue(new DOMRect(10, 20, 100, 80));
  vi.spyOn(f.preview, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 10, 600, 400));
  Object.defineProperties(f.preview, {
    offsetWidth: { value: 300 },
    offsetHeight: { value: 200 },
  });
  wordRects = [new DOMRect(0, 10, 40, 40), new DOMRect(500, 500, 10, 10)];
  tap(f);
  expect(f.preview.children).toHaveLength(1);
  const marker = f.preview.firstElementChild as HTMLElement;
  expect(marker.style.left).toBe('2.5px');
  expect(marker.style.top).toBe('5px');
  expect(marker.style.width).toBe('15px');
  expect(marker.style.height).toBe('15px');
  wordRects = [new DOMRect(20, 30, 20, 10)];
  f.viewport.dispatchEvent(new Event('scroll'));
  expect((f.preview.firstElementChild as HTMLElement).style.left).toBe('7.5px');
  wordRects = [];
  window.dispatchEvent(new Event('resize'));
  expect(f.preview.children).toHaveLength(0);
  expect(f.options.save).not.toHaveBeenCalled();
});

it('never alters the native Selection or rendered text during mode, save, Undo or disposal', async () => {
  const f = fixture({ active: false, canUndo: true });
  const selection = document.getSelection()!;
  const nativeRange = f.first.cloneRange();
  selection.addRange(nativeRange);
  const html = f.body.innerHTML;
  const text = nativeRange.startContainer;
  const remove = vi.spyOn(selection, 'removeAllRanges');
  const add = vi.spyOn(selection, 'addRange');
  const unchanged = () => {
    expect(selection.getRangeAt(0)).toBe(nativeRange);
    expect(selection.toString()).toBe('Alpha');
    expect(nativeRange.startContainer).toBe(text);
    expect(nativeRange.startOffset).toBe(0);
    expect(nativeRange.endOffset).toBe(5);
    expect(f.body.innerHTML).toBe(html);
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  };
  button(f.toolbar, 'Highlight mode').click();
  unchanged();
  tap(f);
  unchanged();
  f.viewport.dispatchEvent(new Event('scroll'));
  unchanged();
  tap(f, 80);
  await Promise.resolve();
  unchanged();
  button(f.toolbar, 'Undo').click();
  await Promise.resolve();
  unchanged();
  button(f.toolbar, 'Done').click();
  unchanged();
  f.controller.dispose();
  unchanged();
});

it('preserves normal link handlers off-mode but suppresses them while highlighting', () => {
  const f = fixture({ active: false });
  const link = document.createElement('a');
  link.href = 'https://example.com/publisher';
  link.textContent = 'Publisher link';
  f.body.append(link);
  const followed = vi.fn((event: Event) => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault(); // Avoid jsdom navigation; the real link handler owns this off-mode.
  });
  link.addEventListener('click', followed);
  tap(f, 200, link);
  expect(followed).toHaveBeenCalledOnce();
  expect(picker.wordAt).not.toHaveBeenCalled();
  button(f.toolbar, 'Highlight mode').click();
  const click = tap(f, 200, link);
  expect(click.defaultPrevented).toBe(true);
  expect(followed).toHaveBeenCalledOnce();
  expect(picker.wordAt).toHaveBeenCalledExactlyOnceWith(200, 30);
  expect(f.options.save).not.toHaveBeenCalled();
  button(f.toolbar, 'Done').click();
  tap(f, 200, link);
  expect(followed).toHaveBeenCalledTimes(2);
});

it('removes overlays and every event response on disposal, including detached toolbar buttons', () => {
  const f = fixture({ active: false, canUndo: true });
  const trigger = button(f.toolbar, 'Highlight mode');
  trigger.click();
  const undo = button(f.toolbar, 'Undo');
  const done = button(f.toolbar, 'Done');
  const hint = f.hint;
  tap(f);
  f.options.modeChanged.mockClear();
  picker.wordAt.mockClear();
  f.controller.dispose();
  f.controller.dispose();
  expect(f.preview.isConnected).toBe(false);
  expect(hint.isConnected).toBe(false);
  expect(f.body.classList.contains('reader-tap-highlight-mode')).toBe(false);
  expect(f.toolbar.classList.contains('reader-tap-highlight-toolbar')).toBe(false);
  trigger.click();
  undo.click();
  done.click();
  expect(tap(f).defaultPrevented).toBe(false);
  pointer(document, 'pointermove', { clientX: 100 });
  pointer(document, 'pointercancel');
  document.dispatchEvent(new Event('scroll'));
  window.dispatchEvent(new Event('resize'));
  expect(escape().defaultPrevented).toBe(false);
  expect(picker.wordAt).not.toHaveBeenCalled();
  expect(f.options.save).not.toHaveBeenCalled();
  expect(f.options.undo).not.toHaveBeenCalled();
  expect(f.options.notify).not.toHaveBeenCalled();
  expect(f.options.modeChanged).not.toHaveBeenCalled();
});

it.each([true, false])(
  'restores original toolbar nodes and prior inline layout when disposed (active=%s)',
  (active) => {
    const f = fixture();
    f.controller.dispose();
    expect([...f.toolbar.childNodes]).toEqual(f.original);
    f.toolbar.style.setProperty('grid-template-columns', 'repeat(2, 44px)', 'important');
    f.host.style.setProperty('--reader-controls-clearance', '89px', 'important');
    // jsdom drops priorities on custom properties; preserve what this host exposes.
    const clearancePriority = f.host.style.getPropertyPriority('--reader-controls-clearance');
    Object.defineProperty(f.host, 'clientWidth', { value: 320 });
    Object.defineProperty(f.toolbar, 'offsetHeight', { value: 52 });
    const controller = new TapHighlighter(f.viewport, f.body, f.toolbar, { ...f.options, active });
    disposers.push(() => controller.dispose());
    expect(f.host.style.getPropertyValue('--reader-controls-clearance')).toBe(
      'calc(64px + var(--reader-controls-bottom))',
    );
    controller.dispose();
    expect([...f.toolbar.childNodes]).toEqual(f.original);
    expect(f.toolbar.querySelector('.reader-tap-highlight-trigger')).toBeNull();
    expect(f.toolbar.style.getPropertyValue('grid-template-columns')).toBe('repeat(2, 44px)');
    expect(f.toolbar.style.getPropertyPriority('grid-template-columns')).toBe('important');
    expect(f.host.style.getPropertyValue('--reader-controls-clearance')).toBe('89px');
    expect(f.host.style.getPropertyPriority('--reader-controls-clearance')).toBe(clearancePriority);
    expect(f.body.classList.contains('reader-tap-highlight-mode')).toBe(false);
    expect(f.toolbar.classList.contains('reader-tap-highlight-toolbar')).toBe(false);
    f.previous.click();
    expect(f.previousClicked).toHaveBeenCalledOnce();
  },
);

it('does not restore old actions or layout over a replacement toolbar owner on disposal', () => {
  const f = fixture();
  const replacement = document.createElement('button');
  replacement.textContent = 'Replacement action';
  f.toolbar.replaceChildren(replacement);
  f.toolbar.style.setProperty('grid-template-columns', 'repeat(3, 48px)');
  f.host.style.setProperty('--reader-controls-clearance', '100px');
  f.controller.dispose();
  expect([...f.toolbar.childNodes]).toEqual([replacement]);
  expect(f.toolbar.style.getPropertyValue('grid-template-columns')).toBe('repeat(3, 48px)');
  expect(f.host.style.getPropertyValue('--reader-controls-clearance')).toBe('100px');
  expect(f.preview.isConnected).toBe(false);
  expect(f.options.modeChanged).not.toHaveBeenCalled();
});

it('ignores a late failed save after disposal without resurrecting UI or reporting stale errors', async () => {
  const f = fixture();
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => {
    fail = reject;
  });
  f.options.save.mockReturnValueOnce(pending);
  tap(f);
  tap(f, 80);
  f.controller.dispose();
  fail(new Error('late failure'));
  await Promise.resolve();
  expect(f.options.notify).not.toHaveBeenCalled();
  expect(f.host.querySelector('[role="status"]')).toBeNull();
  expect(f.host.querySelector('.reader-tap-highlight-preview')).toBeNull();
});

// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { pickNode } from '../src/host/node-picker';
import type { NodeResult, NodesApi } from '../src/host/nodes';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
interface Picker {
  inputEl: HTMLInputElement;
  results: NodeResult[];
  getSuggestions(query: string): NodeResult[];
  renderSuggestion(node: NodeResult, element: HTMLElement): void;
  onChooseSuggestion(node: NodeResult): void;
  close(): void;
}
const mocks = vi.hoisted(() => ({
  picker: undefined as Picker | undefined,
  open: vi.fn(),
  close: vi.fn(),
  setIcon: vi.fn(),
  placeholder: vi.fn(),
}));
vi.mock('obsidian', () => ({
  setIcon: mocks.setIcon,
  SuggestModal: class {
    inputEl = document.createElement('input');
    results: NodeResult[] = [];
    constructor() {
      mocks.picker = this;
    }
    setPlaceholder(value: string) {
      mocks.placeholder(value);
    }
    getSuggestions(_query: string): NodeResult[] {
      return [];
    }
    renderSuggestion(_node: NodeResult, _element: HTMLElement) {}
    onChooseSuggestion(_node: NodeResult) {}
    private input = () => {
      this.results = this.getSuggestions(this.inputEl.value);
    };
    open() {
      mocks.open();
      this.inputEl.addEventListener('input', this.input);
    }
    close() {
      mocks.close();
      this.onClose();
    }
    onClose() {
      this.inputEl.removeEventListener('input', this.input);
    }
  },
}));
beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    createEl(
      this: HTMLElement,
      tag: string,
      options: { text?: string; cls?: string; attr?: Record<string, string> } = {},
    ) {
      const element = document.createElement(tag);
      if (options.text) element.textContent = options.text;
      if (options.cls) element.className = options.cls;
      for (const [name, value] of Object.entries(options.attr ?? {}))
        element.setAttribute(name, value);
      this.append(element);
      return element;
    },
    createDiv(this: HTMLElement, options = {}) {
      return this.createEl('div', options);
    },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.picker = undefined;
});
afterEach(() => {
  document.body.replaceChildren();
});
const node = (id = 0): NodeResult => ({
  path: `Notes/Node ${id}.md`,
  title: `Node ${id}`,
  type: 'People/Person',
  classes: ['Topic', 'People/Person'],
  aliases: [],
  icon: 'contact',
});
function fixture(nodes = [node()]) {
  const api: NodesApi = {
    version: 2,
    listTypes: vi.fn(() => [
      { type: 'Topic', label: 'Topic', icon: 'hash' },
      { type: 'People/Person', label: 'People/Person' },
    ]),
    searchNodes: vi.fn(() => nodes),
    getNode: vi.fn(() => null),
    createNode: vi.fn(async () => null),
  };
  const signal = new AbortController();
  return {
    api,
    signal,
    open: (query = 'initial query') => pickNode({} as App, api, query, signal.signal),
  };
}

it('caps the real picker at 100 without mutating results, and reads class metadata once, not per row', async () => {
  const nodes = Array.from({ length: 150 }, (_, i) => node(i)),
    f = fixture(nodes),
    chosen = f.open();
  const picker = mocks.picker!;
  expect(picker.results).toEqual(nodes.slice(0, 100));
  expect(nodes).toHaveLength(150);
  expect(picker.inputEl.value).toBe('initial query');
  expect(mocks.placeholder).toHaveBeenCalledWith('Link passage to note by class');
  for (const result of picker.results)
    picker.renderSuggestion(result, document.createElement('div'));
  expect(f.api.listTypes).toHaveBeenCalledOnce();
  expect(f.api.searchNodes).toHaveBeenCalledExactlyOnceWith('initial query');
  expect(f.api.getNode).not.toHaveBeenCalled();
  picker.close();
  expect(await chosen).toBeNull();
});

it('renders bound classes in their original order with optional public icons and no colors', async () => {
  const value = node(),
    f = fixture([value]),
    chosen = f.open(),
    row = document.createElement('div');
  const original = structuredClone(value);
  mocks.picker!.renderSuggestion(value, row);
  expect(row.firstElementChild?.textContent).toBe('Node 0');
  expect([...row.querySelectorAll('small')].map((el) => el.textContent)).toEqual([
    'Topic',
    'People/Person',
  ]);
  expect(mocks.setIcon.mock.calls.map(([, icon]) => icon)).toEqual(['hash', 'contact']);
  expect(mocks.setIcon.mock.calls.every(([el]) => el.getAttribute('aria-hidden') === 'true')).toBe(
    true,
  );
  expect(row.querySelector('[style]')).toBeNull();
  expect(value).toEqual(original);
  mocks.picker!.close();
  await chosen;
});

it('keeps unknown class names and titles as text, without inventing missing icons', async () => {
  const value = {
    ...node(),
    title: '<b>Literal</b>',
    type: 'Unknown',
    classes: ['Unknown'],
    icon: undefined,
  };
  const f = fixture([value]),
    chosen = f.open(),
    row = document.createElement('div');
  mocks.picker!.renderSuggestion(value, row);
  expect(row.textContent).toBe('<b>Literal</b>Unknown');
  expect(row.querySelector('b')).toBeNull();
  expect(mocks.setIcon).not.toHaveBeenCalled();
  mocks.picker!.close();
  await chosen;
});

it('does not open or query an already-aborted picker', async () => {
  const f = fixture();
  f.signal.abort();
  expect(await f.open()).toBeNull();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(f.api.listTypes).not.toHaveBeenCalled();
  expect(f.api.searchNodes).not.toHaveBeenCalled();
});

it('abort closes the picker, settles null and ignores late choices and queries', async () => {
  const f = fixture(),
    chosen = f.open(),
    picker = mocks.picker!;
  const remove = vi.spyOn(f.signal.signal, 'removeEventListener');
  f.signal.abort();
  picker.onChooseSuggestion(node());
  expect(picker.getSuggestions('late')).toEqual([]);
  expect(await chosen).toBeNull();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(f.api.searchNodes).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('ordinary close settles null and detaches the abort listener', async () => {
  const f = fixture(),
    chosen = f.open();
  mocks.picker!.close();
  expect(await chosen).toBeNull();
  f.signal.abort();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('honors Obsidian close-before-choice ordering without losing the selected snapshot', async () => {
  const f = fixture(),
    chosen = f.open(),
    selected = node();
  mocks.picker!.close();
  mocks.picker!.onChooseSuggestion(selected);
  expect(await chosen).toBe(selected);
});

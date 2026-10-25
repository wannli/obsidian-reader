// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { NodeResult, NodesApi } from '../src/host/nodes';
import { chooseHighlightHost, type HighlightHostPickerOptions } from '../src/host/highlight-picker';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
const modalState = vi.hoisted(() => ({
  current: undefined as { close(): void } | undefined,
  document: undefined as Document | undefined,
}));
vi.mock('obsidian', () => ({
  Modal: class {
    ownerDocument = modalState.document ?? document;
    modalEl = this.ownerDocument.createElement('div');
    titleEl = this.ownerDocument.createElement('h2');
    contentEl = this.ownerDocument.createElement('div');
    constructor() {
      this.modalEl.append(this.titleEl, this.contentEl);
      modalState.current = this;
    }
    setTitle(title: string) {
      this.titleEl.textContent = title;
    }
    onOpen() {}
    onClose() {}
    open() {
      this.ownerDocument.body.append(this.modalEl);
      this.onOpen();
    }
    close() {
      this.onClose();
      this.modalEl.remove();
    }
  },
  setIcon(element: HTMLElement, name: string) {
    element.dataset.icon = name;
  },
}));

const node = (title: string, classes = ['concept'], aliases: string[] = []): NodeResult => ({
  path: `Notes/${title}.md`,
  title,
  classes,
  aliases,
  type: classes.at(-1) ?? '',
});
const exact = node('Memory');
const alias = node('Recall', ['topic'], ['Memory']);
const fuzzy = node('Spaced repetition', ['topic', 'concept']);
const untyped = { ...node('Untyped', []), type: 'topic' };
const foreign = node('Unknown', ['unknown']);
const availableTypes = [
  { type: 'concept', label: 'Concept', icon: 'brain' },
  { type: 'topic', label: 'Topic', icon: 'tag' },
];
function provider() {
  const index = new Map(
    [exact, alias, fuzzy, untyped, foreign].map((entry) => [entry.path, entry]),
  );
  const writes = {
    createNode: vi.fn<NodesApi['createNode']>(async () => null),
    createNodeForLink: vi.fn<NonNullable<NodesApi['createNodeForLink']>>(async () => null),
    pickNodeForLink: vi.fn<NonNullable<NodesApi['pickNodeForLink']>>(async () => null),
  };
  const api = {
    version: 2 as const,
    listTypes: vi.fn<NodesApi['listTypes']>(() => availableTypes),
    searchNodes: vi.fn<NodesApi['searchNodes']>(() => [...index.values()]),
    getNode: vi.fn<NodesApi['getNode']>((path) => index.get(path) ?? null),
    ...writes,
  };
  return { api, index, writes };
}
let source: ReturnType<typeof provider>;
beforeEach(() => {
  document.body.replaceChildren();
  source = provider();
  modalState.current = undefined;
  modalState.document = undefined;
});
afterEach(() => {
  modalState.current?.close();
  expect(source.writes.createNode).not.toHaveBeenCalled();
  expect(source.writes.createNodeForLink).not.toHaveBeenCalled();
  expect(source.writes.pickNodeForLink).not.toHaveBeenCalled();
});
const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};
const rows = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.reader-highlight-picker-result[data-path]'),
];
const row = (path: string) => {
  const found = rows().find((entry) => entry.dataset.path === path);
  if (!found) throw new Error(`Missing note: ${path}`);
  return found;
};
const creates = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.reader-highlight-picker-create-row'),
];
const create = (type: string) => {
  const found = creates().find((entry) => entry.dataset.createType === type);
  if (!found) throw new Error(`Missing creation class: ${type}`);
  return found;
};
const searchInput = () => document.querySelector<HTMLInputElement>('input[type="search"]')!;
const filterInput = () =>
  document.querySelector<HTMLSelectElement>('.reader-highlight-picker-controls select')!;
const search = (value: string) => {
  searchInput().value = value;
  searchInput().dispatchEvent(new Event('input'));
};
const filter = (value: string) => {
  filterInput().value = value;
  filterInput().dispatchEvent(new Event('change'));
};
const key = (element: HTMLElement, value: string, extra: KeyboardEventInit = {}) =>
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }),
  );
const error = () => document.querySelector<HTMLElement>('[role="alert"]')!;
function open(options: HighlightHostPickerOptions = {}) {
  const choice = chooseHighlightHost({} as App, source.api, options);
  const settled = vi.fn();
  void choice.then(settled);
  return { choice, settled };
}

// Every case also asserts no standalone creation, linked creation, shared picker, or writes.
describe('existing typed highlight notes', () => {
  it('scopes faint picker accents to highlight or node intent, leaving related notes neutral', async () => {
    for (const tone of ['highlight', 'node', 'neutral'] as const) {
      const { choice } = open({ tone });
      const modal = document.querySelector('.reader-highlight-picker-modal')!;
      expect(modal.classList.contains('reader-picker-highlight')).toBe(tone === 'highlight');
      expect(modal.classList.contains('reader-picker-node')).toBe(tone === 'node');
      button('Cancel').click();
      expect(await choice).toBeNull();
    }
  });
  it('omits articles and feeds from search, filters and creation without hiding other notes', async () => {
    const article = node('Article', ['article']);
    const feed = node('Feed', ['feed']);
    const mixed = node('Mixed', ['concept', 'article']);
    for (const entry of [article, feed, mixed]) source.index.set(entry.path, entry);
    source.api.listTypes.mockReturnValue([
      ...availableTypes,
      { type: 'article', label: 'Articles' },
      { type: 'feed', label: 'Feeds' },
    ]);
    const { choice } = open({ multiple: true, minSelection: 0 });
    expect(rows().map((entry) => entry.dataset.path)).toEqual([exact.path, alias.path, fuzzy.path]);
    expect([...filterInput().options].map((entry) => entry.textContent)).toEqual([
      'All types',
      'Concept',
      'Topic',
    ]);
    search('New');
    expect(creates().map((entry) => entry.dataset.createType)).toEqual(['concept', 'topic']);
    search('Article');
    expect(rows().map((entry) => entry.dataset.path)).not.toContain(article.path);
    search('');
    source.index.set(exact.path, { ...exact, classes: ['concept', 'feed'] });
    row(exact.path).click();
    expect(error().textContent).toContain('no longer available');
    button('Cancel').click();
    expect(await choice).toBeNull();
  });
  it('shows exact and fuzzy existing candidates with classes/path, without silently choosing', async () => {
    const { choice, settled } = open({ title: 'Choose highlight notes', query: 'Memory' });
    expect(document.querySelector('h2')?.textContent).toBe('Choose highlight notes');
    expect(rows().map((entry) => entry.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Exact title'),
      expect.stringContaining('Exact alias'),
      expect.stringContaining('Related match'),
    ]);
    expect(row(fuzzy.path).textContent).toContain('Topic · Concept');
    expect(row(fuzzy.path).getAttribute('aria-label')).toContain(fuzzy.path);
    expect(row(fuzzy.path).textContent).not.toContain(fuzzy.path);
    expect(rows()).toHaveLength(3);
    expect(document.body.textContent).not.toContain('Link note');
    key(searchInput(), 'Enter');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    row(fuzzy.path).focus();
    key(row(fuzzy.path), 'Enter');
    expect(await choice).toEqual({ kind: 'existing', node: fuzzy });
    expect(source.api.getNode).toHaveBeenCalledWith(fuzzy.path);
    expect(document.body.children).toHaveLength(0);
  });

  it('seeds a bounded query but allows a completely independent search', async () => {
    const { choice } = open({
      query: 'A long selected quote with many visible words. '.repeat(30),
    });
    expect(searchInput().value.length).toBeLessThanOrEqual(80);
    expect(source.api.searchNodes).toHaveBeenLastCalledWith(searchInput().value);
    expect(searchInput().getAttribute('aria-label')).toBe('Search typed notes');
    expect(filterInput().getAttribute('aria-label')).toBe('Fileclass filter');
    expect(searchInput()).toBe(document.activeElement);
    search('Independent query 🦉');
    expect(source.api.searchNodes).toHaveBeenLastCalledWith('Independent query 🦉');
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('All types includes only registered Fileclasses and a filter accepts secondary classes', async () => {
    const { choice } = open({ multiple: true });
    expect(filterInput().selectedOptions[0].textContent).toBe('All types');
    expect(rows()).toHaveLength(3);
    filter('topic');
    expect(rows()).toHaveLength(2);
    expect(fuzzy.type).toBe('concept');
    row(fuzzy.path).click();
    filter('concept');
    expect(row(fuzzy.path).getAttribute('aria-checked')).toBe('true');
    filter('topic');
    row(alias.path).click();
    filter('concept');
    expect(row(alias.path).getAttribute('aria-checked')).toBe('true');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('false');
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [fuzzy, alias] });
  });

  it('surfaces preferred typed paths even outside search results, without preselecting them', async () => {
    source.api.searchNodes.mockReturnValue([exact]);
    const { choice } = open({
      multiple: true,
      query: 'Memory',
      preferredPaths: [fuzzy.path, untyped.path, fuzzy.path],
    });
    expect(rows()).toHaveLength(2);
    expect(row(fuzzy.path).getAttribute('aria-label')).toContain('Suggested note');
    expect(row(fuzzy.path).textContent).not.toContain('Suggested note');
    expect(rows().every((entry) => entry.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(button('Add highlight').disabled).toBe(true);
    expect(source.api.getNode.mock.calls.filter(([path]) => path === fuzzy.path)).toHaveLength(1);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('rejects a result whose classes cease to be registered before selection', async () => {
    const { choice, settled } = open();
    source.api.listTypes.mockReturnValue([{ type: 'topic', label: 'Topic' }]);
    row(exact.path).click();
    expect(error().textContent).toContain('no longer available');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('returns the freshly revalidated node, not the discovery or initial selection snapshot', async () => {
    const { choice } = open({ multiple: true });
    row(exact.path).click();
    const fresh = { ...exact, title: 'Renamed title', classes: ['topic'], type: 'topic' };
    source.index.set(exact.path, fresh);
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [fresh] });
  });

  it.each(['deleted', 'untyped', 'wrong-class', 'wrong-path'] as const)(
    'rejects a %s target at confirmation and leaves Cancel available',
    async (change) => {
      const { choice, settled } = open({ multiple: true });
      filter('topic');
      row(fuzzy.path).click();
      if (change === 'deleted') source.index.delete(fuzzy.path);
      else
        source.index.set(fuzzy.path, {
          ...fuzzy,
          classes:
            change === 'untyped' ? [] : change === 'wrong-class' ? ['unregistered'] : fuzzy.classes,
          path: change === 'wrong-path' ? 'Notes/Different.md' : fuzzy.path,
        });
      button('Add highlight').click();
      expect(error().textContent).toContain('no longer available');
      expect(button('Cancel').disabled).toBe(false);
      expect(row(fuzzy.path).getAttribute('aria-checked')).toBe('true');
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      button('Cancel').click();
      expect(await choice).toBeNull();
    },
  );

  it('revalidates a clicked result and does not accept primary type without membership', async () => {
    const { choice } = open();
    source.index.set(exact.path, { ...exact, classes: [], type: 'concept' });
    row(exact.path).click();
    expect(error().textContent).toContain('no longer available');
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('does not silently broaden an unavailable class filter after discovery changes', async () => {
    const { choice } = open({ multiple: true });
    filter('topic');
    row(alias.path).click();
    source.api.listTypes.mockReturnValue([{ type: 'concept', label: 'Concept' }]);
    search('different');
    expect(filterInput().value).toBe('topic');
    expect(button('Add highlight').disabled).toBe(true);
    expect(error().textContent).toContain('Fileclass is unavailable');
    expect(row(alias.path).getAttribute('aria-checked')).toBe('true');
    filter('');
    button('Add highlight').click();
    expect(error().textContent).toContain('no longer available');
    row(alias.path).click();
    search('');
    row(fuzzy.path).click();
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [fuzzy] });
  });

  it('can clear an explicitly selected note without closing', async () => {
    const { choice, settled } = open({ multiple: true });
    row(exact.path).click();
    row(exact.path).focus();
    row(exact.path).click();
    expect(row(exact.path).getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(row(exact.path));
    expect(button('Add highlight').disabled).toBe(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });
});

describe('explicit linked creation intents', () => {
  it('opens empty with no creation intent until the user types a name, retaining checked notes', async () => {
    const { choice } = open({ multiple: true, query: '' });
    expect(document.querySelector('input')?.value).toBe('');
    expect(creates()).toHaveLength(0);
    row(exact.path).click();
    search('Typed topic');
    create('topic').click();
    expect(await choice).toEqual({
      kind: 'create',
      title: 'Typed topic',
      type: 'topic',
      existingNodes: [exact],
    });
  });

  it('requires an explicit type and editable title; returns intent without calling any creation API', async () => {
    const { choice, settled } = open({ multiple: true, query: 'Selected words' });
    row(exact.path).click();
    const fresh = { ...exact, title: 'Updated existing title' };
    source.index.set(exact.path, fresh);
    search('  A different   title  ');
    expect(document.querySelectorAll('input')).toHaveLength(1);
    expect(document.querySelectorAll('select')).toHaveLength(1);
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    expect(document.querySelector('.reader-highlight-picker-create')).toBeNull();
    expect(creates()).toHaveLength(2);
    expect(create('topic').textContent).toContain('Create “A different title”');
    expect(create('topic').querySelector('.reader-highlight-picker-result-meta')?.textContent).toBe(
      'Topic',
    );
    expect(create('topic').getAttribute('aria-label')).toContain('and add highlight');
    expect(create('topic').getAttribute('aria-label')).toContain('2 notes');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    create('topic').click();
    expect(await choice).toEqual({
      kind: 'create',
      title: 'A different title',
      type: 'topic',
      existingNodes: [fresh],
    });
    expect(source.api.searchNodes).toHaveBeenLastCalledWith('A different title');
  });

  it('filters both existing candidates and available creation types with the same filter', async () => {
    const { choice } = open({ query: 'New topic' });
    filter('topic');
    expect(creates().map((entry) => entry.dataset.createType)).toEqual(['topic']);
    expect(rows()).toHaveLength(2);
    filter('concept');
    expect(creates().map((entry) => entry.dataset.createType)).toEqual(['concept']);
    expect(rows()).toHaveLength(2);
    create('concept').click();
    expect(await choice).toEqual({ kind: 'create', title: 'New topic', type: 'concept' });
  });

  it.each(['title', 'alias'] as const)(
    'surfaces exact %s duplicates for explicit reuse, never silently creates or chooses',
    async (match) => {
      source.api.searchNodes.mockReturnValue([]);
      const { choice, settled } = open({ query: 'Memory' });
      const type = match === 'title' ? 'concept' : 'topic';
      const expected = match === 'title' ? exact : alias;
      const staleCreate = create(type);
      source.api.searchNodes.mockReturnValue([expected]);
      staleCreate.click();
      expect(error().textContent).toContain('An existing note matches this title');
      expect(row(expected.path).getAttribute('aria-label')).toContain(
        match === 'title' ? 'Exact title' : 'Exact alias',
      );
      expect(document.activeElement).toBe(row(expected.path));
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      row(expected.path).click();
      expect(await choice).toEqual({ kind: 'existing', node: expected });
    },
  );

  it('does not treat a same-title note in a different Fileclass as the chosen creation type', async () => {
    source.api.searchNodes.mockReturnValue([exact]);
    const { choice } = open({ query: 'Memory' });
    expect(creates().map((entry) => entry.dataset.createType)).toEqual(['topic']);
    create('topic').click();
    expect(await choice).toEqual({ kind: 'create', title: 'Memory', type: 'topic' });
  });

  it('keeps creation uncommitted when the final duplicate lookup fails', async () => {
    const { choice, settled } = open({ query: 'New title' });
    source.api.searchNodes.mockImplementationOnce(() => {
      throw new Error('Search stopped');
    });
    create('concept').click();
    expect(error().textContent).toBe('Search stopped');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(button('Cancel').disabled).toBe(false);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('does not block creation because of a stale exact search hit which is no longer typed', async () => {
    source.api.searchNodes.mockReturnValue([exact]);
    source.index.set(exact.path, { ...exact, classes: [] });
    const { choice } = open({ query: 'Memory' });
    create('concept').click();
    expect(await choice).toEqual({ kind: 'create', title: 'Memory', type: 'concept' });
  });

  it.each(['disabled', 'unavailable'] as const)(
    'has no untyped/standalone creation fallback when creation is %s',
    async (state) => {
      if (state === 'unavailable')
        Object.defineProperty(source.api, 'createNodeForLink', { value: undefined });
      const { choice } = open({ query: 'New title', allowCreate: state !== 'disabled' });
      expect(creates()).toHaveLength(0);
      expect(document.body.textContent).not.toContain('All notes');
      row(exact.path).click();
      expect(await choice).toEqual({ kind: 'existing', node: exact });
    },
  );

  it('rechecks linked creation capability and type availability at confirmation', async () => {
    const { choice } = open({ query: 'New title' });
    const staleCreate = create('topic');
    source.api.listTypes.mockReturnValue([{ type: 'concept', label: 'Concept' }]);
    staleCreate.click();
    expect(error().textContent).toContain('Choose an available Fileclass');
    expect(button('Cancel').disabled).toBe(false);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('does not emit a create intent if the optional capability disappears while editing', async () => {
    const { choice } = open({ query: 'New title' });
    Object.defineProperty(source.api, 'createNodeForLink', { value: undefined });
    create('concept').click();
    expect(error().textContent).toContain('linked-note creation is unavailable');
    button('Cancel').click();
    expect(await choice).toBeNull();
  });
});

describe('cancellation and public API failures', () => {
  it('does not open or read the API for an already aborted lifetime', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await chooseHighlightHost({} as App, source.api, { signal: controller.signal }),
    ).toBeNull();
    expect(document.body.children).toHaveLength(0);
    expect(source.api.listTypes).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'dismiss', 'abort'] as const)(
    'resolves null on %s, ignores detached actions, and never writes',
    async (reason) => {
      const controller = new AbortController();
      const { choice } = open({ multiple: true, signal: controller.signal, query: 'New note' });
      row(exact.path).click();
      const detachedConfirm = button('Add highlight');
      const detachedCreate = create('concept');
      if (reason === 'cancel') button('Cancel').click();
      else if (reason === 'dismiss') modalState.current?.close();
      else controller.abort();
      expect(await choice).toBeNull();
      expect(document.body.children).toHaveLength(0);
      const reads = source.api.getNode.mock.calls.length;
      const searches = source.api.searchNodes.mock.calls.length;
      detachedConfirm.click();
      detachedCreate.click();
      expect(source.api.getNode).toHaveBeenCalledTimes(reads);
      expect(source.api.searchNodes).toHaveBeenCalledTimes(searches);
    },
  );

  it('removes its abort listener on close and settles only once', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { choice, settled } = open({ signal: controller.signal });
    row(exact.path).click();
    expect(await choice).toEqual({ kind: 'existing', node: exact });
    controller.abort();
    modalState.current?.close();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('lets an abort during revalidation win over an existing choice', async () => {
    const controller = new AbortController();
    const { choice } = open({ signal: controller.signal });
    source.api.getNode.mockImplementation(() => {
      controller.abort();
      return exact;
    });
    row(exact.path).click();
    expect(await choice).toBeNull();
    expect(document.body.children).toHaveLength(0);
  });

  it('stops discovery if the lifetime aborts inside a public listTypes call', async () => {
    const controller = new AbortController();
    source.api.listTypes.mockImplementationOnce(() => {
      controller.abort();
      return availableTypes;
    });
    const { choice } = open({ signal: controller.signal });
    expect(await choice).toBeNull();
    expect(source.api.searchNodes).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
  });

  it('lets an abort inside the final duplicate lookup win over a create intent', async () => {
    const controller = new AbortController();
    const { choice } = open({ query: 'New title', signal: controller.signal });
    source.api.searchNodes.mockImplementationOnce(() => {
      controller.abort();
      return [];
    });
    create('concept').click();
    expect(await choice).toBeNull();
    expect(document.body.children).toHaveLength(0);
  });

  it.each(['listTypes', 'searchNodes', 'getNode'] as const)(
    'shows a throwing %s inline, allows retry and keeps cancellation available',
    async (method) => {
      if (method !== 'getNode')
        source.api[method].mockImplementationOnce(() => {
          throw new Error(`${method} failed`);
        });
      const { choice, settled } = open();
      if (method === 'getNode') {
        source.api.getNode.mockImplementationOnce(() => {
          throw new Error('getNode failed');
        });
        row(exact.path).click();
      }
      expect(error().hidden).toBe(false);
      expect(error().textContent).toContain(`${method} failed`);
      expect(button('Cancel').disabled).toBe(false);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      button('Retry').click();
      expect(error().hidden).toBe(true);
      expect(rows()).toHaveLength(3);
      row(exact.path).click();
      expect(await choice).toEqual({ kind: 'existing', node: exact });
    },
  );

  it.each(['version', 'searchNodes'] as const)(
    'rejects a public capability that becomes unavailable: %s',
    async (capability) => {
      const { choice } = open();
      Object.defineProperty(source.api, capability, {
        value: capability === 'version' ? 1 : undefined,
      });
      search('changed');
      expect(error().textContent).toContain('typed-note search is unavailable');
      expect(button('Cancel').disabled).toBe(false);
      button('Cancel').click();
      expect(await choice).toBeNull();
    },
  );

  it('keeps an empty Fileclass list typed-only and does not offer creation', async () => {
    source.api.listTypes.mockReturnValue([]);
    const { choice } = open({ query: 'New title' });
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).toContain('No Fileclasses are available');
    expect(creates()).toHaveLength(0);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });
});

describe('lean multi-selection and native list context', () => {
  it('immediately returns a fresh single choice without an Apply or Link step', async () => {
    const { choice } = open();
    const fresh = { ...exact, title: 'Current title' };
    source.index.set(exact.path, fresh);
    expect(document.querySelector('.reader-highlight-picker-footer .mod-cta')).toBeNull();
    row(exact.path).click();
    expect(await choice).toEqual({ kind: 'existing', node: fresh });
  });

  it('works with discovery-only public v2 and does not require standalone or shared creation methods', async () => {
    const minimal = {
      version: 2 as const,
      listTypes: source.api.listTypes,
      searchNodes: source.api.searchNodes,
      getNode: source.api.getNode,
    };
    const choice = chooseHighlightHost({} as App, minimal);
    expect(creates()).toHaveLength(0);
    row(exact.path).click();
    expect(await choice).toEqual({ kind: 'existing', node: exact });
  });

  it('prechecks only explicit selected paths, deduplicates them, and awaits Apply', async () => {
    const { choice, settled } = open({
      multiple: true,
      selectedPaths: [fuzzy.path, exact.path, fuzzy.path],
    });
    expect(row(fuzzy.path).getAttribute('aria-checked')).toBe('true');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    expect(row(alias.path).getAttribute('aria-checked')).toBe('false');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [fuzzy, exact] });
  });

  it('preserves checked notes across independent searches and keeps only results scrollable', async () => {
    source.api.searchNodes.mockImplementation((term) => (term === 'Recall' ? [alias] : [exact]));
    const { choice } = open({ multiple: true, query: 'Memory' });
    row(exact.path).click();
    search('Recall');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    row(alias.path).click();
    const results = document.querySelector('.reader-highlight-picker-results')!;
    expect(results.querySelector('input, select, .reader-highlight-picker-footer')).toBeNull();
    expect(document.querySelector('.reader-highlight-picker-selected')).toBeNull();
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [exact, alias] });
  });

  it.each([0, 1] as const)(
    'honors minimum selection %s and a context-specific action label',
    async (minimum) => {
      const { choice } = open({
        multiple: true,
        minSelection: minimum,
        actionLabel: 'Save related notes',
      });
      expect(button('Save related notes').disabled).toBe(minimum === 1);
      if (minimum) row(exact.path).click();
      button('Save related notes').click();
      expect(await choice).toEqual({ kind: 'existing-many', nodes: minimum ? [exact] : [] });
    },
  );

  it('allows explicit empty Apply after removing all checked notes with minimum zero', async () => {
    const { choice } = open({ multiple: true, minSelection: 0, selectedPaths: [exact.path] });
    row(exact.path).click();
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [] });
  });

  it('toggles a focused row with Enter/Space without duplicate, held-key or composition toggles', async () => {
    const { choice, settled } = open({ multiple: true });
    key(searchInput(), 'ArrowDown');
    expect(document.activeElement).toBe(row(exact.path));
    key(row(exact.path), 'Enter', { isComposing: true });
    key(row(exact.path), 'Enter', { repeat: true });
    expect(row(exact.path).getAttribute('aria-checked')).toBe('false');
    key(row(exact.path), 'Enter');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(row(exact.path));
    key(row(exact.path), 'Enter', { repeat: true });
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    key(row(exact.path), ' ');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('false');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('keeps keyboard focus on Retry when row validation fails after Enter', async () => {
    const { choice, settled } = open();
    row(exact.path).focus();
    source.api.getNode.mockImplementationOnce(() => null);
    key(row(exact.path), 'Enter');
    expect(error().textContent).toContain('no longer available');
    expect(document.activeElement).toBe(button('Retry'));
    expect(document.body.contains(document.activeElement)).toBe(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('handles navigation, toggles and repeat suppression for rows owned by another window', async () => {
    const frame = document.body.appendChild(document.createElement('iframe'));
    const otherDocument = frame.contentDocument!;
    modalState.document = otherDocument;
    const { choice } = open({ multiple: true, allowCreate: false });
    const otherRow = (path: string) =>
      [...otherDocument.querySelectorAll<HTMLButtonElement>('[data-path]')].find(
        (entry) => entry.dataset.path === path,
      )!;
    expect(otherRow(exact.path) instanceof HTMLButtonElement).toBe(false);
    otherRow(exact.path).focus();
    expect(key(otherRow(exact.path), 'ArrowDown')).toBe(false);
    expect(otherDocument.activeElement).toBe(otherRow(alias.path));
    key(otherRow(alias.path), 'Enter');
    expect(otherRow(alias.path).getAttribute('aria-checked')).toBe('true');
    expect(otherDocument.activeElement).toBe(otherRow(alias.path));
    expect(key(otherRow(alias.path), 'Enter', { repeat: true })).toBe(false);
    expect(otherRow(alias.path).getAttribute('aria-checked')).toBe('true');
    const apply = [...otherDocument.querySelectorAll('button')].find(
      (entry) => entry.textContent === 'Add highlight',
    )!;
    apply.click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [alias] });
  });

  it('applies a known checked selection with empty-query Enter', async () => {
    const { choice } = open({ multiple: true });
    row(exact.path).click();
    searchInput().focus();
    key(searchInput(), 'Enter');
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [exact] });
  });

  it('shows public node icons or listed class icons, never the primary type as a fallback', async () => {
    source.index.set(exact.path, { ...exact, type: 'topic' });
    source.index.set(fuzzy.path, { ...fuzzy, icon: 'lightbulb' });
    const { choice } = open();
    expect(
      row(exact.path).querySelector<HTMLElement>('.reader-highlight-picker-icon')?.dataset.icon,
    ).toBe('brain');
    expect(
      row(alias.path).querySelector<HTMLElement>('.reader-highlight-picker-icon')?.dataset.icon,
    ).toBe('tag');
    expect(
      row(fuzzy.path).querySelector<HTMLElement>('.reader-highlight-picker-icon')?.dataset.icon,
    ).toBe('lightbulb');
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('shows paths only for ambiguous titles while every result retains accessible path/class context', async () => {
    const duplicate = { ...node('memory', ['topic']), path: 'Elsewhere/memory.md' };
    source.index.set(duplicate.path, duplicate);
    const { choice } = open();
    expect(row(exact.path).querySelector('.reader-highlight-picker-result-path')?.textContent).toBe(
      exact.path,
    );
    expect(
      row(duplicate.path).querySelector('.reader-highlight-picker-result-path')?.textContent,
    ).toBe(duplicate.path);
    expect(row(fuzzy.path).querySelector('.reader-highlight-picker-result-path')).toBeNull();
    for (const item of [exact, duplicate, fuzzy]) {
      expect(row(item.path).getAttribute('aria-label')).toContain(item.path);
      expect(row(item.path).getAttribute('aria-label')).toContain(
        item.classes.includes('topic') ? 'Topic' : 'Concept',
      );
    }
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('disambiguates a checked title against all eligible matches beyond the first 100', async () => {
    source.index.clear();
    const selected = node('Old');
    const duplicate = { ...node('old', ['topic']), path: 'Elsewhere/old.md' };
    const unique = node('Alpha');
    const rawYamlOnly = { ...node('Alpha', []), path: 'Untyped/Alpha.md', type: 'concept' };
    const unknownClass = {
      ...node('Alpha', ['unknown']),
      path: 'Unknown/Alpha.md',
      type: 'concept',
    };
    for (const item of [selected, duplicate, unique, rawYamlOnly, unknownClass])
      source.index.set(item.path, item);
    for (let i = 0; i < 100; i++) {
      const extra = node(`Extra${String(i).padStart(3, '0')}`);
      source.index.set(extra.path, extra);
    }
    const { choice } = open({ multiple: true, selectedPaths: [selected.path], minSelection: 0 });
    expect(rows()).toHaveLength(101); // One retained check plus the bounded candidate page.
    expect(rows().some((entry) => entry.dataset.path === duplicate.path)).toBe(false);
    expect(row(selected.path).getAttribute('aria-checked')).toBe('true');
    expect(
      row(selected.path).querySelector('.reader-highlight-picker-result-path')?.textContent,
    ).toBe(selected.path);
    expect(row(selected.path).getAttribute('aria-label')).toContain(selected.path);
    expect(row(unique.path).querySelector('.reader-highlight-picker-result-path')).toBeNull();
    expect(
      rows().some((entry) => [rawYamlOnly.path, unknownClass.path].includes(entry.dataset.path!)),
    ).toBe(false);
    filter('concept'); // The hidden Topic duplicate is no longer an eligible matching candidate.
    expect(row(selected.path).querySelector('.reader-highlight-picker-result-path')).toBeNull();
    expect(row(selected.path).getAttribute('aria-checked')).toBe('true');
    filter('');
    expect(
      row(selected.path).querySelector('.reader-highlight-picker-result-path')?.textContent,
    ).toBe(selected.path);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('disambiguates whitespace-equivalent visible titles with paths', async () => {
    const first = node('Memory palace');
    const second = { ...node('Memory  palace'), path: 'Elsewhere/Memory palace.md' };
    source.index.set(first.path, first);
    source.index.set(second.path, second);
    const { choice } = open();
    expect(row(first.path).querySelector('.reader-highlight-picker-result-path')?.textContent).toBe(
      first.path,
    );
    expect(
      row(second.path).querySelector('.reader-highlight-picker-result-path')?.textContent,
    ).toBe(second.path);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('does not silently drop invalid initial selections and can retry a restored public member', async () => {
    const { choice, settled } = open({
      multiple: true,
      minSelection: 0,
      selectedPaths: [exact.path, foreign.path],
    });
    expect(error().textContent).toContain('no longer available');
    expect(button('Add highlight').disabled).toBe(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const restored = { ...foreign, classes: ['topic'], type: 'topic' };
    source.index.set(foreign.path, restored);
    button('Retry').click();
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    expect(row(foreign.path).getAttribute('aria-checked')).toBe('true');
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [exact, restored] });
  });

  it('retains the checked draft after a provider error instead of returning a partial selection', async () => {
    const { choice } = open({ multiple: true });
    row(exact.path).click();
    source.api.searchNodes.mockImplementationOnce(() => {
      throw new Error('Reloading');
    });
    search('Other search');
    expect(error().textContent).toBe('Reloading');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    expect(button('Add highlight').disabled).toBe(true);
    button('Retry').click();
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [exact] });
  });

  it('allows explicitly deselecting a now-invalid draft note before an empty minimum-zero Apply', async () => {
    const { choice } = open({ multiple: true, minSelection: 0, selectedPaths: [exact.path] });
    source.index.set(exact.path, { ...exact, classes: [] });
    button('Add highlight').click();
    expect(error().textContent).toContain('no longer available');
    row(exact.path).click();
    expect(button('Add highlight').disabled).toBe(false);
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [] });
  });

  it('counts the explicit new note toward a larger minimum without requiring an untyped placeholder', async () => {
    const { choice } = open({ multiple: true, minSelection: 2, query: 'New title' });
    expect(button('Add highlight').disabled).toBe(true);
    expect(create('topic').disabled).toBe(true);
    row(exact.path).click();
    expect(button('Add highlight').disabled).toBe(true);
    expect(create('topic').disabled).toBe(false);
    create('topic').click();
    expect(await choice).toEqual({
      kind: 'create',
      title: 'New title',
      type: 'topic',
      existingNodes: [exact],
    });
  });

  it('hides each same-class exact title/alias creation row without hiding explicit reuse', async () => {
    const { choice } = open({ query: 'Memory' });
    expect(creates()).toHaveLength(0);
    expect(row(exact.path)).toBeTruthy();
    expect(row(alias.path)).toBeTruthy();
    row(alias.path).click();
    expect(await choice).toEqual({ kind: 'existing', node: alias });
  });

  it('does not offer a duplicate creation row when a freshly selected note now exactly matches the query', async () => {
    const { choice } = open({ multiple: true, query: 'New title' });
    const fresh = { ...exact, title: 'New title' };
    source.index.set(exact.path, fresh);
    row(exact.path).click();
    expect(creates().map((entry) => entry.dataset.createType)).toEqual(['topic']);
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [fresh] });
  });

  it.each(['title', 'class'] as const)(
    'revalidates stale candidate %s before deciding a same-class creation has no duplicate',
    async (change) => {
      const old = change === 'title' ? { ...exact, title: 'Memory pathways' } : exact;
      source.api.searchNodes.mockReturnValue([old]);
      source.index.set(exact.path, old);
      const { choice, settled } = open({ query: 'Memory' });
      const type = change === 'title' ? 'concept' : 'topic';
      const createRow = create(type);
      const fresh = { ...exact, classes: [type], type };
      source.index.set(exact.path, fresh);
      createRow.click();
      expect(error().textContent).toContain('An existing note matches this title');
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      row(exact.path).click();
      expect(await choice).toEqual({ kind: 'existing', node: fresh });
    },
  );

  it('does not emit a creation intent when one checked existing note loses membership', async () => {
    const { choice, settled } = open({
      multiple: true,
      query: 'New title',
      selectedPaths: [exact.path, alias.path],
    });
    source.index.set(alias.path, { ...alias, classes: [] });
    create('concept').click();
    expect(error().textContent).toContain('no longer available');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(row(exact.path).getAttribute('aria-checked')).toBe('true');
    expect(row(alias.path).getAttribute('aria-checked')).toBe('true');
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('does not apply a stale creation row after the user narrows its class filter', async () => {
    const { choice, settled } = open({ query: 'New title' });
    const staleCreate = create('concept');
    filter('topic');
    staleCreate.click();
    expect(error().textContent).toContain('Choose an available Fileclass');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('does not apply a stale creation row to a subsequently edited query', async () => {
    const { choice, settled } = open({ query: 'Old title' });
    const staleCreate = create('concept');
    search('New title');
    staleCreate.click();
    expect(error().textContent).toContain('search changed');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });
});

describe('native suggestion presentation', () => {
  it('exposes a full-width search wrapper, compact class filter, and native action footer hooks', async () => {
    const { choice } = open({ multiple: true });
    const modal = document.querySelector('.reader-highlight-picker-modal')!;
    const controls = modal.querySelector('.reader-highlight-picker-controls')!;
    const searchWrap = controls.querySelector('.reader-highlight-picker-search-wrap')!;
    expect(modal.classList.contains('prompt')).toBe(true);
    expect(searchWrap.classList.contains('prompt-input-container')).toBe(true);
    expect(searchWrap.children).toHaveLength(1);
    expect(searchInput().parentElement).toBe(searchWrap);
    expect(searchInput().classList.contains('prompt-input')).toBe(true);
    expect(filterInput().parentElement).toBe(controls);
    expect(filterInput().classList.contains('reader-highlight-picker-type-filter')).toBe(true);
    expect(filterInput().classList.contains('dropdown')).toBe(true);
    expect(
      modal.querySelector('.reader-highlight-picker-results')!.classList.contains('prompt-results'),
    ).toBe(true);
    const footer = modal.querySelector('.reader-highlight-picker-footer')!;
    expect([...footer.children].every((element) => element.tagName === 'BUTTON')).toBe(true);
    expect(footer.querySelector('input, select, .reader-highlight-picker-result')).toBeNull();
    expect(
      rows().every((element) => element.tagName === 'BUTTON' && element.type === 'button'),
    ).toBe(true);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('separates the primary name, muted type badge and ambiguous path without concatenating them', async () => {
    const duplicate = { ...node('memory', ['topic']), path: 'Elsewhere/memory.md' };
    source.index.set(duplicate.path, duplicate);
    const { choice } = open();
    const candidate = row(exact.path);
    expect(candidate.classList.contains('suggestion-item')).toBe(true);
    expect(candidate.classList.contains('mod-complex')).toBe(true);
    const content = candidate.querySelector('.reader-highlight-picker-result-content')!;
    const title = content.querySelector('.reader-highlight-picker-result-title')!;
    const metadata = content.querySelector('.reader-highlight-picker-result-meta')!;
    const badge = metadata.querySelector<HTMLElement>('.reader-highlight-picker-type-badge')!;
    const path = metadata.querySelector('.reader-highlight-picker-result-path')!;
    expect(title.parentElement).toBe(content);
    expect(title.nextElementSibling).toBe(metadata);
    expect(title.textContent).toBe('Memory');
    expect(badge.textContent).toBe('Concept');
    expect(badge.title).toBe('Concept');
    expect(path.parentElement).toBe(metadata);
    expect(path.textContent).toBe(exact.path);
    expect(content.textContent).toBe(`Memory Concept ${exact.path}`);
    expect(candidate.getAttribute('aria-label')).toContain(`Memory — Concept — ${exact.path}`);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('retains native checkbox-row activation and an aligned aria-hidden check slot', async () => {
    const { choice } = open({ multiple: true, selectedPaths: [exact.path], minSelection: 0 });
    const check = (path: string) =>
      row(path).querySelector<HTMLElement>('.reader-highlight-picker-check')!;
    expect(row(exact.path).classList.contains('is-checked')).toBe(true);
    expect(check(exact.path).getAttribute('aria-hidden')).toBe('true');
    expect(check(exact.path).dataset.icon).toBe('check');
    expect(check(alias.path).getAttribute('aria-hidden')).toBe('true');
    expect(check(alias.path).dataset.icon).toBeUndefined();
    key(row(exact.path), ' ');
    expect(row(exact.path).getAttribute('aria-checked')).toBe('false');
    expect(row(exact.path).classList.contains('is-checked')).toBe(false);
    expect(check(exact.path).dataset.icon).toBeUndefined();
    row(alias.path).querySelector<HTMLElement>('.reader-highlight-picker-result-title')!.click();
    expect(row(alias.path).getAttribute('aria-checked')).toBe('true');
    expect(check(alias.path).dataset.icon).toBe('check');
    button('Add highlight').click();
    expect(await choice).toEqual({ kind: 'existing-many', nodes: [alias] });
  });

  it('elides only the visible create query while preserving the full input, accessible label and intent', async () => {
    const full = Array(12)
      .fill('Governance and the practical relationship between research and human judgement 🦉')
      .join(' ');
    const raw = `  ${full}  `;
    const { choice } = open({ multiple: true, minSelection: 0, actionLabel: 'Apply' });
    search(raw);
    const candidate = create('topic');
    const visible = candidate.querySelector('.reader-highlight-picker-create-query')!.textContent!;
    expect(Array.from(visible).length).toBeLessThanOrEqual(49);
    expect(visible.endsWith('…')).toBe(true);
    expect(searchInput().value).toBe(raw);
    expect(candidate.getAttribute('aria-label')).toContain(full);
    expect(candidate.title).toBe(candidate.getAttribute('aria-label'));
    expect(candidate.querySelector('.reader-highlight-picker-type-badge')!.textContent).toBe(
      'Topic',
    );
    expect(candidate.querySelector('.reader-highlight-picker-result-title')!.textContent).toBe(
      `Create “${visible}”`,
    );
    expect(candidate.textContent).not.toContain('and apply');
    expect(candidate.getAttribute('aria-label')).toContain('and apply');
    key(candidate, 'Enter');
    expect(await choice).toEqual({ kind: 'create', title: full, type: 'topic', existingNodes: [] });
    expect(source.api.searchNodes).toHaveBeenLastCalledWith(full);
  });

  it('keeps disabled creation native and inert to pointer, Enter and Space until its minimum is met', async () => {
    const { choice, settled } = open({ multiple: true, query: 'New title', minSelection: 2 });
    const disabled = create('topic');
    expect(disabled.tagName).toBe('BUTTON');
    expect(disabled.disabled).toBe(true);
    const reads = source.api.getNode.mock.calls.length;
    const searches = source.api.searchNodes.mock.calls.length;
    const registrations = source.api.listTypes.mock.calls.length;
    disabled.click();
    key(disabled, 'Enter');
    key(disabled, ' ');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(source.api.getNode).toHaveBeenCalledTimes(reads);
    expect(source.api.searchNodes).toHaveBeenCalledTimes(searches);
    expect(source.api.listTypes).toHaveBeenCalledTimes(registrations);
    row(exact.path).click();
    expect(create('topic').disabled).toBe(false);
    key(create('topic'), ' ');
    expect(await choice).toEqual({
      kind: 'create',
      title: 'New title',
      type: 'topic',
      existingNodes: [exact],
    });
  });

  it('renders note names, type badges and query previews as literal text rather than markup', async () => {
    const title = '<img src=x onerror=alert(1)>';
    const label = '<b>Concept</b>';
    source.index.set(exact.path, { ...exact, title });
    source.api.listTypes.mockReturnValue([{ type: 'concept', label, icon: 'brain' }]);
    const { choice } = open();
    expect(
      row(exact.path).querySelector('.reader-highlight-picker-result-title')!.textContent,
    ).toBe(title);
    expect(row(exact.path).querySelector('.reader-highlight-picker-type-badge')!.textContent).toBe(
      label,
    );
    search('Create <script>literal text</script>');
    expect(
      create('concept').querySelector('.reader-highlight-picker-create-query')!.textContent,
    ).toBe('Create <script>literal text</script>');
    expect(document.querySelector('img, script, b')).toBeNull();
    button('Cancel').click();
    expect(await choice).toBeNull();
  });
});

describe('optional choose-from-article intent', () => {
  it('is absent from ordinary single and multi selection contexts', async () => {
    const first = open({ multiple: true });
    expect(document.querySelector('.reader-highlight-picker-article-choice')).toBeNull();
    button('Cancel').click();
    expect(await first.choice).toBeNull();
    const second = open({ allowPickFromArticle: true });
    expect(document.querySelector('.reader-highlight-picker-article-choice')).toBeNull();
    button('Cancel').click();
    expect(await second.choice).toBeNull();
  });

  it('returns an empty article-pick intent without requiring the Apply minimum', async () => {
    const { choice } = open({ multiple: true, allowPickFromArticle: true, minSelection: 2 });
    expect(button('Add highlight').disabled).toBe(true);
    expect(button('Choose from article…').disabled).toBe(false);
    button('Choose from article…').click();
    expect(await choice).toEqual({ kind: 'pick-in-article', nodes: [] });
    expect(document.body.children).toHaveLength(0);
  });

  it('returns the freshly validated checked draft before article picking', async () => {
    const { choice } = open({
      multiple: true,
      allowPickFromArticle: true,
      selectedPaths: [exact.path],
      minSelection: 3,
    });
    const fresh = { ...exact, title: 'Fresh title', classes: ['topic'], type: 'topic' };
    source.index.set(exact.path, fresh);
    button('Choose from article…').click();
    expect(await choice).toEqual({ kind: 'pick-in-article', nodes: [fresh] });
  });

  it('rejects an invalid checked draft rather than arming a partial article-pick operation', async () => {
    const { choice, settled } = open({
      multiple: true,
      allowPickFromArticle: true,
      selectedPaths: [exact.path, alias.path],
    });
    source.index.set(alias.path, { ...alias, classes: [] });
    button('Choose from article…').click();
    expect(error().textContent).toContain('no longer available');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(button('Choose from article…').disabled).toBe(true);
    button('Cancel').click();
    expect(await choice).toBeNull();
  });

  it('lets abort win during article-pick validation and ignores its detached secondary action', async () => {
    const controller = new AbortController();
    const { choice } = open({
      multiple: true,
      allowPickFromArticle: true,
      signal: controller.signal,
      selectedPaths: [exact.path],
    });
    const secondary = button('Choose from article…');
    source.api.getNode.mockImplementation(() => {
      controller.abort();
      return exact;
    });
    secondary.click();
    expect(await choice).toBeNull();
    const reads = source.api.getNode.mock.calls.length;
    secondary.click();
    expect(source.api.getNode).toHaveBeenCalledTimes(reads);
  });
});

// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { ReaderView } from '../src/reader/view';
import { nodesApi, type NodesApi, type NodeResult } from '../src/host/nodes';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import { defaultFolders } from '../src/core/folders';
import { MemoryVault } from './helpers/memory-vault';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
const notices = vi.hoisted(() => [] as string[]);
vi.mock('../src/reader/surface', () => ({ ReadingSurface: class {} }));
vi.mock('obsidian', () => ({
  Platform: { isMobile: false },
  ItemView: class {
    app: any;
    contentEl = document.createElement('div');
    constructor(leaf: any) {
      this.app = leaf.app;
    }
  },
  Modal: class {
    modalEl = document.createElement('div');
    titleEl = document.createElement('h2');
    contentEl = document.createElement('div');
    constructor() {
      this.modalEl.append(this.titleEl, this.contentEl);
    }
    setTitle(title: string) {
      this.titleEl.textContent = title;
    }
    open() {
      document.body.append(this.modalEl);
      (this as any).onOpen();
    }
    close() {
      (this as any).onClose();
      this.modalEl.remove();
    }
  },
  FuzzySuggestModal: class {},
  Menu: class {},
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
  TFile: class {},
  parseLinktext: (path: string) => ({ path }),
  setIcon() {},
  setTooltip() {},
}));
const cleanup = new Set<() => void>();
beforeEach(() => {
  document.body.replaceChildren();
  notices.length = 0;
  const proto = HTMLElement.prototype as any;
  proto.empty = function () {
    this.replaceChildren();
  };
  proto.createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text) el.textContent = options.text;
    if (options.type) (el as HTMLInputElement).type = options.type;
    if (options.placeholder) (el as HTMLInputElement).placeholder = options.placeholder;
    for (const [name, value] of Object.entries(options.attr ?? {}))
      el.setAttribute(name, String(value));
    this.append(el);
    return el;
  };
  proto.createDiv = function (options: any) {
    return this.createEl('div', options);
  };
});
afterEach(() => {
  for (const cancel of cleanup) cancel();
  cleanup.clear();
});
const tick = async () => {
  for (let i = 0; i < 150; i++) await Promise.resolve();
};
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const dismiss = () =>
  [...document.querySelectorAll('button')].find((el) => el.textContent === 'Cancel')?.click();
const rows = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.reader-highlight-picker-result[data-path]'),
];
const rowAt = (path: string) => rows().find((el) => el.dataset.path === path) ?? null;
const row = (label: string) => rowAt(`Topics/${label}.md`);
const checked = (label: string) => row(label)?.getAttribute('aria-checked') === 'true';
const toggle = (label: string, on: boolean) => {
  const candidate = row(label);
  if (!candidate) throw new Error(`Missing typed note: ${label}`);
  if (checked(label) !== on) candidate.click();
};
const searchInput = () => document.querySelector<HTMLInputElement>('input[type="search"]')!;
const search = (value: string) => {
  searchInput().value = value;
  searchInput().dispatchEvent(new Event('input'));
};
const creates = () => [
  ...document.querySelectorAll<HTMLButtonElement>('.reader-highlight-picker-create-row'),
];
const create = (type = 'topic') => {
  const found = creates().find((el) => el.dataset.createType === type);
  if (!found) throw new Error(`Missing creation class: ${type}`);
  return found;
};
const startCreate = (title = 'New', type = 'topic') => {
  search(title);
  create(type).click();
};
const visibleErrors = () => [
  ...notices,
  ...[...document.querySelectorAll<HTMLElement>('[role="alert"]')]
    .filter((el) => !el.hidden)
    .map((el) => el.textContent ?? ''),
];

async function fixture() {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault, defaultFolders);
  const cache = new Map<any, any>();
  const publicNodes = new Map<string, NodeResult>();
  const app: any = {
    vault: {
      getMarkdownFiles: () => [...vault.files.values()],
      getAbstractFileByPath: (path: string) => vault.file(path),
    },
    metadataCache: {
      getFileCache: (file: any) => cache.get(file),
      getFirstLinkpathDest: (path: string) => vault.file(path) ?? vault.file(`${path}.md`),
    },
  };
  const lifetime = new AbortController();
  const host: any = { store, signal: lifetime.signal };
  const view = new ReaderView({ app } as any, host);
  const probe = view as any;
  probe.prepareToLeave = async () => {};
  probe.assertDisplayed = () => {};
  probe.controls = () => {};
  cleanup.add(() => probe.cancelNodeCreation());
  // Deliberately independent of YAML: getNode can return a legitimate untyped DTO.
  const note = async (path: string, properties: any, classes: string[] = ['topic']) => {
    const file = await vault.create(path, createDocument(properties, 'body'));
    Object.setPrototypeOf(file, TFile.prototype);
    const title = path.replace(/.*\//, '').replace(/\.md$/, '');
    Object.assign(file, { basename: title });
    cache.set(file, { frontmatter: properties });
    publicNodes.set(path, {
      path,
      title,
      type: classes.at(-1) ?? properties.type ?? '',
      classes: [...classes],
      aliases: properties.aliases ?? [],
    });
    return file;
  };
  const old = await note('Topics/Old.md', { type: 'topic' });
  const other = await note('Topics/Other.md', { type: 'topic' });
  const article = await note(
    'Reading/Stream/Article.md',
    {
      type: 'article',
      status: 'feed',
      topics: ['[[Topics/Old.md]]'],
    },
    [],
  );
  probe.snapshot = await store.read(article.path);
  // Native Reader always has a displayed body. Preserve that independent baseline
  // through YAML-only writes so guarded draft reopening is tested, not bypassed.
  probe.surface = {
    setTopics: vi.fn(),
    displayedBody: probe.snapshot.body,
    body: document.createElement('article'),
    selection: () => null,
    setBody(body: string) {
      this.displayedBody = body;
    },
  };
  const node = (path: string): NodeResult => {
    const member = publicNodes.get(path);
    if (!member) throw new Error(`Missing synthetic DTO: ${path}`);
    return { ...member, classes: [...member.classes], aliases: [...member.aliases] };
  };
  const api: NodesApi = {
    version: 2,
    embeddedCreation: true,
    listTypes: () => [{ type: 'topic', label: 'Topic' }],
    searchNodes: (query) =>
      [...publicNodes.values()].filter((entry) =>
        [entry.title, ...entry.aliases].some((label) =>
          label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        ),
      ),
    getNode: (path) => (publicNodes.has(path) && vault.file(path) ? node(path) : null),
    createNode: vi.fn(async () => null),
    createNodeForLink: vi.fn(async (_options, link) => {
      const file = await note('Topics/New.md', { type: 'topic' });
      await link(node(file.path));
      return node(file.path);
    }),
  };
  app.plugins = { getPlugin: () => ({ api }) };
  const saved = () => store.read(article.path);
  const open = async () => {
    const pending: Promise<void> = probe.topics();
    // Observe rejection immediately while retaining the original promise/assertions.
    const outcome = pending.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await tick();
    return { pending, outcome };
  };
  return {
    vault,
    store,
    app,
    probe,
    view,
    api,
    article,
    old,
    other,
    node,
    note,
    saved,
    open,
    cache,
    publicNodes,
    lifetime,
  };
}

describe('related-note public adapter', () => {
  it('accepts the optional callback capability and rejects malformed capability', async () => {
    const f = await fixture();
    expect(nodesApi(f.app as App)).toBe(f.api);
    for (const value of [null, false, 'invalid']) {
      (f.api as any).createNodeForLink = value;
      expect(nodesApi(f.app as App)).toBeUndefined();
    }
  });
  it.each(['absent', 'class', 'throws'] as const)(
    'keeps typed assignment safe when linked creation is %s',
    async (mode) => {
      const f = await fixture();
      const providerCreate = f.api.createNodeForLink;
      if (mode === 'absent') delete f.api.createNodeForLink;
      if (mode === 'class') {
        f.api.listTypes = () => [{ type: 'Topic', label: 'Topic' }];
        for (const [path, member] of f.publicNodes)
          if (member.classes.length)
            f.publicNodes.set(path, { ...member, type: 'Topic', classes: ['Topic'] });
      }
      if (mode === 'throws') {
        f.api.listTypes = () => {
          throw new Error('reloading');
        };
        const before = await f.vault.read(f.article);
        await expect(f.probe.topics()).rejects.toThrow('reloading');
        expect(document.querySelector('.reader-highlight-picker')).toBeNull();
        expect(await f.vault.read(f.article)).toBe(before);
        expect(providerCreate).not.toHaveBeenCalled();
        expect(f.api.createNode).not.toHaveBeenCalled();
        return;
      }
      const { pending } = await f.open();
      search('New subject');
      expect(creates().map((el) => el.dataset.createType)).toEqual(
        mode === 'absent' ? [] : ['Topic'],
      );
      expect(creates().some((el) => el.dataset.createType === 'topic')).toBe(false);
      search('');
      toggle('Other', true);
      button('Apply').click();
      await pending;
      expect((await f.saved()).properties.topics).toEqual([
        '[[Topics/Old.md]]',
        '[[Topics/Other.md]]',
      ]);
      expect(providerCreate).not.toHaveBeenCalled();
    },
  );
});

describe('typed related-note assignment', () => {
  it('offers any registered Fileclass by public membership, not arbitrary YAML type', async () => {
    const f = await fixture();
    f.api.listTypes = () => [
      { type: 'topic', label: 'Topic' },
      { type: 'concept', label: 'Concept' },
    ];
    await f.note('Topics/Concept.md', { type: 'not-a-fileclass' }, ['concept']);
    await f.note('Topics/Multi.md', {}, ['topic', 'concept']);
    await f.note('Topics/Unregistered.md', { type: 'topic' }, []);
    await f.note('Topics/UnknownClass.md', { type: 'topic' }, ['unknown']);
    expect(f.api.getNode('Topics/Unregistered.md')?.classes).toEqual([]);
    const { pending } = await f.open();
    expect(row('Concept')).not.toBeNull();
    expect(row('Multi')).not.toBeNull();
    expect(f.node('Topics/Multi.md').type).toBe('concept');
    expect(row('Unregistered')).toBeNull();
    expect(row('UnknownClass')).toBeNull();
    expect(rowAt(f.article.path)).toBeNull();
    toggle('Concept', true);
    toggle('Multi', true);
    button('Apply').click();
    await pending;
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/Old.md]]',
      '[[Topics/Concept.md]]',
      '[[Topics/Multi.md]]',
    ]);
  });

  it('preserves unresolved, untyped and unknown remembered values without offering them as new choices', async () => {
    const f = await fixture();
    await f.note('Topics/Untyped.md', { type: 'topic' }, []);
    const unknown = [
      '[[Missing|authored alias]]',
      '[[Topics/Untyped.md]]',
      'authored text',
      { custom: 'keep' },
      17,
    ];
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { topics: ['[[Topics/Old.md]]', ...unknown] }),
    );
    f.probe.snapshot = await f.store.read(f.article.path);
    const { pending } = await f.open();
    expect(checked('Old')).toBe(true);
    expect(row('Untyped')).toBeNull();
    toggle('Old', false);
    toggle('Other', true);
    button('Apply').click();
    await pending;
    expect((await f.saved()).properties.topics).toEqual([...unknown, '[[Topics/Other.md]]']);
  });

  it('requires the public provider for new assignments but leaves existing source bytes intact', async () => {
    const f = await fixture();
    const before = await f.vault.read(f.article);
    const write = vi.spyOn(f.store, 'setRelatedNodes');
    f.app.plugins.getPlugin = () => undefined;
    await expect(f.probe.topics()).rejects.toThrow('public Nodes API v2');
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(await f.vault.read(f.article)).toBe(before);
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
  });

  it.each(['membership', 'registration', 'provider', 'file'] as const)(
    'rechecks %s at assignment commit without accepting stale choices',
    async (change) => {
      const f = await fixture();
      const { pending } = await f.open();
      toggle('Other', true);
      const before = await f.vault.read(f.article);
      const write = f.store.setRelatedNodes.bind(f.store);
      vi.spyOn(f.store, 'setRelatedNodes').mockImplementationOnce(async (...args) => {
        if (change === 'membership')
          f.publicNodes.set(f.other.path, { ...f.node(f.other.path), classes: [] });
        if (change === 'registration') f.api.listTypes = () => [];
        if (change === 'provider') f.app.plugins.getPlugin = () => ({ api: { ...f.api } });
        if (change === 'file') f.vault.files.set(f.other.path, { ...f.other });
        return write(...args);
      });
      button('Apply').click();
      await tick();
      expect(await f.vault.read(f.article)).toBe(before);
      expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
      expect(visibleErrors().some(Boolean)).toBe(true);
      expect(document.querySelector('.reader-highlight-picker')).toBeNull();
      await pending;
    },
  );

  it.each(['membership', 'registration'] as const)(
    'rechecks unchecked original %s before removing its remembered relationship',
    async (change) => {
      const f = await fixture();
      f.api.listTypes = () => [
        { type: 'topic', label: 'Topic' },
        { type: 'concept', label: 'Concept' },
      ];
      f.publicNodes.set(f.other.path, {
        ...f.node(f.other.path),
        type: 'concept',
        classes: ['concept'],
      });
      const before = await f.vault.read(f.article);
      const { pending } = await f.open();
      toggle('Old', false);
      toggle('Other', true);
      const write = f.store.setRelatedNodes.bind(f.store);
      vi.spyOn(f.store, 'setRelatedNodes').mockImplementationOnce(async (...args) => {
        if (change === 'membership')
          f.publicNodes.set(f.old.path, { ...f.node(f.old.path), classes: [] });
        else f.api.listTypes = () => [{ type: 'concept', label: 'Concept' }];
        return write(...args);
      });
      button('Apply').click();
      await tick();
      expect(await f.vault.read(f.article)).toBe(before);
      expect(visibleErrors().some(Boolean)).toBe(true);
      dismiss();
      await pending;
    },
  );
});

describe('related-note creation and staged draft', () => {
  it('uses one compact footer and explicit typed creation information without an explainer', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    const modal = document.querySelector('.reader-highlight-picker-modal')!;
    const content = modal.querySelector('.reader-highlight-picker')!;
    expect(modal.querySelector('h2')!.textContent).toBe('Related notes');
    expect(content.querySelectorAll('.setting-item, input[type="radio"]')).toHaveLength(0);
    expect(content.textContent).toContain(
      'One selected note receives new highlights automatically.',
    );
    expect(content.querySelectorAll('.reader-highlight-picker-footer')).toHaveLength(1);
    const footer = content.querySelector('.reader-highlight-picker-footer')!;
    expect(
      [...footer.querySelectorAll('button')].filter((el) => !el.hidden).map((el) => el.textContent),
    ).toEqual(['Cancel', 'Apply']);
    expect(button('Apply').classList.contains('mod-cta')).toBe(true);
    const list = content.querySelector('.reader-highlight-picker-results')!;
    expect(
      list.querySelector('input, select, .reader-highlight-picker-footer, [role="alert"]'),
    ).toBeNull();
    expect(content.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(true);
    search('New');
    expect(create().textContent).toContain('Create “New”');
    expect(create().getAttribute('aria-label')).toBe('Create “New” as Topic and apply to 2 notes');
    expect(create().getAttribute('aria-label')).toContain('Topic');
    expect(content.textContent).not.toContain('Create and link immediately');
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    dismiss();
    await pending;
  });

  it('keeps checked rows visible outside zero-result searches without a permanent selected panel', async () => {
    const f = await fixture();
    delete f.api.createNodeForLink;
    const before = await f.vault.read(f.article);
    const write = vi.spyOn(f.store, 'setRelatedNodes');
    const { pending } = await f.open();
    expect(checked('Old')).toBe(true);
    toggle('Old', false);
    expect(button('Apply').disabled).toBe(false); // Related notes explicitly permits an empty result.
    search('Unmatched');
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).toContain('No matching typed notes.');
    search('Other');
    toggle('Other', true);
    search('Unmatched');
    expect(rows()).toHaveLength(1);
    expect(checked('Other')).toBe(true);
    expect(document.querySelector('.reader-highlight-picker-selected')).toBeNull();
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    dismiss();
    await pending;
    expect(write).not.toHaveBeenCalled();
    expect(await f.vault.read(f.article)).toBe(before);
  });

  it('shows paths for case-insensitive duplicate names including candidates beyond the first 100', async () => {
    const f = await fixture();
    for (let i = 0; i < 100; i++) await f.note(`Topics/Extra${i}.md`, { type: 'topic' });
    await f.note('Groups/old.md', { type: 'topic' });
    const { pending } = await f.open();
    expect(row('Old')!.querySelector('.reader-highlight-picker-result-path')?.textContent).toBe(
      'Topics/Old.md',
    );
    expect(row('Other')?.querySelector('.reader-highlight-picker-result-path') ?? null).toBeNull();
    search('OLD');
    expect(rows()).toHaveLength(2);
    expect(
      rows().map((el) => el.querySelector('.reader-highlight-picker-result-path')!.textContent),
    ).toEqual(['Topics/Old.md', 'Groups/old.md']);
    search('');
    for (const candidate of rows()) {
      expect(candidate.getAttribute('aria-label')).toContain(candidate.dataset.path);
      expect(candidate.title).toContain(candidate.dataset.path);
    }
    expect(checked('Old')).toBe(true);
    dismiss();
    await pending;
  });

  it('toggles the full name row by touch and keyboard without double toggling', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    expect(row('Other')!.tagName).toBe('BUTTON');
    expect(checked('Other')).toBe(false);
    row('Other')!.querySelector('span')!.click();
    expect(checked('Other')).toBe(true);
    row('Other')!.focus();
    row('Other')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(checked('Other')).toBe(false);
    expect(document.activeElement).toBe(row('Other'));
    dismiss();
    await pending;
  });

  it('keeps checked rows visible outside search and beyond the first 100 candidates', async () => {
    const f = await fixture();
    for (let i = 0; i < 110; i++) await f.note(`Topics/Extra${i}.md`, { type: 'topic' });
    const { pending } = await f.open();
    expect(
      rows().filter((el) => el.getAttribute('aria-checked') !== 'true').length,
    ).toBeLessThanOrEqual(100);
    search('Extra109');
    toggle('Extra109', true);
    search('');
    expect(checked('Extra109')).toBe(true);
    expect(checked('Old')).toBe(true);
    expect(
      rows().filter((el) => el.getAttribute('aria-checked') !== 'true').length,
    ).toBeLessThanOrEqual(100);
    search('Other');
    toggle('Other', true);
    expect(checked('Old')).toBe(true);
    expect(checked('Extra109')).toBe(true);
    expect(checked('Other')).toBe(true);
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    dismiss();
    await pending;
  });

  it('finishes creation in the original modal without reopening staged search', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    const modal = document.querySelector('.reader-highlight-picker-modal');
    startCreate();
    await pending;
    expect(modal?.isConnected).toBe(false);
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
    expect((await f.saved()).properties.topics).toContain('[[Topics/New.md]]');
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
  });

  it('reports a guarded Apply failure without silently reopening or writing', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    toggle('Other', true);
    vi.spyOn(f.store, 'setRelatedNodes').mockRejectedValueOnce(new Error('Write refused'));
    button('Apply').click();
    await pending;
    expect(visibleErrors().some((message) => message.includes('Write refused'))).toBe(true);
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
  });

  it('drains an in-flight Apply after navigation cancellation without a second commit', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    toggle('Other', true);
    search('New');
    const oldApply = button('Apply'),
      oldCreate = create();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = f.vault.process.bind(f.vault);
    let writes = 0;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      if (result.includes('[[Topics/Other.md]]')) {
        writes++;
        await gate;
      }
      return result;
    });
    oldApply.click();
    await tick();
    oldApply.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    oldCreate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    f.probe.cancelNodeCreation();
    let settled = false;
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await tick();
    expect(settled).toBe(false);
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    release();
    await pending;
    expect(writes).toBe(1);
    expect((await f.saved()).properties.topics).toContain('[[Topics/Other.md]]');
  });

  it('guards detached creation, Apply and selection while provider completion is pending', async () => {
    const f = await fixture();
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.api.createNodeForLink = vi.fn(async () => {
      await gate;
      return null;
    });
    const { pending } = await f.open();
    search('New');
    const oldCreate = create(),
      oldApply = button('Apply'),
      oldOther = row('Old')!;
    oldCreate.click();
    await tick();
    expect(document.querySelectorAll('.reader-highlight-picker')).toHaveLength(1);
    oldCreate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    oldApply.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    oldOther.click();
    await tick();
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    complete();
    await tick();
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
    dismiss();
    await pending;
  });

  it('does not steal provider focus during required completion and restores staged search afterward', async () => {
    const f = await fixture();
    const provider = document.body.appendChild(document.createElement('button'));
    provider.textContent = 'Provider form';
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    f.api.createNodeForLink = async (_options, link) => {
      await f.note('Topics/New.md', { type: 'topic' });
      await link(f.node('Topics/New.md'));
      provider.focus();
      await gate;
      return null;
    };
    const { pending } = await f.open();
    startCreate();
    await tick();
    expect(document.querySelectorAll('.reader-highlight-picker')).toHaveLength(1);
    expect(document.activeElement).toBe(provider);
    expect((await f.saved()).properties.topics).toContain('[[Topics/New.md]]');
    complete();
    await tick();
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();

    dismiss();
    await pending;
    expect((await f.saved()).properties.topics).toContain('[[Topics/New.md]]');
  });

  it('returns to staged choices after provider cancellation without claiming or persisting a new note', async () => {
    const f = await fixture();
    f.api.createNodeForLink = vi.fn(async () => null);
    const { pending } = await f.open();
    toggle('Other', true);
    startCreate('Not created');
    await tick();
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();

    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    dismiss();
    await pending;
    expect(f.vault.file('Topics/New.md')).toBeUndefined();
  });

  it.each([
    ['  New subject  ', 'New subject'],
    ['   ', undefined],
  ] as const)(
    'uses an explicit nonblank creation title from search %j',
    async (query, expected) => {
      const f = await fixture();
      const { pending } = await f.open();
      search(query);
      if (expected === undefined) {
        expect(creates()).toHaveLength(0);
        expect(f.api.createNodeForLink).not.toHaveBeenCalled();
      } else {
        create().click();
        await tick();
        expect(f.api.createNodeForLink).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'topic', suggestedTitle: expected }),
          expect.any(Function),
        );
      }
      dismiss();
      await pending;
    },
  );

  it('applies checked defaults and a new note together before required completion', async () => {
    const f = await fixture();
    f.api.createNodeForLink = vi.fn(async (options, link) => {
      expect(options.completionContainer?.isConnected).toBe(true);
      expect(document.querySelectorAll('.reader-highlight-picker-modal')).toHaveLength(1);
      await f.note('Topics/New.md', { type: 'topic' });
      await link(f.node('Topics/New.md'));
      expect((await f.saved()).properties.topics).toEqual([
        '[[Topics/Other.md]]',
        '[[Topics/New.md]]',
      ]);
      return null;
    });
    const { pending } = await f.open();
    toggle('Old', false);
    toggle('Other', true);
    startCreate();
    await pending;
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });

  it('keeps callback-committed creation after a provider error and lets Apply commit the retained draft', async () => {
    const f = await fixture();
    f.api.createNodeForLink = async (_options, link) => {
      await f.note('Topics/New.md', { type: 'topic' });
      await link(f.node('Topics/New.md'));
      throw new Error('Required completion failed');
    };
    const { pending } = await f.open();
    toggle('Old', false);
    toggle('Other', true);
    startCreate();
    await tick();
    expect(visibleErrors().some((message) => message.includes('Required completion failed'))).toBe(
      true,
    );
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/Other.md]]',
      '[[Topics/New.md]]',
    ]);
    await pending;
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/Other.md]]',
      '[[Topics/New.md]]',
    ]);
  });

  it('advances its body/path baseline after relocation and allows only one creation per flow', async () => {
    const f = await fixture();
    f.store.setStatusFolders({ later: 'Reading/Later' });
    const move = f.vault.move.bind(f.vault);
    vi.spyOn(f.vault, 'move').mockImplementation(async (file, path, guard) => {
      await move(file, path, guard);
      f.vault.bytes.set(
        file,
        (await f.vault.read(file)).replace('body', 'rewritten [[Topics/Old.md]] body'),
      );
    });
    const setBody = vi.fn((body: string) => {
      f.probe.surface.displayedBody = body;
    });
    f.probe.surface = {
      setBody,
      setTopics: vi.fn(),
      displayedBody: f.probe.snapshot.body,
      selection: () => null,
      body: document.createElement('div'),
    };
    let count = 0;
    f.api.createNodeForLink = vi.fn(async (options, link) => {
      expect(options.sourcePath).toBe(
        count === 0 ? 'Reading/Stream/Article.md' : 'Reading/Later/Article.md',
      );
      const path = `Topics/New${++count}.md`;
      await f.note(path, { type: 'topic' });
      await link(f.node(path));
      return null;
    });
    const first = await f.open();
    toggle('Other', true);
    startCreate('New1');
    await tick();
    expect(f.article.path).toBe('Reading/Later/Article.md');
    expect(setBody).toHaveBeenCalledOnce();
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
    await first.pending;
    const second = await f.open();
    startCreate('New2');
    await tick();
    await second.pending;
    expect(f.api.createNodeForLink).toHaveBeenCalledTimes(2);
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/Old.md]]',
      '[[Topics/Other.md]]',
      '[[Topics/New1.md]]',
      '[[Topics/New2.md]]',
    ]);
    expect((await f.saved()).body).toBe('rewritten [[Topics/Old.md]] body');
  });

  it('rejects missing requested topic membership even when YAML and primary type advertise topic', async () => {
    const f = await fixture();
    f.api.listTypes = () => [
      { type: 'topic', label: 'Topic' },
      { type: 'concept', label: 'Concept' },
    ];
    f.api.createNodeForLink = async (_options, link) => {
      const file = await f.note('Topics/New.md', { type: 'topic' }, ['concept']);
      f.publicNodes.set(file.path, { ...f.node(file.path), type: 'topic' });
      await link(f.node(file.path));
      return null;
    };
    const { pending } = await f.open();
    startCreate();
    await tick();
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    expect(visibleErrors().some(Boolean)).toBe(true);
    dismiss();
    await pending;
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });

  it('accepts public multi-class topic membership without requiring a raw YAML type discriminator', async () => {
    const f = await fixture();
    f.api.listTypes = () => [
      { type: 'topic', label: 'Topic' },
      { type: 'concept', label: 'Concept' },
    ];
    let completed = false;
    f.api.createNodeForLink = async (_options, link) => {
      const file = await f.note('Topics/New.md', { fileClass: 'topic' }, ['topic', 'concept']);
      f.vault.bytes.set(file, patchProperties(await f.vault.read(file), { type: undefined }));
      expect(f.node(file.path).type).toBe('concept');
      await link(f.node(file.path));
      expect((await f.saved()).properties.topics).toEqual([
        '[[Topics/Old.md]]',
        '[[Topics/New.md]]',
      ]);
      completed = true;
      return null;
    };
    const { pending } = await f.open();
    startCreate();
    await tick();
    expect(completed).toBe(true);
    const created = f.vault.file('Topics/New.md')!;
    const destination = readDocument(await f.vault.read(created));
    expect(destination.properties.type).toBeUndefined();
    expect(destination.body).toBe('body');
    dismiss();
    await pending;
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
  });

  it.each(['stale', 'duplicate', 'reload', 'getNode'] as const)(
    'rejects %s provider/source safety failures without deleting the created note',
    async (mode) => {
      const f = await fixture();
      f.api.createNodeForLink = async (_options, link) => {
        await f.note('Topics/New.md', { type: 'topic' });
        if (mode === 'stale')
          f.vault.bytes.set(
            f.article,
            patchProperties(await f.vault.read(f.article), { topics: [] }),
          );
        if (mode === 'reload') f.app.plugins.getPlugin = () => ({ api: { ...f.api } });
        if (mode === 'getNode')
          f.api.getNode = () => {
            throw new Error('provider reloading');
          };
        await link(f.node('Topics/New.md'));
        if (mode === 'duplicate') await link(f.node('Topics/New.md'));
        return null;
      };
      const { pending } = await f.open();
      startCreate();
      await tick();
      expect(visibleErrors().some(Boolean)).toBe(true);
      expect((await f.saved()).properties.topics).toEqual(
        mode === 'duplicate'
          ? ['[[Topics/Old.md]]', '[[Topics/New.md]]']
          : mode === 'stale'
            ? []
            : ['[[Topics/Old.md]]'],
      );
      expect(f.vault.file('Topics/New.md')).toBeDefined();
      if (mode === 'duplicate') {
        expect(document.querySelector('.reader-highlight-picker')).toBeNull();
        dismiss();
        await pending;
      } else {
        // A changed source/provider is not a valid continuation of the old dialog.
        expect(document.querySelector('.reader-highlight-picker')).toBeNull();
        await pending;
      }
    },
  );

  it('keeps required completion alive across the saved source metadata echo', async () => {
    const f = await fixture();
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal!: AbortSignal,
      linked = false;
    f.api.createNodeForLink = async (options, link) => {
      signal = options.signal!;
      await f.note('Topics/New.md', { type: 'topic' });
      await link(f.node('Topics/New.md'));
      linked = true;
      await completion;
      return null;
    };
    const { pending } = await f.open();
    startCreate();
    await tick();
    expect(linked).toBe(true);
    await f.view.changed({ path: f.article.path, metadataChanged: true });
    expect(signal.aborted).toBe(false);
    expect(document.querySelectorAll('.reader-highlight-picker')).toHaveLength(1);
    finish();
    await tick();
    expect(signal.aborted).toBe(false);
    await pending;
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
  });

  it('navigation closes the picker and cancels an uncooperative provider without waiting', async () => {
    const f = await fixture();
    let signal!: AbortSignal;
    f.api.createNodeForLink = (options) => {
      signal = options.signal!;
      return new Promise(() => {});
    };
    const { pending } = await f.open();
    startCreate();
    await tick();
    f.probe.cancelNodeCreation();
    await pending;
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('.reader-highlight-picker')).toBeNull();
  });

  it.each(['article', 'host'] as const)(
    'settles %s lifetime cancellation after the durable callback without reopening or error loops',
    async (owner) => {
      const f = await fixture();
      let signal!: AbortSignal;
      f.api.createNodeForLink = async (options, link) => {
        signal = options.signal!;
        await f.note('Topics/New.md', { type: 'topic' });
        await link(f.node('Topics/New.md'));
        return new Promise(() => {});
      };
      const { pending } = await f.open();
      toggle('Other', true);
      startCreate();
      await tick();
      const durable = await f.vault.read(f.article);
      expect((await f.saved()).properties.topics).toEqual([
        '[[Topics/Old.md]]',
        '[[Topics/Other.md]]',
        '[[Topics/New.md]]',
      ]);
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      const beforeNotices = notices.length;
      if (owner === 'article') f.probe.articleLifetime.abort();
      else f.lifetime.abort();
      await tick();
      const settledOnAbort = settled,
        afterNotices = notices.length;
      // Bound a broken retry loop before asserting, so a regression cannot hang Vitest.
      f.probe.cancelNodeCreation();
      await pending;
      expect(settledOnAbort).toBe(true);
      expect(afterNotices).toBe(beforeNotices);
      expect(signal.aborted).toBe(true);
      expect(document.querySelector('.reader-highlight-picker')).toBeNull();
      expect(await f.vault.read(f.article)).toBe(durable);
      expect(f.vault.file('Topics/New.md')).toBeDefined();
    },
  );

  it('drains its dispatched creation callback write after cancellation but not the provider', async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = f.vault.process.bind(f.vault);
    let dispatched = false;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const raw = await process(file, update);
      if (raw.includes('[[Topics/New.md]]')) {
        dispatched = true;
        await gate;
      }
      return raw;
    });
    const { pending } = await f.open();
    let settled = false;
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    startCreate();
    await tick();
    expect(dispatched).toBe(true);
    f.probe.cancelNodeCreation();
    await tick();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });

  it('cancels an uncooperative provider, rejects late callbacks and never deletes its note', async () => {
    const f = await fixture();
    let late!: (node: NodeResult) => Promise<void>, signal!: AbortSignal;
    f.api.createNodeForLink = async (options, link) => {
      late = link;
      signal = options.signal!;
      await f.note('Topics/New.md', { type: 'topic' });
      return new Promise(() => {});
    };
    const { pending } = await f.open();
    startCreate();
    await tick();
    f.probe.cancelNodeCreation();
    await pending;
    expect(signal.aborted).toBe(true);
    await expect(late(f.node('Topics/New.md'))).rejects.toThrow('cancelled');
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });
});

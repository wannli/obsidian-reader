// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { ReaderView } from '../src/reader/view';
import { nodesApi, type NodesApi, type NodeResult } from '../src/host/nodes';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties } from '../src/core/document';
import { defaultFolders } from '../src/core/folders';
import { MemoryVault } from './helpers/memory-vault';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
afterAll(() => dom.teardown(globalThis));
vi.mock('../src/reader/surface', () => ({ ReadingSurface: class {} }));
vi.mock('obsidian', () => ({
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
  Notice: class {},
  TFile: class {},
  parseLinktext: (path: string) => ({ path }),
  setIcon() {},
  setTooltip() {},
  Setting: class {
    el: HTMLElement;
    constructor(parent: HTMLElement) {
      this.el = document.createElement('div');
      this.el.className = 'setting-item';
      parent.append(this.el);
    }
    setName(text: string) {
      this.el.dataset.name = text;
      return this;
    }
    setDesc() {
      return this;
    }
    addToggle(build: (toggle: any) => void) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('aria-label', this.el.dataset.name!);
      this.el.append(input);
      const toggle = {
        setValue(value: boolean) {
          input.checked = value;
          return toggle;
        },
        onChange(fn: (value: boolean) => void) {
          input.onchange = () => fn(input.checked);
          return toggle;
        },
      };
      build(toggle);
      return this;
    }
    addButton(build: (button: any) => void) {
      const el = document.createElement('button');
      this.el.append(el);
      const button = {
        setButtonText(text: string) {
          el.textContent = text;
          return button;
        },
        setDisabled(value: boolean) {
          el.disabled = value;
          return button;
        },
        setCta() {
          return button;
        },
        onClick(fn: () => void) {
          el.onclick = fn;
          return button;
        },
      };
      build(button);
      return this;
    }
  },
}));
beforeEach(() => {
  document.body.replaceChildren();
  const proto = HTMLElement.prototype as any;
  proto.empty = function () {
    this.replaceChildren();
  };
  proto.createEl = function (tag: string, options: any = {}) {
    const el = document.createElement(tag);
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
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((el) => el.textContent === label)!;
const row = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `.reader-topic-row[aria-label="${label} — Topics/${label}.md"]`,
  )!;
const toggle = (label: string, on: boolean) => {
  if ((row(label).getAttribute('aria-pressed') === 'true') !== on) row(label).click();
};
async function fixture() {
  const vault = new MemoryVault();
  const store = new ArticleStore(vault, defaultFolders);
  const cache = new Map<any, any>();
  const app: any = {
    vault: { getMarkdownFiles: () => [...vault.files.values()] },
    metadataCache: {
      getFileCache: (file: any) => cache.get(file),
      getFirstLinkpathDest: (path: string) => vault.file(path) ?? vault.file(`${path}.md`),
    },
  };
  const host: any = { store, signal: new AbortController().signal };
  const view = new ReaderView({ app } as any, host);
  const probe = view as any;
  probe.prepareToLeave = async () => {};
  probe.assertDisplayed = () => {};
  probe.controls = () => {};
  const note = async (path: string, properties: any) => {
    const file = await vault.create(path, createDocument(properties, 'body'));
    Object.assign(file, { basename: path.replace(/.*\//, '').replace(/\.md$/, '') });
    cache.set(file, { frontmatter: properties });
    return file;
  };
  const old = await note('Topics/Old.md', { type: 'topic' });
  const other = await note('Topics/Other.md', { type: 'topic' });
  const article = await note('Reading/Stream/Article.md', {
    type: 'article',
    status: 'feed',
    topics: ['[[Topics/Old.md]]'],
  });
  probe.snapshot = await store.read(article.path);
  const node = (path: string): NodeResult => ({
    path,
    title: 'New',
    type: 'topic',
    classes: ['topic'],
    aliases: [],
  });
  const api: NodesApi = {
    version: 2,
    listTypes: () => [{ type: 'topic', label: 'Topic' }],
    searchNodes: () => [],
    getNode: (path) => node(path),
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
    await tick();
    return { pending };
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
  };
}

describe('topic creation public adapter', () => {
  it('accepts the optional callback capability and rejects malformed capability', async () => {
    const f = await fixture();
    expect(nodesApi(f.app as App)).toBe(f.api);
    for (const value of [null, false, 'invalid']) {
      (f.api as any).createNodeForLink = value;
      expect(nodesApi(f.app as App)).toBeUndefined();
    }
  });
  it.each(['absent', 'class', 'throws'] as const)(
    'keeps multiselect usable when creation is %s',
    async (mode) => {
      const f = await fixture();
      if (mode === 'absent') delete f.api.createNodeForLink;
      if (mode === 'class') f.api.listTypes = () => [{ type: 'Topic', label: 'Topic' }];
      if (mode === 'throws')
        f.api.listTypes = () => {
          throw new Error('reloading');
        };
      const { pending } = await f.open();
      expect(button('Add topic').disabled).toBe(true);
      expect(button('Add topic').title).toContain('Fileclass Inline');
      expect(button('Add topic').getAttribute('aria-description')).toBe(button('Add topic').title);
      expect(document.querySelector('.reader-topic-picker')!.textContent).not.toContain(
        button('Add topic').title,
      );
      toggle('Other', true);
      button('Save').click();
      await pending;
      expect((await f.saved()).properties.topics).toEqual([
        '[[Topics/Old.md]]',
        '[[Topics/Other.md]]',
      ]);
    },
  );
});

describe('article topics creation and draft', () => {
  it('uses one compact footer and accessible creation information without an explainer', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    const modal = document.querySelector('.reader-topic-modal')!;
    const content = modal.querySelector('.reader-topic-picker')!;
    expect(modal.querySelector('h2')!.textContent).toBe('Article topics');
    expect(content.querySelectorAll('p, .setting-item')).toHaveLength(0);
    expect(content.querySelectorAll('.reader-topic-footer')).toHaveLength(1);
    const footer = content.querySelector('.reader-topic-footer')!;
    expect([...footer.children].map((el) => el.textContent)).toEqual([
      'Add topic',
      'Cancel',
      'Save',
    ]);
    expect(content.querySelectorAll('button:not(.reader-topic-row)')).toHaveLength(3);
    expect(footer.parentElement).toBe(content);
    expect(button('Save').classList.contains('mod-cta')).toBe(true);
    const list = content.querySelector('.reader-topic-list')!;
    for (const selector of ['input', '.reader-topic-selection', '.reader-topic-footer']) {
      expect(content.querySelector(selector)).not.toBeNull();
      expect(list.querySelector(selector)).toBeNull();
    }
    for (const selector of ['.reader-topic-status', '.reader-topic-error']) {
      const message = content.querySelector<HTMLElement>(selector)!;
      expect(message.textContent).toBe('');
      expect(message.hidden).toBe(true);
      expect(message.getAttribute('role')).toBe(selector.endsWith('error') ? 'alert' : 'status');
      expect(message.getAttribute('aria-atomic')).toBe('true');
      expect(list.contains(message)).toBe(false);
    }
    expect(content.querySelector('.reader-topic-status')!.getAttribute('aria-live')).toBe('polite');
    expect(button('Add topic').title).toContain('link immediately');
    expect(button('Add topic').title).toContain('Cancel keeps the new topic and link');
    expect(button('Add topic').getAttribute('aria-description')).toBe(button('Add topic').title);
    expect(content.textContent).not.toContain('Create and link immediately');
    button('Cancel').click();
    await pending;
  });

  it('hides an empty selected region and keeps nonempty chips outside zero search results', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    const selection = document.querySelector<HTMLElement>('.reader-topic-selection')!;
    const chosen = document.querySelector<HTMLElement>('.reader-topic-selected')!;
    const count = document.querySelector<HTMLElement>('.reader-topic-count')!;
    expect(selection.hidden).toBe(false);
    expect(count.textContent).toBe('1 selected');
    toggle('Old', false);
    expect(selection.hidden).toBe(true);
    expect(chosen.hidden).toBe(true);
    expect(count.hidden).toBe(true);
    expect(count.textContent).toBe('');
    toggle('Other', true);
    expect(selection.hidden).toBe(false);
    expect(chosen.hidden).toBe(false);
    expect(count.textContent).toBe('1 selected');
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'Unmatched';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.reader-topic-row')).toHaveLength(0);
    const empty = document.querySelector('.reader-topic-empty')!;
    expect(empty.textContent).toBe('No matching topics.');
    expect(empty.getAttribute('role')).toBe('status');
    expect(chosen.textContent).toBe('Other');
    expect(chosen.closest('.reader-topic-list')).toBeNull();
    expect(document.querySelector<HTMLElement>('.reader-topic-status')!.hidden).toBe(true);
    button('Cancel').click();
    await pending;
  });

  it('shows paths only for case-insensitive duplicate basenames while retaining every accessible path', async () => {
    const f = await fixture();
    // Ambiguity includes candidates beyond the first rendered page.
    for (let i = 0; i < 100; i++) await f.note(`Topics/Extra${i}.md`, { type: 'topic' });
    await f.note('Groups/old.md', { type: 'topic' });
    const { pending } = await f.open();
    expect(row('Old').querySelector('.reader-topic-path')!.textContent).toBe('Topics/Old.md');
    expect(row('Other').querySelector('.reader-topic-path')).toBeNull();
    expect(row('Other').querySelector('.reader-topic-name')!.textContent).toBe('Other');
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'OLD';
    search.dispatchEvent(new Event('input'));
    const matches = [...document.querySelectorAll<HTMLButtonElement>('.reader-topic-row')];
    expect(matches).toHaveLength(2);
    expect(matches.map((el) => el.querySelector('.reader-topic-path')!.textContent)).toEqual([
      'Topics/Old.md',
      'Groups/old.md',
    ]);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    for (const candidate of document.querySelectorAll<HTMLButtonElement>('.reader-topic-row')) {
      const name = candidate.querySelector('.reader-topic-name')!.textContent;
      expect(candidate.title).toMatch(/\.md$/);
      expect(candidate.getAttribute('aria-label')).toBe(`${name} — ${candidate.title}`);
      if (name?.toLocaleLowerCase() !== 'old')
        expect(candidate.querySelector('.reader-topic-path')).toBeNull();
    }
    const chip = document.querySelector<HTMLElement>('.reader-topic-selected span')!;
    expect(chip.title).toBe('Topics/Old.md');
    expect(chip.getAttribute('aria-label')).toBe(chip.title);
    button('Cancel').click();
    await pending;
  });

  it('toggles the full name row by touch click and keyboard without double toggling', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    const candidate = row('Other');
    expect(candidate.tagName).toBe('BUTTON');
    expect(candidate.getAttribute('aria-pressed')).toBe('false');
    candidate.querySelector('span')!.click(); // touch on the label, not the checkbox corner
    expect(candidate.getAttribute('aria-pressed')).toBe('true');
    candidate.focus();
    candidate.click(); // native button keyboard activation also issues one click
    expect(candidate.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.reader-topic-selected')!.textContent).not.toContain('Other');
    button('Cancel').click();
    await pending;
  });

  it('keeps selected chips visible outside search and beyond the first 100 results', async () => {
    const f = await fixture();
    for (let i = 0; i < 110; i++) await f.note(`Topics/Extra${i}.md`, { type: 'topic' });
    const { pending } = await f.open();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.querySelectorAll('.reader-topic-row')).toHaveLength(100);
    search.value = 'Extra109';
    search.dispatchEvent(new Event('input'));
    row('Extra109').click();
    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.reader-topic-row')).toHaveLength(100);
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('Extra109');
    search.value = 'Old';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.reader-topic-row')).toHaveLength(1);
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('Old');
    search.value = 'Other';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('Old');
    row('Other').click();
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('Other');
    expect(document.querySelectorAll('.reader-topic-row')).toHaveLength(1);
    button('Cancel').click();
    await pending;
  });

  it('returns from creation with its query, focus, and committed topic visible in selected chips', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'New';
    search.dispatchEvent(new Event('input'));
    button('Add topic').click();
    await tick();
    expect(search.value).toBe('New');
    expect(document.activeElement).toBe(search);
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('New');
    expect(row('New').getAttribute('aria-pressed')).toBe('true');
    button('Cancel').click();
    await pending;
    expect((await f.saved()).properties.topics).toContain('[[Topics/New.md]]');
  });

  it('awaits guarded Save, retains draft after failure, and retries without closing', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    toggle('Other', true);
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'Other';
    search.dispatchEvent(new Event('input'));
    const process = f.vault.process.bind(f.vault);
    let fail = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (fail) throw new Error('Write refused');
      return process(file, update);
    });
    button('Save').focus();
    button('Save').click();
    expect(document.querySelector<HTMLElement>('.reader-topic-status')!.hidden).toBe(false);
    await tick();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Write refused');
    expect(document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.reader-topic-status')!.hidden).toBe(true);
    expect(search.value).toBe('Other');
    expect(document.activeElement).toBe(search);
    expect(row('Other').getAttribute('aria-pressed')).toBe('true');
    expect(button('Save')).not.toBeNull();
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    fail = false;
    button('Save').click();
    expect(document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(true);
    await pending;
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/Old.md]]',
      '[[Topics/Other.md]]',
    ]);
  });

  it('drains an in-flight Save after Cancel without a second commit', async () => {
    const f = await fixture();
    const { pending } = await f.open();
    toggle('Other', true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const process = f.vault.process.bind(f.vault);
    let writes = 0;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      if (result.includes('[[Topics/Other.md]]')) writes++;
      await gate;
      return result;
    });
    button('Save').click();
    await tick();
    expect(button('Save').disabled).toBe(true);
    expect(button('Add topic').disabled).toBe(true);
    // Even programmatic events cannot bypass the in-flight Save guard.
    button('Save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button('Add topic').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    button('Cancel').click();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(writes).toBe(1);
    expect((await f.saved()).properties.topics).toContain('[[Topics/Other.md]]');
  });
  it('guards duplicate creation, Save and selection while creation is pending, keeping Cancel available', async () => {
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
    button('Add topic').click();
    await tick();
    expect(button('Add topic').disabled).toBe(true);
    expect(button('Save').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
    const status = document.querySelector<HTMLElement>('.reader-topic-status')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Creating topic…');
    button('Add topic').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button('Save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    row('Other').click();
    await tick();
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(row('Other').getAttribute('aria-pressed')).toBe('false');
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    complete();
    await tick();
    expect(button('Add topic').disabled).toBe(false);
    expect(button('Save').disabled).toBe(false);
    expect(status.textContent).toBe('No topic was added.');
    button('Cancel').click();
    await pending;
  });

  it('does not steal provider focus during required completion, restores search after settlement', async () => {
    const f = await fixture();
    const provider = document.createElement('button');
    provider.textContent = 'Provider form';
    document.body.append(provider);
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
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'New';
    search.dispatchEvent(new Event('input'));
    button('Add topic').click();
    await tick();
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('New');
    expect(document.activeElement).toBe(provider);
    expect(button('Save').disabled).toBe(true);
    complete();
    await tick();
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe('New');
    button('Cancel').click();
    await pending;
    expect((await f.saved()).properties.topics).toContain('[[Topics/New.md]]');
  });

  it('reports a provider form cancellation without claiming a link or changing the draft', async () => {
    const f = await fixture();
    f.api.createNodeForLink = vi.fn(async () => null);
    const { pending } = await f.open();
    toggle('Other', true);
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'Not created';
    search.dispatchEvent(new Event('input'));
    button('Add topic').click();
    await tick();
    expect(document.querySelectorAll('.reader-topic-row')).toHaveLength(0);
    expect(search.value).toBe('Not created');
    expect(document.activeElement).toBe(search);
    expect(document.querySelector('.reader-topic-selected')!.textContent).toContain('Other');
    expect(document.querySelector('.reader-topic-picker')!.textContent).toContain(
      'No topic was added.',
    );
    expect(document.querySelector('.reader-topic-picker')!.textContent).not.toContain(
      'Topic created and linked.',
    );
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    button('Cancel').click();
    await pending;
    expect(f.vault.file('Topics/New.md')).toBeUndefined();
  });

  it.each([
    ['  New subject  ', 'New subject'],
    ['   ', undefined],
  ])('seeds the public creation form from search %j', async (query, expected) => {
    const f = await fixture();
    const { pending } = await f.open();
    document.querySelector<HTMLInputElement>('input[type="search"]')!.value = query!;
    button('Add topic').click();
    await tick();
    expect(f.api.createNodeForLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'topic', suggestedTitle: expected }),
      expect.any(Function),
    );
    button('Cancel').click();
    await pending;
  });

  it.each(['Save', 'Cancel'])(
    'commits only created link before completion, preserves draft on %s',
    async (finish) => {
      const f = await fixture();
      let complete = false;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        expect(options.type).toBe('topic');
        expect(options.sourcePath).toBe('Reading/Stream/Article.md');
        await f.note('Topics/New.md', { type: 'topic' });
        await link(f.node('Topics/New.md'));
        const saved = await f.saved();
        expect(saved.properties.status).toBe('later');
        expect(saved.properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
        complete = true;
        return null; // Never rely on provider return value to link.
      });
      const { pending } = await f.open();
      toggle('Old', false);
      toggle('Other', true);
      expect(button('Add topic').title).toContain('Cancel keeps the new topic and link');
      expect(document.body.textContent).not.toContain('Cancel keeps them');
      button('Add topic').click();
      await tick();
      expect(complete).toBe(true);
      expect(row('Old').getAttribute('aria-pressed')).toBe('false');
      expect(row('Other').getAttribute('aria-pressed')).toBe('true');
      expect(row('New').getAttribute('aria-pressed')).toBe('true');
      button(finish).click();
      await pending;
      expect((await f.saved()).properties.topics).toEqual(
        finish === 'Save'
          ? ['[[Topics/New.md]]', '[[Topics/Other.md]]']
          : ['[[Topics/Old.md]]', '[[Topics/New.md]]'],
      );
      expect(f.vault.file('Topics/New.md')).toBeDefined();
      expect(f.api.createNode).not.toHaveBeenCalled();
    },
  );
  it('keeps callback-committed selection after provider throws, then Save applies the retained draft', async () => {
    const f = await fixture();
    f.api.createNodeForLink = async (_options, link) => {
      await f.note('Topics/New.md', { type: 'topic' });
      await link(f.node('Topics/New.md'));
      throw new Error('Required completion failed');
    };
    const { pending } = await f.open();
    toggle('Old', false);
    toggle('Other', true);
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'New';
    search.dispatchEvent(new Event('input'));
    button('Add topic').focus();
    button('Add topic').click();
    await tick();
    expect(search.value).toBe('New');
    expect(document.activeElement).toBe(search);
    expect(document.body.textContent).toContain('Required completion failed');
    expect(document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.reader-topic-status')!.hidden).toBe(true);
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
    expect(row('New').getAttribute('aria-pressed')).toBe('true');
    button('Save').click();
    await pending;
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/New.md]]',
      '[[Topics/Other.md]]',
    ]);
  });

  it('advances its own body/path baseline after relocation and supports another creation then Save', async () => {
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
    const setBody = vi.fn();
    f.probe.surface = { setBody };
    let count = 0;
    f.api.createNodeForLink = async (options, link) => {
      expect(options.sourcePath).toBe(
        count === 0 ? 'Reading/Stream/Article.md' : 'Reading/Later/Article.md',
      );
      const path = `Topics/New${++count}.md`;
      await f.note(path, { type: 'topic' });
      await link(f.node(path));
      return null;
    };
    const { pending } = await f.open();
    button('Add topic').click();
    await tick();
    expect(f.article.path).toBe('Reading/Later/Article.md');
    expect(setBody).toHaveBeenCalledOnce();
    button('Add topic').click();
    await tick();
    toggle('Other', true);
    button('Save').click();
    await pending;
    expect((await f.saved()).properties.topics).toEqual([
      '[[Topics/Old.md]]',
      '[[Topics/New1.md]]',
      '[[Topics/New2.md]]',
      '[[Topics/Other.md]]',
    ]);
    expect((await f.saved()).body).toContain('rewritten');
  });

  it('rejects wrong raw type even when metadata and API advertise topic', async () => {
    const f = await fixture();
    f.api.createNodeForLink = async (_options, link) => {
      const file = await f.note('Topics/New.md', { type: 'topic' });
      f.vault.bytes.set(file, createDocument({ fileClass: 'topic' }, 'body'));
      await link(f.node(file.path));
      return null;
    };
    const { pending } = await f.open();
    button('Add topic').click();
    await tick();
    expect(document.body.textContent).toContain('exact type: topic');
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    button('Cancel').click();
    await pending;
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });
  it.each(['stale', 'duplicate', 'reload', 'getNode'] as const)(
    'rejects %s provider/source safety failures',
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
      button('Add topic').click();
      await tick();
      expect(document.querySelector('[role="alert"]')!.textContent).not.toBe('');
      expect((await f.saved()).properties.topics).toEqual(
        mode === 'duplicate'
          ? ['[[Topics/Old.md]]', '[[Topics/New.md]]']
          : mode === 'stale'
            ? []
            : ['[[Topics/Old.md]]'],
      );
      button('Cancel').click();
      await pending;
    },
  );
  it('keeps required completion alive across the saved source metadata echo', async () => {
    const f = await fixture();
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal!: AbortSignal;
    let linked = false;
    f.api.createNodeForLink = async (options, link) => {
      signal = options.signal!;
      await f.note('Topics/New.md', { type: 'topic' });
      await link(f.node('Topics/New.md'));
      linked = true;
      await completion;
      return null;
    };
    const { pending } = await f.open();
    button('Add topic').click();
    await tick();
    expect(linked).toBe(true);
    await f.view.changed({ path: f.article.path, metadataChanged: true });
    expect(signal.aborted).toBe(false);
    expect(button('Save').disabled).toBe(true);
    finish();
    await tick();
    expect(signal.aborted).toBe(false);
    button('Save').click();
    await pending;
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
  });

  it('navigation intent closes the topic modal and cancels an uncooperative provider', async () => {
    const f = await fixture();
    let signal!: AbortSignal;
    f.api.createNodeForLink = (options) => {
      signal = options.signal!;
      return new Promise(() => {});
    };
    const { pending } = await f.open();
    button('Add topic').click();
    await tick();
    f.probe.cancelNodeCreation();
    await pending;
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('button')).toBeNull();
  });

  it('drains its own dispatched callback write after cancellation but not the provider', async () => {
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
    void pending.then(() => {
      settled = true;
    });
    button('Add topic').click();
    await tick();
    expect(dispatched).toBe(true);
    button('Cancel').click();
    await tick();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]', '[[Topics/New.md]]']);
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });

  it('cancels an uncooperative provider, rejects late callback and never deletes its note', async () => {
    const f = await fixture();
    let late!: (node: NodeResult) => Promise<void>;
    let signal!: AbortSignal;
    f.api.createNodeForLink = async (options, link) => {
      late = link;
      signal = options.signal!;
      await f.note('Topics/New.md', { type: 'topic' });
      return new Promise(() => {});
    };
    const { pending } = await f.open();
    button('Add topic').click();
    await tick();
    button('Cancel').click();
    await pending;
    expect(signal.aborted).toBe(true);
    await expect(late(f.node('Topics/New.md'))).rejects.toThrow('cancelled');
    expect((await f.saved()).properties.topics).toEqual(['[[Topics/Old.md]]']);
    expect(f.vault.file('Topics/New.md')).toBeDefined();
  });
});

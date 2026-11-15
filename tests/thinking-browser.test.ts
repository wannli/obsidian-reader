import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import {
  addThinkingToExploration,
  openThinkingBrowser,
  type ThinkingBrowserHost,
} from '../src/host/thinking-browser';
import { ArticleStore } from '../src/core/store';
import { ThinkingStore } from '../src/core/thinking';
import { MemoryVault } from './helpers/memory-vault';

const dom = await vi.hoisted(async () => {
  const { builtinEnvironments } = await import('vitest/runtime');
  return builtinEnvironments.jsdom.setup(globalThis, {});
});
vi.mock('obsidian', () => ({
  Modal: class {
    contentEl = document.createElement('div');
    modalEl = this.contentEl;
    constructor(_app: unknown) {}
    setTitle(title: string) {
      this.contentEl.setAttribute('aria-label', title);
    }
    open() {
      document.body.append(this.contentEl);
      this.onOpen();
    }
    close() {
      this.onClose();
      this.contentEl.remove();
    }
    onOpen() {}
    onClose() {}
  },
}));
afterAll(() => dom.teardown(globalThis));
afterEach(() => document.body.replaceChildren());
const settle = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const freeComment = (id: string, body: string, collected = '2026-11-15') =>
  `> [!note] Comment\n> **Collected:** [[${collected}]]\n>\n> ---\n>\n> ${body}\n>\n> ---\n>\n> #### Connections\n>\n> _None._\n\n^${id}\n`;
async function populated() {
  const fixtureValue = fixture();
  await fixtureValue.vault.create(
    'Notebook.md',
    `---\nfileClass: Notebook\n---\n\nMy protected prose.\n\n${freeComment('comment-one', 'A quiet thought')}\n${freeComment('comment-two', 'A second thought')}`,
  );
  fixtureValue.host.notebookPaths = () => ['Notebook.md'];
  return fixtureValue;
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function resultButton(text: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('.reader-thinking-item button'),
  ].find((button) => button.textContent === text);
  if (!found) throw new Error(`Missing saved-material result: ${text}`);
  return found;
}
function fixture(vault = new MemoryVault()) {
  const lifetime = new AbortController();
  const host: ThinkingBrowserHost<{ path: string }> = {
    store: new ThinkingStore(vault),
    signal: lifetime.signal,
    guard: () => true,
    notebookPaths: () => [],
    explorationPaths: () => [],
    sources: () => [],
    openNative: vi.fn(async () => {}),
    openSource: vi.fn(async () => {}),
  };
  return { vault, host, lifetime };
}

describe('saved material browser public UI', () => {
  it('starts in All with an actionable empty state and no software-keyboard input', async () => {
    const { host } = fixture();
    const browser = openThinkingBrowser({} as App, host);
    await settle();
    expect(document.body.textContent).toContain('Keep passage');
    expect(button('All').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('input')).toBeNull();
    button('Search').click();
    expect(document.querySelector('input')?.getAttribute('aria-label')).toBe(
      'Search saved material',
    );
    browser.close();
  });
  it('edits a comment through the real store and leaves other entries and authored prose intact', async () => {
    const { host } = await populated();
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Edit comment').click();
    const field = document.querySelector('textarea')!;
    field.value = 'Revised **personal** thought';
    button('Save').click();
    await settle();
    expect(document.body.textContent).toContain('Saved locally');
    const saved = await host.store.read('Notebook.md');
    expect(saved.records.map((record) => record.body)).toEqual([
      'Revised **personal** thought',
      'A second thought',
    ]);
    expect(saved.raw).toContain('My protected prose.');
    expect(saved.records[1].raw).toContain('A second thought');
    expect(document.querySelector('strong')?.textContent).toBe('personal');
    expect(
      [...document.querySelectorAll('button')].some((el) => el.textContent?.includes('Delete')),
    ).toBe(false);
  });
  it('Connect starts keyboard-free, excludes self and Cancel writes nothing; Confirm adds only the explicit directed label', async () => {
    const { host } = await populated();
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Connect').click();
    expect(document.querySelector('input')).toBeNull();
    expect(document.body.textContent).not.toContain('comment: A quiet thought');
    expect(button('Confirm').disabled).toBe(true);
    button('comment: A second thought').click();
    button('Cancel').click();
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([]);
    button('Connect').click();
    button('comment: A second thought').click();
    button('Add label').click();
    const field = document.querySelector('input')!;
    field.value = 'Contrasts with';
    field.dispatchEvent(new Event('input'));
    button('Confirm').click();
    await settle();
    const saved = await host.store.read('Notebook.md');
    expect(saved.records[0].connections).toEqual([
      { target: { path: 'Notebook.md', blockId: 'comment-two' }, label: 'Contrasts with' },
    ]);
    expect(saved.records[1].connections).toEqual([]);
    button('Back').click();
    await settle();
    button('Comment — A second thought').click();
    expect(document.body.textContent).toContain('Connected from: A quiet thought');
  });
  it('uncertain native readback exposes Possibly saved and prevents blind retry while navigation remains available', async () => {
    const { host, vault } = await populated();
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Edit comment').click();
    document.querySelector('textarea')!.value = 'Possibly durable thought';
    const originalRead = vault.read.bind(vault);
    const originalProcess = vault.process.bind(vault);
    let settled = false;
    vault.process = async (file, update) => {
      const result = await originalProcess(file, update);
      settled = true;
      return result;
    };
    vault.read = async (file) => {
      if (settled) throw new Error('Readback unavailable');
      return originalRead(file);
    };
    button('Save').click();
    await settle();
    expect(document.body.textContent).toContain('Possibly saved');
    expect(button('Save').disabled).toBe(true);
    button('Cancel').click();
    expect(button('Back').disabled).toBe(false);
    vault.read = originalRead;
    expect((await host.store.read('Notebook.md')).records[0].body).toBe('Possibly durable thought');
  });
  it('provider cancellation preserves an already-created structured note without manufacturing a connection or offering duplicate creation', async () => {
    const { host, vault } = await populated();
    host.createStructuredNote = async (origin) => {
      await vault.create(
        'Typed idea.md',
        `---\nfileClass: Idea\norigin: "[[${origin.path}#^${origin.blockId}]]"\n---\n`,
      );
      return { status: 'cancelled', target: { path: 'Typed idea.md' } };
    };
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Create structured note').click();
    await settle();
    expect(document.body.textContent).toContain('Cancelled');
    expect(vault.file('Typed idea.md')).toBeDefined();
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([]);
    expect(button('Create structured note').disabled).toBe(true);
    button('Open created note').click();
    expect(host.openNative).toHaveBeenCalledWith({ path: 'Typed idea.md' });
  });
  it('overlapping exploration lenses include unassigned entries and preserve original records through membership reorder/removal', async () => {
    const { host, vault } = await populated();
    const originalNotebook = (await host.store.read('Notebook.md')).raw;
    await vault.create(
      'Question.md',
      '---\nfileClass: Exploration\nunknown: keep-me\n---\n\nOpening prose.\n\n- [[Notebook.md#^comment-one]]\n\nBetween prose.\n\n- [[Notebook.md#^comment-two]]\n\nClosing prose.\n',
    );
    await vault.create(
      'Other.md',
      '---\nfileClass: Exploration\n---\n\n- [[Notebook.md#^comment-one]]\n',
    );
    host.explorationPaths = () => ['Question.md', 'Other.md'];
    openThinkingBrowser({} as App, host);
    await settle();
    button('Overview').click();
    await settle();
    const lens = document.querySelector('select')!;
    lens.value = 'Other.md';
    lens.dispatchEvent(new Event('change'));
    await settle();
    expect(document.body.textContent).toContain('Comment — A quiet thought');
    expect(document.body.textContent).not.toContain('Comment — A second thought');
    expect(document.body.textContent).toContain('2026-11-15');
    button('Question.md').click();
    button('Move down').click();
    await settle();
    expect(
      (await host.store.read('Question.md')).memberships.map((member) => member.target.blockId),
    ).toEqual(['comment-two', 'comment-one']);
    button('Remove inclusion').click();
    await settle();
    const exploration = await host.store.read('Question.md');
    expect(exploration.memberships.map((member) => member.target.blockId)).toEqual(['comment-one']);
    expect(exploration.raw).toContain('Opening prose.');
    expect(exploration.raw).toContain('Between prose.');
    expect(exploration.raw).toContain('Closing prose.');
    expect(exploration.raw).toContain('unknown: keep-me');
    expect((await host.store.read('Notebook.md')).raw).toBe(originalNotebook);
    expect((await host.store.read('Other.md')).memberships).toHaveLength(1);
  });
  it('search finds never-opened source text and Back preserves the query without asserting connections', async () => {
    const { host, vault } = await populated();
    await vault.create(
      'Unread.md',
      '---\ntype: article\ntitle: Unread source\n---\nA literal capybara in an unread source.\n',
    );
    host.sources = () => [{ path: 'Unread.md', title: 'Unread source' }];
    openThinkingBrowser({} as App, host);
    await settle();
    expect(button('Unread source')).toBeDefined();
    button('Search').click();
    const search = document.querySelector('input')!;
    search.value = 'capybara';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(document.body.textContent).toContain('Literal text');
    expect(document.body.textContent).toContain('capybara');
    button('Unread.md').click();
    button('Back').click();
    await settle();
    expect(document.querySelector('input')?.value).toBe('capybara');
    button('Unread.md').click();
    button('Open source').click();
    expect(host.openSource).toHaveBeenCalledWith({ path: 'Unread.md' });
    expect(document.querySelector('.reader-thinking-browser')).toBeNull();
    expect(
      (await host.store.read('Notebook.md')).records.every(
        (record) => record.connections.length === 0,
      ),
    ).toBe(true);
  });
  it('creates an explicitly typed note with notebook-block origin and one owned connection without source writes', async () => {
    const { host, vault } = await populated();
    await vault.create('Source.md', '---\ntype: article\n---\nNo source anchor here.\n');
    const source = await host.store.read('Source.md');
    host.createStructuredNote = async (origin) => {
      await vault.create(
        'Typed.md',
        `---\nfileClass: Idea\norigin: "[[${origin.path}#^${origin.blockId}]]"\n---\n`,
      );
      return { status: 'saved', target: { path: 'Typed.md' } };
    };
    host.canConnectStructuredNote = () => !!vault.file('Typed.md');
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Create structured note').click();
    await settle();
    expect(document.body.textContent).toContain(
      'Saved structured note and explicit connection locally',
    );
    expect((await host.store.read('Typed.md')).raw).toContain(
      'origin: "[[Notebook.md#^comment-one]]"',
    );
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([
      { target: { path: 'Typed.md' } },
    ]);
    expect((await host.store.read('Source.md')).raw).toBe(source.raw);
  });
  it('navigation during an uncooperative Fileclass create prevents stale completion from connecting or painting another screen', async () => {
    const { host, vault } = await populated();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    host.createStructuredNote = async () => {
      await gate;
      await vault.create('Slow typed.md', '---\nfileClass: Idea\n---\n');
      return { status: 'saved', target: { path: 'Slow typed.md' } };
    };
    host.canConnectStructuredNote = () => true;
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Create structured note').click();
    button('Back').click();
    await settle();
    resolve();
    await settle();
    expect(button('Comment — A second thought')).toBeDefined();
    expect(document.body.textContent).not.toContain('Saved structured note');
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([]);
    expect(vault.file('Slow typed.md')).toBeDefined();
  });
  it('rechecks provider authority after typed creation and preserves an unlinked note when Fileclass reloads', async () => {
    const { host, vault } = await populated();
    host.createStructuredNote = async () => {
      await vault.create('Created.md', '---\nfileClass: Idea\n---\n');
      return { status: 'saved', target: { path: 'Created.md' } };
    };
    let current = true;
    host.canConnectStructuredNote = () => {
      const wasCurrent = current;
      current = false;
      return wasCurrent;
    };
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Create structured note').click();
    await settle();
    expect(document.body.textContent).toContain('Structured note saved; connection incomplete');
    expect(vault.file('Created.md')).toBeDefined();
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([]);
  });
  it('Unassigned overview includes free comments without inventing a date for undated sources', async () => {
    const { host, vault } = await populated();
    await vault.create(
      'Lens.md',
      '---\nfileClass: Exploration\n---\n- [[Notebook.md#^comment-one]]\n',
    );
    host.explorationPaths = () => ['Lens.md'];
    host.sources = () => [{ path: 'Undated.md', title: 'Undated source' }];
    openThinkingBrowser({} as App, host);
    await settle();
    button('Overview').click();
    await settle();
    const lens = document.querySelector('select')!;
    lens.value = 'unassigned';
    lens.dispatchEvent(new Event('change'));
    await settle();
    expect(document.body.textContent).toContain('Comment — A second thought');
    expect(document.body.textContent).not.toContain('Comment — A quiet thought');
    expect(document.body.textContent).toContain('Undated source');
    expect(document.body.textContent).toContain('Undated');
  });
  it('read-only duplicate anchors remain readable and cannot be selected as connection endpoints', async () => {
    const { host, vault } = await populated();
    const notebook = await host.store.read('Notebook.md');
    vault.bytes.set(notebook.file, notebook.raw + '\n' + notebook.records[1].raw);
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    button('Connect').click();
    expect(button('comment: A second thought').disabled).toBe(true);
    expect(document.body.textContent).toContain('Read-only or unresolved');
    button('Cancel').click();
    button('Back').click();
    await settle();
    button('Comment — A second thought').click();
    expect(document.querySelector('.reader-thinking-body')?.textContent).toContain(
      'A second thought',
    );
    expect(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Edit comment',
      ),
    ).toBe(false);
  });
  it('unresolved direct entry has a native escape and runtime abort closes without painting late reads', async () => {
    const { host, lifetime, vault } = await populated();
    openThinkingBrowser({} as App, host, { path: 'Notebook.md', blockId: 'removed-anchor' });
    await settle();
    expect(document.body.textContent).toContain('Unresolved saved entry');
    expect(button('Open Markdown')).toBeDefined();
    lifetime.abort();
    expect(document.querySelector('.reader-thinking-browser')).toBeNull();
    expect(await vault.read(vault.file('Notebook.md')!)).toContain('A quiet thought');
  });
  it('the capture caller entry adds the original block once and exposes existing membership without a second copy', async () => {
    const { host, vault } = await populated();
    await vault.create(
      'Explore.md',
      '---\nfileClass: Exploration\n---\n\nProtected exploration prose.\n',
    );
    host.explorationPaths = () => ['Explore.md'];
    const notebook = (await host.store.read('Notebook.md')).raw;
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-one' });
    await settle();
    button('Add: Explore.md').click();
    await settle();
    expect(document.body.textContent).toContain('Saved locally');
    expect(button('Included: Explore.md').disabled).toBe(true);
    expect(
      (await host.store.read('Explore.md')).memberships.map((member) => member.target),
    ).toEqual([{ path: 'Notebook.md', blockId: 'comment-one' }]);
    expect((await host.store.read('Notebook.md')).raw).toBe(notebook);
    button('Cancel').click();
    expect(document.querySelector('.reader-thinking-browser')).toBeNull();
  });
  it('exploration prose edits preserve provider fields and native memberships, while Cancel discards only the draft', async () => {
    const { host, vault } = await populated();
    await vault.create(
      'Explore.md',
      '---\nfileClass: Exploration\nunknown: unchanged\n---\n\nOriginal prose.\n\n- [[Notebook.md#^comment-one]]\n',
    );
    host.explorationPaths = () => ['Explore.md'];
    openThinkingBrowser({} as App, host);
    await settle();
    button('Explore.md').click();
    button('Edit prose').click();
    document.querySelector('textarea')!.value = 'Discard me';
    button('Cancel').click();
    expect((await host.store.read('Explore.md')).raw).toContain('Original prose.');
    button('Edit prose').click();
    document.querySelector('textarea')!.value = '\nRewritten **prose**.\n\n';
    button('Save').click();
    await settle();
    const savedDocument = await host.store.read('Explore.md');
    expect(savedDocument.raw).toContain('unknown: unchanged');
    expect(savedDocument.raw).toContain('Rewritten **prose**.');
    expect(savedDocument.memberships[0].target).toEqual({
      path: 'Notebook.md',
      blockId: 'comment-one',
    });
  });
  it('source-retention failure prevents exploration publication and remains visible beside the action', async () => {
    const { host, vault } = fixture();
    await vault.create('Source.md', '---\ntype: article\n---\nPublisher text.\n');
    await vault.create('Explore.md', '---\nfileClass: Exploration\n---\nAuthored prose.\n');
    host.sources = () => [{ path: 'Source.md', title: 'Source' }];
    host.explorationPaths = () => ['Explore.md'];
    addThinkingToExploration({} as App, host, { path: 'Source.md' });
    await settle();
    button('Add: Explore.md').click();
    await settle();
    expect(document.body.textContent).toContain('Not saved');
    expect(document.body.textContent).toContain('retention');
    expect((await host.store.read('Explore.md')).memberships).toEqual([]);
    expect((await host.store.read('Source.md')).raw).toContain('Publisher text.');
  });
  it('unmatched gap comments stay visibly Unplaced with their saved personal writing and explicit source return', async () => {
    const { host, vault } = fixture();
    await vault.create('Source.md', '---\ntype: article\n---\nChanged text has no saved gap.\n');
    await vault.create(
      'Notebook.md',
      '---\nfileClass: Notebook\n---\n\n> [!note] Comment\n> **Source:** [[Source.md]]\n>\n> **Collected:** [[2026-11-15]]\n>\n> **Before:** Old paragraph end\n>\n> **After:** Old next paragraph\n>\n> ---\n>\n> My gap writing.\n>\n> ---\n>\n> #### Connections\n>\n> _None._\n\n^gap-one\n',
    );
    host.notebookPaths = () => ['Notebook.md'];
    host.sourceSnapshot = (path) => new ArticleStore(vault).read(path);
    openThinkingBrowser({} as App, host, { path: 'Notebook.md', blockId: 'gap-one' });
    await settle();
    expect(document.body.textContent).toContain('Unplaced comment');
    expect(document.body.textContent).toContain('My gap writing.');
    button('Back to source').click();
    expect(host.openSource).toHaveBeenCalledWith(
      { path: 'Source.md' },
      expect.objectContaining({ body: 'My gap writing.' }),
    );
    expect(document.querySelector('.reader-thinking-browser')).toBeNull();
  });
  it('bounds initial list DOM and exposes further saved material explicitly instead of scanning sources', async () => {
    const { host } = fixture();
    host.sources = () =>
      Array.from({ length: 120 }, (_, index) => ({
        path: `Source-${index}.md`,
        title: `Source ${index}`,
      }));
    openThinkingBrowser({} as App, host);
    await settle();
    expect(document.querySelectorAll('.reader-thinking-item')).toHaveLength(100);
    expect(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Source 119',
      ),
    ).toBe(false);
    button('Show more saved material').click();
    await settle();
    expect(button('Source 119')).toBeDefined();
  });
  it('new exploration creation includes the original item immediately before metadata discovery catches up', async () => {
    const { host, vault } = await populated();
    host.createExploration = async () => {
      await vault.create(
        'New exploration.md',
        '---\nfileClass: Exploration\n---\n\nNew authored container.\n',
      );
      return { status: 'saved', target: { path: 'New exploration.md' } };
    };
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-one' });
    await settle();
    button('Create exploration').click();
    await settle();
    expect(button('Included: New exploration.md').disabled).toBe(true);
    expect((await host.store.read('New exploration.md')).memberships[0].target).toEqual({
      path: 'Notebook.md',
      blockId: 'comment-one',
    });
  });
  it('native shortest-path About links and relative incoming connections reveal the same saved original', async () => {
    class NativeVault extends MemoryVault {
      resolveLink(link: string, source: string) {
        if (source === 'Other/Reply.md' && link === '../Notes/Notebook')
          return this.file('Notes/Notebook.md');
        if (source === 'Notes/Notebook.md' && link === 'Notebook')
          return this.file('Notes/Notebook.md');
        return this.file(link) ?? this.file(`${link}.md`);
      }
    }
    const { host, vault } = fixture(new NativeVault());
    const attached = freeComment('attached-one', 'My attached response').replace(
      '> **Collected:**',
      '> **About:** [[Notebook#^comment-one]]\n>\n> **Collected:**',
    );
    await vault.create(
      'Notes/Notebook.md',
      `---\nfileClass: Notebook\n---\n${freeComment('comment-one', 'A quiet thought')}\n${attached}`,
    );
    await vault.create(
      'Other/Reply.md',
      `---\nfileClass: Notebook\n---\n${freeComment('reply-one', 'A related response')}`,
    );
    host.notebookPaths = () => ['Notes/Notebook.md', 'Other/Reply.md'];
    const reply = (await host.store.read('Other/Reply.md')).records[0];
    expect(
      (
        await host.store.connect({
          record: reply,
          target: { path: '../Notes/Notebook', blockId: 'comment-one' },
        })
      ).status,
    ).toBe('saved');
    openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    expect(document.body.textContent).toContain('Connected from: A related response');
    expect(document.body.textContent).toContain('Comment: My attached response');
    button('Comment: My attached response').click();
    button('About: Notebook#^comment-one').click();
    expect(document.body.textContent).toContain('Connected from: A related response');
  });
  it('relative exploration references display Included in both inclusion pickers and overlapping overview', async () => {
    class NativeVault extends MemoryVault {
      resolveLink(link: string, source: string) {
        if (source === 'Explorations/Question.md' && link === '../Notes/Notebook')
          return this.file('Notes/Notebook.md');
        return this.file(link) ?? this.file(`${link}.md`);
      }
    }
    const { host, vault } = fixture(new NativeVault());
    await vault.create(
      'Notes/Notebook.md',
      `---\nfileClass: Notebook\n---\n${freeComment('comment-one', 'A quiet thought')}`,
    );
    await vault.create(
      'Explorations/Question.md',
      '---\nfileClass: Exploration\n---\n- [[../Notes/Notebook#^comment-one]]\n',
    );
    host.notebookPaths = () => ['Notes/Notebook.md'];
    host.explorationPaths = () => ['Explorations/Question.md'];
    const browser = addThinkingToExploration({} as App, host, {
      path: 'Notes/Notebook.md',
      blockId: 'comment-one',
    });
    await settle();
    expect(button('Included: Explorations/Question.md').disabled).toBe(true);
    browser.close();
    openThinkingBrowser({} as App, host);
    await settle();
    button('Explorations/Question.md').click();
    button('Add saved material').click();
    expect(button('Included: Notes/Notebook.md#^comment-one').disabled).toBe(true);
    button('Cancel').click();
    button('Back').click();
    await settle();
    button('Overview').click();
    await settle();
    const lens = document.querySelector('select')!;
    lens.value = 'Explorations/Question.md';
    lens.dispatchEvent(new Event('change'));
    await settle();
    expect(button('Comment — A quiet thought')).toBeDefined();
    expect((await host.store.read('Explorations/Question.md')).memberships).toHaveLength(1);
  });
  it('an authoritative unresolved native reference never falls back to an existing same-path file', async () => {
    class NativeVault extends MemoryVault {
      resolveLink(link: string, source: string) {
        if (source === 'Other/Reply.md' || source === 'Explorations/Question.md') return undefined;
        return this.file(link) ?? this.file(`${link}.md`);
      }
    }
    const { host, vault } = fixture(new NativeVault());
    await vault.create(
      'Notes/Notebook.md',
      `---\nfileClass: Notebook\n---\n${freeComment('comment-one', 'A quiet thought')}`,
    );
    const response = freeComment('reply-one', 'An unresolved response').replace(
      '> _None._',
      '> - [[Notes/Notebook.md#^comment-one]]',
    );
    await vault.create('Other/Reply.md', `---\nfileClass: Notebook\n---\n${response}`);
    await vault.create(
      'Explorations/Question.md',
      '---\nfileClass: Exploration\n---\n- [[Notes/Notebook.md#^comment-one]]\n',
    );
    host.notebookPaths = () => ['Notes/Notebook.md', 'Other/Reply.md'];
    host.explorationPaths = () => ['Explorations/Question.md'];
    const browser = openThinkingBrowser({} as App, host);
    await settle();
    button('Comment — A quiet thought').click();
    expect(document.body.textContent).not.toContain('Connected from: An unresolved response');
    browser.close();
    addThinkingToExploration({} as App, host, {
      path: 'Notes/Notebook.md',
      blockId: 'comment-one',
    });
    await settle();
    expect(button('Add: Explorations/Question.md').disabled).toBe(false);
    expect((await host.store.read('Other/Reply.md')).records[0].connections[0].target).toEqual({
      path: 'Notes/Notebook.md',
      blockId: 'comment-one',
    });
  });
  it('exploration prose search opens its writing and membership controls and Back retains the search', async () => {
    const { host, vault } = await populated();
    await vault.create(
      'Explore.md',
      '---\nfileClass: Exploration\n---\n\nZephyr open questions.\n\n- [[Notebook.md#^comment-one]]\n',
    );
    host.explorationPaths = () => ['Explore.md'];
    openThinkingBrowser({} as App, host);
    await settle();
    button('Search').click();
    const field = document.querySelector('input')!;
    field.value = 'Zephyr';
    field.dispatchEvent(new Event('input'));
    await settle();
    resultButton('Explore.md').click();
    expect(document.querySelector('.reader-thinking-body')?.textContent).toContain(
      'Zephyr open questions.',
    );
    expect(button('Edit prose')).toBeDefined();
    expect(button('Remove inclusion')).toBeDefined();
    expect(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Open source',
      ),
    ).toBe(false);
    button('Back').click();
    await settle();
    expect(document.querySelector('input')?.value).toBe('Zephyr');
    resultButton('Explore.md').click();
    button('Open exploration Markdown').click();
    expect(host.openNative).toHaveBeenCalledWith({ path: 'Explore.md' });
    expect(host.openSource).not.toHaveBeenCalled();
    expect(document.querySelector('.reader-thinking-browser')).toBeNull();
  });
  it('ordinary notebook prose search opens a readable notebook with native escape, never an article route', async () => {
    const { host, vault } = fixture();
    await vault.create(
      'Notebook.md',
      '---\nfileClass: Notebook\n---\n\nOsprey personal questions.\n',
    );
    host.notebookPaths = () => ['Notebook.md'];
    openThinkingBrowser({} as App, host);
    await settle();
    button('Search').click();
    const field = document.querySelector('input')!;
    field.value = 'Osprey';
    field.dispatchEvent(new Event('input'));
    await settle();
    resultButton('Notebook.md').click();
    expect(document.querySelector('.reader-thinking-body')?.textContent).toContain(
      'Osprey personal questions.',
    );
    expect(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Open source',
      ),
    ).toBe(false);
    button('Back').click();
    await settle();
    expect(document.querySelector('input')?.value).toBe('Osprey');
    resultButton('Notebook.md').click();
    button('Open notebook Markdown').click();
    expect(host.openNative).toHaveBeenCalledWith({ path: 'Notebook.md' });
    expect(host.openSource).not.toHaveBeenCalled();
  });
  it('the quiet exploration picker search filters actual choices and only explicit Add writes membership, never an entry edge', async () => {
    const { host, vault } = await populated();
    for (const path of ['Alpha.md', 'Beta.md'])
      await vault.create(path, '---\nfileClass: Exploration\n---\nAuthored exploration prose.\n');
    host.explorationPaths = () => ['Alpha.md', 'Beta.md'];
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-one' });
    await settle();
    expect(document.querySelector('input')).toBeNull();
    button('Search').click();
    const field = document.querySelector('input')!;
    expect(field.getAttribute('aria-label')).toBe('Search explorations');
    field.value = 'Beta';
    field.dispatchEvent(new Event('input'));
    await settle();
    expect(button('Add: Beta.md')).toBeDefined();
    expect(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Add: Alpha.md',
      ),
    ).toBe(false);
    expect((await host.store.read('Beta.md')).memberships).toEqual([]);
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([]);
    button('Add: Beta.md').click();
    await settle();
    expect(button('Included: Beta.md').disabled).toBe(true);
    expect(document.querySelector('input')?.value).toBe('Beta');
    expect((await host.store.read('Beta.md')).memberships[0].target).toEqual({
      path: 'Notebook.md',
      blockId: 'comment-one',
    });
    expect((await host.store.read('Notebook.md')).records[0].connections).toEqual([]);
  });
  it('recent exploration choices are explicit, bounded-session ordering for the same store, not persistent activity', async () => {
    const { host, vault } = await populated();
    for (const path of ['Alpha.md', 'Zulu.md'])
      await vault.create(path, '---\nfileClass: Exploration\n---\nOriginal prose.\n');
    host.explorationPaths = () => ['Alpha.md', 'Zulu.md'];
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-one' });
    await settle();
    button('Add: Zulu.md').click();
    await settle();
    button('Cancel').click();
    const second = addThinkingToExploration({} as App, host, {
      path: 'Notebook.md',
      blockId: 'comment-two',
    });
    await settle();
    expect(document.body.textContent).toContain('Recent explicit choices (this session only)');
    expect(
      [...document.querySelectorAll('button')]
        .filter((button) => button.textContent?.startsWith('Add:'))
        .map((button) => button.textContent),
    ).toEqual(['Add: Zulu.md', 'Add: Alpha.md']);
    second.close();
    host.store = new ThinkingStore(vault);
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-two' });
    await settle();
    expect(document.body.textContent).not.toContain('Recent explicit choices (this session only)');
    expect(
      [...document.querySelectorAll('button')]
        .filter((button) => button.textContent?.startsWith('Add:'))
        .map((button) => button.textContent),
    ).toEqual(['Add: Alpha.md', 'Add: Zulu.md']);
    expect((await host.store.read('Alpha.md')).raw).toBe(
      '---\nfileClass: Exploration\n---\nOriginal prose.\n',
    );
    expect((await host.store.read('Zulu.md')).memberships).toHaveLength(1);
  });
  it('picker search stays separate from saved-material search and Cancel restores the same item/list query', async () => {
    const { host, vault } = await populated();
    for (const path of ['Alpha.md', 'Beta.md'])
      await vault.create(path, '---\nfileClass: Exploration\n---\n');
    host.explorationPaths = () => ['Alpha.md', 'Beta.md'];
    openThinkingBrowser({} as App, host);
    await settle();
    button('Search').click();
    let field = document.querySelector('input')!;
    field.value = 'quiet';
    field.dispatchEvent(new Event('input'));
    await settle();
    resultButton('Comment — A quiet thought').click();
    button('Add to exploration').click();
    expect(document.querySelector('input')).toBeNull();
    button('Search').click();
    field = document.querySelector('input')!;
    expect(field.getAttribute('aria-label')).toBe('Search explorations');
    field.value = 'Beta';
    field.dispatchEvent(new Event('input'));
    await settle();
    expect(button('Add: Beta.md')).toBeDefined();
    button('Cancel').click();
    await settle();
    expect(button('Edit comment')).toBeDefined();
    button('Back').click();
    await settle();
    expect(document.querySelector('input')?.value).toBe('quiet');
    expect(resultButton('Comment — A quiet thought')).toBeDefined();
    expect((await host.store.read('Beta.md')).memberships).toEqual([]);
  });
  it('only the eight most recent explicit exploration choices are labelled recent', async () => {
    const { host, vault } = await populated();
    const paths = Array.from({ length: 10 }, (_, index) => `Explore-${index}.md`);
    for (const path of paths) await vault.create(path, '---\nfileClass: Exploration\n---\n');
    host.explorationPaths = () => paths;
    const first = addThinkingToExploration({} as App, host, {
      path: 'Notebook.md',
      blockId: 'comment-one',
    });
    await settle();
    for (const path of paths) {
      button(`Add: ${path}`).click();
      await settle();
    }
    first.close();
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-two' });
    await settle();
    expect(
      [...document.querySelectorAll('button')]
        .filter((button) => button.textContent?.startsWith('Add:'))
        .map((button) => button.textContent),
    ).toEqual([
      'Add: Explore-9.md',
      'Add: Explore-8.md',
      'Add: Explore-7.md',
      'Add: Explore-6.md',
      'Add: Explore-5.md',
      'Add: Explore-4.md',
      'Add: Explore-3.md',
      'Add: Explore-2.md',
      'Add: Explore-0.md',
      'Add: Explore-1.md',
    ]);
    expect(document.body.textContent).toContain('Other explorations');
  });
  it('picker search shortlists beyond the read budget and verified recent choices stay visible on reopen', async () => {
    const { host, vault } = await populated();
    const paths = Array.from({ length: 101 }, (_, index) => `Exploration-${index}.md`);
    for (const path of paths) await vault.create(path, '---\nfileClass: Exploration\n---\n');
    host.explorationPaths = () => paths;
    const first = addThinkingToExploration({} as App, host, {
      path: 'Notebook.md',
      blockId: 'comment-one',
    });
    await settle();
    button('Search').click();
    const field = document.querySelector('input')!;
    field.value = 'Exploration-100';
    field.dispatchEvent(new Event('input'));
    await settle();
    button('Add: Exploration-100.md').click();
    await settle();
    first.close();
    addThinkingToExploration({} as App, host, { path: 'Notebook.md', blockId: 'comment-two' });
    await settle();
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain('Loading saved material'),
    );
    expect(button('Add: Exploration-100.md')).toBeDefined();
    expect(document.body.textContent).toContain('Recent explicit choices (this session only)');
  });
  it('a superseded search cannot paint old literal evidence after the new query settles', async () => {
    const { host, vault } = fixture();
    await vault.create('Source.md', '---\ntype: article\n---\nOnly capybara appears.\n');
    host.sources = () => [{ path: 'Source.md', title: 'Source' }];
    openThinkingBrowser({} as App, host);
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vault.read.bind(vault);
    let first = true;
    let occupied = 0;
    let peak = 0;
    vault.read = async (file) => {
      occupied++;
      peak = Math.max(peak, occupied);
      try {
        if (first) {
          first = false;
          await gate;
        }
        return await read(file);
      } finally {
        occupied--;
      }
    };
    button('Search').click();
    const search = document.querySelector('input')!;
    search.value = 'capybara';
    search.dispatchEvent(new Event('input'));
    await settle();
    search.value = 'zebra';
    search.dispatchEvent(new Event('input'));
    await settle();
    expect(peak).toBe(1);
    release();
    await settle();
    expect(document.body.textContent).toContain('No matching saved material');
    expect(document.body.textContent).not.toContain('Only capybara');
    expect(document.querySelector('input')?.value).toBe('zebra');
  });
});

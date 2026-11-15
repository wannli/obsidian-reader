import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { openThinkingBrowser, type ThinkingBrowserHost } from '../src/host/thinking-browser';
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
function fixture() {
  const vault = new MemoryVault();
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
});

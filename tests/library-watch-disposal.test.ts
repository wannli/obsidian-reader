import { expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';
import { createDocument, readDocument } from '../src/core/document';

vi.mock('obsidian', () => ({ MarkdownView: class {}, TFile: class {}, TFolder: class {} }));
import { watchLibrary } from '../src/host/vault';

type Ref = { name: string; callback: (...args: any[]) => void };
function emitter() {
  const refs = new Set<Ref>();
  return {
    refs,
    on(name: string, callback: Ref['callback']) {
      const ref = { name, callback };
      refs.add(ref);
      return ref;
    },
    offref(ref: Ref) {
      refs.delete(ref);
    },
    emit(name: string, ...args: unknown[]) {
      for (const ref of refs) if (ref.name === name) ref.callback(...args);
    },
  };
}

it('keeps emitter and plugin-owned reference counts bounded across generation replacements', () => {
  const metadata = emitter(),
    vault = emitter(),
    workspace = emitter();
  const ownedEvents = new Set<unknown>(),
    ownedCleanup = new Set<unknown>();
  const app = {
    metadataCache: { ...metadata, getFileCache: vi.fn() },
    vault: { ...vault, getMarkdownFiles: () => [] },
    workspace: { ...workspace, onLayoutReady: (callback: () => void) => callback() },
  } as unknown as App;
  // Model real Plugin ownership: registerEvent/register retain their argument until unload.
  const plugin = {
    app,
    registerEvent: vi.fn((ref: unknown) => ownedEvents.add(ref)),
    register: vi.fn((cleanup: unknown) => ownedCleanup.add(cleanup)),
  };
  let stop = () => {};
  for (let generation = 0; generation < 25; generation++) {
    stop();
    expect(metadata.refs.size + vault.refs.size + workspace.refs.size).toBe(0);
    expect(ownedEvents.size + ownedCleanup.size).toBe(0);
    const store = new ArticleStore(new MemoryVault()) as unknown as ArticleStore<TFile>;
    const changed = vi.fn();
    stop = watchLibrary(plugin, store, changed);
    expect(metadata.refs.size).toBe(1);
    expect(vault.refs.size).toBe(3);
    expect(workspace.refs.size).toBe(2);
    expect(ownedEvents.size + ownedCleanup.size).toBe(0);
    const ref = [...metadata.refs][0];
    const file = { path: `Reading/Articles/${generation}.md`, extension: 'md' };
    const cache = { frontmatter: { type: 'article' } };
    metadata.emit('changed', file, 'Body', cache);
    expect(changed).toHaveBeenCalledOnce();
    expect(store.catalog.article(file.path)).toBeDefined();
    stop();
    // Even a callback already captured by the host cannot revive the retired store.
    ref.callback({ ...file, path: `${file.path}-late.md` }, 'Body', cache);
    expect(changed).toHaveBeenCalledOnce();
    expect(store.catalog.size).toBe(1);
  }
  stop();
  expect(metadata.refs.size + vault.refs.size + workspace.refs.size).toBe(0);
  expect(ownedEvents.size + ownedCleanup.size).toBe(0);
  expect(plugin.registerEvent).not.toHaveBeenCalled();
  expect(plugin.register).not.toHaveBeenCalled();
});

it('places a live native Inbox capture but never touches template articles', async () => {
  const memory = new MemoryVault();
  const store = new ArticleStore(memory);
  const metadata = emitter(),
    vault = emitter(),
    workspace = emitter();
  const caches = new Map<unknown, unknown>();
  const app = {
    metadataCache: { ...metadata, getFileCache: (file: unknown) => caches.get(file) },
    vault: { ...vault, getMarkdownFiles: () => [] },
    workspace: { ...workspace, onLayoutReady: (callback: () => void) => callback() },
  } as unknown as App;
  const stop = watchLibrary({ app } as any, store as unknown as ArticleStore<TFile>, vi.fn());
  for (const path of ['Elsewhere/QuickAdd.md', 'Templates/QuickAdd.md']) {
    const raw = createDocument({ type: 'article', status: 'inbox' }, 'Native text');
    const file = Object.assign(await memory.create(path, raw), {
      extension: 'md',
      stat: { ctime: Date.now() },
    });
    Object.setPrototypeOf(file, (await import('obsidian')).TFile.prototype);
    caches.set(file, { frontmatter: readDocument(raw).properties });
    vault.emit('create', file);
    metadata.emit('changed', file, raw, caches.get(file));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if (path.startsWith('Templates/')) {
      expect(file.path).toBe(path);
      expect(await memory.read(file)).toBe(raw);
      expect(store.catalog.article(path)).toBeUndefined();
    } else {
      expect(file.path).toBe('Reading/Inbox/QuickAdd.md');
      expect(readDocument(await memory.read(file)).properties.status).toBe('inbox');
    }
  }
  stop();
});

it('updates YAML metadata without moving a note on an external status edit', async () => {
  const memory = new MemoryVault();
  const store = new ArticleStore(memory);
  const raw = createDocument({ type: 'article', status: 'inbox' }, 'Text');
  const file = Object.assign(await memory.create('Reading/Inbox/Article.md', raw), {
    extension: 'md',
  });
  const metadata = emitter(),
    vault = emitter(),
    workspace = emitter();
  const app = {
    metadataCache: {
      ...metadata,
      getFileCache: () => ({ frontmatter: readDocument(raw).properties }),
    },
    vault: { ...vault, getMarkdownFiles: () => [file] },
    workspace: { ...workspace, onLayoutReady: (callback: () => void) => callback() },
  } as unknown as App;
  const stop = watchLibrary({ app } as any, store as unknown as ArticleStore<TFile>, vi.fn());
  const updated = createDocument({ type: 'article', status: 'archive' }, 'Text');
  memory.bytes.set(file, updated);
  metadata.emit('changed', file, updated, { frontmatter: readDocument(updated).properties });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(file.path).toBe('Reading/Inbox/Article.md');
  expect(store.catalog.article(file.path)?.queue).toBe('Inbox');
  expect(store.catalog.article(file.path)?.status).toBe('archive');
  stop();
});

it('does not organize an existing startup note whose metadata cache arrives after layout', async () => {
  const memory = new MemoryVault(),
    store = new ArticleStore(memory);
  store.setStatusFolders({ later: 'Mapped' });
  const raw = createDocument({ type: 'article', status: 'later' }, 'Words');
  const file = Object.assign(await memory.create('Existing.md', raw), { extension: 'md' });
  const metadata = emitter(),
    vault = emitter(),
    workspace = emitter();
  const app = {
    metadataCache: { ...metadata, getFileCache: () => undefined },
    vault: { ...vault, getMarkdownFiles: () => [file] },
    workspace: { ...workspace, onLayoutReady: (callback: () => void) => callback() },
  } as unknown as App;
  const stop = watchLibrary({ app } as any, store as unknown as ArticleStore<TFile>, vi.fn());
  const read = vi.spyOn(memory, 'read');
  metadata.emit('changed', file, raw, { frontmatter: readDocument(raw).properties });
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(file.path).toBe('Existing.md');
  expect(read).not.toHaveBeenCalled();
  stop();
});

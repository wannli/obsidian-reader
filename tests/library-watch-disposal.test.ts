import { expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

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
    vault = emitter();
  const ownedEvents = new Set<unknown>(),
    ownedCleanup = new Set<unknown>();
  const app = {
    metadataCache: { ...metadata, getFileCache: vi.fn() },
    vault: { ...vault, getMarkdownFiles: () => [] },
    workspace: { onLayoutReady: (callback: () => void) => callback() },
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
    expect(metadata.refs.size + vault.refs.size).toBe(0);
    expect(ownedEvents.size + ownedCleanup.size).toBe(0);
    const store = new ArticleStore(new MemoryVault()) as unknown as ArticleStore<TFile>;
    const changed = vi.fn();
    stop = watchLibrary(plugin, store, changed);
    expect(metadata.refs.size).toBe(1);
    expect(vault.refs.size).toBe(2);
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
  expect(metadata.refs.size + vault.refs.size).toBe(0);
  expect(ownedEvents.size + ownedCleanup.size).toBe(0);
  expect(plugin.registerEvent).not.toHaveBeenCalled();
  expect(plugin.register).not.toHaveBeenCalled();
});

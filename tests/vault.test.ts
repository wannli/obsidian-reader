// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  MarkdownView,
  TFile,
  TFolder,
  type App,
  type Editor,
  type Plugin,
  type TAbstractFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { ArticleStore } from '../src/core/store';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import type { Properties } from '../src/core/model';
import { Ingestion } from '../src/host/ingestion';
import { ObsidianVault, watchLibrary, type LibraryChange } from '../src/host/vault';

vi.mock('obsidian', () => {
  class TFile {
    path = '';
    name = '';
  }
  class TFolder {
    path = '';
    name = '';
    children: unknown[] = [];
  }
  class MarkdownView {
    file?: TFile;
    editor?: unknown;
    mode = 'preview';
    getMode() {
      return this.mode;
    }
  }
  return { TFile, TFolder, MarkdownView };
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const SOURCE = 'Reading/Inbox/Story.md',
  TARGET = 'Reading/Later/Story.md',
  RAW = 'Original article.\n';
function fixture() {
  const root = new TFolder(),
    files = new Map<string, TAbstractFile>([['', root]]),
    bytes = new Map<TFile, string>();
  const views: MarkdownView[] = [];
  let active = true;
  const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  function folder(path: string): TFolder {
    const existing = files.get(path);
    if (existing instanceof TFolder) return existing;
    const parent = folder(parentPath(path));
    const result = Object.assign(new TFolder(), {
      path,
      name: path.split('/').pop()!,
      children: [],
      parent,
    });
    files.set(path, result);
    parent.children.push(result);
    return result;
  }
  function note(path = SOURCE, raw = RAW): TFile {
    const parent = folder(parentPath(path));
    const file = Object.assign(new TFile(), {
      path,
      name: path.split('/').pop()!,
      extension: 'md',
      parent,
    });
    files.set(path, file);
    parent.children.push(file);
    bytes.set(file, raw);
    return file;
  }
  function remove(file: TFile) {
    files.delete(file.path);
    bytes.delete(file);
    file.parent!.children = file.parent!.children.filter((child) => child !== file);
  }
  const hooks: {
    folder?: (path: string) => Promise<void>;
    process?: () => Promise<void>;
    read?: () => Promise<void>;
    rename?: () => Promise<void>;
  } = {};
  const vault = {
    getRoot: () => root,
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    getMarkdownFiles: vi.fn(() => {
      throw new Error('No vault enumeration');
    }),
    getAllLoadedFiles: vi.fn(() => {
      throw new Error('No vault enumeration');
    }),
    read: vi.fn(async (file: TFile) => {
      await hooks.read?.();
      if (files.get(file.path) !== file) throw new Error('Missing file');
      return bytes.get(file)!;
    }),
    createFolder: vi.fn(async (path: string) => {
      await hooks.folder?.(path);
      if (files.has(path)) throw new Error('Folder appeared');
      return folder(path);
    }),
    create: vi.fn(async (path: string, raw: string) => {
      if (files.has(path)) throw new Error('File exists');
      return note(path, raw);
    }),
    process: vi.fn(async (file: TFile, update: (raw: string) => string) => {
      await hooks.process?.();
      // The adapter must reject replacement identity inside this callback.
      const current = bytes.get(files.get(file.path) as TFile)!;
      const next = update(current);
      bytes.set(file, next);
      return next;
    }),
    trash: vi.fn(async (file: TFile, _system: boolean) => {
      remove(file);
    }),
    delete: vi.fn(() => {
      throw new Error('Permanent deletion is forbidden');
    }),
  };
  const fileManager = {
    renameFile: vi.fn(async (file: TFile, path: string) => {
      await hooks.rename?.();
      if (files.has(path)) throw new Error('File exists');
      const raw = bytes.get(file)!;
      remove(file);
      file.path = path;
      file.name = path.split('/').pop()!;
      file.parent = folder(parentPath(path));
      file.parent.children.push(file);
      files.set(path, file);
      bytes.set(file, raw);
    }),
    trashFile: vi.fn(() => {
      throw new Error('Deletion preference may be permanent');
    }),
  };
  const app = {
    vault,
    fileManager,
    workspace: {
      iterateAllLeaves: (visit: (leaf: { view: MarkdownView }) => void) =>
        views.forEach((view) => visit({ view })),
    },
  } as unknown as App;
  const adapter = new ObsidianVault(app, () => active);
  function open(file: TFile, value = RAW, mode = 'preview') {
    const buffer = {
      value,
      getValue() {
        return this.value;
      },
    };
    const view = Object.assign(new MarkdownView({} as WorkspaceLeaf), {
      file,
      editor: buffer as unknown as Editor,
      mode,
    });
    views.push(view);
    return { view, buffer };
  }
  return {
    app,
    adapter,
    vault,
    fileManager,
    files,
    bytes,
    hooks,
    note,
    folder,
    remove,
    open,
    stop: () => {
      active = false;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function libraryFixture() {
  const f = fixture(),
    store = new ArticleStore(f.adapter);
  const events = new Map<string, (...args: any[]) => void>();
  const caches = new Map<TFile, { frontmatter: Properties }>();
  const changes: LibraryChange[] = [];
  const on = (name: string, callback: (...args: any[]) => void) => {
    events.set(name, callback);
    return {};
  };
  const getFileCache = vi.fn((file: TFile) => caches.get(file));
  Object.assign(f.vault, { on });
  Object.assign(f.app, { metadataCache: { on, getFileCache } });
  Object.assign(f.app.workspace, { onLayoutReady() {} });
  const stop = watchLibrary(
    { app: f.app, registerEvent() {} } as unknown as Plugin,
    store,
    (change) => changes.push(change),
  );
  const add = (path: string, properties: Properties) => {
    const file = f.note(path, createDocument(properties, 'Publisher text.'));
    caches.set(file, { frontmatter: properties });
    store.catalog.update(path, properties);
    return file;
  };
  const subtree = (path: string) =>
    [...f.files.values()].filter((file) => file.path === path || file.path.startsWith(`${path}/`));
  const renameFolder = (folder: TFolder, path: string, omitChildren = false) => {
    const old = folder.path,
      entries = subtree(old);
    folder.parent!.children = folder.parent!.children.filter((child) => child !== folder);
    const parent = f.folder(path.slice(0, path.lastIndexOf('/')));
    for (const entry of entries) f.files.delete(entry.path);
    for (const entry of entries) {
      entry.path = path + entry.path.slice(old.length);
      entry.name = entry.path.split('/').pop()!;
      f.files.set(entry.path, entry);
    }
    folder.parent = parent;
    parent.children.push(folder);
    if (omitChildren) folder.children = [];
    events.get('rename')!(folder, old);
  };
  const deleteFolder = (folder: TFolder, omitChildren = false) => {
    for (const entry of subtree(folder.path)) {
      f.files.delete(entry.path);
      if (entry instanceof TFile) f.bytes.delete(entry);
    }
    folder.parent!.children = folder.parent!.children.filter((child) => child !== folder);
    if (omitChildren) folder.children = [];
    events.get('delete')!(folder);
  };
  return {
    ...f,
    store,
    caches,
    events,
    changes,
    getFileCache,
    add,
    renameFolder,
    deleteFolder,
    stop,
  };
}
type Operation = 'process' | 'move' | 'trash';
function operate(
  f: Fixture,
  file: TFile,
  operation: Operation,
  update = vi.fn((raw: string) => raw + 'Reader change.'),
) {
  return operation === 'process'
    ? f.adapter.process(file, update)
    : operation === 'move'
      ? f.adapter.move(file, TARGET)
      : f.adapter.trash(file, () => {});
}

describe('final native trash validation', () => {
  it('retains an expired article annotated during the final native read', async () => {
    const f = fixture(),
      store = new ArticleStore(f.adapter);
    const properties = { type: 'article', published: '2026-08-01', url: 'https://example.com/one' };
    const file = f.note(
      'Reading/Stream/260801 Story.md',
      createDocument(properties, 'Publisher text.'),
    );
    store.catalog.update(file.path, properties);
    let reads = 0;
    f.hooks.read = async () => {
      if (++reads === 2)
        f.bytes.set(file, createDocument(properties, 'Publisher ==newly annotated== text.'));
    };
    expect(await store.expire(new Date('2026-10-13'))).toEqual({
      deleted: 0,
      promoted: 0,
      retained: 1,
    });
    expect(reads).toBe(2);
    expect(f.vault.trash).not.toHaveBeenCalled();
    expect(f.bytes.get(file)).toContain('==newly annotated==');
    expect(store.catalog.article(file.path)).toBeDefined();
  });
  it.each(['active reader', 'pending backlink promotion'])(
    'retains expiry when %s appears during the final native read',
    async (reason) => {
      const f = fixture(),
        store = new ArticleStore(f.adapter);
      const properties = { type: 'article', published: '2026-08-01' };
      const file = f.note(
        'Reading/Stream/260801 Story.md',
        createDocument(properties, 'Publisher text.'),
      );
      store.catalog.update(file.path, properties);
      let reads = 0,
        activeFile: TFile | undefined;
      const backlinkPromotions = new Set<string>();
      f.hooks.read = async () => {
        if (++reads === 2) {
          if (reason === 'active reader') activeFile = file;
          else backlinkPromotions.add(file.path);
        }
      };
      expect(
        await store.expire(
          new Date('2026-10-13'),
          (current) => current === activeFile || backlinkPromotions.has(current.path),
        ),
      ).toEqual({ deleted: 0, promoted: 0, retained: 1 });
      expect(reads).toBe(2);
      expect(f.vault.trash).not.toHaveBeenCalled();
    },
  );
  it('checks dirty buffers before invoking the synchronous final validator', async () => {
    const f = fixture(),
      file = f.note(),
      { buffer } = f.open(file),
      validate = vi.fn();
    f.hooks.read = async () => {
      buffer.value += 'Unsaved edit';
    };
    await expect(f.adapter.trash(file, validate)).rejects.toThrow(/Markdown editor/);
    expect(validate).not.toHaveBeenCalled();
    expect(f.vault.trash).not.toHaveBeenCalled();
  });
  it('passes fresh bytes to the validator and dispatches recoverable trash in the same turn', async () => {
    const f = fixture(),
      file = f.note(),
      events: string[] = [];
    const nativeTrash = f.vault.trash.getMockImplementation()!;
    f.vault.trash.mockImplementation(async (file, system) => {
      events.push('trash');
      await nativeTrash(file, system);
    });
    await f.adapter.trash(file, (raw) => {
      expect(raw).toBe(RAW);
      events.push('validate');
      queueMicrotask(() => events.push('next microtask'));
    });
    expect(events).toEqual(['validate', 'trash', 'next microtask']);
    expect(f.vault.trash).toHaveBeenCalledWith(file, false);
  });
  it.each(['authored notes', 'URL', 'identity', 'stop'])(
    'protects unsubscribe against late %s changes',
    async (change) => {
      const f = fixture(),
        store = new ArticleStore(f.adapter),
        ingestion = new Ingestion(store, () => {});
      const properties = { type: 'feed', url: 'https://example.com/feed' };
      const file = f.note('Reading/Feeds/Example.md', createDocument(properties, 'My notes.'));
      store.catalog.update(file.path, properties);
      const feed = store.catalog.feed(file.path)!;
      let reads = 0;
      f.hooks.read = async () => {
        if (++reads !== 2) return;
        if (change === 'authored notes')
          f.bytes.set(file, createDocument(properties, 'New authored notes.'));
        if (change === 'URL')
          f.bytes.set(
            file,
            createDocument({ ...properties, url: 'https://example.com/new' }, 'My notes.'),
          );
        if (change === 'identity') f.note(file.path, f.bytes.get(file)!);
        if (change === 'stop') ingestion.stop();
      };
      await expect(ingestion.unsubscribe(feed)).rejects.toThrow();
      expect(reads).toBe(2);
      expect(f.vault.trash).not.toHaveBeenCalled();
      expect(store.catalog.feed(feed.path)).toBeDefined();
      expect(f.files.has(file.path)).toBe(true);
      ingestion.stop();
    },
  );
  it('unsubscribes an unchanged feed through recoverable trash', async () => {
    const f = fixture(),
      store = new ArticleStore(f.adapter),
      ingestion = new Ingestion(store, () => {});
    const properties = { type: 'feed', url: 'https://example.com/feed' };
    const file = f.note('Reading/Feeds/Example.md', createDocument(properties, ''));
    store.catalog.update(file.path, properties);
    await ingestion.unsubscribe(store.catalog.feed(file.path)!);
    expect(f.vault.trash).toHaveBeenCalledWith(file, false);
    expect(store.catalog.feed(file.path)).toBeUndefined();
    ingestion.stop();
  });
});

// These exercise the real adapter through public API mocks, not MemoryVault.
describe('native editor and write boundaries', () => {
  it.each<Operation>(['process', 'move', 'trash'])(
    'preserves dirty source and preview buffers during %s',
    async (operation) => {
      for (const mode of ['source', 'preview']) {
        const f = fixture(),
          file = f.note(),
          { buffer } = f.open(file, RAW + 'Unsaved typing.', mode),
          update = vi.fn();
        await expect(operate(f, file, operation, update)).rejects.toThrow(/Markdown editor/);
        expect(buffer.value).toBe(RAW + 'Unsaved typing.');
        expect(f.bytes.get(file)).toBe(RAW);
        expect(file.path).toBe(SOURCE);
        expect(update).not.toHaveBeenCalled();
        expect(f.fileManager.renameFile).not.toHaveBeenCalled();
        expect(f.vault.trash).not.toHaveBeenCalled();
      }
    },
  );
  it.each<Operation>(['process', 'move', 'trash'])(
    'permits a single preview only when its buffer matches current bytes: %s',
    async (operation) => {
      const f = fixture(),
        file = f.note();
      f.open(file);
      await operate(f, file, operation);
      if (operation === 'process') expect(f.bytes.get(file)).toBe(RAW + 'Reader change.');
      if (operation === 'move')
        expect(f.fileManager.renameFile).toHaveBeenCalledExactlyOnceWith(file, TARGET);
      if (operation === 'trash') expect(f.vault.trash).toHaveBeenCalledExactlyOnceWith(file, false);
    },
  );
  it.each(['source', 'loading', 'missing editor', 'multiple previews'])(
    'defers unproven editor lifecycles even with clean bytes: %s',
    async (state) => {
      const f = fixture(),
        file = f.note(),
        { view } = f.open(
          file,
          RAW,
          state === 'source' ? 'source' : state === 'loading' ? 'loading' : 'preview',
        );
      if (state === 'missing editor') Object.assign(view, { editor: undefined });
      if (state === 'multiple previews') f.open(file);
      const update = vi.fn();
      await expect(f.adapter.process(file, update)).rejects.toThrow(/Markdown editor/);
      expect(update).not.toHaveBeenCalled();
      expect(f.bytes.get(file)).toBe(RAW);
    },
  );
  it.each(['editor opens', 'preview becomes dirty', 'replacement', 'rename', 'stop'])(
    'rechecks inside Vault.process after %s',
    async (change) => {
      const f = fixture(),
        file = f.note(),
        entered = gate(),
        held = gate();
      const preview = change === 'preview becomes dirty' ? f.open(file) : undefined;
      f.hooks.process = async () => {
        entered.resolve();
        await held.promise;
      };
      const update = vi.fn((raw: string) => raw + 'Reader change.');
      const result = f.adapter.process(file, update).catch((error) => error);
      await entered.promise;
      if (change === 'editor opens') f.open(file, RAW + 'Typing.', 'source');
      if (preview) preview.buffer.value += 'Typing.';
      if (change === 'replacement') {
        f.remove(file);
        f.note(SOURCE, 'Replacement content.');
      }
      if (change === 'rename') {
        f.files.delete(SOURCE);
        file.path = TARGET;
        f.files.set(TARGET, file);
      }
      if (change === 'stop') f.stop();
      held.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(update).not.toHaveBeenCalled();
      if (change === 'replacement')
        expect(f.bytes.get(f.files.get(SOURCE) as TFile)).toBe('Replacement content.');
      else expect(f.bytes.get(file)).toBe(RAW);
    },
  );
  it.each<Operation>(['move', 'trash'])(
    'rechecks an editor opened while the native read awaits: %s',
    async (operation) => {
      const f = fixture(),
        file = f.note(),
        entered = gate(),
        held = gate();
      f.hooks.read = async () => {
        entered.resolve();
        await held.promise;
      };
      const result = operate(f, file, operation).catch((error) => error);
      await entered.promise;
      f.open(file, RAW + 'Unsaved preview data.');
      held.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(f.bytes.get(file)).toBe(RAW);
      expect(f.fileManager.renameFile).not.toHaveBeenCalled();
      expect(f.vault.trash).not.toHaveBeenCalled();
    },
  );
  it('uses vault-local recoverable trash, never preference-based or permanent deletion', async () => {
    const f = fixture(),
      file = f.note();
    await f.adapter.trash(file, () => {});
    expect(f.vault.trash).toHaveBeenCalledExactlyOnceWith(file, false);
    expect(f.vault.delete).not.toHaveBeenCalled();
    expect(f.fileManager.trashFile).not.toHaveBeenCalled();
  });
});

describe('create and move folder awaits', () => {
  it('checks an invalid create guard before creating any folders', async () => {
    const f = fixture();
    await expect(
      f.adapter.create(SOURCE, RAW, () => {
        throw new Error('Cancelled');
      }),
    ).rejects.toThrow('Cancelled');
    expect(f.vault.createFolder).not.toHaveBeenCalled();
    expect(f.vault.create).not.toHaveBeenCalled();
  });
  it('rechecks an async create guard after folder creation', async () => {
    const f = fixture(),
      entered = gate(),
      held = gate();
    let valid = true;
    const guard = vi.fn(async () => {
      if (!valid) throw new Error('Subscription cancelled');
    });
    f.hooks.folder = async (path) => {
      if (path === 'Reading/Inbox') {
        entered.resolve();
        await held.promise;
      }
    };
    const result = f.adapter.create(SOURCE, RAW, guard).catch((error) => error);
    await entered.promise;
    valid = false;
    held.resolve();
    expect(await result).toMatchObject({ message: 'Subscription cancelled' });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(f.vault.create).not.toHaveBeenCalled();
    expect(f.files.has(SOURCE)).toBe(false);
  });
  it.each(['Reading', 'Reading/Inbox'])(
    'stopping during %s creation prevents later folders and note writes',
    async (blocked) => {
      const f = fixture(),
        entered = gate(),
        held = gate();
      f.hooks.folder = async (path) => {
        if (path === blocked) {
          entered.resolve();
          await held.promise;
        }
      };
      const result = f.adapter.create(SOURCE, RAW).catch((error) => error);
      await entered.promise;
      f.stop();
      held.resolve();
      expect(await result).toMatchObject({ message: 'Reader has stopped.' });
      expect(f.vault.create).not.toHaveBeenCalled();
      if (blocked === 'Reading') expect(f.files.has('Reading/Inbox')).toBe(false);
    },
  );
  it('tolerates another operation creating the same directory', async () => {
    const f = fixture();
    f.hooks.folder = async (path) => {
      f.folder(path);
    };
    const file = await f.adapter.create(SOURCE, RAW);
    expect(f.bytes.get(file)).toBe(RAW);
  });
  it.each(['deleted', 'replaced', 'edited', 'dirty preview', 'occupied destination', 'stop'])(
    'does not dispatch rename after source/destination becomes %s during folder creation',
    async (change) => {
      const f = fixture(),
        file = f.note(),
        entered = gate(),
        held = gate();
      f.hooks.folder = async (path) => {
        if (path === 'Reading/Later') {
          entered.resolve();
          await held.promise;
        }
      };
      const result = f.adapter.move(file, TARGET).catch((error) => error);
      await entered.promise;
      if (change === 'deleted' || change === 'replaced') f.remove(file);
      if (change === 'replaced') f.note(SOURCE, 'Replacement content.');
      if (change === 'edited') f.bytes.set(file, RAW + 'External edit.');
      if (change === 'dirty preview') f.open(file, RAW + 'Unsaved typing.');
      if (change === 'occupied destination') f.note(TARGET, 'Other note.');
      if (change === 'stop') f.stop();
      held.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(f.fileManager.renameFile).not.toHaveBeenCalled();
      if (change === 'replaced')
        expect(f.bytes.get(f.files.get(SOURCE) as TFile)).toBe('Replacement content.');
      if (change === 'edited') expect(f.bytes.get(file)).toBe(RAW + 'External edit.');
      if (change === 'occupied destination')
        expect(f.bytes.get(f.files.get(TARGET) as TFile)).toBe('Other note.');
    },
  );
  it('preserves both files when the native rename rejects a racing destination', async () => {
    const f = fixture(),
      file = f.note();
    f.hooks.rename = async () => {
      f.note(TARGET, 'Racing destination.');
    };
    await expect(f.adapter.move(file, TARGET)).rejects.toThrow('File exists');
    expect(f.bytes.get(file)).toBe(RAW);
    expect(file.path).toBe(SOURCE);
    expect(f.bytes.get(f.files.get(TARGET) as TFile)).toBe('Racing destination.');
  });
});

it('revokes auto-title ownership before reindexing every native file rename, including away and back', () => {
  const callbacks = new Map<string, (...args: any[]) => void>(),
    calls: string[] = [];
  const on = (name: string, callback: (...args: any[]) => void) => {
    callbacks.set(name, callback);
    return {};
  };
  const file = Object.assign(new TFile(), { path: TARGET, extension: 'md' });
  const store = {
    noteRenamed: vi.fn((actual: TFile) => {
      expect(actual).toBe(file);
      calls.push('revoke');
    }),
    catalog: { remove: () => calls.push('remove'), update: () => calls.push('index') },
  };
  const plugin = {
    app: {
      vault: { on },
      metadataCache: { on, getFileCache: () => ({ frontmatter: { type: 'article' } }) },
      workspace: { onLayoutReady() {} },
    },
    registerEvent() {},
  };
  watchLibrary(plugin as unknown as Plugin, store as unknown as ArticleStore<TFile>, () => {
    calls.push('changed');
  });
  callbacks.get('rename')!(file, SOURCE);
  file.path = SOURCE;
  callbacks.get('rename')!(file, TARGET);
  expect(calls).toEqual([
    'remove',
    'revoke',
    'index',
    'changed',
    'remove',
    'revoke',
    'index',
    'changed',
  ]);
  expect(store.noteRenamed).toHaveBeenCalledTimes(2);
});

describe('native YAML-link annotation events', () => {
  it.each([
    { related: '[[Topics/X.md]]' },
    { related: { targets: [{ title: '[[Topics/X.md]]' }] } },
    { topics: ['Research'] },
  ])('signals an authored property annotation without another body read: %j', (properties) => {
    const f = libraryFixture(),
      file = f.add('Reading/Stream/260801 Article.md', { type: 'article' });
    const raw = patchProperties(f.bytes.get(file)!, properties),
      cache = { frontmatter: readDocument(raw).properties };
    f.caches.set(file, cache);
    f.bytes.set(file, raw);
    f.events.get('changed')!(file, raw, cache);
    expect(f.changes).toHaveLength(1);
    expect(f.changes[0]).toMatchObject({ path: file.path, annotations: true });
    expect(f.vault.read).not.toHaveBeenCalled();
    expect(f.vault.getMarkdownFiles).not.toHaveBeenCalled();
  });

  it('does not signal annotations for native feed/state fields or unrelated scalar highlights', () => {
    const f = libraryFixture(),
      properties = {
        type: 'article',
        feed: '[[Reading/Wires/Feed.md]]',
        reading_position: 'anchor:[[Topics/X.md]]',
        title: '[[Literal title]]',
        error: '[[Literal error]]',
        related: '==not a vault link==',
      };
    const file = f.add('Reading/Stream/260801 Article.md', properties);
    f.events.get('changed')!(file, f.bytes.get(file), f.caches.get(file));
    expect(f.changes[0]).toMatchObject({ path: file.path, annotations: false });
    expect(f.vault.read).not.toHaveBeenCalled();
  });
});

describe('folder-only library events', () => {
  it.each([false, true])(
    'reindexes article/feed descendants after a folder-only rename (omitted children: %s)',
    (omitChildren) => {
      const f = libraryFixture();
      const article = f.add('Reading/Inbox/Group/Story.md', {
        type: 'article',
        url: 'https://example.com/story',
      });
      const nested = f.add('Reading/Inbox/Group/Nested/Other.md', { type: 'article' });
      const feed = f.add('Reading/Inbox/Group/Nested/Feed.md', {
        type: 'feed',
        url: 'https://example.com/feed',
      });
      const sibling = f.add('Reading/Inbox/Grouped/Untouched.md', { type: 'article' });
      const old = [article.path, nested.path, feed.path],
        revoked = vi.spyOn(f.store, 'noteRenamed');
      f.renameFolder(f.folder('Reading/Inbox/Group'), 'Reading/Later/Group', omitChildren);
      for (const path of old) {
        expect(f.store.catalog.article(path)).toBeUndefined();
        expect(f.store.catalog.feed(path)).toBeUndefined();
      }
      expect(f.store.catalog.article(article.path)?.queue).toBe('Later');
      expect(f.store.catalog.article(nested.path)?.queue).toBe('Later');
      expect(f.store.catalog.feed(feed.path)).toBeDefined();
      expect(f.store.catalog.findUrl('https://example.com/story')?.path).toBe(article.path);
      expect(f.store.catalog.article(sibling.path)?.queue).toBe('Inbox');
      expect(revoked).toHaveBeenCalledTimes(3);
      expect(f.getFileCache).toHaveBeenCalledTimes(3);
      expect(f.changes).toEqual(
        expect.arrayContaining(
          [article, nested, feed].map((file, i) => ({
            path: file.path,
            previousPath: old[i],
            metadataChanged: true,
          })),
        ),
      );
      expect(f.changes).toHaveLength(3);
      expect(f.vault.read).not.toHaveBeenCalled();
      expect(f.vault.getMarkdownFiles).not.toHaveBeenCalled();
      expect(f.vault.getAllLoadedFiles).not.toHaveBeenCalled();
    },
  );
  it('revokes child auto-title receipts on folder rename away and back', async () => {
    const f = libraryFixture();
    const file = await f.store.capture({ url: 'https://example.com/capture' });
    const original = file.path;
    f.caches.set(file, { frontmatter: readDocument(f.bytes.get(file)!).properties });
    const folder = f.folder('Reading/Inbox');
    f.renameFolder(folder, 'Reading/Later/Temporary');
    f.renameFolder(folder, 'Reading/Inbox');
    expect(f.vault.read).not.toHaveBeenCalled();
    const saved = await f.store.acquire(
      await f.store.read(original),
      'Publisher body.',
      'Publisher title',
    );
    expect(saved.path).toBe(original);
    expect(file.path).toBe(original);
    expect(f.fileManager.renameFile).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'removes article/feed index descendants on folder deletion (omitted children: %s)',
    (omitChildren) => {
      const f = libraryFixture();
      const article = f.add('Reading/Inbox/Group/Story.md', {
        type: 'article',
        url: 'https://example.com/story',
      });
      const feed = f.add('Reading/Inbox/Group/Nested/Feed.md', {
        type: 'feed',
        url: 'https://example.com/feed',
      });
      const sibling = f.add('Reading/Inbox/Grouped/Untouched.md', { type: 'article' });
      const revoked = vi.spyOn(f.store, 'noteRenamed');
      f.deleteFolder(f.folder('Reading/Inbox/Group'), omitChildren);
      expect(f.store.catalog.article(article.path)).toBeUndefined();
      expect(f.store.catalog.feed(feed.path)).toBeUndefined();
      expect(f.store.catalog.findUrl('https://example.com/story')).toBeUndefined();
      expect(f.store.catalog.article(sibling.path)).toBeDefined();
      if (!omitChildren) {
        expect(revoked).toHaveBeenCalledWith(article);
        expect(revoked).toHaveBeenCalledWith(feed);
      }
      expect(f.changes).toEqual(
        expect.arrayContaining(
          [article, feed].map((file) => ({
            path: file.path,
            deleted: true,
            metadataChanged: true,
          })),
        ),
      );
      expect(f.changes).toHaveLength(2);
      expect(f.getFileCache).not.toHaveBeenCalled();
      expect(f.vault.read).not.toHaveBeenCalled();
      expect(f.vault.getMarkdownFiles).not.toHaveBeenCalled();
      expect(f.vault.getAllLoadedFiles).not.toHaveBeenCalled();
    },
  );
  it('ignores late folder events after watcher disposal', () => {
    const f = libraryFixture();
    f.add('Reading/Inbox/Group/Story.md', { type: 'article' });
    const folder = f.folder('Reading/Inbox/Group'),
      revoke = vi.spyOn(f.store, 'noteRenamed');
    f.stop();
    f.renameFolder(folder, 'Reading/Later/Group');
    f.deleteFolder(folder);
    expect(f.changes).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(f.getFileCache).not.toHaveBeenCalled();
  });
});

describe('portable collision lookup without body or vault scans', () => {
  it('finds files, folders, case variants and NFC-equivalent names through parent children', () => {
    const f = fixture();
    f.note();
    f.folder('Reading/Inbox/Occupied.md');
    f.note('Reading/Inbox/Café.md');
    for (const path of [
      SOURCE,
      'reading/inbox/story.MD',
      'Reading/Inbox/occupied.MD',
      'Reading/Inbox/Cafe\u0301.md',
    ])
      expect(f.adapter.exists(path), path).toBe(true);
    expect(f.adapter.exists('Reading/Inbox/Available.md')).toBe(false);
    expect(f.adapter.exists('New/Folder/Available.md')).toBe(false);
    expect(f.adapter.file('Reading/Inbox/Occupied.md')).toBeUndefined();
    expect(f.vault.read).not.toHaveBeenCalled();
    expect(f.vault.getMarkdownFiles).not.toHaveBeenCalled();
    expect(f.vault.getAllLoadedFiles).not.toHaveBeenCalled();
  });
  it.each(['file', 'folder', 'case-only file'])(
    'never creates over an existing %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'folder') f.folder(SOURCE);
      else f.note(kind === 'case-only file' ? 'Reading/Inbox/story.md' : SOURCE);
      await expect(f.adapter.create(SOURCE, 'Replacement')).rejects.toThrow(/exists/);
      expect(f.vault.create).not.toHaveBeenCalled();
    },
  );
  it.each(['file', 'folder'])('rejects an occupied move destination (%s)', async (kind) => {
    const f = fixture(),
      file = f.note();
    if (kind === 'folder') f.folder(TARGET);
    else f.note('Reading/Later/story.md');
    await expect(f.adapter.move(file, TARGET)).rejects.toThrow(/exists/);
    expect(f.fileManager.renameFile).not.toHaveBeenCalled();
    expect(f.bytes.get(file)).toBe(RAW);
  });
  it.each(['file blocks folder', 'differently cased folder'])(
    'does not create conflicting parent paths: %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'file blocks folder') f.note('Reading/Inbox');
      else f.folder('reading/Inbox');
      await expect(f.adapter.create(SOURCE, RAW)).rejects.toThrow(/Folder path/);
      expect(f.vault.create).not.toHaveBeenCalled();
    },
  );
});

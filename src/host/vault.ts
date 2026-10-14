import {
  MarkdownView,
  TFile,
  TFolder,
  type App,
  type Plugin,
  type TAbstractFile,
  type Events,
  type EventRef,
} from 'obsidian';
import { ChangedNote } from '../core/document';
import { hasPropertyAnnotations } from '../core/annotations';
import type { ArticleStore, VaultPort } from '../core/store';

export class ObsidianVault implements VaultPort<TFile> {
  private pending = new Set<Promise<unknown>>();
  /** A stopped generation cannot cancel host I/O already dispatched. Drain it before replacement. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  private dispatch<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.active()) return Promise.reject(new Error('Reader has stopped.'));
    const result = operation();
    this.pending.add(result);
    const clear = () => this.pending.delete(result);
    void result.then(clear, clear);
    return result;
  }
  constructor(
    private app: App,
    private active: () => boolean = () => true,
  ) {}
  file(path: string): TFile | undefined {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : undefined;
  }
  read(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }
  /** Resolve portable name collisions using only the folders on this path. */
  private entry(path: string): TAbstractFile | undefined {
    const exact = this.app.vault.getAbstractFileByPath(path);
    if (exact) return exact;
    let entry: TAbstractFile = this.app.vault.getRoot();
    for (const name of path.split('/')) {
      if (!(entry instanceof TFolder)) return;
      const folded = name.normalize('NFC').toLowerCase();
      const child = entry.children.find(
        (item) => item.name.normalize('NFC').toLowerCase() === folded,
      );
      if (!child) return;
      entry = child;
    }
    return entry;
  }
  exists(path: string): boolean {
    return !!this.entry(path);
  }
  async folder(path: string): Promise<void> {
    let part = '';
    for (const name of path.split('/').filter(Boolean)) {
      if (!this.active()) throw new Error('Reader has stopped.');
      part = part ? `${part}/${name}` : name;
      const existing = this.entry(part);
      if (existing && (!(existing instanceof TFolder) || existing.path !== part))
        throw new Error(`Folder path is occupied or differently spelled: ${part}`);
      if (!existing) {
        try {
          await this.dispatch(() => this.app.vault.createFolder(part));
        } catch (error) {
          if (!(this.app.vault.getAbstractFileByPath(part) instanceof TFolder)) throw error;
        }
      }
    }
  }
  async create(
    path: string,
    content: string,
    guard: () => void | Promise<void> = () => {},
  ): Promise<TFile> {
    await guard();
    await this.folder(path.slice(0, path.lastIndexOf('/')));
    await guard();
    if (!this.active()) throw new Error('Reader has stopped.');
    if (this.exists(path)) throw new Error(`Destination already exists: ${path}`);
    return this.dispatch(() => this.app.vault.create(path, content));
  }
  assertWritable(file: TFile, current?: string): void {
    if (!this.active()) throw new Error('Reader has stopped.');
    if (this.file(file.path) !== file) throw new ChangedNote();
    let count = 0,
      blocked = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView) || leaf.view.file !== file) return;
      count++;
      const view = leaf.view;
      // Preview can retain an unsaved source buffer during a mode switch. Only
      // fresh durable bytes at the write boundary prove that buffer is clean.
      if (
        view.getMode() !== 'preview' ||
        !view.editor ||
        typeof view.editor.getValue !== 'function'
      )
        blocked = true;
      else {
        const buffer = view.editor.getValue();
        if (typeof buffer !== 'string' || (current !== undefined && buffer !== current))
          blocked = true;
      }
    });
    if (blocked || count > 1)
      throw new Error(
        'Close this note’s Markdown editor and extra views before Reader changes it. Your edits are preserved.',
      );
  }
  private assertCurrent(file: TFile, path: string, current: string): void {
    if (file.path !== path) throw new ChangedNote();
    this.assertWritable(file, current);
  }
  async process(file: TFile, update: (current: string) => string): Promise<string> {
    const path = file.path;
    this.assertWritable(file);
    return this.dispatch(() =>
      this.app.vault.process(file, (current) => {
        this.assertCurrent(file, path, current);
        return update(current);
      }),
    );
  }
  async move(file: TFile, path: string): Promise<void> {
    const from = file.path;
    this.assertWritable(file);
    if (from === path) return;
    const before = await this.read(file);
    this.assertCurrent(file, from, before);
    if (this.exists(path)) throw new Error(`Destination already exists: ${path}`);
    await this.folder(path.slice(0, path.lastIndexOf('/')));
    const current = await this.read(file);
    this.assertCurrent(file, from, current);
    if (current !== before) throw new ChangedNote();
    if (this.exists(path)) throw new Error(`Destination already exists: ${path}`);
    // Use the host's link-aware move, not a second implementation of Obsidian backlinks.
    await this.dispatch(() => this.app.fileManager.renameFile(file, path));
  }
  async trash(file: TFile, validate: (current: string) => void): Promise<void> {
    const path = file.path;
    this.assertWritable(file);
    const current = await this.read(file);
    this.assertCurrent(file, path, current);
    // fileManager.trashFile follows the user's deletion preference, which can be permanent.
    // Explicit vault-local trash keeps Reader deletion recoverable on every platform.
    // No await between caller validation and native dispatch. Once native I/O starts,
    // this cannot provide a cross-device transaction or cancel the host operation.
    validate(current);
    await this.dispatch(() => this.app.vault.trash(file, false));
  }
}

export interface LibraryChange {
  path: string;
  previousPath?: string;
  deleted?: boolean;
  metadataChanged?: boolean;
  annotations?: boolean;
}
/** Metadata-only index. The caller owns disposal; never retain generation refs on the plugin. */
export function watchLibrary(
  plugin: Pick<Plugin, 'app'>,
  store: ArticleStore<TFile>,
  changed: (event: LibraryChange) => void,
): () => void {
  const { app } = plugin;
  let active = true;
  const disposers: (() => void)[] = [];
  const observe = (host: Events, reference: EventRef) => {
    disposers.push(() => host.offref(reference));
  };
  const index = (file: TFile) => {
    if (!active || file.extension !== 'md') return;
    const cache = app.metadataCache.getFileCache(file);
    if (cache?.frontmatter) store.catalog.update(file.path, cache.frontmatter);
    else store.catalog.remove(file.path);
  };
  const seed = () => {
    if (active) for (const file of app.vault.getMarkdownFiles()) index(file);
  };
  const descendants = (folder: TFolder): TFile[] => {
    const files: TFile[] = [],
      pending: TAbstractFile[] = [...folder.children];
    while (pending.length) {
      const child = pending.pop()!;
      if (child instanceof TFolder) {
        for (const entry of child.children) pending.push(entry);
      } else if (child instanceof TFile && child.extension === 'md') files.push(child);
    }
    return files;
  };
  observe(
    app.metadataCache,
    app.metadataCache.on('changed', (file, raw, cache) => {
      if (!active) return;
      const wasKnown = !!store.catalog.article(file.path) || !!store.catalog.feed(file.path);
      const metadataChanged = cache.frontmatter
        ? store.catalog.update(file.path, cache.frontmatter)
        : wasKnown;
      if (!cache.frontmatter) store.catalog.remove(file.path);
      const body = raw.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
      const annotations =
        body.includes('==') ||
        body.includes('[[') ||
        /\]\((?![a-z][\w+.-]*:|\/\/|#)/i.test(body) ||
        hasPropertyAnnotations(cache.frontmatter);
      changed({ path: file.path, metadataChanged, annotations });
    }),
  );
  observe(
    app.vault,
    app.vault.on('rename', (file, old) => {
      if (!active) return;
      if (file instanceof TFile) {
        store.catalog.remove(old);
        store.noteRenamed(file);
        index(file);
        changed({ path: file.path, previousPath: old, metadataChanged: true });
      } else if (file instanceof TFolder) {
        const paths = new Set(store.catalog.pathsWithin(old));
        const moved = new Map<string, TFile>();
        for (const child of descendants(file)) {
          const from = old + child.path.slice(file.path.length);
          paths.add(from);
          moved.set(from, child);
        }
        // Supplement the public children with known index paths if the host's
        // folder object no longer contains every child at event delivery.
        for (const from of paths) {
          if (!moved.has(from)) {
            const child = app.vault.getAbstractFileByPath(file.path + from.slice(old.length));
            if (child instanceof TFile) moved.set(from, child);
          }
          store.catalog.remove(from);
        }
        for (const child of moved.values()) store.noteRenamed(child);
        for (const child of moved.values()) index(child);
        // Publish only after the entire affected subtree has been reindexed.
        for (const from of paths) {
          const child = moved.get(from);
          changed(
            child
              ? { path: child.path, previousPath: from, metadataChanged: true }
              : { path: from, deleted: true, metadataChanged: true },
          );
        }
      }
    }),
  );
  observe(
    app.vault,
    app.vault.on('delete', (file) => {
      if (!active) return;
      const paths = new Set(
        file instanceof TFolder ? store.catalog.pathsWithin(file.path) : [file.path],
      );
      const files =
        file instanceof TFolder ? descendants(file) : file instanceof TFile ? [file] : [];
      for (const child of files) {
        store.noteRenamed(child);
        paths.add(child.path);
      }
      const changes: LibraryChange[] = [];
      for (const path of paths) {
        const known = !!store.catalog.article(path) || !!store.catalog.feed(path);
        store.catalog.remove(path);
        changes.push({ path, deleted: true, metadataChanged: known });
      }
      for (const change of changes) changed(change);
    }),
  );
  // Enumerate once; later updates use event files, folder children and indexed paths.
  app.workspace.onLayoutReady(seed);
  return () => {
    if (!active) return;
    active = false;
    for (const dispose of disposers.splice(0)) dispose();
  };
}

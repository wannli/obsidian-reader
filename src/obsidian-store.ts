import { TFile, TFolder, normalizePath, type MarkdownView, type Vault, type Workspace } from 'obsidian';
import type { FileStore } from './types';
import { assertUnambiguousNotePath, safePath } from './storage/safety';
import { editorEdits, editorTransaction, EditorWriteDeferredError, retainsEditorPatch } from './editor-transaction';
import { StaleArticleWriteError } from './storage/preconditions';
import { assertNoLegacyOwnership } from './storage/legacy-discovery';
import { isSidecarPath } from './storage/sidecar-format';
export class ObsidianStore implements FileStore {
  private moving = new Set<string>();
  private writes = new Map<string, number>();
  private pathRevisions = new Map<string, number>();
  private unattributedRevision = 0;
  private detachEvents: Array<() => void> = [];
  constructor(private vault: Vault, private workspace: Workspace) {
    // Native Markdown/JSON edits can add late path ownership evidence.
    // Track cross-path changes while the target has its own write guards.
    const changed = (path?: string) => {
      if (path && (/\.md$/i.test(path) || isSidecarPath(path)))
        this.pathRevisions.set(path, (this.pathRevisions.get(path) ?? 0) + 1);
      else if (!path) this.unattributedRevision++;
    };
    const createRef = vault.on('create', file => changed(file.path));
    const modifyRef = vault.on('modify', file => changed(file.path));
    const deleteRef = vault.on('delete', file => changed(file.path));
    const renameRef = vault.on('rename', (file, oldPath) => { changed(oldPath); changed(file.path); });
    this.detachEvents.push(() => vault.offref(createRef), () => vault.offref(modifyRef),
      () => vault.offref(deleteRef), () => vault.offref(renameRef));
    const editorRef = workspace.on('editor-change', (_editor, info) => changed(info?.file?.path));
    this.detachEvents.push(() => workspace.offref(editorRef));
  }
  revision(excludingPath?: string): number {
    let total = this.unattributedRevision;
    for (const [path, revision] of this.pathRevisions) if (path !== excludingPath) total += revision;
    return total;
  }
  dispose(): void { for (const detach of this.detachEvents.splice(0)) detach(); }
  indexedPaths(): readonly string[] { return this.vault.getMarkdownFiles().map(file => file.path); }
  async list(): Promise<string[]> {
    const paths = this.vault.getMarkdownFiles().map(file => file.path);
    // Include all historical JSON evidence paths, nested and case-insensitive,
    // without recursing into unrelated folders or interpreting its bytes.
    for (const file of this.vault.getAllLoadedFiles())
      if (file instanceof TFile && isSidecarPath(file.path) && /\.json$/i.test(file.path)) paths.push(file.path);
    return paths;
  }
  assertNotePath(path: string): void {
    assertUnambiguousNotePath(this.vault.getAllLoadedFiles().map(entry => ({ path: entry.path, folder: entry instanceof TFolder })), path);
  }
  /** Observed vault events + indexed identity/stat + live buffers form a synchronous
   * commit guard. External bytes not yet reported by Obsidian cannot be locked. */
  async observe(path: string, read: (current: string) => void) {
    const file = this.file(path); let changed = false;
    const invalidate = (entry: { path: string }) => { if (entry === file || entry.path === path) changed = true; };
    const refs = [this.vault.on('modify', invalidate), this.vault.on('rename', invalidate), this.vault.on('delete', invalidate)];
    const dispose = () => { for (const ref of refs) this.vault.offref(ref); };
    try {
      let expected = '';
      await this.inspect(path, current => { read(current); expected = current; });
      const mtime = file.stat?.mtime, size = file.stat?.size;
      const views = this.views(file).map(view => ({ view, editor: view.editor, mode: view.getMode(), content: view.getViewData() }));
      const assert = () => {
        const currentViews = this.views(file);
        if (changed || this.moving.has(path) || file.path !== path || this.vault.getAbstractFileByPath(path) !== file ||
            file.stat?.mtime !== mtime || file.stat?.size !== size || currentViews.length !== views.length ||
            views.some((saved, index) => currentViews[index] !== saved.view || saved.view.file !== file ||
              saved.view.editor !== saved.editor || saved.view.getMode() !== saved.mode || saved.view.getViewData() !== saved.content || saved.content !== expected))
          throw new Error('Node changed or was deleted: ' + path);
      };
      assert(); return { assert, dispose };
    } catch (error) { dispose(); throw error; }
  }
  async exists(path: string): Promise<boolean> { return this.vault.getAbstractFileByPath(normalizePath(path)) !== null; }
  private file(path: string): TFile {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error('Note not found: ' + path); return file;
  }
  // Storage reads durable text; mutations separately inspect the latest editor.
  read(path: string): Promise<string> { return this.vault.read(this.file(path)); }
  assertAbsent(path: string): void {
    if (this.vault.getAbstractFileByPath(normalizePath(path))) throw new StaleArticleWriteError();
  }
  async create(path: string, content: string, options?: { guard?: () => void }): Promise<void> {
    options?.guard?.();
    const clean = normalizePath(path), parents = clean.split('/').slice(0, -1); let current = '';
    if (this.moving.has(clean)) throw new EditorWriteDeferredError('Reader is moving this note; creation is deferred.');
    for (const name of parents) {
      current = current ? current + '/' + name : name;
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing && !(existing instanceof TFolder)) throw new Error('A file blocks folder ' + current);
      if (!existing) {
        try { await this.vault.createFolder(current); }
        catch (error) { if (!(this.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error; }
      }
    }
    if (this.moving.has(clean)) throw new EditorWriteDeferredError('Reader is moving this note; creation is deferred.');
    // This is the final ownership boundary for callers that create directly
    // through FileStore, including typed-node batches bypassing StorageContext.
    const ownershipRevision = this.revision(clean);
    if (/\.md$/i.test(clean)) await assertNoLegacyOwnership(this, clean);
    if (this.revision(clean) !== ownershipRevision) throw new StaleArticleWriteError();
    options?.guard?.();
    await this.vault.create(clean, content);
  }
  /** Exact rename only. Repository preflight must prove ordinary references
   * remain valid; this adapter does not perform native link updates. */
  async rename(from: string, to: string, options: { expectedContent: string; guard?: () => void }): Promise<void> {
    safePath(from, true); safePath(to, true);
    const valid = (path: string) => path === normalizePath(path) && !/[\\\r\n]/.test(path) && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..');
    if (!valid(from) || !valid(to)) throw new Error('Reader cannot move an invalid note path.');
    if (this.moving.has(from) || this.moving.has(to) || this.writes.has(from) || this.writes.has(to)) throw new EditorWriteDeferredError('Reader is waiting for another note operation before moving it.');
    const file = this.file(from);
    const assertSource = () => {
      options.guard?.();
      if (file.path !== from || this.vault.getAbstractFileByPath(from) !== file) throw new StaleArticleWriteError();
      const views = this.views(file), editors = this.editable(file);
      // Public SDK cannot prove that an editable leaf has no queued native save.
      if (views.length > 1 || editors.length || views.some(view => view.getViewData() !== options.expectedContent))
        throw new EditorWriteDeferredError('Close the article’s Markdown editor and any extra views before moving it; Reader will not discard or force-save editor changes.');
    };
    const folded = (path: string) => path.normalize('NFC').toLowerCase();
    const assertDestination = () => {
      if (from === to) return;
      if (folded(from) === folded(to) || this.vault.getAllLoadedFiles().some(item => folded(item.path) === folded(to))) throw new Error('Reader cannot move the article: the destination already exists (including a case-only match).');
      for (const parent of to.split('/').slice(0, -1).map((_part, i, parts) => parts.slice(0, i + 1).join('/'))) {
        const found = this.vault.getAllLoadedFiles().find(item => folded(item.path) === folded(parent));
        if (found && (found.path !== parent || !(found instanceof TFolder))) throw new Error('Reader cannot move the article: a file or differently cased folder blocks ' + parent);
      }
    };
    assertSource(); assertDestination(); this.moving.add(from); this.moving.add(to);
    try {
      if (await this.vault.read(file) !== options.expectedContent) throw new StaleArticleWriteError();
      assertSource(); assertDestination(); if (from === to) return;
      let parent = '';
      for (const name of to.split('/').slice(0, -1)) {
        parent = parent ? parent + '/' + name : name;
        assertSource(); assertDestination();
        if (!this.vault.getAbstractFileByPath(parent)) {
          try { await this.vault.createFolder(parent); }
          catch (error) { if (!(this.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error; }
        }
      }
      // Re-read after folder creation; no awaited work separates these final checks and rename.
      if (await this.vault.read(file) !== options.expectedContent) throw new StaleArticleWriteError();
      assertSource(); assertDestination();
      await this.vault.rename(file, to);
    } finally { this.moving.delete(from); this.moving.delete(to); }
  }
  /** One-time retirement only, not a general note deletion API. */
  async remove(path: string, options: { expectedContent: string; expectedSource?: { path: string; content: string }; guard?: () => void }): Promise<void> {
    if (!/^Reading\/(?:Metadata|Pullman Metadata)\/[a-f0-9]{64}\.json$/.test(path))
      throw new Error('Only verified legacy metadata JSON can be retired');
    safePath(path);
    const sourcePath = options.expectedSource?.path;
    if (sourcePath) safePath(sourcePath, true);
    if ([path, ...(sourcePath ? [sourcePath] : [])].some(key => this.moving.has(key) || this.writes.has(key))) throw new EditorWriteDeferredError();
    const file = this.file(path), source = sourcePath ? this.file(sourcePath) : undefined;
    const revision = (target: TFile) => target.stat && `${target.stat.mtime}:${target.stat.size}`;
    const jsonRevision = revision(file), sourceRevision = source && revision(source);
    let observedChange = false;
    // Local retirement-window observation catches same-size/same-timestamp
    // native writes while the other durable file is being read.
    const observe = (changed: { path: string }) => {
      if (changed === file || changed === source || changed.path === path || changed.path === sourcePath) observedChange = true;
    };
    const refs = typeof this.vault.on === 'function' ? [this.vault.on('modify', observe), this.vault.on('delete', observe), this.vault.on('rename', observe)] : [];
    const unchanged = () => {
      options.guard?.();
      if (observedChange) throw new EditorWriteDeferredError('Legacy JSON or converted source changed during retirement.');
      if (file.path !== path || this.vault.getAbstractFileByPath(path) !== file || this.views(file).length || revision(file) !== jsonRevision)
        throw new EditorWriteDeferredError('Legacy JSON changed or is open; retirement is deferred.');
      if (source && (source.path !== sourcePath || this.vault.getAbstractFileByPath(sourcePath!) !== source || revision(source) !== sourceRevision ||
          this.views(source).length > 1 || this.editable(source).length || this.views(source).some(view => view.getViewData() !== options.expectedSource!.content)))
        throw new EditorWriteDeferredError('Converted source changed or has an editable Markdown view; close it before legacy retirement.');
    };
    this.moving.add(path); if (sourcePath) this.moving.add(sourcePath);
    try {
      unchanged();
      if (await this.vault.read(file) !== options.expectedContent) throw new Error('Legacy JSON changed before retirement');
      unchanged();
      if (source && await this.vault.read(source) !== options.expectedSource!.content) throw new Error('Converted source changed before legacy retirement');
      // Final identity/editor/lifecycle checks immediately precede dispatch;
      // source preparation must not introduce another asynchronous gap here.
      unchanged();
      await this.vault.delete(file);
    } finally {
      this.moving.delete(path); if (sourcePath) this.moving.delete(sourcePath);
      for (const ref of refs) this.vault.offref(ref);
    }
  }
  private views(file: TFile): MarkdownView[] {
    const result: MarkdownView[] = [];
    this.workspace.iterateAllLeaves(leaf => { const view = leaf.view as MarkdownView; if (view.getViewType() === 'markdown' && view.file?.path === file.path) result.push(view); });
    return result;
  }
  private editable(file: TFile): MarkdownView[] {
    try { const views = this.views(file); if (views.some(view => !['source', 'preview'].includes(view.getMode()))) throw new Error(); return views.filter(view => view.getMode() === 'source'); }
    catch { throw new EditorWriteDeferredError('Reader is waiting for the native editor to finish loading.'); }
  }
  private assertEditor(file: TFile, path: string, view: MarkdownView, editor: MarkdownView['editor']): void {
    const current = this.editable(file);
    if (file.path !== path || this.vault.getAbstractFileByPath(path) !== file || view.file !== file || this.views(file).length !== 1 || current.length !== 1 || current[0] !== view || view.editor !== editor) throw new EditorWriteDeferredError();
  }
  private async limited<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now(); if (remaining <= 0) { void promise.catch(() => {}); throw new EditorWriteDeferredError('Reader could not verify a durable native save yet; the write is deferred.'); }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new EditorWriteDeferredError('Reader could not verify a durable native save yet; the write is deferred.')), remaining);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  private async processEditor(file: TFile, view: MarkdownView, update: (current: string) => string): Promise<void> {
    const path = file.path, editor = view.editor;
    if (!editor || typeof view.save !== 'function') throw new EditorWriteDeferredError();
    this.assertEditor(file, path, view, editor);
    const before = editor.getValue(); let after: string;
    try { after = update(before); }
    catch (error) { if (error instanceof StaleArticleWriteError) throw error; throw new EditorWriteDeferredError('Reader cannot safely update the current editor: ' + (error instanceof Error ? error.message : String(error))); }
    if (after === before) {
      // A link/delete visible only in an unsaved buffer is NOT durable completion.
      const durable = await this.vault.read(file); this.assertEditor(file, path, view, editor);
      if (durable !== before || editor.getValue() !== before) throw new EditorWriteDeferredError('Reader is waiting for the unchanged editor state to be saved.');
      return;
    }
    const edits = editorEdits(before, after), transaction = editorTransaction(editor, after, edits);
    this.assertEditor(file, path, view, editor);
    if (editor.getValue() !== before) throw new EditorWriteDeferredError();
    const deadline = Date.now() + 3000;
    try {
      editor.transaction(transaction, 'reader'); // Changes use the original document; selections use the result.
      while (true) {
        this.assertEditor(file, path, view, editor);
        const snapshot = editor.getValue();
        if (!retainsEditorPatch(after, snapshot, edits)) throw new EditorWriteDeferredError('The editor changed this operation before it could be saved; Reader deferred further work.');
        // save() can return early when another native save is in flight. Verify actual durable bytes.
        await this.limited(Promise.resolve(view.save()), deadline);
        const durable = await this.limited(this.vault.read(file), deadline);
        this.assertEditor(file, path, view, editor);
        const current = editor.getValue();
        if (!retainsEditorPatch(after, current, edits)) throw new EditorWriteDeferredError('The editor changed this operation before it could be saved; Reader deferred further work.');
        if (durable === snapshot || durable === current) return;
        if (Date.now() >= deadline) throw new EditorWriteDeferredError('Reader could not verify a durable native save yet; the write is deferred.');
        await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      }
    } catch (error) {
      if (error instanceof EditorWriteDeferredError) throw error;
      throw new EditorWriteDeferredError('Reader could not verify the native save: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  async inspect(path: string, read: (current: string) => void): Promise<void> {
    if (this.moving.has(path)) throw new EditorWriteDeferredError();
    const file = this.file(path), editors = this.editable(file);
    if (this.views(file).length > 1) throw new EditorWriteDeferredError('Reader deferred this write because the note has multiple Markdown views. Close the extra views and retry.');
    if (editors.length === 1) {
      const view = editors[0], editor = view.editor;
      this.assertEditor(file, path, view, editor);
      const before = editor.getValue(); read(before);
      this.assertEditor(file, path, view, editor);
      if (editor.getValue() !== before) throw new EditorWriteDeferredError();
      return;
    }
    await this.process(path, current => { read(current); return current; });
  }
  async process(path: string, update: (current: string) => string): Promise<void> {
    if (this.moving.has(path)) throw new EditorWriteDeferredError('Reader is moving this article; retry after the move finishes.');
    this.writes.set(path, (this.writes.get(path) ?? 0) + 1);
    try { await this.processCurrent(path, update); }
    finally { const count = (this.writes.get(path) ?? 1) - 1; if (count) this.writes.set(path, count); else this.writes.delete(path); }
  }
  private async processCurrent(path: string, update: (current: string) => string): Promise<void> {
    const file = this.file(path), editors = this.editable(file);
    // Equal-looking separate editors still have separate, unproven save lifecycles.
    if (this.views(file).length > 1) throw new EditorWriteDeferredError('Reader deferred this write because the note has multiple Markdown views. Close the extra views and retry.');
    if (editors.length === 1) return this.processEditor(file, editors[0], update);
    const unchanged = new Error('Reader disk transaction was unchanged');
    try {
      await this.vault.process(file, current => {
        if (file.path !== path || this.vault.getAbstractFileByPath(path) !== file) throw new StaleArticleWriteError();
        if (this.views(file).length > 1 || this.editable(file).length || this.views(file).some(view => view.getViewData() !== current)) throw new EditorWriteDeferredError();
        const next = update(current); if (next === current) throw unchanged; return next;
      });
    } catch (error) { if (error !== unchanged) throw error; }
  }
}

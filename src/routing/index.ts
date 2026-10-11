import type { App, WorkspaceLeaf } from 'obsidian';
import { parseNote } from '../storage/markdown';
import { isArticleNote, type ArticleTemplateExclusions } from '../storage/classifier';
import { articleSubpath } from './subpath';

export interface ArticleRouteRequest {
  path: string;
  /** Obsidian link subpath, e.g. #^hl-123. Preserve even if UI cannot focus it. */
  subpath?: string;
  ephemeralState: Record<string, unknown>;
  /** Check after every await, before changing the view/article. */
  isCurrent(): boolean;
}
export interface ArticleRoutingOptions {
  app: App;
  readerViewType?: string;
  /** Current optional template-path snapshot, owned by main/storage integration. */
  templateExclusions?: () => ArticleTemplateExclusions;
  /** Replace this leaf only; never getLeaf/revealLeaf or set active:true.
   * Persist {file: request.path} in Reader's getState/setState. The callback
   * must start setViewState synchronously and guard subsequent async work.
   * UI focus is permitted only if this leaf is still workspace.activeLeaf.
   */
  openReaderInLeaf(leaf: WorkspaceLeaf, request: ArticleRouteRequest): Promise<void> | void;
  onError?(error: unknown): void;
}
export interface ArticleRouting {
  /** Call BEFORE explicit Markdown open. One reservation, retained for the
   * resulting leaf/path until navigation away; metadata updates do not clear it.
   * Returns a cancellation function (call if opening Markdown fails).
   */
  preserveMarkdown(leaf: WorkspaceLeaf, path: string): () => void;
  /** Invalidate old reads and retain explicit editor intent across a native rename. */
  remapPath(from: string, to: string): void;
  dispose(): void;
}
interface Attempt { path: string; view: WorkspaceLeaf['view']; routing: boolean }
interface MarkdownIntent { path: string; entered: boolean; originPath: unknown }

/** Public Obsidian events only. Does not register .md or patch core methods.
 * Reads authoritative YAML through storage's strict parser, even when the
 * metadata cache has not caught up with a newly created note.
 */
export function installArticleRouting(options: ArticleRoutingOptions): ArticleRouting {
  const { app } = options, { workspace, metadataCache, vault } = app;
  const readerType = options.readerViewType ?? 'reader';
  const attempts = new Map<WorkspaceLeaf, Attempt>();
  const intents = new Map<WorkspaceLeaf, MarkdownIntent>();
  let disposed = false;
  function leaves(): Set<WorkspaceLeaf> {
    const result = new Set<WorkspaceLeaf>();
    // A truthy callback result stops native traversal; Set.add must not escape.
    workspace.iterateAllLeaves((leaf): void => { result.add(leaf); });
    return result;
  }
  function current(leaf: WorkspaceLeaf, attempt: Attempt): boolean {
    if (disposed || attempts.get(leaf) !== attempt || intents.get(leaf)?.path === attempt.path || !leaves().has(leaf)) return false;
    const state = leaf.getViewState();
    return state.state?.file === attempt.path && ((state.type === 'markdown' && leaf.view === attempt.view) || (attempt.routing && state.type === readerType));
  }
  async function route(leaf: WorkspaceLeaf, attempt: Attempt): Promise<void> {
    try {
      const file = vault.getFileByPath(attempt.path);
      if (!file || file.extension.toLowerCase() !== 'md') return;
      const text = await vault.read(file);
      if (!current(leaf, attempt)) return;
      // Malformed/ambiguous frontmatter must remain editable Markdown.
      let article = false;
      try {
        const frontmatter = parseNote(text).doc.toJS({ maxAliasCount: 50 });
        article = isArticleNote(attempt.path, frontmatter, options.templateExclusions?.());
      } catch { return; }
      if (!article || !current(leaf, attempt)) return;
      const ephemeralState = { ...(leaf.getEphemeralState() ?? {}) };
      const subpath = articleSubpath(ephemeralState, metadataCache.getFileCache(file));
      attempt.routing = true;
      await options.openReaderInLeaf(leaf, { path: attempt.path, subpath, ephemeralState, isCurrent: () => current(leaf, attempt) });
    } catch (error) {
      if (current(leaf, attempt)) options.onError?.(error);
    } finally {
      attempt.routing = false;
    }
  }
  function scan(changedPath?: string): void {
    if (disposed) return;
    const live = leaves();
    for (const leaf of attempts.keys()) if (!live.has(leaf)) attempts.delete(leaf);
    for (const leaf of intents.keys()) if (!live.has(leaf)) intents.delete(leaf);
    for (const leaf of live) {
      const state = leaf.getViewState(), path = state.state?.file;
      const intent = intents.get(leaf);
      if (intent) {
        if (state.type === 'markdown' && path === intent.path) intent.entered = true;
        else if (intent.entered || (typeof path === 'string' && path !== intent.path && path !== intent.originPath)) intents.delete(leaf);
      }
      const old = attempts.get(leaf);
      if (state.type !== 'markdown' || typeof path !== 'string' || !/\.md$/i.test(path)) {
        // Keep the request token alive while its callback installs Reader.
        if (!(old?.routing && state.type === readerType && path === old.path)) attempts.delete(leaf);
        continue;
      }
      if (intents.get(leaf)?.path === path) { attempts.delete(leaf); continue; }
      if (old && old.path === path && old.view === leaf.view && (old.routing || changedPath !== path)) continue;
      const attempt: Attempt = { path, view: leaf.view, routing: false };
      attempts.set(leaf, attempt);
      void route(leaf, attempt);
    }
  }
  const fileOpen = workspace.on('file-open', () => scan());
  const activeLeaf = workspace.on('active-leaf-change', () => scan());
  const layout = workspace.on('layout-change', () => scan());
  const metadata = metadataCache.on('changed', file => scan(file.path));
  // onLayoutReady has no unsubscribe API; disposed makes its late call inert.
  workspace.onLayoutReady(() => scan());
  return {
    preserveMarkdown(leaf, path) {
      if (disposed) return () => {};
      const state = leaf.getViewState();
      const intent: MarkdownIntent = {
        path, entered: state.type === 'markdown' && state.state?.file === path,
        originPath: state.state?.file,
      };
      intents.set(leaf, intent); attempts.delete(leaf);
      return () => { if (intents.get(leaf) === intent) intents.delete(leaf); };
    },
    remapPath(from, to) {
      if (disposed || from === to) return;
      for (const [leaf, attempt] of attempts) if (attempt.path === from) attempts.delete(leaf);
      for (const intent of intents.values()) {
        if (intent.path === from) intent.path = to;
        if (intent.originPath === from) intent.originPath = to;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      workspace.offref(fileOpen); workspace.offref(activeLeaf); workspace.offref(layout);
      metadataCache.offref(metadata);
      attempts.clear(); intents.clear();
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import type { App, CachedMetadata, ViewState, WorkspaceLeaf } from 'obsidian';
import { installArticleRouting, type ArticleRouteRequest } from '../src/routing';
import { articleSubpath } from '../src/routing/subpath';

class Events {
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(name: string, fn: (...args: any[]) => void) {
    const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set);
    return { name, fn };
  }
  offref(ref: { name: string; fn: (...args: any[]) => void }) { this.listeners.get(ref.name)?.delete(ref.fn); }
  emit(name: string, ...args: any[]) { for (const fn of this.listeners.get(name) ?? []) fn(...args); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
class Leaf {
  view = {};
  state: ViewState;
  ephemeral: Record<string, unknown> = {};
  constructor(path: string, type = 'markdown') { this.state = { type, state: { file: path } }; }
  getViewState() { return this.state; }
  getEphemeralState() { return this.ephemeral; }
  navigate(path: string, type = 'markdown') { this.state = { type, state: { file: path } }; }
}
const article = '---\ntype: article\n---\nText';
async function settle() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup(paths: string[] = ['a.md']) {
  const workspaceEvents = new Events(), metadataEvents = new Events();
  const leaves = paths.map(path => new Leaf(path));
  const texts = new Map(paths.map(path => [path, article]));
  const cache = new Map<string, CachedMetadata>();
  let layoutReady = () => {};
  const workspace = Object.assign(workspaceEvents, {
    activeLeaf: leaves[0],
    // Native traversal stops within a workspace branch on a truthy result.
    iterateAllLeaves: (fn: (leaf: Leaf) => unknown) => { for (const leaf of leaves) if (fn(leaf)) break; },
    onLayoutReady: (fn: () => void) => { layoutReady = fn; },
  });
  const metadataCache = Object.assign(metadataEvents, { getFileCache: (file: { path: string }) => cache.get(file.path) ?? null });
  const read = vi.fn(async (file: { path: string }) => texts.get(file.path)!);
  const vault = { getFileByPath: (path: string) => texts.has(path) ? { path, extension: path.split('.').pop() } : null, read };
  const open = vi.fn(async (leaf: WorkspaceLeaf, request: ArticleRouteRequest) => {
    if (!request.isCurrent()) return;
    (leaf as unknown as Leaf).navigate(request.path, 'reader'); workspace.emit('layout-change');
    expect(request.isCurrent()).toBe(true);
  });
  const error = vi.fn();
  const routing = installArticleRouting({ app: { workspace, metadataCache, vault } as unknown as App, openReaderInLeaf: open, onError: error });
  const changed = (path = 'a.md') => metadataEvents.emit('changed', { path });
  return { workspace, metadataCache, leaves, texts, read, open, routing, changed, ready: () => layoutReady(), cache, error };
}

describe('article routing through public workspace events', () => {
  it('routes article file-open into the existing intended split/tab, not activeLeaf', async () => {
    const s = setup(['normal.md', 'a.md']); s.texts.set('normal.md', 'ordinary note');
    s.workspace.emit('file-open', { path: 'a.md' }); await settle();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.open.mock.calls[0][0]).toBe(s.leaves[1]); expect(s.open.mock.calls[0][1].path).toBe('a.md');
    expect(s.workspace.activeLeaf).toBe(s.leaves[0]); expect(s.leaves[0].state.type).toBe('markdown');
    s.routing.dispose();
  });
  it.each(['file-open', 'layout-change'])('routes newly appended article leaves beyond an existing Reader on %s', async event => {
    const s = setup(['existing.md']); s.ready(); await settle();
    const normal = new Leaf('normal.md'), first = new Leaf('new-tab.md'), second = new Leaf('new-split.md');
    s.leaves.push(normal, first, second); s.texts.set('normal.md', 'ordinary note');
    s.texts.set('new-tab.md', article); s.texts.set('new-split.md', article); s.workspace.activeLeaf = second;
    s.workspace.emit(event, { path: 'new-split.md' }); await settle();
    expect(s.open.mock.calls.map(call => call[1].path)).toEqual(['existing.md', 'new-tab.md', 'new-split.md']);
    expect(first.state.type).toBe('reader'); expect(second.state.type).toBe('reader');
    expect(normal.state.type).toBe('markdown'); expect(s.workspace.activeLeaf).toBe(second); s.routing.dispose();
  });
  it.each(['ordinary note', '---\ntype: feed\n---', '---\ntype: Article\n---', '---\ntype: [article]\n---', '---\ntype: article\ntype: feed\n---', '---\ntype: article', '---\n- article\n---'])('leaves nonarticle or invalid YAML in Markdown: %s', async text => {
    const s = setup(); s.texts.set('a.md', text); s.cache.set('a.md', { frontmatter: { type: 'article' } });
    s.ready(); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('reads fresh capture YAML without metadata cache, even with generic source mode', async () => {
    const s = setup(); s.leaves[0].state.state!.mode = 'source';
    s.workspace.emit('file-open', { path: 'a.md' }); await settle();
    expect(s.open).toHaveBeenCalledTimes(1); s.routing.dispose();
  });
  it('retries unfinished/new metadata without requiring another file open', async () => {
    const s = setup(); s.texts.set('a.md', '---\ntype:'); s.ready(); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.texts.set('a.md', article); s.changed(); await settle();
    expect(s.open).toHaveBeenCalledTimes(1); s.routing.dispose();
  });
  it('ignores embeds/file events with no matching article Markdown pane', async () => {
    const s = setup(['normal.md']); s.texts.set('normal.md', 'normal'); s.texts.set('embedded.md', article);
    s.workspace.emit('file-open', { path: 'embedded.md' }); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('drops a stale async read if the user changed this leaf path', async () => {
    const s = setup(), pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise);
    s.ready(); s.leaves[0].navigate('other.md'); pending.resolve(article); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('does not resurrect an older A→B→A request', async () => {
    const s = setup(), pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise); s.ready();
    s.leaves[0].navigate('other.md'); s.workspace.emit('file-open');
    s.leaves[0].navigate('a.md'); s.workspace.emit('file-open'); await settle();
    pending.resolve(article); await settle(); expect(s.open).toHaveBeenCalledTimes(1); s.routing.dispose();
  });
  it('does not focus another pane when the user switches leaves during read', async () => {
    const s = setup(['a.md', 'normal.md']), pending = deferred<string>(); s.texts.set('normal.md', 'normal');
    s.read.mockReturnValueOnce(pending.promise); s.ready(); s.workspace.activeLeaf = s.leaves[1];
    s.workspace.emit('active-leaf-change', s.leaves[1]); pending.resolve(article); await settle();
    expect(s.open.mock.calls[0][0]).toBe(s.leaves[0]); expect(s.workspace.activeLeaf).toBe(s.leaves[1]); s.routing.dispose();
  });
  it('deduplicates file, layout, active-leaf and metadata recursion', async () => {
    const s = setup(); s.ready(); s.workspace.emit('file-open'); s.workspace.emit('layout-change');
    s.workspace.emit('active-leaf-change'); await settle(); s.changed(); s.workspace.emit('file-open'); await settle();
    expect(s.open).toHaveBeenCalledTimes(1); expect(s.read).toHaveBeenCalledTimes(1); s.routing.dispose();
  });
  it('restores each article pane independently at layout-ready, leaving normal notes alone', async () => {
    const s = setup(['a.md', 'b.md', 'normal.md']); s.texts.set('normal.md', 'normal'); s.ready(); await settle();
    expect(s.open.mock.calls.map(call => call[1].path)).toEqual(['a.md', 'b.md']); s.routing.dispose();
  });
  it('never reads missing files or non-Markdown files', async () => {
    const s = setup(['a.md', 'image.png']); s.texts.delete('a.md'); s.ready(); await settle();
    expect(s.open).not.toHaveBeenCalled(); expect(s.read).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('invalidates in-flight routing on leaf unload', async () => {
    const s = setup(), pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise); s.ready();
    s.leaves.splice(0); s.workspace.emit('layout-change'); pending.resolve(article); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('unregisters listeners, invalidates pending work, and makes late layout-ready inert', async () => {
    const s = setup(), pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise);
    s.workspace.emit('file-open'); s.routing.dispose(); s.routing.dispose(); pending.resolve(article); s.ready(); await settle();
    expect(s.workspace.count()).toBe(0); expect(s.metadataCache.count()).toBe(0); expect(s.open).not.toHaveBeenCalled();
  });
  it('invalidates callback follow-up work after navigation while Reader loads', async () => {
    const s = setup(), pending = deferred<void>(); let request: ArticleRouteRequest | undefined;
    s.open.mockImplementationOnce(async (leaf, next) => {
      request = next; (leaf as unknown as Leaf).navigate(next.path, 'reader');
      s.workspace.emit('layout-change'); await pending.promise;
    });
    s.ready(); await settle(); expect(request?.isCurrent()).toBe(true);
    s.leaves[0].navigate('other.md'); s.workspace.emit('file-open');
    expect(request?.isCurrent()).toBe(false); pending.resolve(); await settle(); s.routing.dispose();
  });
  it('reports read errors without replacing Markdown', async () => {
    const s = setup(); s.read.mockRejectedValueOnce(new Error('read failed')); s.ready(); await settle();
    expect(s.error).toHaveBeenCalledOnce(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
});

describe('explicit Markdown intent', () => {
  it('is scoped per leaf/path, survives metadata/focus changes, and expires after navigation', async () => {
    const s = setup(['a.md', 'a.md']); s.routing.preserveMarkdown(s.leaves[0] as unknown as WorkspaceLeaf, 'a.md');
    s.ready(); await settle(); s.changed(); s.workspace.emit('active-leaf-change'); await settle();
    expect(s.leaves[0].state.type).toBe('markdown'); expect(s.leaves[1].state.type).toBe('reader');
    s.leaves[0].navigate('normal.md'); s.workspace.emit('file-open');
    s.leaves[0].navigate('a.md'); s.workspace.emit('file-open'); await settle();
    expect(s.open).toHaveBeenCalledTimes(2); s.routing.dispose();
  });
  it('reserves a one-shot bypass before Reader becomes Markdown and persists for editing', async () => {
    const s = setup(); s.leaves[0].navigate('a.md', 'reader');
    s.routing.preserveMarkdown(s.leaves[0] as unknown as WorkspaceLeaf, 'a.md'); s.ready(); await settle();
    s.leaves[0].navigate('a.md'); s.workspace.emit('file-open'); s.changed(); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('cancels a pending metadata read when explicit editing wins', async () => {
    const s = setup(), pending = deferred<string>(); s.read.mockReturnValueOnce(pending.promise); s.ready();
    s.routing.preserveMarkdown(s.leaves[0] as unknown as WorkspaceLeaf, 'a.md'); pending.resolve(article); await settle();
    expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('drops an unused reservation if the user navigates elsewhere first', async () => {
    const s = setup(); s.leaves[0].navigate('a.md', 'reader');
    s.routing.preserveMarkdown(s.leaves[0] as unknown as WorkspaceLeaf, 'a.md');
    s.leaves[0].navigate('other.md'); s.workspace.emit('file-open');
    s.leaves[0].navigate('a.md'); s.workspace.emit('file-open'); await settle();
    expect(s.open).toHaveBeenCalledOnce(); s.routing.dispose();
  });
  it('supports cancelling an unsuccessful explicit Markdown open', async () => {
    const s = setup(); const cancel = s.routing.preserveMarkdown(s.leaves[0] as unknown as WorkspaceLeaf, 'a.md'); cancel();
    s.ready(); await settle(); expect(s.open).toHaveBeenCalledOnce(); s.routing.dispose();
  });
});

describe('queue renames', () => {
  it('keeps explicit Markdown intent at the moved path', async () => {
    const from = 'Reading/Inbox/261009 Note.md', to = 'Reading/Later/261009 Note.md', s = setup([from]);
    s.routing.preserveMarkdown(s.leaves[0] as unknown as WorkspaceLeaf, from);
    s.routing.remapPath(from, to); s.texts.set(to, article); s.texts.delete(from); s.leaves[0].navigate(to);
    s.ready(); s.changed(to); await settle(); expect(s.open).not.toHaveBeenCalled(); s.routing.dispose();
  });
  it('invalidates an old-path read and routes only the new path', async () => {
    const from = 'Reading/Inbox/261009 Note.md', to = 'Reading/Later/261009 Note.md', s = setup([from]), pending = deferred<string>();
    s.read.mockReturnValueOnce(pending.promise); s.ready(); s.routing.remapPath(from, to);
    s.texts.set(to, article); s.texts.delete(from); s.leaves[0].navigate(to); s.workspace.emit('file-open'); await settle();
    pending.resolve(article); await settle(); expect(s.open.mock.calls.map(call => call[1].path)).toEqual([to]); s.routing.dispose();
  });
  it('routes explicit type article anywhere and never infers identity from a URL', async () => {
    const paths = ['Reading/Inbox/Note.md', 'Reading/Later/Note.md', 'Reading/Stream/Note.md', 'Reading/Treasury/Note.md', 'Reading/Wires/Subscription.md', 'Reading/Other/Note.md'];
    const explicit = setup(paths);
    for (const path of paths) explicit.texts.set(path, '---\ntype: article\nurl: https://example.com/article\n---\n');
    explicit.ready(); await settle(); expect(explicit.open.mock.calls.map(call => call[1].path)).toEqual(paths); explicit.routing.dispose();
    const untyped = setup(paths);
    for (const path of paths) untyped.texts.set(path, '---\nurl: https://example.com/article\n---\n');
    untyped.ready(); await settle(); expect(untyped.open).not.toHaveBeenCalled(); untyped.routing.dispose();
  });
});

describe('article deep links', () => {
  it('preserves explicit block subpaths and full ephemeral state', async () => {
    const s = setup(); s.leaves[0].ephemeral = { subpath: '#^hl-example', line: 23, focus: false };
    s.ready(); await settle(); const request = s.open.mock.calls[0][1];
    expect(request.subpath).toBe('#^hl-example'); expect(request.ephemeralState).toEqual(s.leaves[0].ephemeral); s.routing.dispose();
  });
  it('maps a resolved link location to an exact native cached block', () => {
    const cache: CachedMetadata = { blocks: { 'hl-example': { id: 'hl-example', position: { start: { line: 23, col: 0, offset: 100 }, end: { line: 24, col: 0, offset: 120 } } } } };
    expect(articleSubpath({ startLoc: { line: 23 } }, cache)).toBe('#^hl-example');
    expect(articleSubpath({ line: 23 }, cache)).toBe('#^hl-example');
    expect(articleSubpath({ line: 24 }, cache)).toBeUndefined();
    expect(articleSubpath({ scroll: 23 }, cache)).toBeUndefined();
    expect(articleSubpath({ line: 23 }, null)).toBeUndefined();
  });
});

// @vitest-environment node
import {
  mocks,
  defaultHighlightPath,
  hostFixture,
  enableHighlightHost,
  enableTypedTopics,
  pluginFixture,
  expectedHosted,
  menu,
} from './helpers/reader-view-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileView, MarkdownView, TFile } from 'obsidian';
import { defaultFolders, type ReaderFolders } from '../src/core/folders';
import { createDocument, patchProperties, readDocument } from '../src/core/document';
import { hostSelection, paragraphAnchors } from '../src/core/hosted-highlights';
import { READER_VIEW, ReaderView } from '../src/reader/view';
import ReaderPlugin from '../src/main';
import { gate } from './helpers/memory-vault';

describe('Reader operation and close lifecycle', () => {
  it('uses the plugin-namespaced view registry without selecting unrelated generic reader leaves', async () => {
    const f = await pluginFixture();
    f.leaves.push({ view: { getViewType: () => 'reader' } });
    const leaves = vi.spyOn(f.app.workspace, 'getLeavesOfType');
    expect(f.view.getViewType()).toBe('obsidian-reader');
    expect(f.pluginProbe.views()).toEqual([f.view]);
    expect(leaves).toHaveBeenCalledWith('obsidian-reader');
  });

  it('serializes a slow move before navigation without mixing snapshots and bodies', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md', 'article A'),
      b = await f.note('Reading/Inbox/B.md', 'article B');
    await f.view.openArticle(a.path);
    const started = gate(),
      finish = gate();
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      started.resolve();
      await finish.promise;
      return process(file, update);
    });
    mocks.choose.mockResolvedValue('Later');
    const moving = f.probe.move();
    await started.promise;
    const navigating = f.view.openArticle(b.path);
    expect(f.view.file).toBe(a);
    finish.resolve();
    await Promise.all([moving, navigating]);
    expect(f.view.file).toBe(b);
    expect(f.probe.surface.body.textContent).toBe('article B');
  });

  it('saves position on close without annotating native selection', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md');
    await enableHighlightHost(f, file);
    await f.view.openArticle(file.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    surface.marker = 'words';
    f.probe.selectionChanged();
    await f.view.onClose();
    const saved = readDocument(await f.vault.read(file));
    expect(saved.body).toBe('before words after');
    expect(saved.properties.bookmark).toBe('words');
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(f.probe.surface).toBeUndefined();
  });

  it('Delete & next survives the synchronous native delete notification', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path, true);
    const trash = f.vault.trash.bind(f.vault);
    vi.spyOn(f.vault, 'trash').mockImplementation(async (file) => {
      await trash(file);
      await f.view.changed({ path: file.path, deleted: true });
    });
    await f.probe.finish('delete');
    expect(f.view.file).toBe(b);
    expect(f.vault.trashed).toEqual([a.path]);
  });

  it('cancels queued navigation on close and never mounts a late move result', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path);
    const started = gate(),
      finish = gate();
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      started.resolve();
      await finish.promise;
      return process(file, update);
    });
    mocks.choose.mockResolvedValue('Later');
    const moving = f.probe.move();
    await started.promise;
    const surface = f.probe.surface,
      closing = f.view.onClose(),
      navigating = f.view.openArticle(b.path);
    finish.resolve();
    await Promise.all([moving, closing, navigating]);
    expect(f.view.file).not.toBe(b);
    expect(f.probe.surface).toBeUndefined();
    expect(surface.dispose).toHaveBeenCalledOnce();
  });

  it('ignores a metadata read that completes after navigation', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md', 'new article');
    await f.view.openArticle(a.path);
    const old = await f.store.read(a.path),
      started = gate(),
      finish = gate(),
      read = f.store.read.bind(f.store);
    vi.spyOn(f.store, 'read').mockImplementation(async (path) => {
      if (path === a.path) {
        started.resolve();
        await finish.promise;
        return old;
      }
      return read(path);
    });
    const updating = f.view.changed({ path: a.path });
    await started.promise;
    const navigating = f.view.openArticle(b.path);
    finish.resolve();
    await navigating;
    await updating;
    expect(f.view.file).toBe(b);
    expect(f.probe.surface.body.textContent).toBe('new article');
  });

  it('detaches immediately on unload even when a provider ignores dialog cancellation', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const started = gate(),
      release = gate(),
      surface = f.probe.surface;
    mocks.choose.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return 'Later';
    });
    const moving = f.probe.move();
    await started.promise;
    f.plugin.onunload();
    expect(surface.dispose).toHaveBeenCalledOnce();
    expect(f.probe.surface).toBeUndefined();
    await f.view.onClose(); // Must not wait for the still-pending provider.
    release.resolve();
    await moving;
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(f.probe.surface).toBeUndefined();
  });

  it('keeps both highlights when identical words are selected in different contexts', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md', 'First words end. Second words stop.');
    await enableHighlightHost(f, file);
    await f.view.openArticle(file.path);
    f.probe.surface.selectionValue = {
      quote: 'words',
      before: 'First ',
      after: ' end. Second words stop.',
    };
    const firstExpected = hostSelection(
      'First words end. Second words stop.',
      f.probe.surface.selectionValue,
      [defaultHighlightPath],
    ).body;
    await f.probe.saveSelection();
    expect((await f.store.read(file.path)).body).toBe(firstExpected);
    f.probe.surface.selectionValue = {
      quote: 'words',
      before: 'First words end. Second ',
      after: ' stop.',
    };
    await f.probe.saveSelection();
    const saved = (await f.store.read(file.path)).body;
    expect(saved).toBe(
      hostSelection(firstExpected, f.probe.surface.selectionValue, [defaultHighlightPath]).body,
    );
    expect(paragraphAnchors(saved)).toHaveLength(1);
    expect(paragraphAnchors(saved)[0].blockId).toBe(paragraphAnchors(firstExpected)[0].blockId);
  });
});

describe('public article commands', () => {
  it('opens only the active article source URL in the browser', async () => {
    const f = await pluginFixture();
    const command = (checking = true) => mocks.commands.get('open-url')!.checkCallback!(checking);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const file = await f.note('Reading/Inbox/Source.md');
    expect(command()).toBe(false);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    expect(command()).toBe(false);
    f.vault.bytes.set(
      file,
      createDocument(
        { type: 'article', status: 'inbox', url: 'https://example.com/start#section' },
        'Article',
      ),
    );
    await f.view.openArticle(file.path);
    expect(command()).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(command(false)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/start#section',
      '_blank',
      'noopener,noreferrer',
    );
    for (const url of ['javascript:alert(1)', 'https://user:pass@example.com']) {
      f.vault.bytes.set(file, createDocument({ type: 'article', status: 'inbox', url }, 'Article'));
      await f.view.changed({ path: file.path });
      expect(command()).toBe(false);
      expect(command(false)).toBe(false);
    }
    f.vault.bytes.set(
      file,
      createDocument(
        { type: 'article', status: 'inbox', url: 'https://example.com/new' },
        'Article',
      ),
    );
    await f.view.changed({ path: file.path });
    expect(command(false)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith(
      'https://example.com/new',
      '_blank',
      'noopener,noreferrer',
    );
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(null);
    expect(command(false)).toBe(false);
    f.signal.abort();
    expect(f.view.articleCommand('open-url', false)).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
    f.view.stopForUnload();
  });

  it('checks active Reader context without side effects, preserves Move/Topics, and keeps Markdown escape on failure', async () => {
    const f = await pluginFixture();
    const command = (id: string, checking = true) =>
      mocks.commands.get(id)!.checkCallback!(checking);
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id)).toBe(false);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id, false)).toBe(false);
    const article = await f.note('Reading/Inbox/Commands.md');
    enableTypedTopics(f);
    await f.view.openArticle(article.path);
    const before = await f.vault.read(article);
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id)).toBe(true);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.topics).not.toHaveBeenCalled();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    mocks.choose.mockResolvedValue('Later');
    command('move', false);
    await f.probe.operations;
    expect(article.path).toBe('Reading/Later/Commands.md');
    expect((await f.store.read(article.path)).properties.status).toBe('later');
    expect(await f.vault.read(article)).toBe(patchProperties(before, { status: 'later' }));
    command('topics', false);
    await f.probe.operations;
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      expect.any(Object),
      expect.objectContaining({ title: 'Related notes', actionLabel: 'Apply', multiple: true }),
    );
    expect(mocks.topics).not.toHaveBeenCalled();
    f.vault.bytes.set(article, '---\ntype: other\n---\nUnchanged authored words.');
    await f.view.changed({ path: article.path });
    expect(command('move')).toBe(false);
    expect(command('topics')).toBe(false);
    expect(command('open-markdown')).toBe(true);
    f.host.edit = (view: ReaderView, file: TFile) => f.plugin.edit(view, file);
    command('open-markdown', false);
    await f.probe.operations;
    await vi.waitFor(
      () =>
        expect(f.leaf.setViewState).toHaveBeenCalledWith({
          type: 'markdown',
          state: { file: article.path, mode: 'source' },
          active: true,
        }),
      { interval: 1 },
    );
    f.signal.abort();
    for (const id of ['move', 'topics', 'open-markdown']) expect(command(id)).toBe(false);
    f.view.stopForUnload();
  });
});

describe('public dog-ear command and URI', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('moves the dog ear on next navigation without changing either reading-position bookmark', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md', 'first article');
    const second = await f.note('Reading/Inbox/B.md', 'second article');
    await f.view.openArticle(first.path, true);
    expect((await f.store.read(first.path)).properties.dog_ear).toBe(true);
    await f.view.navigate(1);
    expect(f.view.file).toBe(second);
    expect((await f.store.read(first.path)).properties).not.toHaveProperty('dog_ear');
    expect((await f.store.read(second.path)).properties.dog_ear).toBe(true);
    expect((await f.store.read(first.path)).properties).not.toHaveProperty('bookmark');
  });
  it.each(['command', 'uri'])(
    'opens the marked article and falls back to newest Inbox (%s)',
    async (route) => {
      const f = await pluginFixture();
      const older = await f.note('Reading/Inbox/Older.md');
      const newest = await f.note('Reading/Inbox/Newest.md');
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      // Same date: title sorts before path, so Older precedes Newest by title.
      const first = f.store.catalog.list('Inbox', '', 0, 1)[0].path;
      const invoke = () =>
        route === 'command'
          ? mocks.commands.get('open-dog-ear')!.callback!()
          : mocks.protocols.get('obsidian-reader')!({ view: 'dog-ear' });
      invoke();
      await vi.waitFor(() => expect(f.view.file?.path).toBe(first));
      await f.store.dogEar(first === older.path ? newest.path : older.path);
      invoke();
      await vi.waitFor(() =>
        expect(f.view.file?.path).toBe(first === older.path ? newest.path : older.path),
      );
    },
  );
  it('copies a vault-aware shortcut link only on request', async () => {
    const clipboard = { writeText: vi.fn(async (_link: string) => {}) };
    vi.stubGlobal('navigator', { clipboard });
    const f = await pluginFixture();
    vi.mocked(f.app.vault.getName).mockReturnValue('iPhone & Boox');
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await mocks.commands.get('copy-dog-ear-link')!.callback!();
    expect(clipboard.writeText).toHaveBeenCalledWith(
      'obsidian://obsidian-reader?vault=iPhone%20%26%20Boox&view=dog-ear',
    );
  });
});

describe('public reading-list command and URI', () => {
  afterEach(() => vi.unstubAllGlobals());
  const invoke = (route: string) =>
    route === 'command'
      ? mocks.commands.get('open-reader')!.callback!()
      : mocks.protocols.get('obsidian-reader')!({ action: 'obsidian-reader', view: 'list' });

  it.each(['command', 'uri'])(
    'forces the library through the existing lifecycle, draining writes and cancelling navigation scopes (%s)',
    async (route) => {
      const f = await pluginFixture();
      const article = await f.note('Reading/Inbox/Article.md');
      const highlight = await enableHighlightHost(f, article);
      await f.view.openArticle(article.path);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      expect(mocks.commands.get('open-reader')!.name).toBe('Open reading list');
      expect([...mocks.protocols.keys()]).toEqual(['obsidian-reader']);
      const pending = gate();
      f.probe.positionWrite = pending.promise;
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      f.probe.surface.marker = 'words';
      invoke(route);
      expect(f.view.file).toBe(article);
      pending.resolve();
      await f.probe.operations;
      expect(f.view.file).toBeUndefined();
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
      const saved = readDocument(await f.vault.read(article));
      expect(saved.body).toBe('before words after');
      expect(saved.properties.bookmark).toBe('words');
      // Cancel a genuine Reader create intent separately: cancelling a modal's captured
      // selection must not replay that cancelled intent as a fresh automatic highlight.
      await f.view.openArticle(article.path);
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      await f.probe.saveSelection();
      f.probe.surface.selectionValue = undefined;
      f.probe.surface.refresh();
      const beforeCancel = await f.vault.read(article),
        entered = gate();
      let requestSignal!: AbortSignal;
      highlight.api.createNodeForLink = (options) => {
        requestSignal = options.signal!;
        entered.resolve();
        return new Promise(() => {});
      };
      mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'words', type: 'topic' });
      const creating = menu(f.view, 'Notes…');
      await entered.promise;
      invoke(route);
      expect(requestSignal.aborted).toBe(true);
      await f.probe.operations;
      await creating;
      expect(f.view.file).toBeUndefined();
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
      expect(await f.vault.read(article)).toBe(beforeCancel);
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it.each(['command', 'uri'])(
    'keeps a failed source save mounted and reports it through the public %s route',
    async (route) => {
      const f = await pluginFixture();
      const article = await f.note('Reading/Inbox/Article.md');
      await enableHighlightHost(f, article);
      await f.view.openArticle(article.path);
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      const raw = createDocument({ type: 'article' }, 'New externally saved source');
      f.vault.bytes.set(article, raw);
      invoke(route);
      await expect(f.probe.operations).rejects.toThrow();
      await Promise.resolve();
      expect(f.view.file).toBe(article);
      expect(await f.vault.read(article)).toBe(raw);
      expect(mocks.notice).toHaveBeenCalled();
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it('opens a new library without replacing a dirty native editor or clearing its Markdown exemption', async () => {
    const f = await pluginFixture();
    const article = await f.note('Reading/Inbox/Native.md');
    const native = new MarkdownView(f.leaf),
      raw = await f.vault.read(article);
    const editor = { getValue: () => raw + '\nUnsaved native words' };
    Object.assign(native, { file: article, editor });
    f.leaf.view = native;
    f.vault.dirty.add(article);
    const exemption = { file: article, transitioning: false };
    f.pluginProbe.sourceLeaves.set(f.leaf, exemption);
    const leaf: any = { app: f.app, setViewState: vi.fn() };
    const reader = new ReaderView(leaf, f.plugin);
    leaf.view = reader;
    f.leaves.push(leaf);
    leaf.setViewState.mockImplementation(async (state: any) =>
      reader.setState(state.state, { history: false }),
    );
    vi.mocked(f.app.workspace.getLeaf).mockReturnValue(leaf);
    invoke('uri');
    await (reader as any).operations;
    expect(f.app.workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: 'obsidian-reader',
      state: {},
      active: true,
    });
    expect(reader.contentEl.querySelector('.reader-list')).not.toBeNull();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    expect(f.leaf.view).toBe(native);
    expect(editor.getValue()).toBe(raw + '\nUnsaved native words');
    expect(await f.vault.read(article)).toBe(raw);
    expect(f.pluginProbe.sourceLeaves.get(f.leaf)).toBe(exemption);
  });

  it.each([undefined, '', 'article', 'List', 'unknown'])(
    'ignores unsupported URI view %s',
    async (view) => {
      const f = await pluginFixture();
      const open = vi.spyOn(f.plugin, 'openList');
      const params: Record<string, string> = { action: 'obsidian-reader' };
      if (view !== undefined) params.view = view;
      mocks.protocols.get('obsidian-reader')!(params);
      expect(open).not.toHaveBeenCalled();
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it('copies only on explicit command, encoding the current local vault name every time without reading the clipboard', async () => {
    const clipboard = { writeText: vi.fn(async (_text: string) => {}), readText: vi.fn() };
    vi.stubGlobal('navigator', { clipboard, onLine: false });
    const f = await pluginFixture();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(f.app.vault.getName).not.toHaveBeenCalled();
    const command = mocks.commands.get('copy-reading-list-link')!;
    expect(command.name).toBe('Copy reading-list link');
    for (const name of ['iPhone Reading & références / # 日本語', 'Boox local – 阅读']) {
      vi.mocked(f.app.vault.getName).mockReturnValue(name);
      await command.callback!();
      const link = clipboard.writeText.mock.calls.at(-1)![0];
      expect(link).toBe(`obsidian://obsidian-reader?vault=${encodeURIComponent(name)}&view=list`);
      const url = new URL(link);
      expect(url.protocol).toBe('obsidian:');
      expect(url.hostname).toBe('obsidian-reader');
      expect([...url.searchParams]).toEqual([
        ['vault', name],
        ['view', 'list'],
      ]);
      expect(url.hash).toBe('');
      expect(mocks.notice).toHaveBeenLastCalledWith('Reading-list link copied.');
    }
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'denied'])(
    'reports %s clipboard support without an unhandled error or navigation',
    async (mode) => {
      const writeText = vi.fn(async () => {
        throw new Error('Permission denied');
      });
      vi.stubGlobal('navigator', {
        clipboard: mode === 'unsupported' ? undefined : { writeText },
        onLine: false,
      });
      const f = await pluginFixture();
      await mocks.commands.get('copy-reading-list-link')!.callback!();
      expect(mocks.notice).toHaveBeenCalledWith(
        mode === 'unsupported'
          ? 'Clipboard is unavailable on this device. Reading-list link was not copied.'
          : 'Could not copy the reading-list link: Permission denied',
      );
      expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    },
  );

  it('ignores late commands and URI callbacks after unload', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText }, onLine: false });
    const f = await pluginFixture();
    f.plugin.onunload();
    invoke('command');
    invoke('uri');
    await mocks.commands.get('copy-reading-list-link')!.callback!();
    expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('safe default article routing', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  async function fixture(type = 'article', path = 'Outside/Article.md') {
    const f = await pluginFixture();
    const file = await f.note(path, 'Authored body', type);
    const native = new MarkdownView(f.leaf);
    const editor = { getValue: vi.fn(() => f.vault.bytes.get(file)!) };
    Object.assign(native, { file, editor });
    (file as any).stat = { mtime: 1, ctime: 1, size: f.vault.bytes.get(file)!.length };
    f.leaf.view = native;
    vi.mocked(f.app.workspace.getActiveViewOfType).mockImplementation((constructor: any) =>
      f.leaf.view instanceof constructor ? f.leaf.view : null,
    );
    f.leaf.setViewState.mockImplementation(async (state: any) => {
      if (state.type === 'obsidian-reader') f.leaf.view = f.view;
    });
    return { ...f, file, native, editor };
  }
  it.each(['article', 'Project', 'PhoneTask', 'note', 'Article'])(
    'routes only exact real type: article, including outside queues (%s)',
    async (type) => {
      const f = await fixture(type);
      const raw = await f.vault.read(f.file);
      f.workspace('file-open', f.file);
      await settle();
      if (type === 'article')
        expect(f.leaf.setViewState).toHaveBeenCalledExactlyOnceWith({
          type: 'obsidian-reader',
          state: { file: f.file.path },
        });
      else expect(f.leaf.setViewState).not.toHaveBeenCalled();
      expect(await f.vault.read(f.file)).toBe(raw);
    },
  );
  it('does not classify a folder name or stale cached article type as article', async () => {
    const f = await fixture('Project', 'Reading/Inbox/Project.md');
    f.cache.get(f.file).frontmatter.type = 'article';
    f.workspace('file-open', f.file);
    f.metadata('changed', f.file);
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
  });
  it('can route from fresh bytes despite missing metadata; deferred editor/metadata readiness retries safely', async () => {
    const f = await fixture();
    f.cache.delete(f.file);
    f.editor.getValue.mockReturnValue('');
    f.workspace('file-open', f.file);
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    f.editor.getValue.mockReturnValue(f.vault.bytes.get(f.file)!);
    f.metadata('changed', f.file);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledOnce();
    f.metadata('changed', f.file);
    f.workspace('active-leaf-change', f.leaf);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledOnce();
  });
  it.each([
    'dirty',
    'missing-editor',
    'throwing-editor',
    'modal',
    'property-field',
    'property-title',
    'selection',
  ])('never replaces an uncertain native editor (%s)', async (condition) => {
    const f = await fixture();
    if (condition === 'dirty') f.editor.getValue.mockReturnValue('Unsaved native changes');
    if (condition === 'missing-editor') (f.native as any).editor = undefined;
    if (condition === 'throwing-editor')
      f.editor.getValue.mockImplementation(() => {
        throw new Error('not ready');
      });
    if (condition === 'modal') document.body.createDiv({ cls: 'modal-container' });
    if (condition === 'property-field') document.body.createEl('input').focus();
    if (condition === 'property-title') {
      const title = document.body.createDiv({ attr: { contenteditable: 'true', tabindex: '0' } });
      title.focus();
    }
    if (condition === 'selection') {
      const text = document.body.createEl('p', { text: 'Native selected words' });
      const range = document.createRange();
      range.selectNodeContents(text);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      expect(document.getSelection()!.isCollapsed).toBe(false);
    }
    f.workspace('file-open', f.file);
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
    expect(f.leaf.view).toBe(f.native);
  });
  it('can route a focused native source editor once its public bytes are proven clean', async () => {
    const f = await fixture();
    const editor = document.body.createDiv({ attr: { contenteditable: 'true', tabindex: '0' } });
    editor.focus();
    Object.assign(f.editor, { hasFocus: () => true });
    f.workspace('file-open', f.file);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledOnce();
  });
  it.each([
    'dirty',
    'file-change',
    'replace',
    'rename',
    'revision',
    'background',
    'round-trip',
    'unload',
  ])('rejects a deferred routing result after %s', async (condition) => {
    const f = await fixture();
    const raw = f.vault.bytes.get(f.file)!;
    const started = gate(),
      release = gate();
    vi.spyOn(f.vault, 'read').mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return raw;
    });
    f.workspace('file-open', f.file);
    await started.promise;
    if (condition === 'dirty') f.editor.getValue.mockReturnValue(raw + '\nUnsaved');
    if (condition === 'file-change')
      (f.native as any).file = await f.note('Notes/Other.md', '', 'Project');
    if (condition === 'replace') f.vault.files.set(f.file.path, {} as any);
    if (condition === 'rename') f.file.path = 'Outside/Renamed.md';
    if (condition === 'revision') f.file.stat.mtime++;
    if (condition === 'background' || condition === 'round-trip') {
      vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(null);
      f.workspace('active-leaf-change', null);
      if (condition === 'round-trip')
        vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.native);
    }
    if (condition === 'unload') f.plugin.onunload();
    release.resolve();
    await settle();
    expect(f.leaf.setViewState).not.toHaveBeenCalled();
  });
  it('preserves explicit Markdown intent across metadata and active-leaf events without persisting view state', async () => {
    const f = await fixture();
    f.leaf.view = f.view;
    await f.view.openArticle(f.file.path);
    f.leaf.setViewState.mockImplementation(async () => {
      f.leaf.view = f.native;
      f.workspace('file-open', f.file);
    });
    await f.plugin.edit(f.view, f.file);
    f.metadata('changed', f.file);
    f.metadata('resolve', f.file);
    f.workspace('active-leaf-change', f.leaf);
    await settle();
    expect(f.leaf.setViewState).toHaveBeenCalledExactlyOnceWith({
      type: 'markdown',
      state: { file: f.file.path, mode: 'source' },
      active: true,
    });
    expect(f.view.getState()).toEqual({ file: f.file.path, queue: 'Inbox' });
  });
});

describe('native title-only presentation', () => {
  it('refreshes cloned state without history, remounting, or prefixing the article heading', async () => {
    const f = hostFixture(),
      file = await f.note('Reading/Inbox/A.md');
    f.host.refreshPresentation = () =>
      f.leaf.setViewState({ type: READER_VIEW, state: { readerPresentationOnly: true } });
    f.leaf.setViewState.mockImplementation(async ({ state }: any) => {
      const result = { history: true };
      await f.view.setState(JSON.parse(JSON.stringify(state)), result);
      expect(result.history).toBe(false);
    });
    await f.view.openArticle(file.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const selection = surface.selectionValue;
    expect(f.view.getDisplayText()).toBe('Reader: A');
    f.vault.bytes.set(file, patchProperties(await f.vault.read(file), { title: 'External title' }));
    await f.view.changed({ path: file.path });
    expect(f.view.getDisplayText()).toBe('Reader: External title');
    expect(surface.title.textContent).toBe('External title');
    expect(f.probe.surface).toBe(surface);
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(surface.selectionValue).toBe(selection);
    expect(f.view.getState()).not.toHaveProperty('readerPresentationOnly');
    surface.selectionValue = undefined;
    await f.view.readingList();
    expect(f.view.getDisplayText()).toBe('Reading list');
  });
  it('never replays an old article or swallows navigation when delayed title requests arrive', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    const requests: { state: Record<string, unknown>; done: ReturnType<typeof gate> }[] = [];
    f.host.refreshPresentation = () =>
      f.leaf.setViewState({ type: READER_VIEW, state: { readerPresentationOnly: true } });
    f.leaf.setViewState.mockImplementation(({ state }: any) => {
      const done = gate();
      requests.push({ state: JSON.parse(JSON.stringify(state)), done });
      return done.promise;
    });
    await f.view.openArticle(a.path);
    await f.view.setState({ file: b.path, queue: 'Inbox' }, { history: false });
    const surface = f.probe.surface;
    expect(requests).toHaveLength(2);
    for (const request of requests.reverse()) {
      const result = { history: true };
      await f.view.setState(request.state, result);
      request.done.resolve();
      expect(result.history).toBe(false);
      expect(f.view.file).toBe(b);
      expect(f.probe.surface).toBe(surface);
    }
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.getState()).toEqual({ file: b.path, queue: 'Inbox' });
  });
});

describe('folder-authoritative queue presentation', () => {
  it.each([
    ['Reading/Stream/Misleading.md', {}, 'Feed', 'later', 'Reading/Later/Misleading.md'],
    [
      'Reading/Stream/Misleading.md',
      { status: 'inbox' },
      'Feed',
      'later',
      'Reading/Later/Misleading.md',
    ],
    [
      'Reading/Inbox/Misleading.md',
      { status: 'feed' },
      'Inbox',
      'feed',
      'Reading/Inbox/Misleading.md',
    ],
    [
      'Reading/Later/Misleading.md',
      { status: 'archive' },
      'Later',
      'archive',
      'Reading/Later/Misleading.md',
    ],
    [
      'Reading/Treasury/Misleading.md',
      { status: 'later' },
      'Archive',
      'later',
      'Reading/Treasury/Misleading.md',
    ],
    [
      'Unrelated/Inbox/Misleading.md',
      { status: 'inbox' },
      undefined,
      'inbox',
      'Unrelated/Inbox/Misleading.md',
    ],
  ] as const)(
    'folder wins over YAML and Feed annotation retains before saving: %s %j',
    async (path, properties, queue, savedStatus, finalPath) => {
      const f = hostFixture(),
        article = await f.note(path);
      const raw = createDocument({ type: 'article', ...properties }, 'before words after');
      f.vault.bytes.set(article, raw);
      f.store.catalog.update(article.path, readDocument(raw).properties);
      expect(f.store.catalog.article(article.path)?.queue).toBe(queue);
      await enableHighlightHost(f);
      await f.view.openArticle(article.path);
      expect(await f.vault.read(article)).toBe(patchProperties(raw, { dog_ear: true }));
      f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
      await f.probe.saveSelection();
      const saved = await f.store.read(article.path);
      expect(saved.properties.status).toBe(savedStatus);
      expect(saved.body).toBe(expectedHosted('before ==words== after'));
      expect(article.path).toBe(finalPath);
      expect(f.store.catalog.article(article.path)?.queue).toBe(queue === 'Feed' ? 'Later' : queue);
    },
  );

  it('refreshes status-only metadata without remounting the article content', async () => {
    const f = hostFixture(),
      article = await f.note('Elsewhere/Article.md');
    await f.view.openArticle(article.path, true);
    const surface = f.probe.surface;
    surface.setBody.mockClear();
    await f.vault.process(article, (raw) => patchProperties(raw, { status: 'archive' }));
    await f.view.changed({ path: article.path, metadataChanged: true });
    expect(f.probe.snapshot.properties.status).toBe('archive');
    expect(f.probe.surface).toBe(surface);
    expect(surface.setBody).not.toHaveBeenCalled();
    expect(surface.dispose).not.toHaveBeenCalled();
    expect(f.view.getState()).toEqual({ file: article.path, queue: 'Inbox' });
    expect(
      f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
    ).not.toBeNull();
  });

  it.each([undefined, 'words'])(
    'resumes bookmark only, never legacy position: %s',
    async (bookmark) => {
      const f = hostFixture(),
        article = await f.note('Elsewhere/Article.md');
      await f.vault.process(article, (raw) =>
        patchProperties(raw, { bookmark, reading_position: 'before' }),
      );
      const original = await f.vault.read(article);
      await f.view.openArticle(article.path);
      expect(f.probe.surface.restore).toHaveBeenCalledWith(bookmark ?? '');
      expect(await f.vault.read(article)).toBe(patchProperties(original, { dog_ear: true }));
    },
  );
});

describe('browsing context and presentation', () => {
  it('refreshes the native list title when a filter changes or clears without persisting it', () => {
    const f = hostFixture();
    const refresh = vi.fn(async () => {});
    f.host.refreshPresentation = refresh;
    f.view.showList();
    expect(f.view.getDisplayText()).toBe('Reading list');
    f.probe.topicFilter = { label: 'sea level', terms: ['sea level'] };
    f.view.showList();
    expect(f.view.getDisplayText()).toBe('Reading list: sea level');
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(f.view.getState()).toEqual({ file: undefined, queue: 'Inbox' });
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    f.view.stopForUnload();
  });
  it('returns a promoted article to the filtered list before clearing via the filter toggle', async () => {
    const f = hostFixture();
    const before = await f.note('Reading/Stream/A.md', 'sea level');
    const current = await f.note('Reading/Stream/B.md', 'sea level');
    const after = await f.note('Reading/Stream/C.md', 'sea level');
    const topic = await f.note('Topics/Sea.md', '', 'topic');
    for (const file of f.vault.files.values())
      Object.assign(file, { stat: { mtime: 1, size: f.vault.bytes.get(file)!.length } });
    f.probe.topicFilter = { label: 'sea level', terms: ['sea level'] };
    f.view.showList('Feed');
    for (let i = 0; i < 100; i++) await Promise.resolve();
    const api = enableTypedTopics(f);
    await f.view.openArticle(current.path, true);
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'existing-many',
      nodes: [api.getNode(topic.path)!],
    });
    await f.probe.topics();
    expect((await f.store.read(current.path)).properties.status).toBe('later');
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    await f.view.readingList();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(f.view.getDisplayText()).toBe('Reading list: sea level');
    const write = vi.spyOn(f.vault, 'process');
    f.host.ingestion.acquire.mockClear();
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Filter by topic"]')!.click();
    expect(f.view.getDisplayText()).toBe('Reading list');
    expect(f.probe.topicFilter).toBeUndefined();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
    await f.view.openArticle(before.path, true);
    await f.view.navigate(1);
    expect(f.view.file).toBe(after);
    f.view.stopForUnload();
  });
  it('navigates the actual filtered article snapshot next/previous and returns to the filtered list', async () => {
    const f = hostFixture();
    const first = await f.note('Reading/Inbox/A.md', 'sea level');
    await f.note('Reading/Inbox/B.md', 'unrelated');
    const last = await f.note('Reading/Inbox/C.md', 'SEA LEVEL');
    for (const file of f.vault.files.values())
      Object.assign(file, { stat: { mtime: 1, size: f.vault.bytes.get(file)!.length } });
    f.probe.topicFilter = { label: 'sea level', terms: ['sea level'] };
    f.view.showList();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    await f.view.openArticle(first.path, true);
    await f.view.navigate(1);
    expect(f.view.file).toBe(last);
    await f.view.navigate(-1);
    expect(f.view.file).toBe(first);
    expect(f.view.getDisplayText()).toBe('Reader: A');
    expect(f.view.contentEl.querySelector('.reader-topic-filter-state')).toBeNull();
    await f.view.readingList();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(f.probe.topicFilter.label).toBe('sea level');
    expect(f.view.getDisplayText()).toBe('Reading list: sea level');
    f.view.stopForUnload();
  });
  it.each(['Inbox', 'Feed', 'Later', 'Archive'] as const)(
    'command-palette move to Later stays on the article from %s',
    async (queue) => {
      const folders = { ...defaultFolders, articles: 'Queues/Articles' };
      const f = hostFixture(folders);
      const folder = `Reading/${{ Inbox: 'Inbox', Feed: 'Stream', Later: 'Later', Archive: 'Treasury' }[queue]}`;
      const article = await f.note(`${folder}/A.md`, 'Article A'),
        next = await f.note(`${folder}/B.md`, 'Article B');
      f.view.showList(queue);
      await f.view.openArticle(article.path, true);
      const surface = f.probe.surface;
      surface.marker = 'Article A';
      const move = vi.spyOn(f.store, 'move');
      f.host.ingestion.acquire.mockClear();
      expect(
        f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
      ).not.toBeNull();
      mocks.choose.mockResolvedValueOnce('Later');
      await f.probe.move();
      expect(mocks.choose).toHaveBeenCalledWith(
        f.app,
        'Change article status…',
        ['Inbox', 'Later', 'Feed', 'Archive'],
        expect.any(Function),
        expect.any(AbortSignal),
      );
      expect(move).toHaveBeenCalledWith(expect.anything(), 'Later');
      expect(article.path).toBe('Reading/Later/A.md');
      expect((await f.store.read(article.path)).properties.status).toBe('later');
      expect(f.view.file).toBe(article);
      expect(f.probe.surface).toBe(surface);
      expect(f.view.getState()).toEqual({ file: article.path, queue });
      const saved = readDocument(await f.vault.read(article));
      expect(saved.body).toBe('Article A');
      expect(saved.properties.bookmark).toBe('Article A');
      expect(f.host.ingestion.acquire).toHaveBeenCalledWith(article.path);
      expect(mocks.notice).toHaveBeenCalledWith('Saved to Later');
      mocks.choose.mockResolvedValueOnce('Later');
      await f.probe.move();
      expect(article.path).toBe('Reading/Later/A.md');
      expect((await f.store.read(article.path)).properties.status).toBe('later');
      await f.view.navigate(1);
      expect(f.view.file).toBe(next);
      await f.view.readingList();
      expect(f.view.getState().queue).toBe(queue);
    },
  );

  it('rejects a status choice when the displayed source has changed', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    const external = createDocument({ type: 'article' }, 'External edit');
    f.vault.bytes.set(article, external);
    mocks.choose.mockResolvedValueOnce('Later');
    f.view.contentEl
      .querySelector<HTMLButtonElement>('[aria-label^="Change status and advance"]')!
      .click();
    await Promise.resolve(); // Let the selected choice queue the guarded write.
    await expect(f.probe.operations).rejects.toThrow();
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(await f.vault.read(article)).toBe(external);
    expect(f.view.file).toBe(article);
    expect(
      f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
    ).not.toBeNull();
    expect(mocks.notice).not.toHaveBeenCalledWith('Saved to Later');
  });

  it('does not acknowledge Later when YAML saves but the folder move fails', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    f.vault.failMove = true;
    mocks.choose.mockResolvedValueOnce('Later');
    f.view.contentEl
      .querySelector<HTMLButtonElement>('[aria-label^="Change status and advance"]')!
      .click();
    await Promise.resolve();
    await expect(f.probe.operations).rejects.toThrow('Move failed');
    expect((await f.store.read(article.path)).properties.status).toBe('later');
    expect(article.path).toBe('Reading/Inbox/A.md');
    expect(
      f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
    ).not.toBeNull();
    expect(mocks.notice).not.toHaveBeenCalledWith('Saved to Later');
  });

  it('keeps the status picker after external folder moves and YAML changes without remounting', async () => {
    const f = hostFixture();
    const article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path, true);
    const surface = f.probe.surface;
    const expectControls = () => {
      expect(
        f.view.contentEl.querySelector('[aria-label^="Change status and advance"]'),
      ).not.toBeNull();
      expect(f.probe.surface).toBe(surface);
    };
    // YAML alone cannot retain an Inbox article.
    await f.vault.process(article, (raw) => patchProperties(raw, { status: 'later' }));
    f.store.catalog.update(article.path, readDocument(await f.vault.read(article)).properties);
    await f.view.changed({ path: article.path, metadataChanged: true });
    expectControls();
    // Folder moves change queue membership without rewriting the stale YAML.
    for (const folder of ['Later', 'Treasury', 'Later', 'Outside']) {
      const previousPath = article.path;
      await f.vault.move(article, `Reading/${folder}/A.md`);
      f.store.catalog.rename(
        previousPath,
        article.path,
        readDocument(await f.vault.read(article)).properties,
      );
      await f.view.changed({ path: article.path, previousPath, metadataChanged: true });
      expectControls();
      if (folder === 'Later') {
        await f.vault.process(article, (raw) => patchProperties(raw, { status: 'archive' }));
        f.store.catalog.update(article.path, readDocument(await f.vault.read(article)).properties);
        await f.view.changed({ path: article.path, metadataChanged: true });
        expectControls();
      }
    }
    expect(mocks.notice).not.toHaveBeenCalledWith('Saved to Later');
  });

  it('keeps capture placement independent from Feed browsing and explicit Archive', async () => {
    const folders: ReaderFolders = {
      articles: 'Cache/Feed',
      feeds: 'Subscriptions',
    };
    const f = hostFixture(folders);
    const a = await f.note('Reading/Stream/A.md', '==Preserve this=='),
      b = await f.note('Reading/Stream/B.md', 'Next article');
    const rawA = f.vault.bytes.get(a),
      rawB = f.vault.bytes.get(b);
    const captured = await f.store.capture({ url: 'https://example.test/from-capture' });
    expect(captured.path).toMatch(/^Reading\/Inbox\//);
    expect((await f.store.read(captured.path)).properties.status).toBe('inbox');
    f.view.showList('Feed');
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(2);
    expect(a.path).toBe('Reading/Stream/A.md');
    await f.view.openArticle(a.path, true);
    expect(a.path).toBe('Reading/Stream/A.md');
    expect(f.view.getDisplayText()).toBe('Reader: A');
    await f.probe.finish('next');
    expect(f.view.file).toBe(b);
    mocks.choose.mockResolvedValueOnce('Archive');
    f.view.contentEl
      .querySelector<HTMLButtonElement>('[aria-label^="Change status and advance"]')!
      .click();
    await Promise.resolve();
    await f.probe.operations;
    expect(f.view.file).toBeUndefined();
    expect(b.path).toBe('Reading/Treasury/B.md');
    expect(f.vault.bytes.get(a)).toBe(rawA);
    expect(f.vault.bytes.get(b)).toBe(patchProperties(rawB!, { status: 'archive', dog_ear: true }));
  });
  it('snapshots every matching search result, excluding unrelated and later-arriving articles', async () => {
    const f = hostFixture();
    for (let index = 0; index < 62; index++)
      await f.note(
        `Reading/Inbox/${String(index).padStart(2, '0')} ${index === 1 ? 'Other' : 'Match'}.md`,
      );
    f.probe.search = 'Match';
    f.view.showList('Inbox');
    const matching = f.store.catalog
      .list('Inbox', 'Match', 0, f.store.catalog.size)
      .map((article) => article.path);
    expect(f.view.contentEl.querySelectorAll('.reader-list-item')).toHaveLength(50);
    await f.view.openArticle(matching[49], true);
    const late = await f.note('Reading/Inbox/Late Match.md');
    await f.view.navigate(1);
    expect(f.view.file?.path).toBe(matching[50]);
    expect(f.probe.readingQueue.paths).toEqual(matching);
    expect(f.probe.readingQueue.paths).not.toContain(late.path);
  });

  it('requests public layout saves and updates its own visible title on navigation, rename and list return', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Inbox/A.md'),
      b = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(a.path);
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('A');
    await f.view.openArticle(b.path);
    expect(f.view.getState()).toEqual({ file: b.path, queue: 'Inbox' });
    expect(f.view.getDisplayText()).toBe('Reader: B');
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('B');
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(2);
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(2);
    const old = b.path;
    await f.vault.move(b, 'Reading/Inbox/Renamed.md');
    await f.view.changed({ path: b.path, previousPath: old });
    expect(f.view.contentEl.querySelector('h1')?.textContent).toBe('Renamed');
    expect(f.view.getState().file).toBe(b.path);
    await f.view.readingList();
    expect(f.view.getState().file).toBeUndefined();
    expect(f.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(4);
  });

  it.each([
    'before ==words== after',
    'before [[Notes/Target]] after',
    'before [words](/Notes/Target.md) after',
    '> ==first\n> second==',
    '- ==first\n  second==',
    '> ==first\r\n> second==',
    '- ==first\r\n  second==',
  ])('opens a Feed article with native annotations without status writes: %s', async (body) => {
    const f = hostFixture(),
      a = await f.note('Reading/Stream/A.md', body),
      b = await f.note('Reading/Stream/B.md');
    f.view.showList('Feed');
    const move = vi.spyOn(f.store, 'move'),
      enumerate = vi.spyOn(f.app.vault, 'getMarkdownFiles');
    await f.view.openArticle(a.path, true);
    expect(move).not.toHaveBeenCalled();
    expect(enumerate).not.toHaveBeenCalled();
    expect(a.path).toBe('Reading/Stream/A.md');
    expect((await f.store.read(a.path)).properties.status).toBe('feed');
    expect((await f.store.read(a.path)).body).toBe(body);
    expect(f.view.getState().queue).toBe('Feed');
    await f.view.navigate(1);
    expect(f.view.file).toBe(b);
  });

  it.each([
    { properties: { related: '[[Topics/X.md]]' }, kept: true },
    { properties: { related: { nested: ['[[Topics/X.md]]'] } }, kept: true },
    {
      properties: { feed: '[[Reading/Wires/Feed.md]]', bookmark: 'quote:[[Topics/X.md]]' },
      kept: false,
    },
  ])(
    'checks authored YAML links, not feed/position values, when opening Feed: %j',
    async ({ properties }) => {
      const f = hostFixture(),
        file = await f.note('Reading/Stream/Article.md');
      const raw = await f.vault.process(file, (current) => patchProperties(current, properties));
      await f.view.openArticle(file.path);
      expect(file.path).toBe('Reading/Stream/Article.md');
      expect(await f.vault.read(file)).toBe(patchProperties(raw, { dog_ear: true }));
      expect((await f.store.read(file.path)).properties.status).toBe('feed');
    },
  );

  it('retains the Feed source and origin queue when annotation promotion fails', async () => {
    const f = hostFixture(),
      a = await f.note('Reading/Stream/A.md', 'before words after'),
      b = await f.note('Reading/Stream/B.md');
    f.view.showList('Feed');
    await enableHighlightHost(f);
    await f.view.openArticle(a.path, true);
    const raw = await f.vault.read(a);
    vi.spyOn(f.vault, 'process').mockRejectedValueOnce(new Error('Queue change failed'));
    f.probe.surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await expect(f.probe.saveSelection()).rejects.toThrow('Queue change failed');
    expect(f.view.file).toBe(a);
    expect(a.path).toBe('Reading/Stream/A.md');
    expect(await f.vault.read(a)).toBe(raw);
    expect(f.probe.surface.displayedBody).toBe('before words after');
    expect(f.vault.trashed).toEqual([]);
    await f.view.navigate(1);
    expect(f.view.file).toBe(b);
  });
});

describe('native Markdown escape hatch', () => {
  it.each(['malformed', 'render', 'type-change'] as const)(
    'keeps an editor escape for %s failures without saving stale state',
    async (kind) => {
      const f = await pluginFixture(),
        article = await f.note('Reading/Inbox/A.md');
      const view = new ReaderView(f.leaf, f.plugin);
      f.leaf.view = view;
      if (kind === 'malformed')
        f.vault.bytes.set(article, '---\ntype: [\n---\nvaluable authored text');
      if (kind === 'render') mocks.renderError = new Error('Content is too large.');
      await view.openArticle(article.path);
      if (kind === 'type-change') {
        f.vault.bytes.set(article, createDocument({ type: 'ordinary' }, 'user text'));
        await view.changed({ path: article.path, metadataChanged: true });
      }
      const before = await f.vault.read(article),
        position = vi.spyOn(f.store, 'position'),
        annotate = vi.spyOn(f.store, 'annotate');
      expect(view.file).toBe(article);
      expect((view as any).snapshot).toBeUndefined();
      expect(view.contentEl.textContent).toContain('Open Markdown');
      await f.plugin.edit(view, article);
      expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
        type: 'markdown',
        state: { file: article.path, mode: 'source' },
        active: true,
      });
      expect(position).not.toHaveBeenCalled();
      expect(annotate).not.toHaveBeenCalled();
      expect(await f.vault.read(article)).toBe(before);
    },
  );

  it('also escapes a type change before its cache notification reaches Reader', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md');
    const view = new ReaderView(f.leaf, f.plugin);
    f.leaf.view = view;
    await view.openArticle(article.path);
    (view as any).surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const changed = createDocument({ type: 'ordinary' }, 'native authored text');
    f.vault.bytes.set(article, changed);
    await f.plugin.edit(view, article);
    expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
      type: 'markdown',
      state: { file: article.path, mode: 'source' },
      active: true,
    });
    expect(await f.vault.read(article)).toBe(changed);
  });
});

describe('plugin routing and conservative expiry', () => {
  it('fails closed while any per-file cache is missing, even if resolved fires', async () => {
    const f = await pluginFixture(),
      file = await f.note('Reading/Stream/000101 Old.md');
    const cached = f.cache.get(file);
    f.cache.delete(file);
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 0, promoted: 0 });
    f.layouts.forEach((run) => run());
    await f.pluginProbe.tick(true);
    expect(expire).not.toHaveBeenCalled();
    f.metadata('resolved');
    expect(expire).not.toHaveBeenCalled();
    expect(f.pluginProbe.referencesReady).toBe(false);
    f.cache.set(file, cached);
    f.metadata('resolved');
    expect(expire).toHaveBeenCalledOnce();
    f.metadata('changed', file);
    await f.pluginProbe.expire();
    expect(expire).toHaveBeenCalledOnce();
    f.metadata('resolved');
    await f.pluginProbe.expire();
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('enables late-plugin-load expiry from complete public link metadata without resolvedLinks or body scans', async () => {
    const f = hostFixture(),
      source = await f.note('Notes/Source.md', '', 'topic');
    const bodyTarget = await f.note('Reading/Stream/000101 Body target.md'),
      frontmatterTarget = await f.note('Reading/Stream/000101 Frontmatter target.md');
    f.cache.get(source).links = [
      { link: encodeURI(bodyTarget.path), original: `[keep](/${encodeURI(bodyTarget.path)})` },
    ];
    f.cache.get(source).frontmatterLinks = [
      { link: frontmatterTarget.path, original: `[[${frontmatterTarget.path}]]`, key: 'related' },
    ];
    // The original completion event happened before plugin registration, and the
    // aggregate index is deliberately unavailable. Per-file metadata is sufficient.
    f.metadata('resolved');
    Object.defineProperty(f.app.metadataCache, 'resolvedLinks', {
      get() {
        throw new Error('Do not consult aggregate link state');
      },
    });
    const reads = vi.spyOn(f.vault, 'read'),
      enumerate = vi.spyOn(f.app.vault, 'getMarkdownFiles');
    const plugin = new ReaderPlugin(f.app, {} as any);
    (plugin as any).app = f.app;
    await plugin.onload();
    plugin.store = f.store;
    const probe = plugin as any;
    vi.spyOn(probe, 'promote').mockResolvedValue(undefined);
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 2, promoted: 0 });
    f.layouts.forEach((run) => run());
    await probe.tick(true);
    expect(probe.referencesReady).toBe(true);
    expect(probe.referencesRecovered).toBe(true);
    expect(probe.promotions.has(bodyTarget)).toBe(true);
    expect(probe.promotions.has(frontmatterTarget)).toBe(true);
    expect(expire).toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(enumerate).toHaveBeenCalledOnce();
    const guard = expire.mock.calls[0][1]!;
    expect(guard(bodyTarget)).toBe(true);
    expect(guard(frontmatterTarget)).toBe(true);
    // Future completion events need no second vault-wide reconstruction.
    f.metadata('resolved');
    expect(enumerate).toHaveBeenCalledOnce();
  });

  it('queues startup YAML-link/topic promotion from metadata only, then revalidates only those articles', async () => {
    const f = await pluginFixture();
    const candidates: TFile[] = [],
      ordinary: TFile[] = [];
    for (const [index, properties] of [
      { related: '[[Topics/X.md]]' },
      { related: { nested: [{ title: '[[Topics/X.md]]' }] } },
      { topics: ['Research'] },
      { feed: '[[Reading/Wires/Feed.md]]', bookmark: 'quote:[[Topics/X.md]]' },
      {},
    ].entries()) {
      const file = await f.note(`Reading/Stream/261013 Article ${index}.md`);
      const raw = await f.vault.process(file, (current) => patchProperties(current, properties));
      f.cache.get(file).frontmatter = readDocument(raw).properties;
      (index < 3 ? candidates : ordinary).push(file);
    }
    const reads = vi.spyOn(f.vault, 'read'),
      promote = vi.spyOn(f.pluginProbe, 'promote').mockResolvedValue(undefined);
    expect(f.pluginProbe.recoverReferences()).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    for (const file of candidates) expect(f.pluginProbe.promotions.has(file)).toBe(true);
    for (const file of ordinary) expect(f.pluginProbe.promotions.has(file)).toBe(false);
    f.pluginProbe.referencesReady = true;
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 3, promoted: 0 });
    await f.pluginProbe.expire();
    const guard = expire.mock.calls[0][1]!;
    for (const file of candidates) expect(guard(file)).toBe(true);
    for (const file of ordinary) expect(guard(file)).toBe(false);
    promote.mockRestore();
    for (const file of candidates) await f.pluginProbe.promote(file);
    for (const file of candidates) {
      expect(file.path).toContain('/Later/');
      expect((await f.store.read(file.path)).properties.status).toBe('later');
    }
    for (const file of ordinary) expect(file.path).toContain('/Stream/');
    expect(reads.mock.calls.every(([file]) => candidates.includes(file as TFile))).toBe(true);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each([
    { type: 'article', retain: false },
    { type: 'feed', retain: false },
    { type: 'topic', retain: true },
    { type: undefined, retain: true },
  ])(
    'filters source/state cached links only on identified Reader records: %j',
    async ({ type, retain }) => {
      const f = await pluginFixture(),
        source = await f.note('Notes/Source.md', '', 'topic');
      const properties: Record<string, unknown> = { type },
        links: any[] = [],
        targets: TFile[] = [];
      for (const key of [
        'feed',
        'bookmark',
        'title',
        'error',
        'url',
        'published',
        ...(type === 'article' ? [] : ['prefix', 'enabled']),
      ]) {
        const target = await f.note(`Reading/Stream/000101 ${key}.md`);
        targets.push(target);
        properties[key] = `literal [[${target.path}]]`;
        links.push({ key, link: target.path, original: `[[${target.path}]]` });
      }
      const raw = await f.vault.process(source, (current) => patchProperties(current, properties));
      f.cache.set(source, { frontmatter: readDocument(raw).properties, frontmatterLinks: links });
      const reads = vi.spyOn(f.vault, 'read');
      vi.spyOn(f.pluginProbe, 'promote').mockResolvedValue(undefined);
      expect(f.pluginProbe.recoverReferences()).toBe(true);
      for (const target of targets) expect(f.pluginProbe.promotions.has(target)).toBe(retain);
      expect(f.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledTimes(
        retain ? targets.length : 0,
      );
      expect(reads).not.toHaveBeenCalled();
      // Unknown nested fields remain real outgoing references even on Reader records.
      f.cache.get(source).frontmatter.related = { target: `[[${targets[0].path}]]` };
      f.cache.get(source).frontmatterLinks = [
        { key: 'related.target', link: targets[0].path, original: `[[${targets[0].path}]]` },
      ];
      f.pluginProbe.keepReferences(source);
      expect(f.pluginProbe.promotions.get(targets[0])).toBe(true);
    },
  );

  it.each([false, true])(
    'revalidates a live unknown-field annotation against current bytes (stale cache: %s)',
    async (stale) => {
      const f = await pluginFixture(),
        file = await f.note('Reading/Stream/Article.md');
      const properties = { type: 'article', related: { nested: ['[[Topics/X.md]]'] } };
      f.cache.get(file).frontmatter = properties;
      if (!stale) await f.vault.process(file, (raw) => patchProperties(raw, properties));
      const before = await f.vault.read(file),
        promote = vi.spyOn(f.pluginProbe, 'promote');
      f.pluginProbe.changed({ path: file.path, metadataChanged: false });
      await Promise.all(promote.mock.results.map((result) => result.value));
      expect(file.path).toBe(stale ? 'Reading/Stream/Article.md' : 'Reading/Later/Article.md');
      expect(await f.vault.read(file)).toBe(
        stale ? before : patchProperties(before, { status: 'later' }),
      );
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it('blocks expiry again if a public cache disappears after startup recovery', async () => {
    const f = await pluginFixture(),
      file = await f.note('Reading/Stream/000101 Article.md');
    expect(f.pluginProbe.recoverReferences()).toBe(true);
    f.pluginProbe.referencesReady = true;
    const cache = f.cache.get(file);
    f.cache.delete(file);
    const expire = vi
      .spyOn(f.store, 'expire')
      .mockResolvedValue({ deleted: 0, retained: 0, promoted: 0 });
    f.metadata('resolve', file);
    f.metadata('resolved');
    await f.pluginProbe.expire();
    expect(f.pluginProbe.referencesReady).toBe(false);
    expect(expire).not.toHaveBeenCalled();
    f.cache.set(file, cache);
    f.metadata('resolved');
    expect(f.pluginProbe.referencesReady).toBe(true);
    expect(expire).toHaveBeenCalledOnce();
  });

  it('never treats publisher fragments, authorities or schemes as native-link promotion', async () => {
    const f = await pluginFixture(),
      source = await f.note('Notes/Source.md', '', 'topic'),
      target = await f.note('Reading/Stream/000101 Old.md');
    vi.spyOn(f.pluginProbe, 'promote').mockResolvedValue(undefined);
    f.cache.get(source).links = [
      '#toc',
      '//publisher/path',
      'https://publisher/path',
      '%6aavascript%3Aalert(1)',
      '%23toc',
      target.path,
    ].map((link) => ({ link }));
    f.pluginProbe.changed({ path: source.path });
    expect(f.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledTimes(1);
    expect(f.pluginProbe.promotions.has(target)).toBe(true);
    // Startup reconstruction uses the same provenance-aware filter.
    vi.mocked(f.app.metadataCache.getFirstLinkpathDest).mockClear();
    f.pluginProbe.recoverReferences();
    expect(f.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledTimes(1);
  });

  it('protects all open FileViews and Reader articles even without a saveable selection', async () => {
    const f = await pluginFixture(),
      native = await f.note('Reading/Stream/000101 Native.md'),
      reader = await f.note('Reading/Stream/000101 Reader.md');
    await f.view.openArticle(reader.path);
    const preview = new MarkdownView(f.leaf);
    (preview as any).file = native;
    f.leaves.push({ view: preview });
    const other = await f.note('Reading/Stream/000101 Other.md'),
      otherView = new (FileView as unknown as new () => FileView)();
    (otherView as any).file = other;
    f.leaves.push({ view: otherView });
    f.pluginProbe.referencesReady = true;
    await f.pluginProbe.expire();
    expect(f.vault.trashed).toEqual([]);
  });

  it('expires the Markdown exemption when that leaf navigates away, including to an ordinary note', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      ordinary = await f.note('Notes/Ordinary.md', '', 'topic');
    // Use the plugin as the real view host for this transition.
    (article as any).stat = { mtime: 1, size: f.vault.bytes.get(article)!.length };
    vi.mocked(f.app.workspace.getActiveViewOfType).mockImplementation((constructor: any) =>
      f.leaf.view instanceof constructor ? f.leaf.view : null,
    );
    const view = new ReaderView(f.leaf, f.plugin);
    f.leaf.view = view;
    await view.openArticle(article.path);
    await f.pluginProbe.presentations.get(f.leaf);
    f.leaf.setViewState.mockClear(); // The initial title refresh is not a Markdown escape.
    f.leaf.setViewState.mockImplementation(async (state: any) => {
      if (state.type === 'markdown') {
        const native = new MarkdownView(f.leaf);
        Object.assign(native, {
          file: article,
          editor: { getValue: () => f.vault.bytes.get(native.file!) },
        });
        f.leaf.view = native;
        f.workspace('file-open', article);
      }
    });
    await f.plugin.edit(view, article);
    expect(f.leaf.setViewState).toHaveBeenCalledTimes(1);
    f.leaf.view.file = ordinary;
    f.workspace('file-open', ordinary);
    f.leaf.view.file = article;
    f.workspace('file-open', article);
    await vi.waitFor(
      () =>
        expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
          type: 'obsidian-reader',
          state: { file: article.path },
        }),
      { interval: 1 },
    );
  });

  it('flushes proactively when hidden, but unload synchronously closes the write barrier', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const flush = vi.spyOn(f.view, 'flush').mockResolvedValue();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    mocks.dom.get('visibilitychange')!();
    expect(flush).toHaveBeenCalledOnce();
    expect(f.plugin.onunload()).toBeUndefined();
    expect(f.plugin.signal.aborted).toBe(true);
    await expect(f.store.position(article.path, 'words')).rejects.toThrow('stopped');
  });
});

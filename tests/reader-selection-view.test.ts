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
import { TFile } from 'obsidian';
import { createDocument, patchProperties } from '../src/core/document';
import { passages } from '../src/core/annotations';
import { paragraphAnchors } from '../src/core/hosted-highlights';
import * as surfaceModule from '../src/reader/surface';
import type { NodesApi, NodeResult } from '../src/host/nodes';
import { gate } from './helpers/memory-vault';

describe('native selection never annotates', () => {
  let f: Awaited<ReturnType<typeof selectionFixture>>;
  async function selectionFixture(remember = true) {
    const actual = await vi.importActual<typeof surfaceModule>('../src/reader/surface');
    vi.spyOn(surfaceModule, 'ReadingSurface').mockImplementation(function (...args) {
      return new actual.ReadingSurface(...args);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange();
      range.getClientRects = () => [] as unknown as DOMRectList;
      range.getBoundingClientRect = () => new DOMRect();
      return range;
    });
    const f = hostFixture(),
      body = 'Alpha phrase.\n\nBeta phrase.',
      article = await f.note('Reading/Inbox/Selection.md', body);
    const highlight = await enableHighlightHost(f, ...(remember ? [article] : []));
    await f.view.onOpen();
    await f.view.openArticle(article.path);
    const surface = f.probe.surface as surfaceModule.ReadingSurface;
    function select(paragraph: number, end = paragraph === 0 ? 5 : 4, notify = true) {
      const node = surface.body.querySelectorAll('p')[paragraph].firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, end);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      if (notify) document.dispatchEvent(new Event('selectionchange'));
    }
    return { ...f, article, body, surface, select, highlight };
  }
  afterEach(() => {
    f?.view.stopForUnload();
    document.getSelection()?.removeAllRanges();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it.each([true, false])(
    'keeps selection passive with a default host=%s, including close',
    async (remember) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      f = await selectionFixture(remember);
      const before = (await f.store.read(f.article.path)).body;
      const collect = vi.spyOn(f.store, 'collectHighlight');
      f.select(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(collect).not.toHaveBeenCalled();
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect(document.getSelection()?.toString()).toBe('Alpha');
      await f.view.onClose();
      expect((await f.store.read(f.article.path)).body).toBe(before);
    },
  );
});

describe('displayed source and deferred rendering', () => {
  it('rejects stale selection, passage, move, topic, trash and position actions while newer source is deferred', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', 'before ==words== after');
    enableTypedTopics(f);
    await f.view.openArticle(article.path);
    const surface = f.probe.surface,
      old = f.probe.snapshot.body;
    surface.hold = true;
    const current = createDocument({ type: 'article' }, 'before ==new words== after');
    f.vault.bytes.set(article, current);
    await f.view.changed({ path: article.path });
    expect(surface.displayedBody).toBe(old);
    expect(f.probe.snapshot.body).toBe('before ==new words== after');
    const annotate = vi.spyOn(f.store, 'annotate'),
      move = vi.spyOn(f.store, 'move'),
      trash = vi.spyOn(f.store, 'trash'),
      position = vi.spyOn(f.store, 'position');
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await expect(f.probe.saveSelection()).rejects.toThrow('Article text changed');
    surface.selectionValue = undefined;
    expect(() => f.probe.passageMenu(passages(old)[0], new MouseEvent('click'))).toThrow(
      'Article text changed',
    );
    mocks.choose.mockResolvedValue('Later');
    await expect(f.probe.move()).rejects.toThrow('Article text changed');
    await expect(f.probe.topics()).rejects.toThrow('Article text changed');
    await expect(f.probe.finish('delete')).rejects.toThrow('Article text changed');
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    expect(annotate).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
    expect(await f.vault.read(article)).toBe(current);
    surface.hold = false;
    surface.refresh();
    expect(surface.displayedBody).toBe(f.probe.snapshot.body);
  });

  it('permits automatic range adjustment over its own deferred highlight markup only', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await enableHighlightHost(f, article);
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await f.probe.saveSelection();
    const first = expectedHosted('before ==words== after');
    expect((await f.store.read(article.path)).body).toBe(first);
    const blockId = paragraphAnchors(first)[0].blockId;
    expect(surface.displayedBody).toBe('before words after');
    surface.selectionValue = { quote: 'words after', before: 'before ', after: '' };
    await f.probe.saveSelection();
    expect((await f.store.read(article.path)).body).toBe(
      expectedHosted('before ==words after==', defaultHighlightPath, blockId),
    );
    expect(surface.displayedBody).toBe('before words after');
    f.vault.bytes.set(
      article,
      createDocument({ type: 'article' }, 'before ==words after== plus native text'),
    );
    await f.view.changed({ path: article.path });
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    await expect(f.probe.saveSelection()).rejects.toThrow('Article text changed');
    expect((await f.store.read(article.path)).body).toBe('before ==words after== plus native text');
  });

  it('does not save native selection while closing', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await enableHighlightHost(f, article);
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const closing = f.view.onClose();
    surface.selectionValue = undefined;
    await closing;
    expect((await f.store.read(article.path)).body).toBe('before words after');
    expect(surface.dispose).toHaveBeenCalledOnce();
  });

  it('turns a deferred failure into a non-mutating Markdown escape and ignores errors from old surfaces', async () => {
    const f = await pluginFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      other = await f.note('Reading/Inbox/B.md');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.hold = true;
    f.vault.bytes.set(article, createDocument({ type: 'article' }, 'new unrenderable body'));
    await f.view.changed({ path: article.path });
    mocks.renderError = new Error('Content is too large.');
    surface.hold = false;
    surface.refresh();
    expect(f.view.file).toBe(article);
    expect(f.probe.snapshot).toBeUndefined();
    expect(f.view.contentEl.textContent).toContain('Content is too large.');
    const position = vi.spyOn(f.store, 'position'),
      annotate = vi.spyOn(f.store, 'annotate');
    await f.plugin.edit(f.view, article);
    expect(f.leaf.setViewState).toHaveBeenLastCalledWith({
      type: 'markdown',
      state: { file: article.path, mode: 'source' },
      active: true,
    });
    expect(position).not.toHaveBeenCalled();
    expect(annotate).not.toHaveBeenCalled();
    mocks.renderError = undefined;
    await f.view.openArticle(other.path);
    surface.renderError(new Error('late old callback'));
    expect(f.view.file).toBe(other);
    expect(f.probe.snapshot).toBeDefined();
  });
});

describe('commit-time annotation targets', () => {
  function readerPicker(f: ReturnType<typeof hostFixture>, target: TFile, wait = async () => {}) {
    const node: NodeResult = {
      path: target.path,
      title: 'Target',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const api: NodesApi = {
      version: 2,
      listTypes: () => [{ type: 'topic', label: 'Topic' }],
      searchNodes: () => [node],
      getNode: (path) => (path === target.path ? node : null),
      createNode: vi.fn(async () => null),
      createNodeForLink: vi.fn(async () => null),
      pickNodeForLink: vi.fn(async () => null),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    mocks.highlightPicker.mockImplementation(async () => {
      await wait();
      return { kind: 'existing', node };
    });
  }
  it('allows a position save while a link picker is open without losing the annotation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    const started = gate(),
      finish = gate();
    readerPicker(f, target, async () => {
      started.resolve();
      await finish.promise;
    });
    const linking = menu(f.view, 'Add highlight to notes…');
    await started.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    finish.resolve();
    await linking;
    expect((await f.store.read(article.path)).body).toBe(expectedHosted('==words==', target.path));
    expect((await f.store.read(article.path)).properties.bookmark).toBe('words');
  });

  it('rejects a selected note replaced at the same path after preflight validation', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    readerPicker(f, target);
    const original = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.vault.files.set(target.path, { path: target.path });
      return original(file, transform);
    });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      'typed destination changed',
    );
    expect((await f.store.read(article.path)).body).toBe('==words==');
  });

  it.each(['api', 'classes', 'file', 'swap'] as const)(
    'rechecks Nodes %s inside the actual commit',
    async (kind) => {
      const f = hostFixture(),
        article = await f.note('Reading/Inbox/A.md', '==words=='),
        target = await f.note('Nodes/One.md', '', 'topic');
      const node = {
        path: target.path,
        type: 'topic',
        classes: ['topic'],
        title: 'One',
        aliases: [],
      };
      const api = {
        version: 2,
        listTypes: () => [{ type: 'topic', label: 'Topic' }],
        searchNodes: () => [node],
        getNode: () => node,
        createNode: async () => node,
        pickNodeForLink: vi.fn(async () => null),
      };
      let current: unknown = api;
      (f.app as any).plugins = { getPlugin: () => ({ api: current }) };
      mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node });
      await f.view.openArticle(article.path);
      const before = await f.vault.read(article),
        original = f.vault.process.bind(f.vault);
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
        if (kind === 'api') current = { ...api };
        else if (kind === 'classes') node.classes = ['person'];
        else if (kind === 'file') f.vault.files.delete(target.path);
        else f.vault.files.set(target.path, { path: target.path });
        return original(file, transform);
      });
      await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
        /Fileclass Inline changed|typed destination changed/,
      );
      expect(api.pickNodeForLink).not.toHaveBeenCalled();
      expect(await f.vault.read(article)).toBe(before);
      expect((await f.store.read(article.path)).body).toBe('==words==');
    },
  );

  it('resolves short native topic links and preserves their authored spelling', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Topics/Short topic name.md', '', 'topic');
    f.vault.bytes.set(
      article,
      createDocument({ type: 'article', topics: ['[[Short topic name|My label]]'] }, 'body'),
    );
    vi.mocked(f.app.metadataCache.getFirstLinkpathDest).mockImplementation((path, source) => {
      expect(source).toBe(article.path);
      return path === 'Short topic name' || path === target.path ? target : null;
    });
    // The production NativeVault delegates native aliases to the metadata cache.
    Object.assign(f.vault, {
      resolveLink: (link: string, source: string) =>
        f.app.metadataCache.getFirstLinkpathDest(link, source) ?? undefined,
    });
    const api = enableTypedTopics(f);
    await f.view.openArticle(article.path);
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'existing-many',
      nodes: [api.getNode(target.path)!],
    });
    await f.probe.topics();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      api,
      expect.objectContaining({ selectedPaths: [target.path] }),
    );
    expect((await f.store.read(article.path)).properties.topics).toEqual([
      '[[Short topic name|My label]]',
    ]);
  });

  it.each([
    { topics: ['unrecognized'] },
    { topics: ['[[Missing]]'] },
    { topics: [42] },
    { topics: 'not an array' },
  ])(
    'preserves unrecognized/unresolved topic data while adding a typed destination: $topics',
    async ({ topics }) => {
      const f = hostFixture(),
        article = await f.note('Reading/Inbox/A.md'),
        target = await f.note('Topics/Typed.md', 'Keep this target', 'topic');
      const original = createDocument({ type: 'article', status: 'inbox', topics }, 'body');
      f.vault.bytes.set(article, original);
      const api = enableTypedTopics(f),
        targetBefore = await f.vault.read(target);
      await f.view.openArticle(article.path);
      mocks.highlightPicker.mockImplementationOnce(async (_app, current, options) => {
        expect(current).toBe(api);
        expect(options.selectedPaths).toEqual([]);
        expect(api.searchNodes('')).toEqual([api.getNode(target.path)]);
        return { kind: 'existing-many', nodes: [api.getNode(target.path)!] };
      });
      await f.probe.topics();
      expect(mocks.highlightPicker).toHaveBeenCalledOnce();
      expect(api.getNode).toHaveBeenCalledWith(target.path);
      expect(await f.vault.read(article)).toBe(
        patchProperties(patchProperties(original, { dog_ear: true }), {
          topics: [...(Array.isArray(topics) ? topics : [topics]), '[[Topics/Typed.md]]'],
        }),
      );
      expect(await f.vault.read(target)).toBe(targetBefore);
    },
  );

  it('retains an article promoted before a link target disappears, without saving the stale link', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Stream/A.md', '==words=='),
      target = await f.note('Notes/Target.md', '', 'topic');
    await f.view.openArticle(article.path);
    readerPicker(f, target);
    // Lose the target only after retention is durably saved; preflight loss must not promote.
    f.probe.snapshot = await f.store.move(await f.store.read(article.path), 'Feed');
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      const raw = await process(file, update);
      f.vault.files.delete(target.path);
      return raw;
    });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      'typed destination changed',
    );
    expect(article.path).toBe('Reading/Stream/A.md');
    expect((await f.store.read(article.path)).properties.status).toBe('later');
    expect((await f.store.read(article.path)).body).toBe('==words==');
  });

  it('rechecks topic identity and type at commit time and keeps the rejected draft for Cancel', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Topics/One.md', '', 'topic');
    const api = enableTypedTopics(f);
    await f.view.openArticle(article.path);
    const before = await f.vault.read(article);
    let cancel: (() => void) | undefined;
    let draft: string[] = [];
    mocks.highlightPicker
      .mockResolvedValueOnce({ kind: 'existing-many', nodes: [api.getNode(target.path)!] })
      .mockImplementationOnce(async (_app, current, options) => {
        expect(current).toBe(api);
        draft = options.selectedPaths;
        return new Promise<null>((resolve) => {
          cancel = () => resolve(null);
        });
      });
    const original = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.cache.set(target, { frontmatter: { type: 'person' } });
      return original(file, transform);
    });
    const pending = f.probe.topics();
    for (let i = 0; i < 100 && !cancel; i++) await Promise.resolve();
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringContaining('typed destination changed'));
    expect(draft).toEqual([target.path]);
    expect(mocks.highlightPicker).toHaveBeenCalledTimes(2);
    expect(await f.vault.read(article)).toBe(before);
    expect(cancel).toBeDefined();
    cancel!();
    await pending;
    expect((await f.store.read(article.path)).properties.topics).toBeUndefined();
  });

  it('preserves rich words when unlinking a Markdown-linked highlight', async () => {
    const f = hostFixture(),
      article = await f.note(
        'Reading/Inbox/A.md',
        '==[**formatted words**](/Notes/URI%20Path.md)==',
      );
    await f.view.openArticle(article.path);
    await menu(f.view, 'Remove references (article only)');
    expect((await f.store.read(article.path)).body).toBe('==**formatted words**==');
  });
});

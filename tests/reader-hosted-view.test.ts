// @vitest-environment node
import { mocks, hostFixture, passageButton, menu } from './helpers/reader-view-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIcon, TFile } from 'obsidian';
import { patchProperties, readDocument } from '../src/core/document';
import { passages } from '../src/core/annotations';
import { hostSelection, paragraphAnchors } from '../src/core/hosted-highlights';
import { appendQuotation, originLink, removeQuotation } from '../src/core/quotation';
import { renderBody } from '../src/reader/render';
import { ReaderView, openExistingNote } from '../src/reader/view';
import * as surfaceModule from '../src/reader/surface';
import type { NodesApi, NodeResult } from '../src/host/nodes';
import { gate } from './helpers/memory-vault';

describe('hosted highlight UI integration', () => {
  const views: ReaderView[] = [],
    renders: (() => void)[] = [];
  afterEach(() => {
    renders.splice(0).forEach((dispose) => dispose());
    views.splice(0).forEach((view) => view.stopForUnload());
    if (vi.isFakeTimers()) {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    vi.unstubAllGlobals();
  });
  async function fixture(options: { body?: string; defaults?: number[] } = {}) {
    const f = hostFixture();
    views.push(f.view);
    const article = await f.note(
      'Reading/Inbox/Hosted.md',
      options.body ?? 'Before first words after.',
    );
    const targets = [
      await f.note('Nodes/Concept.md', 'Authored concept.', 'concept'),
      await f.note('Nodes/Project.md', 'Authored project.', 'project'),
    ];
    const nodes: NodeResult[] = targets.map((file, index) => ({
      path: file.path,
      title: index ? 'Project' : 'Concept',
      type: 'different-primary-type',
      classes: index ? ['Other', 'Project'] : ['Other', 'Concept'],
      aliases: [],
    }));
    const api = {
      version: 2 as const,
      listTypes: vi.fn(() => [
        { type: 'Concept', label: 'Concept' },
        { type: 'Project', label: 'Project' },
      ]),
      searchNodes: vi.fn(() => nodes),
      getNode: vi.fn((path: string) => nodes.find((node) => node.path === path) ?? null),
      createNode: vi.fn(async () => null),
      pickNodeForLink: vi.fn(async () => null),
      createNodeForLink: vi.fn<NonNullable<NodesApi['createNodeForLink']>>(async () => null),
    } satisfies NodesApi;
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    if (options.defaults)
      f.vault.bytes.set(
        article,
        patchProperties(await f.vault.read(article), {
          topics: options.defaults.map((index) => `[[${nodes[index].path.replace(/\.md$/, '')}]]`),
        }),
      );
    await f.view.onOpen();
    await f.view.openArticle(article.path);
    const select = (quote = 'first words', before = 'Before ', after = ' after.') => {
      f.probe.surface.selectionValue = { quote, before, after };
      return f.probe.saveSelection() as Promise<void>;
    };
    const paint = () =>
      renders.push(
        renderBody(
          f.probe.snapshot.body,
          f.probe.surface.body,
          'https://publisher.test',
          (path, element) => f.probe.paintReferenceIcon(path, element, article),
        ),
      );
    return { ...f, article, targets, nodes, api, select, paint };
  }
  function nativeClicks(f: Awaited<ReturnType<typeof fixture>>) {
    const root = f.probe.surface.body as HTMLElement;
    let hit: Element = root;
    const nativeRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = nativeRange();
      range.getClientRects = () => [new DOMRect(0, 0, 400, 40)] as unknown as DOMRectList;
      range.getBoundingClientRect = () => new DOMRect(0, 0, 400, 40);
      return range;
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40));
    const descriptors = ['elementFromPoint', 'caretRangeFromPoint'].map(
      (key) => [key, Object.getOwnPropertyDescriptor(document, key)] as const,
    );
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const walker = document.createTreeWalker(hit, NodeFilter.SHOW_TEXT),
          text = walker.nextNode();
        if (!text) return null;
        const range = document.createRange();
        range.setStart(text, 0);
        range.collapse(true);
        return range;
      },
    });
    renders.push(() =>
      descriptors.forEach(([key, descriptor]) => {
        if (descriptor) Object.defineProperty(document, key, descriptor);
        else delete (document as unknown as Record<string, unknown>)[key];
      }),
    );
    return (element: Element, init: MouseEventInit = {}) => {
      hit = element;
      for (const type of ['pointerdown', 'pointerup']) {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          ...init,
        });
        Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
        element.dispatchEvent(event);
      }
      element.dispatchEvent(
        new MouseEvent(init.button === 1 ? 'auxclick' : 'click', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          ...init,
        }),
      );
    };
  }
  async function initialPartialCollection(mode: 'native selection' | 'tap') {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 20, 12));
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
    const f = await fixture({ body: 'first words' });
    f.store.setStatusFolders({ feed: 'Reading/Stream', later: 'Reading/Later' });
    await f.vault.move(f.article, 'Reading/Stream/Hosted.md');
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { status: 'feed' }),
    );
    f.probe.adoptSnapshot(await f.store.read(f.article.path));
    const process = f.vault.process.bind(f.vault),
      calls: string[] = [];
    let created!: TFile,
      failed = false;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === created && !failed) {
        failed = true;
        throw new Error('Created destination failed before its process applied');
      }
      return process(file, update);
    });
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Created',
      type: 'Project',
      existingNodes: [f.nodes[0]],
    });
    f.api.createNodeForLink.mockImplementationOnce(async (_options, link) => {
      created = await f.note('Nodes/Created.md', 'Authored created note.', 'project');
      const node = {
        ...f.nodes[1],
        path: created.path,
        title: 'Created',
        classes: ['Concept', 'Project'],
      };
      f.nodes.push(node);
      await link(node);
      return node;
    });
    const click = nativeClicks(f),
      root = f.probe.surface.body as HTMLElement;
    const save = vi.spyOn(f.probe, mode === 'tap' ? 'saveTapSelection' : 'saveSelection');
    if (mode === 'tap') {
      (
        f.view.contentEl.querySelector('.reader-tap-highlight-trigger') as HTMLButtonElement
      ).click();
      click(root.querySelector('p')!);
      passageButton(f.view, 'Paragraph').click();
    } else {
      const range = document.createRange();
      range.selectNodeContents(root.querySelector('p')!);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await expect(f.probe.operations).rejects.toThrow(/source annotation was saved/i);
    await f.probe.positionWrite;
    expect(save).toHaveBeenCalledOnce();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ query: '' }),
    );
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(f.api.createNodeForLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Project', suggestedTitle: 'Created' }),
      expect.any(Function),
    );
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.article.path).toBe('Reading/Later/Hosted.md');
    const source = await f.store.read(f.article.path),
      first = await f.vault.read(f.targets[0]),
      pending = await f.vault.read(created);
    expect(passages(source.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Created']);
    expect(first).toContain('[[2026-10-20]]');
    expect(pending).not.toContain('## Highlights');
    expect(readDocument(pending).properties.origin).toBeUndefined();
    const retry = passageButton(f.view, 'Retry note updates');
    expect(retry.isConnected).toBe(true);
    return { ...f, created, source, first, pending, calls, retry };
  }
  it.each(['native selection', 'tap'] as const)(
    'retries only the unfinished created destination after initial %s filing fails',
    async (mode) => {
      const f = await initialPartialCollection(mode),
        before = f.calls.length;
      vi.setSystemTime(new Date(2026, 9, 21, 12));
      f.retry.click();
      await f.probe.operations;
      expect(f.calls.slice(before)).toEqual([f.created.path]);
      expect(await f.vault.read(f.article)).toBe(f.source.raw);
      expect(await f.vault.read(f.targets[0])).toBe(f.first);
      const filed = await f.vault.read(f.created),
        block = paragraphAnchors(f.source.body)[0].blockId;
      expect(filed).toContain(
        `> first words (※ ${originLink(f.source.path, block, 'Hosted')} [[2026-10-21]])`,
      );
      expect(readDocument(filed).properties.origin).toBe(originLink(f.source.path, block));
      expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it.each(
    (['native selection', 'tap'] as const).flatMap((mode) =>
      (['provider', 'target identity', 'requested class', 'source bytes'] as const).map(
        (change) => ({ mode, change }),
      ),
    ),
  )(
    'revalidates original $change authority before retrying initial $mode collection',
    async ({ mode, change }) => {
      const f = await initialPartialCollection(mode),
        before = f.calls.length;
      let expectedSource = f.source.raw,
        target = f.created;
      if (change === 'provider')
        (f.app as any).plugins = { getPlugin: () => ({ api: { ...f.api } }) };
      else if (change === 'target identity') {
        f.vault.files.delete(f.created.path);
        target = await f.note(f.created.path, 'Replacement must stay untouched.', 'project');
      } else if (change === 'requested class')
        f.nodes.find((node) => node.path === f.created.path)!.classes = ['Concept'];
      else {
        expectedSource += '\nForeign source edit.';
        f.vault.bytes.set(f.article, expectedSource);
      }
      const targetBytes = await f.vault.read(target);
      f.retry.click();
      await f.probe.operations.catch(() => {});
      expect(f.calls.slice(before)).toEqual([]);
      expect(await f.vault.read(f.article)).toBe(expectedSource);
      expect(await f.vault.read(f.targets[0])).toBe(f.first);
      expect(await f.vault.read(target)).toBe(targetBytes);
      expect(readDocument(targetBytes).properties.origin).toBeUndefined();
      expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
      expect(f.vault.trashed).toEqual([]);
    },
  );
  it('keeps a failed explicit mention origin-only and never offers the quotation retry action', async () => {
    const initial = hostSelection('first words', { quote: 'first words' }, ['Nodes/Concept.md']);
    const f = await fixture({ body: initial.body });
    const first = await f.vault.read(f.targets[0]),
      process = f.vault.process.bind(f.vault);
    let created!: TFile, planned: string | undefined;
    f.api.createNodeForLink.mockImplementationOnce(async (_options, link) => {
      created = await f.note('Nodes/Created mention.md', 'Authored mention note.', 'project');
      const node = { ...f.nodes[1], path: created.path, title: 'Created mention' };
      f.nodes.push(node);
      await link(node);
      return node;
    });
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      if (file === created) {
        planned = update(await f.vault.read(file));
        throw new Error('Origin-only destination failure');
      }
      return process(file, update);
    });
    f.paint();
    nativeClicks(f)(f.probe.surface.body.querySelector('mark'));
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Created mention',
      type: 'Project',
    });
    passageButton(f.view, 'Convert to note link…').click();
    await expect(f.probe.operations).rejects.toThrow(/destination update was not saved/i);
    const source = await f.store.read(f.article.path);
    expect(source.body).toContain('[[Nodes/Created mention|first words]]');
    expect(passages(source.body)).toEqual([]);
    expect(readDocument(planned!).properties.origin).toBe(originLink(source.path, initial.blockId));
    expect(planned).not.toContain('## Highlights');
    expect(await f.vault.read(created)).not.toContain('## Highlights');
    expect(readDocument(await f.vault.read(created)).properties.origin).toBeUndefined();
    expect(await f.vault.read(f.targets[0])).toBe(first);
    expect(
      [...f.view.contentEl.querySelectorAll('button')].some(
        (button) => button.getAttribute('aria-label') === 'Retry note updates',
      ),
    ).toBe(false);
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
  });
  it('retries only the unfinished filing after choosing among another highlight’s many hosts with a staged draft', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]);
    const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
      'Nodes/Project.md',
      'Nodes/Other.md',
    ]);
    const f = await fixture({ body: first.body + '\n\n' + second.body });
    const other = await f.note('Nodes/Other.md', 'Other note stays untouched.', 'concept');
    f.nodes.push({ ...f.nodes[0], path: other.path, title: 'Other' });
    const otherBytes = await f.vault.read(other),
      process = f.vault.process.bind(f.vault),
      calls: string[] = [];
    let failed = false;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === f.targets[1] && !failed) {
        failed = true;
        throw new Error('Second chosen destination failed before process');
      }
      return process(file, update);
    });
    f.paint();
    const root = f.probe.surface.body as HTMLElement,
      click = nativeClicks(f);
    click(root.querySelectorAll('mark')[0]);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'pick-in-article', nodes: [f.nodes[0]] });
    passageButton(f.view, 'Add highlight to notes…').click();
    await f.probe.operations;
    expect(f.probe.sendSource?.mode).toBe('explicit');
    mocks.choose.mockResolvedValueOnce(f.nodes[1]);
    click(root.querySelectorAll('mark')[1]);
    await expect(f.probe.operations).rejects.toThrow(/source annotation was saved/i);
    expect(mocks.choose).toHaveBeenCalledOnce();
    const source = await f.store.read(f.article.path),
      copy = await f.vault.read(f.targets[0]),
      before = calls.length;
    expect(copy).toContain('> First excerpt.');
    passageButton(f.view, 'Retry note updates').click();
    await f.probe.operations;
    expect(calls.slice(before)).toEqual([f.targets[1].path]);
    expect(await f.vault.read(f.article)).toBe(source.raw);
    expect(await f.vault.read(f.targets[0])).toBe(copy);
    expect(await f.vault.read(f.targets[1])).toContain('> First excerpt.');
    expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
    expect(await f.vault.read(other)).toBe(otherBytes);
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
  });
  it('collects one new range into every checked typed note with one guarded source annotation', async () => {
    const f = await fixture(),
      collect = vi.spyOn(f.store, 'collectHighlightMany');
    const process = vi.spyOn(f.vault, 'process');
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.select();
    const saved = await f.store.read(f.article.path);
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ multiple: true, minSelection: 1, actionLabel: 'Add highlight' }),
    );
    expect(collect).toHaveBeenCalledOnce();
    expect(process.mock.calls.filter(([file]) => file === f.article)).toHaveLength(1);
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
    for (const target of f.targets)
      expect(await f.vault.read(target)).toContain('> first words (※ [[Reading/Inbox/Hosted#^');
  });
  it('collects checked existing notes and one created note inside the durable callback before required completion', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Project',
      type: 'Project',
      existingNodes: [f.nodes[0]],
    });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(f.nodes[1]);
      entered.resolve();
      await release.promise;
      return null;
    });
    const pending = f.select();
    await entered.promise;
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual([
      'Nodes/Concept',
      'Nodes/Project',
    ]);
    for (const target of f.targets) expect(await f.vault.read(target)).toContain('> first words');
    expect(readDocument(await f.vault.read(f.targets[0])).properties.origin).toBeUndefined();
    expect(readDocument(await f.vault.read(f.targets[1])).properties.origin).toContain('#^reader-');
    release.resolve();
    await pending;
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
  });
  it('cancels related-note drafts without writes, then applies metadata once without pruning earlier highlight copies', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    const before = await f.store.read(f.article.path),
      copy = await f.vault.read(f.targets[0]);
    const set = vi.spyOn(f.store, 'setRelatedNodes');
    mocks.highlightPicker.mockResolvedValueOnce(null);
    await f.probe.topics();
    expect(f.probe.surface.topics.textContent).toBe('Concept');
    expect(set).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).raw).toBe(before.raw);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [f.nodes[1]] });
    await f.probe.topics();
    expect(set).toHaveBeenCalledOnce();
    const saved = await f.store.read(f.article.path);
    expect(saved.properties.topics).toEqual(['[[Nodes/Project.md]]']);
    expect(f.probe.surface.topics.textContent).toBe('Project');
    expect(saved.body).toBe(before.body);
    expect(await f.vault.read(f.targets[0])).toBe(copy);
    expect(await f.vault.read(f.targets[1])).not.toContain('> first words');
  });
  it('links a created related note before completion but keeps other edits staged when Cancel follows', async () => {
    const f = await fixture({ defaults: [0] }),
      entered = gate(),
      release = gate();
    const file = await f.note('Nodes/New.md', 'New authored note.', 'different-primary');
    const created: NodeResult = {
      path: file.path,
      title: 'New',
      type: 'different-primary',
      classes: ['Concept'],
      aliases: [],
    };
    f.nodes.push(created);
    mocks.highlightPicker
      .mockResolvedValueOnce({
        kind: 'create',
        title: 'New',
        type: 'Concept',
        existingNodes: [f.nodes[1]],
      })
      .mockResolvedValueOnce(null);
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(created);
      entered.resolve();
      await release.promise;
      return created;
    });
    const pending = f.probe.topics();
    await entered.promise;
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      '[[Nodes/Concept]]',
      '[[Nodes/New.md]]',
    ]);
    expect(await f.vault.read(file)).toContain('New authored note.');
    release.resolve();
    await pending;
    expect(mocks.highlightPicker).toHaveBeenLastCalledWith(
      f.app,
      f.api,
      expect.objectContaining({
        selectedPaths: ['Nodes/Project.md', 'Nodes/New.md'],
        allowCreate: false,
        actionLabel: 'Apply',
      }),
    );
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      '[[Nodes/Concept]]',
      '[[Nodes/New.md]]',
    ]);
    expect(f.vault.trashed).toEqual([]);
  });
  it('opens a plain reference click as that passage multiselect when no highlight is selected', async () => {
    const body = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const f = await fixture({ body });
    f.paint();
    const click = nativeClicks(f);
    click(f.probe.surface.body.querySelector('.reader-reference-pill'));
    await f.probe.operations;
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({
        selectedPaths: ['Nodes/Concept.md'],
        minSelection: 0,
        multiple: true,
      }),
    );
    expect(f.opened.openFile).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(body);
  });
  it.each(['plain', 'nested internal anchor'] as const)(
    'clicks the %s source highlight then an exact pill in a many-host passage, without arming Send',
    async (kind) => {
      const first =
        kind === 'plain'
          ? hostSelection('First excerpt.', { quote: 'First excerpt.' }, ['Nodes/Concept.md']).body
          : '[==First excerpt.==](Nodes/Concept.md) (※ [[Nodes/Concept]]) ^native-first';
      const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
        'Nodes/Concept.md',
        'Nodes/Project.md',
      ]).body;
      const f = await fixture({ body: `${first}\n\n${second}` }),
        conceptBefore = await f.vault.read(f.targets[0]);
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement;
      click(root.querySelector('mark')!);
      expect(f.probe.sendSource?.mode).toBe('selected');
      click(
        root.querySelector(
          '[data-reader-passage="1"] .reader-reference-pill[href="Nodes/Project"]',
        )!,
      );
      await f.probe.operations;
      const saved = await f.store.read(f.article.path);
      expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
      expect(saved.body).toContain(second);
      expect(await f.vault.read(f.targets[1])).toContain(
        kind === 'plain' ? '> First excerpt.' : '> [First excerpt.](Nodes/Concept.md)',
      );
      if (kind !== 'plain') expect(saved.body).toContain('[==First excerpt.==](Nodes/Concept.md)');
      expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
      expect(await f.vault.read(f.targets[0])).toBe(conceptBefore);
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect(f.opened.openFile).not.toHaveBeenCalled();
      expect(f.probe.sendSource?.snapshot.body).toBe(saved.body);
    },
  );
  it.each([false, true])(
    'routes an actual reference SVG path click with selected source=%s',
    async (selected) => {
      const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
        'Nodes/Concept.md',
      ]).body;
      const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
        'Nodes/Concept.md',
        'Nodes/Project.md',
      ]).body;
      const f = await fixture({ body: `${first}\n\n${second}` });
      f.nodes.forEach((node) => (node.icon = 'tag'));
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement,
        pill = root.querySelector<HTMLAnchorElement>(
          '[data-reader-passage="1"] .reader-reference-pill[href="Nodes/Project"]',
        )!;
      // The SDK shim does not load native Lucide paths. Reproduce its actual SVG
      // subtree so the dispatched event target is an SVGElement, not HTMLElement.
      const icon = pill.querySelector('.reader-node-icon') ?? document.createElement('span');
      icon.classList.add('reader-node-icon', 'reader-reference-icon');
      icon.setAttribute('data-reader-decoration', 'reference');
      icon.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M2 2h12v12H2z');
      svg.append(path);
      icon.replaceChildren(svg);
      if (!icon.parentElement) pill.prepend(icon);
      if (selected) click(root.querySelector('mark')!);
      click(path);
      await f.probe.operations;
      expect(f.opened.openFile).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).body).toContain(second);
      if (selected) {
        expect(await f.vault.read(f.targets[1])).toContain('> First excerpt.');
        expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
        expect(await f.vault.read(f.targets[0])).not.toContain('> First excerpt.');
        expect(mocks.highlightPicker).not.toHaveBeenCalled();
      } else {
        expect(mocks.highlightPicker).toHaveBeenCalledWith(
          f.app,
          f.api,
          expect.objectContaining({ selectedPaths: ['Nodes/Concept.md', 'Nodes/Project.md'] }),
        );
        expect((await f.store.read(f.article.path)).body).toBe(`${first}\n\n${second}`);
        for (const target of f.targets) expect(await f.vault.read(target)).not.toContain('> ');
      }
    },
  );
  it('clicking a different mark switches the active source instead of sending the previous excerpt', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = '[==Second excerpt.==](Nodes/Concept.md) (※ [[Nodes/Project]]) ^native-second';
    const f = await fixture({ body: `${first}\n\n${second}` });
    f.paint();
    const click = nativeClicks(f),
      root = f.probe.surface.body as HTMLElement;
    click(root.querySelectorAll('mark')[0]);
    click(root.querySelectorAll('mark')[1]);
    expect(f.probe.sendSource?.passage.text).toBe('Second excerpt.');
    for (const file of f.targets)
      expect(await f.vault.read(file)).not.toContain('> First excerpt.');
    expect((await f.store.read(f.article.path)).body).toBe(`${first}\n\n${second}`);
  });
  it.each(['Done', 'Escape', 'plain text'] as const)(
    'clears selected-source pill sending on %s',
    async (clear) => {
      const body =
        hostSelection('First excerpt.', { quote: 'First excerpt.' }, ['Nodes/Concept.md']).body +
        '\n\nBackground prose.';
      const f = await fixture({ body });
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement;
      click(root.querySelector('mark')!);
      expect(f.probe.sendSource).toBeDefined();
      if (clear === 'Done') passageButton(f.view, 'Done').click();
      else if (clear === 'Escape')
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      else click(root.querySelectorAll('p')[1]);
      expect(f.probe.sendSource).toBeUndefined();
      click(root.querySelector('.reader-reference-pill')!);
      await f.probe.operations;
      expect(mocks.highlightPicker).toHaveBeenCalledOnce();
      expect(await f.vault.read(f.targets[0])).not.toContain('> First excerpt.');
    },
  );
  it('shows existing topic aliases, untyped notes and unresolved labels without changing their metadata', async () => {
    const f = await fixture({ defaults: [0] });
    const legacy = await f.note('Nodes/Legacy.md', 'Authored legacy content.', 'not-registered');
    const before = await f.store.read(f.article.path);
    f.vault.bytes.set(
      f.article,
      patchProperties(before.raw, {
        topics: [
          '[[Nodes/Project.md|Project alias]]',
          `[[${legacy.path}|Legacy alias]]`,
          '[[Missing/Note|Missing alias]]',
          '[[Nodes/Project.md|Duplicate alias]]',
        ],
      }),
    );
    await f.view.changed({ path: f.article.path, metadataChanged: true });
    const source = (await f.store.read(f.article.path)).raw,
      body = f.probe.surface.body.firstChild;
    expect(f.probe.surface.topics.textContent).toBe('Project alias Legacy alias Missing alias');
    expect(f.probe.surface.topics.querySelectorAll('a')).toHaveLength(2);
    expect(f.probe.surface.topics.querySelector('.reader-reference-prefix')).toBeNull();
    f.api.getNode.mockImplementation(() => {
      throw new Error('Provider reloaded');
    });
    await f.view.changed({ path: legacy.path, metadataChanged: true });
    expect(f.probe.surface.topics.textContent).toBe('Project alias Legacy alias Missing alias');
    expect(f.probe.surface.body.firstChild).toBe(body);
    expect((await f.store.read(f.article.path)).raw).toBe(source);
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it.each([
    { ctrlKey: false, metaKey: false, button: 0, newLeaf: false },
    { ctrlKey: true, metaKey: false, button: 0, newLeaf: true },
    { ctrlKey: false, metaKey: true, button: 0, newLeaf: true },
    { ctrlKey: false, metaKey: false, button: 1, newLeaf: true },
  ])(
    'navigates header topics without invoking highlight filing: %j',
    async ({ newLeaf, ...options }) => {
      const f = await fixture({ defaults: [0] }),
        before = (await f.store.read(f.article.path)).raw,
        target = await f.vault.read(f.targets[0]),
        open = vi.spyOn(f.probe, 'openLinked').mockResolvedValue(undefined),
        bodyClick = vi.spyOn(f.probe, 'targetClicked');
      const link = f.probe.surface.topics.querySelector('a')!;
      link.dispatchEvent(
        new MouseEvent(options.button === 1 ? 'auxclick' : 'click', {
          ...options,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(open).toHaveBeenCalledWith(f.targets[0].path, newLeaf);
      expect(bodyClick).not.toHaveBeenCalled();
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).raw).toBe(before);
      expect(await f.vault.read(f.targets[0])).toBe(target);
    },
  );
  it('unchecks one of two filed notes through Apply, removing only its exact quotation', async () => {
    const f = await fixture({ defaults: [0, 1] });
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const before = await f.store.read(f.article.path),
      anchor = paragraphAnchors(before.body)[0].blockId,
      retained = await f.vault.read(f.targets[0]),
      removed = await f.vault.read(f.targets[1]),
      expected = removeQuotation(
        removed,
        'first words',
        originLink(before.path, anchor, 'Hosted'),
      ).raw;
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [f.nodes[0]] });
    await menu(f.view, 'Add highlight to notes…');
    expect(mocks.highlightPicker).toHaveBeenLastCalledWith(
      f.app,
      f.api,
      expect.objectContaining({
        query: '',
        selectedPaths: f.nodes.map((node) => node.path),
        minSelection: 0,
        actionLabel: 'Apply',
      }),
    );
    const saved = await f.store.read(f.article.path);
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept']);
    expect(passages(saved.body)[0].text).toBe('first words');
    expect(paragraphAnchors(saved.body)[0].blockId).toBe(anchor);
    expect(saved.properties.topics).toEqual(before.properties.topics);
    expect(await f.vault.read(f.targets[0])).toBe(retained);
    expect(await f.vault.read(f.targets[1])).toBe(expected);
    expect(f.vault.trashed).toEqual([]);
  });
  it('clears the last checked host and its exact copy while keeping text, anchors, defaults, and unrelated snapshots', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const original = await f.store.read(f.article.path),
      anchor = paragraphAnchors(original.body)[0].blockId;
    f.vault.bytes.set(
      f.targets[0],
      appendQuotation(
        await f.vault.read(f.targets[0]),
        'Unrelated owned snapshot.',
        originLink('Other/Source.md', 'native-other', 'Other'),
      ).raw,
    );
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
    await menu(f.view, 'Add highlight to notes…');
    const saved = await f.store.read(f.article.path),
      target = await f.vault.read(f.targets[0]);
    expect(passages(saved.body)).toEqual([]);
    expect(saved.body).toContain('Before first words after.');
    expect(saved.body).toContain(`^${anchor}`);
    expect(saved.properties.topics).toEqual(original.properties.topics);
    expect(target).not.toContain('> first words');
    expect(target).toContain('> Unrelated owned snapshot.');
    expect(target).toContain('Authored concept.');
    expect(f.vault.trashed).toEqual([]);
    expect(f.probe.tapUndo).toBeUndefined();
  });
  it('refuses an explicit uncheck before any source mutation when the filed quotation was edited', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const target = (await f.vault.read(f.targets[0])).replace(
      '> first words',
      '> User edited these words',
    );
    f.vault.bytes.set(f.targets[0], target);
    const original = await f.store.read(f.article.path),
      process = vi.spyOn(f.vault, 'process');
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(/quotation/i);
    expect((await f.store.read(f.article.path)).raw).toBe(original.raw);
    expect(await f.vault.read(f.targets[0])).toBe(target);
    expect(process.mock.calls.filter(([file]) => file === f.article)).toHaveLength(0);
  });
  it('retries only unfinished explicit removals after a source-first partial failure', async () => {
    const f = await fixture();
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const process = f.vault.process.bind(f.vault);
    let fail = true;
    const calls: string[] = [];
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === f.targets[1] && fail) {
        fail = false;
        throw new Error('Temporarily blocked destination');
      }
      return process(file, update);
    });
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      /source annotation was saved/i,
    );
    expect(passages((await f.store.read(f.article.path)).body)).toEqual([]);
    expect(await f.vault.read(f.targets[0])).not.toContain('> first words');
    expect(await f.vault.read(f.targets[1])).toContain('> first words');
    passageButton(f.view, 'Retry note updates').click();
    await f.probe.operations;
    for (const file of f.targets) expect(await f.vault.read(file)).not.toContain('> first words');
    expect(calls.filter((path) => path === f.targets[0].path)).toHaveLength(1);
    expect(calls.filter((path) => path === f.targets[1].path)).toHaveLength(2);
    expect(f.vault.trashed).toEqual([]);
  });
  it('paints public resolved node icons before listed-class fallback, stripping fragments and tolerating provider failure', async () => {
    const f = await fixture(),
      icon = document.createElement('span');
    f.nodes[0].icon = 'star';
    f.api.listTypes.mockReturnValue([
      { type: 'Project', label: 'Project', icon: 'briefcase' },
      { type: 'Concept', label: 'Concept', icon: 'book' },
    ] as any);
    vi.mocked(setIcon).mockClear();
    f.probe.paintReferenceIcon('Nodes/Concept#Heading', icon, f.article);
    expect(setIcon).toHaveBeenLastCalledWith(icon, 'star');
    delete f.nodes[0].icon;
    f.probe.paintReferenceIcon('Nodes/Concept#^native-existing', icon, f.article);
    expect(setIcon).toHaveBeenLastCalledWith(icon, 'book');
    f.nodes[0].classes = ['Concept', 'Project'];
    f.api.listTypes.mockReturnValue([
      { type: 'Concept', label: 'Concept' },
      { type: 'Project', label: 'Project', icon: 'notebook' },
    ] as any);
    f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article);
    expect(setIcon).toHaveBeenLastCalledWith(icon, 'notebook');
    vi.mocked(setIcon).mockClear();
    f.nodes[0].icon = '';
    f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article);
    expect(setIcon).not.toHaveBeenCalled();
    delete f.nodes[0].icon;
    f.nodes[0].classes = ['NotRegistered'];
    f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article);
    expect(setIcon).not.toHaveBeenCalled();
    f.api.getNode.mockImplementationOnce(() => {
      throw new Error('Provider unavailable');
    });
    expect(() => f.probe.paintReferenceIcon('Nodes/Concept', icon, f.article)).not.toThrow();
  });
  it.each(['revoked membership', 'replacement file'] as const)(
    'does not erase an unchecked related-note original after %s at the final source boundary',
    async (change) => {
      const f = await fixture({ defaults: [0] }),
        before = await f.store.read(f.article.path);
      mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [] });
      const process = f.vault.process.bind(f.vault);
      let changed = false;
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        if (file === f.article && !changed) {
          changed = true;
          if (change === 'revoked membership') f.nodes[0].classes = [];
          else {
            const replacement = Object.setPrototypeOf(
              { ...f.targets[0] },
              TFile.prototype,
            ) as TFile;
            f.vault.files.set(replacement.path, replacement);
            f.vault.bytes.set(replacement, await f.vault.read(f.targets[0]));
            f.cache.set(replacement, f.cache.get(f.targets[0]));
          }
        }
        return process(file, update);
      });
      await f.probe.topics();
      expect(changed).toBe(true);
      expect(mocks.notice).toHaveBeenCalledWith(
        expect.stringMatching(
          change === 'replacement file'
            ? /note changed.*Nothing was overwritten/
            : /typed destination changed/,
        ),
      );
      expect((await f.store.read(f.article.path)).raw).toBe(before.raw);
      expect(mocks.highlightPicker).toHaveBeenCalledTimes(2);
      expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    },
  );
  it.each([{ ctrlKey: true }, { metaKey: true }, { button: 1 }])(
    'keeps modified reference navigation available with a source highlight active (%j)',
    async (init) => {
      const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
        'Nodes/Concept.md',
      ]).body;
      const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
        'Nodes/Project.md',
      ]).body;
      const f = await fixture({ body: `${first}\n\n${second}` });
      f.paint();
      const click = nativeClicks(f),
        root = f.probe.surface.body as HTMLElement;
      click(root.querySelector('mark')!);
      expect(f.probe.sendSource).toBeDefined();
      click(root.querySelector('[data-reader-passage="1"] .reader-reference-pill')!, init);
      for (let i = 0; i < 100 && !f.opened.openFile.mock.calls.length; i++) await Promise.resolve();
      expect(f.opened.openFile).toHaveBeenCalledOnce();
      expect(f.opened.openFile).toHaveBeenCalledWith(f.targets[1], { active: true });
      expect(f.probe.sendSource).toBeUndefined();
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      for (const target of f.targets)
        expect(await f.vault.read(target)).not.toContain('> First excerpt.');
      expect((await f.store.read(f.article.path)).body).toBe(`${first}\n\n${second}`);
    },
  );
  it('keeps a fresh source snapshot for repeated exact-pill filings without duplicating quotation copies', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = hostSelection('Second excerpt.', { quote: 'Second excerpt.' }, [
      'Nodes/Project.md',
    ]).body;
    const f = await fixture({ body: `${first}\n\n${second}` });
    f.paint();
    const click = nativeClicks(f),
      root = f.probe.surface.body as HTMLElement;
    click(root.querySelector('mark')!);
    click(root.querySelector('[data-reader-passage="1"] .reader-reference-pill')!);
    await f.probe.operations;
    const filed = await f.vault.read(f.targets[1]);
    f.paint();
    click(root.querySelector('[data-reader-passage="1"] .reader-reference-pill')!);
    await f.probe.operations;
    expect(await f.vault.read(f.targets[1])).toBe(filed);
    expect(filed.match(/> First excerpt\./g)).toHaveLength(1);
    expect(f.probe.sendSource?.snapshot.body).toBe((await f.store.read(f.article.path)).body);
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('retries an unfinished removal without repeating a completed created-note collection or origin write', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const process = f.vault.process.bind(f.vault),
      calls: string[] = [];
    let fail = true;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      calls.push(file.path);
      if (file === f.targets[0] && fail) {
        fail = false;
        throw new Error('Temporary removal failure');
      }
      return process(file, update);
    });
    mocks.highlightPicker.mockResolvedValueOnce({
      kind: 'create',
      title: 'Project',
      type: 'Project',
    });
    f.api.createNodeForLink.mockImplementationOnce(async (_options, link) => {
      await link(f.nodes[1]);
      return f.nodes[1];
    });
    await expect(menu(f.view, 'Add highlight to notes…')).rejects.toThrow(
      /source annotation was saved/i,
    );
    const createdCopy = await f.vault.read(f.targets[1]);
    expect(createdCopy).toContain('> first words');
    expect(readDocument(createdCopy).properties.origin).toContain('#^reader-');
    passageButton(f.view, 'Retry note updates').click();
    await f.probe.operations;
    expect(await f.vault.read(f.targets[1])).toBe(createdCopy);
    expect(await f.vault.read(f.targets[0])).not.toContain('> first words');
    expect(calls.filter((path) => path === f.targets[1].path)).toHaveLength(1);
    expect(calls.filter((path) => path === f.targets[0].path)).toHaveLength(2);
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
  });
  it('converts a hosted highlight to a note link without removing any earlier filed quotation', async () => {
    const f = await fixture({ defaults: [0] });
    await f.select();
    f.probe.surface.selectionValue = undefined;
    f.probe.surface.refresh();
    const copy = await f.vault.read(f.targets[0]);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing', node: f.nodes[1] });
    await menu(f.view, 'Convert to note link…');
    expect((await f.store.read(f.article.path)).body).toContain('[[Nodes/Project|first words]]');
    expect(await f.vault.read(f.targets[0])).toBe(copy);
    expect(await f.vault.read(f.targets[1])).not.toContain('> first words');
  });
  it('requires a picker when no typed default exists and cancellation writes neither file', async () => {
    const f = await fixture(),
      before = await f.store.read(f.article.path),
      target = await f.vault.read(f.targets[0]);
    await f.select();
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect(await f.store.read(f.article.path)).toEqual(before);
    expect(await f.vault.read(f.targets[0])).toBe(target);
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
  });
  it.each([0, 1])(
    'inherits one valid typed destination of any class (destination %i)',
    async (index) => {
      const f = await fixture({ defaults: [index] });
      await f.select();
      const saved = await f.store.read(f.article.path);
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
      expect(passages(saved.body)[0].hosts).toEqual([f.nodes[index].path.replace(/\.md$/, '')]);
      expect(await f.vault.read(f.targets[index])).toContain(
        '> first words (※ [[Reading/Inbox/Hosted#^reader-',
      );
      expect(saved.properties.topics).toEqual([`[[${f.nodes[index].path.replace(/\.md$/, '')}]]`]);
    },
  );
  it('offers several defaults without silently choosing the first, and remembers an explicit new choice', async () => {
    const f = await fixture({ defaults: [0, 1] });
    await f.select();
    expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ preferredPaths: f.nodes.map((node) => node.path) }),
    );
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    f.probe.lastSelection = '';
    await f.select();
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual(['Nodes/Project']);
    expect(await f.vault.read(f.targets[0])).not.toContain('## Highlights');
  });
  it('ignores invalid/untyped defaults instead of treating arbitrary files as hosts', async () => {
    const f = await fixture({ defaults: [0] });
    f.nodes[0].classes = ['NotAFileclass'];
    await f.select();
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
  });
  it('shows a clear provider error for new highlights while keeping legacy removal usable', async () => {
    const f = await fixture();
    (f.app as any).plugins = undefined;
    await expect(f.select()).rejects.toThrow(/Fileclass Inline.*v2/);
    expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
    const old = await f.note('Reading/Inbox/Legacy.md', 'Before ==legacy== after.');
    await f.view.openArticle(old.path);
    await menu(f.view, 'Remove highlight (article only)');
    expect((await f.store.read(old.path)).body).toBe('Before legacy after.');
  });
  it('uses createNodeForLink before required completion, accepts membership rather than primary type, and never invokes a shared picker', async () => {
    const f = await fixture();
    mocks.highlightPicker.mockResolvedValue({
      kind: 'create',
      title: 'Typed project',
      type: 'Project',
    });
    f.api.createNodeForLink.mockImplementation(async (options, link) => {
      expect(options).toMatchObject({
        type: 'Project',
        suggestedTitle: 'Typed project',
        sourcePath: f.article.path,
      });
      await link(f.nodes[1]);
      expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual([
        'Nodes/Project',
      ]);
      expect(await f.vault.read(f.targets[1])).toContain('## Highlights');
      expect(readDocument(await f.vault.read(f.targets[1])).properties.origin).toMatch(
        /Hosted#\^reader-/,
      );
      return null; // Completion cancellation never rolls back a created node/source.
    });
    await f.select();
    expect(f.api.createNodeForLink).toHaveBeenCalledOnce();
    expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect(f.vault.file(f.targets[1].path)).toBe(f.targets[1]);
  });
  it('rejects a created node without the selected class and a duplicate callback', async () => {
    const f = await fixture();
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'Project', type: 'Project' });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(f.nodes[1]);
      await expect(link(f.nodes[1])).rejects.toThrow(/already ran/);
      return f.nodes[1];
    });
    await f.select();
    expect((await f.vault.read(f.targets[1])).match(/> first words/g)).toHaveLength(1);
    const other = await fixture();
    mocks.highlightPicker.mockResolvedValue({
      kind: 'create',
      title: 'Wrong class',
      type: 'Project',
    });
    other.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(other.nodes[0]);
      return other.nodes[0];
    });
    await expect(other.select()).rejects.toThrow(/chosen Fileclass/);
    expect((await other.store.read(other.article.path)).body).toBe('Before first words after.');
  });
  it.each(['provider', 'classes', 'source'] as const)(
    'rechecks %s at the callback mutation boundary',
    async (change) => {
      const f = await fixture(),
        targetRaw = await f.vault.read(f.targets[0]);
      mocks.highlightPicker.mockResolvedValue({
        kind: 'create',
        title: 'Concept',
        type: 'Concept',
      });
      f.api.createNodeForLink.mockImplementation(async (_options, link) => {
        if (change === 'provider')
          (f.app as any).plugins = { getPlugin: () => ({ api: { ...f.api } }) };
        else if (change === 'classes') f.nodes[0].classes = ['Other'];
        else f.vault.bytes.set(f.article, `${await f.vault.read(f.article)}\nExternal edit.`);
        await link(f.nodes[0]);
        return f.nodes[0];
      });
      await expect(f.select()).rejects.toThrow();
      expect(await f.vault.read(f.targets[0])).toBe(targetRaw);
      expect((await f.store.read(f.article.path)).body).not.toContain('==');
    },
  );
  it.each([false, true])(
    'cancels an uncooperative creation provider without losing dispatched content (committed=%s)',
    async (committed) => {
      const f = await fixture({ body: '==first words==' }),
        entered = gate();
      mocks.highlightPicker.mockResolvedValue({
        kind: 'create',
        title: 'Concept',
        type: 'Concept',
      });
      let callback!: (node: NodeResult) => Promise<void>;
      f.api.createNodeForLink.mockImplementation(async (_options, link) => {
        callback = link;
        if (committed) await link(f.nodes[0]);
        entered.resolve();
        return new Promise<never>(() => {});
      });
      const pending = menu(f.view, 'Add highlight to notes…');
      await entered.promise;
      const leaving = f.view.readingList();
      await leaving;
      await pending;
      await expect(callback(f.nodes[0])).rejects.toThrow(/cancelled/);
      expect(f.probe.snapshot).toBeUndefined();
      expect((await f.store.read(f.article.path)).body.includes('(※')).toBe(committed);
      expect((await f.vault.read(f.targets[0])).includes('## Highlights')).toBe(committed);
    },
  );
  it('drains an already-dispatched target write before navigation and never rolls it back', async () => {
    const f = await fixture({ body: '==first words==' }),
      entered = gate(),
      release = gate();
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[0] });
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      if (file === f.targets[0]) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = menu(f.view, 'Add highlight to notes…');
    await entered.promise;
    let left = false;
    const leaving = f.view.readingList().then(() => {
      left = true;
    });
    await Promise.resolve();
    expect(left).toBe(false);
    expect(await f.vault.read(f.targets[0])).toContain('## Highlights');
    release.resolve();
    await leaving;
    await pending.catch(() => {}); // Cancellation may report an already-dispatched save as uncertain.
    expect((await f.store.read(f.article.path)).body).toContain('(※ [[Nodes/Concept]])');
    expect(await f.vault.read(f.targets[0])).toContain('> first words');
  });
  it('routes the first excerpt to a second highlight host and leaves the second passage unchanged', async () => {
    const body = hostSelection('First excerpt.\n\nSecond excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = hostSelection(body, { quote: 'Second excerpt.' }, ['Nodes/Project.md']);
    const f = await fixture({ body: second.body });
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    expect(passageButton(f.view, 'Cancel choosing from article')).toBeDefined();
    f.probe.selectPassageMark(
      f.probe.surface.body.querySelectorAll('mark')[1],
      new MouseEvent('click'),
    );
    await f.probe.operations;
    const saved = await f.store.read(f.article.path),
      found = passages(saved.body);
    expect(found[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
    expect(found[1].hosts).toEqual(['Nodes/Project']);
    expect(found[1].text).toBe('Second excerpt.');
    const firstAnchor = /\^(reader-[a-z0-9-]+)/.exec(saved.body)![1];
    const target = await f.vault.read(f.targets[1]);
    expect(target).toContain(`> First excerpt. (※ [[Reading/Inbox/Hosted#^${firstAnchor}`);
    expect(target).not.toContain('> Second excerpt.');
  });
  it('sends to the actual highlight host when a mark is inside an internal link with a different target', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second = '[==Second excerpt.==](Nodes/Concept.md) (※ [[Nodes/Project]]) ^native-existing';
    const f = await fixture({ body: `${first}\n\n${second}` });
    f.vault.bytes.set(
      f.targets[0],
      appendQuotation(
        await f.vault.read(f.targets[0]),
        'First excerpt.',
        originLink(f.article.path, paragraphAnchors(first)[0].blockId, 'Hosted'),
      ).raw,
    );
    const conceptBefore = await f.vault.read(f.targets[0]);
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    const mark = f.probe.surface.body.querySelectorAll('mark')[1] as HTMLElement;
    expect(mark.parentElement?.matches('a.internal-link')).toBe(true);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(click, 'target', { value: mark });
    // Native caret hit-testing belongs to the TapHighlighter. Verify its two
    // Reader callbacks separately: the inline-link interceptor must decline the
    // marked text, then the mapped logical passage supplies the actual host.
    expect(f.probe.targetClicked(click)).toBe(false);
    f.probe.selectPassageMark(mark, click);
    await f.probe.operations;
    const saved = await f.store.read(f.article.path);
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept', 'Nodes/Project']);
    expect(saved.body).toContain(second);
    expect(await f.vault.read(f.targets[1])).toContain('> First excerpt.');
    expect(await f.vault.read(f.targets[1])).not.toContain('> Second excerpt.');
    expect(await f.vault.read(f.targets[0])).toBe(conceptBefore);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(mocks.highlightPicker).toHaveBeenCalledOnce();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ allowPickFromArticle: true, multiple: true }),
    );
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it('still uses an internal link exact target when its unmarked portion is clicked', async () => {
    const first = hostSelection('First excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    const second =
      '[Unmarked ==Second excerpt.==](Nodes/Concept.md) (※ [[Nodes/Project]]) ^native-existing';
    const f = await fixture({ body: `${first}\n\n${second}` });
    const projectBefore = await f.vault.read(f.targets[1]);
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    const link = f.probe.surface.body.querySelector(
      'a.internal-link[href="Nodes/Concept.md"]',
    ) as HTMLAnchorElement;
    expect(link.querySelector('mark')).not.toBeNull();
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
      link.dispatchEvent(event);
    }
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toContain(second);
    expect(await f.vault.read(f.targets[0])).toContain('> First excerpt.');
    expect(await f.vault.read(f.targets[1])).toBe(projectBefore);
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it('requires an explicit choice among multiple second-highlight hosts and supports Cancel choosing from article', async () => {
    let body = hostSelection('First excerpt.\n\nSecond excerpt.', { quote: 'First excerpt.' }, [
      'Nodes/Concept.md',
    ]).body;
    body = hostSelection(body, { quote: 'Second excerpt.' }, [
      'Nodes/Concept.md',
      'Nodes/Project.md',
    ]).body;
    const f = await fixture({ body });
    f.paint();
    f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
    await menu(f.view, 'Choose from article…');
    passageButton(f.view, 'Cancel choosing from article').click();
    expect(f.probe.sendSource).toBeUndefined();
    expect((await f.store.read(f.article.path)).body).toBe(body);
    await menu(f.view, 'Choose from article…');
    mocks.choose.mockResolvedValue(null);
    f.probe.selectPassageMark(
      f.probe.surface.body.querySelectorAll('mark')[1],
      new MouseEvent('click'),
    );
    await f.probe.operations;
    expect(mocks.choose).toHaveBeenCalledWith(
      f.app,
      'Add highlight to notes',
      f.nodes,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect((await f.store.read(f.article.path)).body).toBe(body);
  });
  it.each(['inline', 'reference'] as const)(
    'routes to the exact typed %s link rather than opening it',
    async (kind) => {
      const base = hostSelection('First excerpt.\n\nSecond excerpt.', { quote: 'First excerpt.' }, [
        'Nodes/Concept.md',
      ]).body;
      const body =
        kind === 'reference'
          ? hostSelection(base, { quote: 'Second excerpt.' }, ['Nodes/Project.md']).body
          : `${base}\n\n[[Nodes/Project.md|Project link]]`;
      const f = await fixture({ body });
      f.paint();
      f.probe.passageMenu(passages(f.probe.snapshot.body)[0]);
      await menu(f.view, 'Choose from article…');
      const links = [
        ...(f.probe.surface.body as HTMLElement).querySelectorAll<HTMLAnchorElement>(
          'a.internal-link',
        ),
      ];
      const link = links.find(
        (link) => link.getAttribute('href')?.replace(/\.md$/, '') === 'Nodes/Project',
      )!;
      for (const type of ['pointerdown', 'pointerup']) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
        link.dispatchEvent(event);
      }
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await f.probe.operations;
      expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual([
        'Nodes/Concept',
        'Nodes/Project',
      ]);
      expect(f.opened.openFile).not.toHaveBeenCalled();
    },
  );
  it('Undo removes only the source mark/references, retaining anchors, defaults, and user-owned destination snapshots', async () => {
    const f = await fixture({ defaults: [0] });
    f.paint();
    const range = document.createRange(),
      node = f.probe.surface.body.querySelector('p').firstChild;
    range.setStart(node, 7);
    range.setEnd(node, 18);
    await f.probe.saveTapSelection(f.probe.surface.body, range);
    const target = await f.vault.read(f.targets[0]),
      saved = await f.store.read(f.article.path);
    const anchor = /\^reader-[a-z0-9-]+/.exec(saved.body)![0];
    passageButton(f.view, 'Undo').click();
    await f.probe.operations;
    const undone = await f.store.read(f.article.path);
    expect(undone.body).toBe(`Before first words after. ${anchor}`);
    expect(undone.properties.topics).toEqual(saved.properties.topics);
    expect(await f.vault.read(f.targets[0])).toBe(target);
  });
  it('explicitly unchecks a destination by removing its exact filed quotation while retaining defaults and the new destination', async () => {
    const f = await fixture({ body: '==first words==' });
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[0] });
    await menu(f.view, 'Add highlight to notes…');
    const firstSnapshot = await f.vault.read(f.targets[0]);
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    await menu(f.view, 'Add highlight to notes…');
    const source = await f.store.read(f.article.path);
    expect(passages(source.body)[0].hosts).toEqual(['Nodes/Project']);
    expect(firstSnapshot).toContain('> first words');
    expect(await f.vault.read(f.targets[0])).not.toContain('> first words');
    expect(await f.vault.read(f.targets[0])).toContain('Authored concept.');
    expect(await f.vault.read(f.targets[1])).toContain('> first words');
    expect(source.properties.topics).toEqual(['[[Nodes/Concept]]', '[[Nodes/Project]]']);
  });
  it('converts only on explicit intent into an ordinary node alias without a redundant pill or quotation', async () => {
    const initial = hostSelection('first words', { quote: 'first words' }, ['Nodes/Concept.md']);
    const f = await fixture({ body: initial.body }),
      target = await f.vault.read(f.targets[1]);
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    await menu(f.view, 'Convert to note link…');
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ query: 'first words' }),
    );
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toBe(`[[Nodes/Project|first words]] ^${initial.blockId}`);
    expect(await f.vault.read(f.targets[1])).toBe(target);
    expect(passages(saved.body)).toEqual([]);
  });
  it('links a fresh tap range to an explicitly chosen typed note without saving a highlight or quotation', async () => {
    const f = await fixture({ defaults: [0] });
    f.paint();
    const range = document.createRange(),
      node = f.probe.surface.body.querySelector('p').firstChild;
    range.setStart(node, 7);
    range.setEnd(node, 18);
    const originalTarget = await f.vault.read(f.targets[1]);
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.nodes[1] });
    await f.probe.saveTapNode(f.probe.surface.body, range);
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ query: 'first words', multiple: false }),
    );
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toMatch(/Before \[\[Nodes\/Project\|first words\]\] after\. \^reader-/);
    expect(saved.body).not.toContain('==');
    expect(await f.vault.read(f.targets[1])).toBe(originalTarget);
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
  });
  it('commits the source link and birth origin through public typed creation before required completion', async () => {
    const f = await fixture();
    f.paint();
    const range = document.createRange(),
      node = f.probe.surface.body.querySelector('p').firstChild;
    range.setStart(node, 7);
    range.setEnd(node, 18);
    mocks.highlightPicker.mockResolvedValue({
      kind: 'create',
      title: 'First words',
      type: 'Concept',
    });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      await link(f.nodes[0]);
      const saved = await f.store.read(f.article.path);
      expect(saved.body).toContain('[[Nodes/Concept|first words]]');
      expect(saved.body).not.toContain('==');
      return f.nodes[0];
    });
    await f.probe.saveTapNode(f.probe.surface.body, range);
    const saved = await f.store.read(f.article.path);
    const anchor = /\^reader-[a-z0-9-]+/.exec(saved.body)![0];
    expect(await f.vault.read(f.targets[0])).toContain(
      `origin: "[[${saved.path.replace(/\.md$/, '')}#${anchor}]]"`,
    );
    expect(await f.vault.read(f.targets[0])).not.toContain('## Highlights');
  });
  it('never converts automatically when a selected excerpt equals the node title', async () => {
    const f = await fixture({ defaults: [0] });
    f.nodes[0].title = 'first words';
    await f.select();
    expect(passages((await f.store.read(f.article.path)).body)).toHaveLength(1);
    expect(await f.vault.read(f.targets[0])).toContain('> first words');
  });
  it('preserves a Reader position write while a creation callback is pending', async () => {
    const f = await fixture({ body: '==first words==' });
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'Concept', type: 'Concept' });
    f.api.createNodeForLink.mockImplementation(async (_options, link) => {
      f.probe.persistPosition('first words');
      await f.probe.positionWrite;
      await link(f.nodes[0]);
      return f.nodes[0];
    });
    await menu(f.view, 'Add highlight to notes…');
    const saved = await f.store.read(f.article.path);
    expect(saved.properties.bookmark).toBe('first words');
    expect(passages(saved.body)[0].hosts).toEqual(['Nodes/Concept']);
  });
  it('preserves other typed remembered destinations through existing topic assignment without reclassifying them', async () => {
    const f = await fixture({ defaults: [0, 1] });
    const topic = await f.note('Topics/Real.md', 'A topic.', 'topic');
    f.nodes.push({
      path: topic.path,
      title: 'Real',
      type: 'different-primary',
      classes: ['Concept'],
      aliases: [],
    });
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: f.nodes });
    await f.probe.topics();
    const saved = await f.store.read(f.article.path);
    expect(saved.properties.topics).toEqual([
      '[[Nodes/Concept]]',
      '[[Nodes/Project]]',
      '[[Topics/Real.md]]',
    ]);
    expect(readDocument(await f.vault.read(f.targets[1])).properties.type).toBe('project');
  });
  it('offers only public Fileclass destinations in article assignment and preserves ineligible legacy YAML', async () => {
    const f = await fixture();
    const untyped = await f.note('Topics/Untyped.md', 'An old untyped topic.', 'topic');
    const legacy = ['[[Topics/Untyped.md]]', 'unrecognized authored value', { custom: 'preserve' }];
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { topics: legacy }),
    );
    await f.view.openArticle(f.article.path);
    mocks.highlightPicker.mockImplementationOnce(async (_app, api, options) => {
      expect(api).toBe(f.api);
      expect(options).toEqual(
        expect.objectContaining({
          multiple: true,
          selectedPaths: [],
          minSelection: 0,
          actionLabel: 'Apply',
          title: 'Related notes',
        }),
      );
      expect(api.getNode(untyped.path)).toBeNull();
      return { kind: 'existing-many', nodes: [f.nodes[1]] };
    });
    await f.probe.topics();
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      ...legacy,
      '[[Nodes/Project.md]]',
    ]);
    expect(readDocument(await f.vault.read(untyped)).properties.type).toBe('topic');
  });
  it('blocks assignment without the public provider but retains read-only legacy topic filtering', async () => {
    const f = await fixture();
    const legacy = await f.note('Topics/Legacy.md', 'An ordinary legacy topic.', 'topic');
    (f.app as any).plugins = undefined;
    await expect(f.probe.topics()).rejects.toThrow(/Fileclass Inline.*v2/);
    expect(mocks.topics).not.toHaveBeenCalled();
    await f.view.readingList();
    const { chooseTopicFilter } = await import('../src/host/topic-filter-dialog');
    vi.mocked(chooseTopicFilter).mockResolvedValueOnce(null);
    await f.probe.selectTopicFilter();
    expect(chooseTopicFilter).toHaveBeenCalledWith(
      f.app,
      expect.arrayContaining([expect.objectContaining({ path: legacy.path })]),
      undefined,
      expect.any(AbortSignal),
    );
  });
  it('rechecks assigned Fileclass membership inside the final source transform', async () => {
    const f = await fixture(),
      original = await f.store.read(f.article.path);
    mocks.highlightPicker.mockResolvedValueOnce({ kind: 'existing-many', nodes: [f.nodes[0]] });
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, transform) => {
      f.nodes[0].classes = ['NotRegistered'];
      return process(file, transform);
    });
    await f.probe.topics();
    expect(mocks.notice).toHaveBeenCalledWith(expect.stringMatching(/typed destination changed/));
    expect(mocks.highlightPicker).toHaveBeenLastCalledWith(
      f.app,
      f.api,
      expect.objectContaining({ selectedPaths: [f.nodes[0].path] }),
    );
    expect((await f.store.read(f.article.path)).raw).toBe(original.raw);
  });
  it('does not revive a queued picker after a newer explicit navigation intent', async () => {
    const f = await fixture({ body: '==first words==' }),
      entered = gate(),
      release = gate();
    const blocked = f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = menu(f.view, 'Add highlight to notes…');
    const leaving = f.view.readingList();
    release.resolve();
    await blocked;
    await pending;
    await leaving;
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('captures and drains a sole-default native selection on normal close even after the native range disappears', async () => {
    const f = await fixture({ defaults: [0] });
    f.probe.surface.selectionValue = { quote: 'first words', before: 'Before ', after: ' after.' };
    const closing = f.view.onClose();
    f.probe.surface.selectionValue = undefined;
    await closing;
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual(['Nodes/Concept']);
    expect(await f.vault.read(f.targets[0])).toContain('> first words');
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('finishes a sole-default pending native selection before navigation without starting a picker', async () => {
    const f = await fixture({ defaults: [1] });
    f.probe.surface.selectionValue = { quote: 'first words', before: 'Before ', after: ' after.' };
    await f.view.readingList();
    expect(passages((await f.store.read(f.article.path)).body)[0].hosts).toEqual(['Nodes/Project']);
    expect(f.probe.snapshot).toBeUndefined();
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it.each([{ defaults: [] }, { defaults: [0, 1] }])(
    'does not open a newly required picker after navigation intent (defaults=$defaults)',
    async ({ defaults }) => {
      const f = await fixture({ defaults });
      f.probe.surface.selectionValue = {
        quote: 'first words',
        before: 'Before ',
        after: ' after.',
      };
      await f.view.readingList();
      expect((await f.store.read(f.article.path)).body).toBe('Before first words after.');
      expect(mocks.highlightPicker).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'uses an incoming native paragraph only when explicitly requested, after bookmark restore (fragment=%s)',
    async (fragment) => {
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
      const restore = vi.spyOn(actual.ReadingSurface.prototype, 'restore'),
        reveal = vi.spyOn(actual.ReadingSurface.prototype, 'reveal');
      const f = await fixture({
        body: 'First saved paragraph.\n\nExplicit destination paragraph. ^native-existing',
      });
      f.vault.bytes.set(
        f.article,
        patchProperties(await f.vault.read(f.article), { bookmark: 'First saved paragraph.' }),
      );
      restore.mockClear();
      reveal.mockClear();
      await f.view.setState(
        { file: f.article.path, ...(fragment ? { subpath: '#^native-existing' } : {}) },
        {} as any,
      );
      expect(restore).toHaveBeenCalledWith('First saved paragraph.');
      if (fragment) {
        expect(reveal).toHaveBeenCalledOnce();
        expect(reveal.mock.calls[0][0].dataset.readerParagraph).toBe('native-existing');
        expect(reveal.mock.invocationCallOrder[0]).toBeGreaterThan(
          restore.mock.invocationCallOrder[0],
        );
      } else expect(reveal).not.toHaveBeenCalled();
      expect(f.view.getState()).not.toHaveProperty('subpath');
      expect((await f.store.read(f.article.path)).properties).not.toHaveProperty('subpath');
    },
  );
  it('passes an existing native paragraph subpath through the public new-pane opener', async () => {
    const f = await fixture({ body: 'Destination paragraph. ^native-existing' });
    await openExistingNote(f.app, `${f.article.path}#^native-existing`, 'Nodes/Concept.md', true);
    expect(f.app.workspace.getLeaf).toHaveBeenCalledWith(true);
    expect(f.opened.openFile).toHaveBeenCalledWith(f.article, {
      active: true,
      eState: { subpath: '#^native-existing' },
    });
  });
  it('does not also capture or open a URL when its click ends a native selection', async () => {
    const f = await fixture({ body: '[first words](https://publisher.test/report)' });
    f.paint();
    f.probe.surface.selectionValue = { quote: 'first words', before: '', after: '' };
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    f.probe.surface.body.querySelector('a').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.confirmWebLink).not.toHaveBeenCalled();
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
});

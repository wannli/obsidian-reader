// @vitest-environment node
import {
  mocks,
  hostFixture,
  pluginFixture,
  actionName,
  passageButton,
  passageLabels,
  expectNoPassagePopup,
  expectedPassageActions,
  expectedHosted,
  menu,
} from './helpers/reader-view-fixture';
import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { defaultFolders } from '../src/core/folders';
import { createDocument, readDocument } from '../src/core/document';
import { changePassage, passages } from '../src/core/annotations';
import { paragraphAnchors } from '../src/core/hosted-highlights';
import { appendQuotation, originLink, rememberOrigin } from '../src/core/quotation';
import { ReaderView, nativeLinkPath, openExistingNote } from '../src/reader/view';
import ReaderPlugin from '../src/main';
import type { NodesApi, NodeResult } from '../src/host/nodes';
import { gate } from './helpers/memory-vault';

describe('Nodes v2 linked creation', () => {
  async function fixture(body = '==words==') {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md', body),
      target = await f.note('Nodes/One.md', 'Keep this created note', 'topic');
    const node: NodeResult = {
      path: target.path,
      title: 'One',
      type: 'topic',
      classes: ['topic', 'Other'],
      aliases: [],
    };
    const api: NodesApi = {
      version: 2,
      listTypes: vi.fn(() => [
        { type: 'topic', label: 'Topic' },
        { type: 'Other', label: 'Other' },
      ]),
      searchNodes: vi.fn(() => [node]),
      // Discovery's last-bound type legitimately differs from creation's chosen class.
      getNode: vi.fn((path) =>
        path === node.path ? { ...node, type: 'Other', classes: [...node.classes] } : null,
      ),
      createNode: vi.fn(async () => node),
      createNodeForLink: vi.fn(async (_options, link) => {
        await link(node);
        return node;
      }),
      pickNodeForLink: vi.fn(async () => null),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'words', type: 'topic' });
    await f.view.openArticle(article.path);
    return { ...f, article, target, node, api, linkedBody: expectedHosted(body, target.path) };
  }
  const linkedBody = expectedHosted('==words==', 'Nodes/One.md');
  const originalLinkedBody = '==[[Notes/Existing.md|words]]==';
  function expectedFiledTarget(f: Awaited<ReturnType<typeof fixture>>, before: string): string {
    const blockId = paragraphAnchors(f.linkedBody)[0].blockId;
    const citation = originLink(f.article.path, blockId, f.article.basename);
    return rememberOrigin(
      appendQuotation(before, 'words', citation).raw,
      originLink(f.article.path, blockId),
    );
  }
  async function uiFixture() {
    const f = await fixture(originalLinkedBody);
    await f.note('Reading/Inbox/0.md');
    await f.note('Reading/Inbox/B.md');
    await f.note('Notes/Existing.md', 'Keep existing note', 'topic');
    f.host.paged = true;
    await f.view.onOpen(); // Install Reader's actual DOM handlers, not calls to private navigation.
    await f.view.openArticle(f.article.path, true);
    const plugin = new ReaderPlugin(f.app, {} as any);
    (plugin as any).app = f.app;
    await plugin.onload();
    plugin.store = f.store;
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    f.host.edit = vi.fn((view: ReaderView, file: TFile) => plugin.edit(view, file));
    const web = vi.spyOn(window, 'open').mockReturnValue(null);
    async function click(route: string, label: string) {
      if (route === 'footer' && label === 'Related notes')
        mocks.highlightPicker.mockResolvedValueOnce(null); // Explicitly Cancel the separate related-note draft.
      if (route === 'footer' || (route === 'link' && !['heading', 'unsafe'].includes(label))) {
        const signal = f.probe.nodeCreation?.controller.signal as AbortSignal | undefined;
        // Normal article navigation is intentionally replaced by the passage bar.
        // Done must cancel synchronously, before any queued navigation can wait on Nodes.
        passageButton(f.view, 'Done').click();
        if (signal) expect(signal.aborted).toBe(true);
        expect(f.view.contentEl.querySelector('[aria-label="Done"]')).toBeNull();
      }
      if (route === 'footer' && ['Read later', 'Archive'].includes(label))
        mocks.choose.mockResolvedValueOnce(label === 'Read later' ? 'Later' : 'Archive');
      if (route === 'command') {
        const id = { 'Move…': 'move', 'Topics…': 'topics', 'Open Markdown': 'open-markdown' }[
          label
        ];
        const command = mocks.commands.get(id!);
        expect(command?.checkCallback?.(true)).toBe(true);
        if (id === 'topics') mocks.highlightPicker.mockResolvedValueOnce(null); // Cancel the new staged Related notes dialog, not the uncooperative provider.
        expect(command?.checkCallback?.(false)).toBe(true);
      } else if (route === 'menu') {
        // Legacy route name; actions now use the existing passage bar, not a popup.
        passageButton(f.view, label).click();
        expectNoPassagePopup();
      } else if (route === 'link') {
        const anchor = document.createElement('a');
        anchor.setAttribute(
          'href',
          label === 'external'
            ? 'https://example.test/article'
            : label === 'heading'
              ? '#section'
              : label === 'unsafe'
                ? 'javascript%3Aalert(1)'
                : f.target.path,
        );
        if (label !== 'external' && label !== 'heading') anchor.classList.add('internal-link');
        f.probe.surface.body.append(anchor);
        anchor.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            ctrlKey: label === 'new-leaf',
          }),
        );
      } else {
        const parent: HTMLElement = route === 'fallback' ? f.view.contentEl : f.probe.actions;
        const button = [...parent.querySelectorAll('button')].find(
          (button) =>
            actionName(button) ===
            (['Read later', 'Archive'].includes(label) ? 'Change status' : label),
        );
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(false);
        button!.click();
      }
      // Only drain the resulting work after the synchronous event handler has run.
      await Promise.resolve();
    }
    return { ...f, click, web };
  }

  it.each(
    [true, false].flatMap((linked) => [true, false].map((integrated) => ({ linked, integrated }))),
  )(
    'shows the approved icon-only passage bar (linked=$linked, Nodes=$integrated)',
    async ({ linked, integrated }) => {
      const f = await fixture(linked ? linkedBody : '==words==');
      if (!integrated) (f.app as any).plugins = undefined;
      await f.view.onOpen();
      try {
        await f.view.openArticle(f.article.path, true);
        f.probe.surface.body.innerHTML = '<mark>words</mark>';
        f.probe.surface.body
          .querySelector('mark')
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(passageLabels(f.view)).toEqual(
          expectedPassageActions({ linked, provider: integrated }),
        );
        expect(
          [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('[data-action]')].map(
            (button) => button.dataset.action,
          ),
        ).toEqual([
          ...(linked ? ['open-note'] : []),
          'link-note',
          'convert-node',
          ...(linked ? ['unlink'] : []),
          'remove-highlight',
        ]);
        for (const button of f.view.contentEl.querySelectorAll('.reader-actions button')) {
          expect(button.textContent).toBe('');
          expect(button.querySelector('svg')).not.toBeNull();
        }
        expectNoPassagePopup();
      } finally {
        f.view.stopForUnload();
      }
    },
  );

  it.each([
    { linked: false, intent: 'existing' },
    { linked: true, intent: 'existing' },
    { linked: false, intent: 'create' },
  ] as const)(
    'uses the Reader multiselect for linked=$linked / $intent, never the shared provider picker',
    async ({ linked, intent }) => {
      const f = await fixture(linked ? originalLinkedBody : '==words==');
      if (intent === 'existing')
        mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.node });
      else
        mocks.highlightPicker.mockResolvedValue({
          kind: 'create',
          title: 'Typed topic',
          type: 'topic',
        });
      await menu(f.view, 'Notes…');
      expect(mocks.highlightPicker).toHaveBeenCalledWith(
        f.app,
        f.api,
        expect.objectContaining({
          query: '',
          signal: expect.any(AbortSignal),
          title: 'Add highlight to notes',
          multiple: true,
          minSelection: 0,
          actionLabel: 'Apply',
        }),
      );
      if (intent === 'create')
        expect(f.api.createNodeForLink).toHaveBeenCalledWith(
          {
            type: 'topic',
            suggestedTitle: 'Typed topic',
            sourcePath: f.article.path,
            signal: expect.any(AbortSignal),
          },
          expect.any(Function),
        );
      else expect(f.api.createNodeForLink).not.toHaveBeenCalled();
      expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
      expect(mocks.choose).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      const body = (await f.store.read(f.article.path)).body;
      expect(body).toBe(linked ? expectedHosted(originalLinkedBody, f.target.path) : linkedBody);
      if (linked) {
        expect(body).toContain('==[[Notes/Existing.md|words]]=='); // Preserve the authored URL; it is not an extra host.
        expect(passages(body)[0].hosts).toEqual(['Nodes/One']);
      }
    },
  );

  it.each(['picker', 'creation'] as const)(
    'cancels the Reader %s flow without a write',
    async (stage) => {
      const f = await fixture(),
        before = await f.vault.read(f.article),
        targetBefore = await f.vault.read(f.target);
      if (stage === 'picker') mocks.highlightPicker.mockResolvedValue(null);
      else f.api.createNodeForLink = vi.fn(async () => null);
      await menu(f.view, 'Notes…');
      expect(await f.vault.read(f.article)).toBe(before);
      expect(await f.vault.read(f.target)).toBe(targetBefore);
      expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
      expect(f.vault.trashed).toEqual([]);
      expect(f.probe.dialog).toBe(false);
    },
  );

  it('preserves stale-source checks across Reader choice and the typed creation callback', async () => {
    const f = await fixture(),
      changed = createDocument({ type: 'article' }, '==new words==');
    f.api.createNodeForLink = async (_options, link) => {
      f.vault.bytes.set(f.article, changed);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Notes…')).rejects.toThrow();
    expect(await f.vault.read(f.article)).toBe(changed);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['Remove references (article only)', 'Remove highlight (article only)'])(
    'never removes or rewrites the linked file through %s',
    async (label) => {
      const f = await fixture(linkedBody),
        targetBefore = await f.vault.read(f.target);
      await menu(f.view, label);
      expect((await f.store.read(f.article.path)).body).toBe(
        `${label === 'Remove highlight (article only)' ? 'words' : '==words=='} ^${paragraphAnchors(linkedBody)[0].blockId}`,
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(await f.vault.read(f.target)).toBe(targetBefore);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each([
    ['topic', 'Other'],
    ['Other', 'topic'],
    ['Other', 'topic', 'Extra'],
  ])(
    'links an existing node by class membership, not primary type or class order (%j)',
    async (...classes) => {
      const f = await fixture();
      f.api.getNode = () => ({ ...f.node, type: 'Other', classes });
      mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.node });
      await menu(f.view, 'Notes…');
      expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
    },
  );

  it.each(['Inbox', 'Feed'] as const)(
    'commits directly before required completion without self-cancellation or a second link (%s)',
    async (queue) => {
      const f = await fixture(),
        entered = gate(),
        complete = gate(),
        order: string[] = [];
      if (queue === 'Feed')
        f.probe.snapshot = await f.store.move(await f.store.read(f.article.path), 'Feed');
      const annotate = vi.spyOn(f.store, 'collectHighlight'),
        process = f.vault.process.bind(f.vault),
        move = f.vault.move.bind(f.vault);
      vi.spyOn(f.vault, 'move').mockImplementation(async (file, path) => {
        const previousPath = file.path;
        await move(file, path);
        await f.view.changed({ path, previousPath });
      });
      let requestSignal!: AbortSignal;
      // Native metadata notifications may be delivered before the write promise resolves.
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        const raw = await process(file, update);
        await f.view.changed({ path: file.path, metadataChanged: true });
        return raw;
      });
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        expect(options).toMatchObject({ suggestedTitle: 'words', sourcePath: f.article.path });
        requestSignal = options.signal!;
        expect(requestSignal.aborted).toBe(false);
        order.push('created');
        await link(f.node);
        expect(requestSignal.aborted).toBe(false);
        order.push('linked');
        entered.resolve();
        await complete.promise;
        order.push('required completion');
        return f.node;
      });
      const creation = menu(f.view, 'Notes…');
      await entered.promise;
      expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
      expect(order).toEqual(['created', 'linked']);
      expect(f.probe.dialog).toBe(true);
      expect(f.probe.surface.displayedBody).toBe(f.linkedBody);
      await f.view.changed({ path: f.article.path, metadataChanged: true });
      f.probe.persistPosition('words');
      await f.probe.positionWrite; // Must not wait for itself through the metadata notification.
      expect(requestSignal.aborted).toBe(false);
      expect((await f.store.read(f.article.path)).properties.bookmark).toBe('words');
      complete.resolve();
      await creation;
      expect(order).toEqual(['created', 'linked', 'required completion']);
      expect(annotate).toHaveBeenCalledOnce();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(f.probe.dialog).toBe(false);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(['body', 'rename', 'replacement', 'delete', 'type'] as const)(
    'aborts required completion promptly on an external source %s change after linking',
    async (kind) => {
      const f = await fixture(),
        linked = gate(),
        stopped = gate();
      let requestSignal!: AbortSignal;
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Notes…');
      await linked.promise;
      expect(requestSignal.aborted).toBe(false);
      const oldPath = f.article.path;
      if (kind === 'body')
        f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'External edit'));
      if (kind === 'type')
        f.vault.bytes.set(f.article, createDocument({ type: 'note' }, f.linkedBody));
      if (kind === 'rename') await f.vault.move(f.article, 'Reading/Inbox/Renamed.md');
      if (kind === 'replacement') {
        const replacement = Object.setPrototypeOf({ path: oldPath }, TFile.prototype);
        f.vault.files.set(oldPath, replacement);
        f.vault.bytes.set(replacement, f.vault.bytes.get(f.article)!);
      }
      if (kind === 'delete') f.vault.files.delete(oldPath);
      await f.view.changed({
        path: f.article.path,
        previousPath: kind === 'rename' ? oldPath : undefined,
        deleted: kind === 'delete',
      });
      expect(requestSignal.aborted).toBe(true);
      await creation;
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it('aborts a pending creation on an external body change before the callback stage', async () => {
    const f = await fixture(),
      entered = gate(),
      stopped = gate();
    let requestSignal!: AbortSignal;
    f.api.createNodeForLink = async (options) => {
      requestSignal = options.signal!;
      requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      return null;
    };
    const creation = menu(f.view, 'Notes…');
    await entered.promise;
    f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'External edit'));
    await f.view.changed({ path: f.article.path });
    expect(requestSignal.aborted).toBe(true);
    await creation;
    expect((await f.store.read(f.article.path)).body).toBe('External edit');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  }, 1500);

  it.each(
    ['before', 'after'].flatMap((phase) =>
      ['open', 'navigate', 'list', 'markdown', 'close', 'unload'].map((action) => ({
        phase,
        action,
      })),
    ),
  )(
    'aborts Nodes $phase callback commit before waiting on public $action work',
    async ({ phase, action }) => {
      const f = await fixture(),
        next = await f.note('Reading/Inbox/B.md'),
        linked = gate(),
        stopped = gate();
      f.probe.readingQueue.open([f.article.path, next.path], f.article.path);
      let requestSignal!: AbortSignal;
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        requestSignal.addEventListener('abort', () => stopped.resolve(), { once: true });
        if (phase === 'after') await link(f.node);
        linked.resolve();
        await stopped.promise;
        return null;
      };
      const creation = menu(f.view, 'Notes…');
      await linked.promise;
      let transition: Promise<void> | undefined;
      if (action === 'open') transition = f.view.openArticle(next.path);
      if (action === 'navigate') transition = f.view.navigate(1);
      if (action === 'list') transition = f.view.readingList();
      if (action === 'markdown') transition = f.view.prepareMarkdown();
      if (action === 'close') transition = f.view.onClose();
      if (action === 'unload') f.view.stopForUnload();
      expect(requestSignal.aborted).toBe(true);
      await creation;
      await transition;
      expect((await f.store.read(f.article.path)).body).toBe(
        phase === 'after' ? f.linkedBody : '==words==',
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      ['open', 'navigate', 'list'].map((action) => ({ phase, action })),
    ),
  )(
    'unblocks public $action $phase commit even if the provider ignores abort; rejects its late callback',
    async ({ phase, action }) => {
      const f = await fixture(),
        next = await f.note('Reading/Inbox/B.md'),
        entered = gate(),
        providerRelease = gate();
      f.probe.readingQueue.open([f.article.path, next.path], f.article.path);
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      let requestSignal!: AbortSignal;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise; // Deliberately ignores the signal.
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      const creation = menu(f.view, 'Notes…');
      await entered.promise;
      const transition =
        action === 'open'
          ? f.view.openArticle(next.path)
          : action === 'navigate'
            ? f.view.navigate(1)
            : f.view.readingList();
      expect(requestSignal.aborted).toBe(true);
      await creation;
      await transition; // Must finish while the provider remains suspended.
      providerRelease.resolve();
      await vi.mocked(f.api.createNodeForLink).mock.results[0].value;
      expect(annotate).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
      expect((await f.store.read(f.article.path)).body).toBe(
        phase === 'after' ? f.linkedBody : '==words==',
      );
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
    1500,
  );

  it.each(['before', 'after'])(
    'Done synchronously cancels a never-settling picker %s commit and restores article controls',
    async (phase) => {
      const f = await uiFixture(),
        entered = gate(),
        targetBefore = await f.vault.read(f.target);
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      let requestSignal!: AbortSignal, late!: (node: NodeResult) => Promise<void>;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        late = link;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        return new Promise<NodeResult | null>(() => {}); // Never settles, even after abort.
      });
      try {
        const creation = menu(f.view, 'Notes…');
        await entered.promise;
        const targetExpected =
          phase === 'after' ? expectedFiledTarget(f, targetBefore) : targetBefore;
        passageButton(f.view, 'Done').click();
        expect(requestSignal.aborted).toBe(true); // No queue or microtask may precede abort.
        expect(f.probe.tapMode).toBe(false);
        expect(f.view.contentEl.querySelector('[aria-label="Done"]')).toBeNull();
        expect(
          passageLabels(f.view).some((label) => label.startsWith('Change status and advance')),
        ).toBe(true);
        await creation;
        await f.probe.operations;
        await expect(late(f.node)).rejects.toThrow('request has finished');
        expect(f.probe.dialog).toBe(false);
        expect(annotate).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
        expect((await f.store.read(f.article.path)).body).toBe(
          phase === 'after' ? f.linkedBody : originalLinkedBody,
        );
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        expect(f.vault.trashed).toEqual([]);
        expectNoPassagePopup();
      } finally {
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      [
        'Notes…',
        'Notes…',
        'Remove references (article only)',
        'Remove highlight (article only)',
      ].map((label) => ({ phase, label })),
    ),
  )(
    'supersedes a never-settling picker through the actual $label passage button $phase commit',
    async ({ phase, label }) => {
      const f = await uiFixture(),
        entered = gate(),
        targetBefore = await f.vault.read(f.target);
      const collect = vi.spyOn(f.store, 'collectHighlight'),
        annotate = vi.spyOn(f.store, 'annotate');
      let requestSignal!: AbortSignal,
        late!: (node: NodeResult) => Promise<void>,
        calls = 0;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        if (++calls > 1) return null;
        requestSignal = options.signal!;
        late = link;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        return new Promise<NodeResult | null>(() => {});
      });
      try {
        const creation = menu(f.view, 'Notes…');
        await entered.promise;
        const targetExpected =
          phase === 'after' ? expectedFiledTarget(f, targetBefore) : targetBefore;
        const superseding = f.click('menu', label);
        expect(requestSignal.aborted).toBe(true);
        await superseding;
        await creation;
        await f.probe.operations;
        await expect(late(f.node)).rejects.toThrow('request has finished');
        const changesPassage = [
          'Remove references (article only)',
          'Remove highlight (article only)',
        ].includes(label);
        expect(collect).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
        expect(annotate).toHaveBeenCalledTimes(changesPassage ? 1 : 0);

        expect(calls).toBe(changesPassage ? 1 : 2);
        const expectedSource = phase === 'after' ? f.linkedBody : originalLinkedBody;
        expect((await f.store.read(f.article.path)).body).toBe(
          changesPassage
            ? changePassage(
                expectedSource,
                passages(expectedSource)[0],
                label === 'Remove highlight (article only)' ? 'remove' : 'unlink',
              )
            : expectedSource,
        );

        expect(f.probe.dialog).toBe(false);
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        expect(f.vault.trashed).toEqual([]);
        expectNoPassagePopup();
      } finally {
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each(
    ['before', 'after'].flatMap((phase) =>
      [
        ['footer', 'Read later'],
        ['footer', 'Archive'],
        ['footer', 'Delete'],
        ['footer', 'List'],
        ['command', 'Move…'],
        ['command', 'Topics…'],
        ['command', 'Open Markdown'],
        ['link', 'internal'],
        ['link', 'new-leaf'],
        ['link', 'external'],
        ['menu', 'Open note'],
        ['menu', 'Notes…'],
        ['menu', 'Notes…'],
        ['menu', 'Remove references (article only)'],
        ['menu', 'Remove highlight (article only)'],
      ].map(([route, label]) => ({ phase, route, label })),
    ),
  )(
    'cancels via actual $route / $label UI $phase commit, without waiting for the provider',
    async ({ phase, route, label }) => {
      const f = await uiFixture(),
        entered = gate(),
        providerRelease = gate();
      const collect = vi.spyOn(f.store, 'collectHighlight'),
        annotate = vi.spyOn(f.store, 'annotate'),
        targetBytes = await f.vault.read(f.target);
      const sourcePath = f.article.path;
      const neighbour = f.probe.readingQueue.neighbour(label === 'Previous' ? -1 : 1, () => true);
      let requestSignal!: AbortSignal,
        calls = 0;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        if (++calls > 1) return null; // A second explicit Create node action is cancelled at its picker.
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise; // Ignores cancellation deliberately.
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      try {
        const creation = menu(f.view, 'Notes…');
        await entered.promise;
        const targetExpected =
          phase === 'after' ? expectedFiledTarget(f, targetBytes) : targetBytes;
        const intent = f.click(route, label);
        expect(requestSignal.aborted).toBe(true); // Even before the next microtask.
        await intent;
        await creation;
        await f.probe.operations;
        // Reach the destination before releasing the uncooperative provider.
        if (['Next', 'Previous', 'Archive', 'Read later', 'Delete'].includes(label))
          expect(f.view.file?.path).toBe(neighbour);
        if (label === 'Read later') {
          expect(f.article.path).toBe('Reading/Later/A.md');
          expect((await f.store.read(f.article.path)).properties.status).toBe('later');
          expect(mocks.choose).toHaveBeenCalledWith(
            f.app,
            'Change article status…',
            ['Inbox', 'Later', 'Feed', 'Archive'],
            expect.any(Function),
            expect.any(AbortSignal),
          );
          expect(f.api.createNodeForLink).toHaveBeenCalledTimes(1);
        }
        if (label === 'List') expect(f.view.file).toBeUndefined();
        if (label === 'Move…') expect(mocks.choose).toHaveBeenCalled();
        if (label === 'Topics…')
          expect(mocks.highlightPicker).toHaveBeenCalledWith(
            f.app,
            f.api,
            expect.objectContaining({ title: 'Related notes', multiple: true }),
          );
        if (label === 'Notes…') expect(f.api.createNodeForLink).toHaveBeenCalledTimes(2);
        if (label === 'Notes…') expect(calls).toBe(2);
        if (label === 'Archive') {
          expect(f.article.path).toBe('Reading/Treasury/A.md');
          expect((await f.store.read(f.article.path)).properties.status).toBe('archive');
        }
        if (label === 'Open Markdown')
          await vi.waitFor(
            () =>
              expect(f.leaf.setViewState).toHaveBeenCalledWith({
                type: 'markdown',
                state: { file: sourcePath, mode: 'source' },
                active: true,
              }),
            { interval: 1 },
          );
        if (['internal', 'new-leaf', 'Open note'].includes(label)) {
          const path =
            label === 'Open note' && phase === 'before' ? 'Notes/Existing.md' : f.target.path;
          await vi.waitFor(
            () =>
              expect(f.opened.openFile).toHaveBeenCalledWith(f.vault.file(path), { active: true }),
            { interval: 1 },
          );
          expect(f.app.workspace.getLeaf).toHaveBeenCalledWith(label === 'new-leaf');
        }
        if (label === 'external') {
          expect(mocks.confirmWebLink).not.toHaveBeenCalled();
          expect(f.web).toHaveBeenCalledWith(
            'https://example.test/article',
            '_blank',
            'noopener,noreferrer',
          );
        }
        providerRelease.resolve();
        await vi.mocked(f.api.createNodeForLink).mock.results[0].value;
        const changesPassage = [
          'Remove references (article only)',
          'Remove highlight (article only)',
        ].includes(label);
        expect(collect).toHaveBeenCalledTimes(phase === 'after' ? 1 : 0);
        expect(annotate).toHaveBeenCalledTimes(changesPassage ? 1 : 0);

        const expectedSource = phase === 'after' ? f.linkedBody : originalLinkedBody;
        expect((await f.store.read(f.article.path)).body).toBe(
          changesPassage
            ? changePassage(
                expectedSource,
                passages(expectedSource)[0],
                label === 'Remove highlight (article only)' ? 'remove' : 'unlink',
              )
            : expectedSource,
        );

        expect(f.vault.trashed).toEqual([]);
        if (label === 'Delete') {
          expect(f.article.path).toBe('Reading/Treasury/A.md');
          expect((await f.store.read(f.article.path)).properties.status).toBe('archive');
        }
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        expect(f.api.createNode).not.toHaveBeenCalled();
      } finally {
        providerRelease.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each([
    ['footer', 'List'],
    ['link', 'internal'],
  ])(
    'drains an already-dispatched callback write before the %s / %s UI leaves, without rollback',
    async (route, label) => {
      const f = await uiFixture(),
        dispatched = gate(),
        release = gate(),
        process = f.vault.process.bind(f.vault);
      let requestSignal!: AbortSignal;
      vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
        const raw = await process(file, update);
        dispatched.resolve();
        await release.promise;
        return raw;
      });
      f.api.createNodeForLink = async (options, link) => {
        requestSignal = options.signal!;
        await link(f.node);
        return f.node;
      };
      try {
        const creation = menu(f.view, 'Notes…');
        const rejected = expect(creation).rejects.toThrow(/request.*(finished|cancelled)/);
        await dispatched.promise;
        const intent = f.click(route, label);
        expect(requestSignal.aborted).toBe(true);
        await intent;
        expect(f.view.file).toBe(f.article);
        expect(f.opened.openFile).not.toHaveBeenCalled();
        release.resolve();
        await rejected;
        await f.probe.operations;
        if (route === 'footer') expect(f.view.file).not.toBe(f.article);
        else
          await vi.waitFor(
            () => expect(f.opened.openFile).toHaveBeenCalledWith(f.target, { active: true }),
            {
              interval: 1,
            },
          );
        expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        release.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it.each(['before', 'after'])(
    'keeps the actual fallback Open Markdown escape usable after source failure %s commit',
    async (phase) => {
      const f = await uiFixture(),
        entered = gate(),
        providerRelease = gate();
      let requestSignal!: AbortSignal;
      f.api.createNodeForLink = vi.fn(async (options, link) => {
        requestSignal = options.signal!;
        if (phase === 'after') await link(f.node);
        entered.resolve();
        await providerRelease.promise;
        await expect(link(f.node)).rejects.toThrow('request has finished');
        return f.node;
      });
      try {
        const creation = menu(f.view, 'Notes…');
        await entered.promise;
        const external = createDocument({ type: 'note', custom: 'keep' }, 'External source');
        f.vault.bytes.set(f.article, external);
        await f.view.changed({ path: f.article.path });
        expect(requestSignal.aborted).toBe(true);
        await creation;
        await vi.waitFor(
          () => expect(f.view.contentEl.textContent).toContain('Cannot display this article'),
          { interval: 1 },
        );
        await f.click('fallback', 'Open Markdown');
        await f.probe.operations;
        await vi.waitFor(
          () =>
            expect(f.leaf.setViewState).toHaveBeenCalledWith({
              type: 'markdown',
              state: { file: f.article.path, mode: 'source' },
              active: true,
            }),
          { interval: 1 },
        );
        providerRelease.resolve();
        await vi.mocked(f.api.createNodeForLink).mock.results[0].value;
        expect(await f.vault.read(f.article)).toBe(external);
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        providerRelease.resolve();
        f.view.stopForUnload();
      }
    },
  );

  it.each([
    ['footer', 'List'],
    ['link', 'internal'],
    ['command', 'Open Markdown'],
    ['menu', 'Remove highlight (article only)'],
  ])(
    'invalidates queued Nodes creation at the actual %s / %s UI intent',
    async (route, label) => {
      const f = await uiFixture(),
        entered = gate(),
        release = gate();
      f.api.createNodeForLink = vi.fn(async () => f.node);
      try {
        const busy = f.probe.operation(async () => {
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        const creation = menu(f.view, 'Notes…');
        await f.click(route, label);
        release.resolve();
        await busy;
        await creation;
        await f.probe.operations;
        expect(f.api.createNodeForLink).not.toHaveBeenCalled();
        expect(f.api.createNode).not.toHaveBeenCalled();
        expect(f.vault.file(f.target.path)).toBe(f.target);
        expect(f.vault.trashed).toEqual([]);
      } finally {
        release.resolve();
        f.view.stopForUnload();
      }
    },
    1500,
  );

  it('keeps required completion live for scrolling, blocked link/keyboard navigation and background flush', async () => {
    const f = await uiFixture(),
      entered = gate(),
      complete = gate();
    let requestSignal!: AbortSignal;
    f.api.createNodeForLink = async (options, link) => {
      requestSignal = options.signal!;
      await link(f.node);
      entered.resolve();
      await complete.promise;
      return f.node;
    };
    try {
      const creation = menu(f.view, 'Notes…');
      await entered.promise;
      // Palette availability checks and in-article scrolling do not cancel completion.
      for (const id of ['move', 'topics', 'open-markdown'])
        expect(mocks.commands.get(id)?.checkCallback?.(true)).toBe(true);
      expect(f.view.contentEl.querySelector('[aria-label="Next page"]')).toBeNull();
      f.probe.surface.viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      const heading = document.createElement('h2');
      heading.id = 'section';
      f.probe.surface.body.append(heading);
      await f.click('link', 'heading');
      await f.click('link', 'unsafe');
      f.view.key(new KeyboardEvent('keydown', { key: 'j' }));
      expect(f.probe.surface.page).not.toHaveBeenCalled();
      expect(f.probe.surface.reveal).not.toHaveBeenCalled();
      expect(f.opened.openFile).not.toHaveBeenCalled();
      expect(f.view.file).toBe(f.article);
      const flushing = f.view.flush();
      await Promise.resolve();
      expect(requestSignal.aborted).toBe(false);
      complete.resolve();
      await creation;
      await flushing;
      expect(requestSignal.aborted).toBe(false);
    } finally {
      complete.resolve();
      f.view.stopForUnload();
    }
  });

  it('does not start a queued Nodes creation after a newer navigation intent', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    f.api.createNodeForLink = vi.fn(async () => f.node);
    const busy = f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const creation = menu(f.view, 'Notes…'),
      navigation = f.view.readingList();
    release.resolve();
    await busy;
    await creation;
    await navigation;
    expect(f.api.createNodeForLink).not.toHaveBeenCalled();
    expect(f.api.createNode).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.trashed).toEqual([]);
  });

  it.each(['null', 'cancel', 'reject'] as const)(
    'retains both committed link and target after completion %s',
    async (kind) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'collectHighlight');
      const rejection = { reason: 'completion failed' },
        targetBytes = await f.vault.read(f.target);
      f.api.createNodeForLink = async (_options, link) => {
        await link(f.node);
        if (kind === 'cancel') f.probe.articleLifetime.abort();
        if (kind === 'reject') throw rejection;
        return null;
      };
      const creation = menu(f.view, 'Notes…');
      if (kind === 'reject') await expect(creation).rejects.toBe(rejection);
      else await creation;
      expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
      expect(annotate).toHaveBeenCalledOnce();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(await f.vault.read(f.target)).toBe(expectedFiledTarget(f, targetBytes));
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it.each(['null', 'identity'] as const)(
    'does not link from a %s return or accept a callback after the request settles',
    async (result) => {
      const f = await fixture(),
        annotate = vi.spyOn(f.store, 'collectHighlight');
      let late!: (node: NodeResult) => Promise<void>;
      f.api.createNodeForLink = async (_options, link) => {
        late = link;
        return result === 'null' ? null : f.node;
      };
      await menu(f.view, 'Notes…');
      await expect(late(f.node)).rejects.toThrow('request has finished');
      expect((await f.store.read(f.article.path)).body).toBe('==words==');
      expect(annotate).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(f.vault.file(f.target.path)).toBe(f.target);
      expect(f.vault.trashed).toEqual([]);
    },
  );

  it('rejects an in-flight callback at commit if Nodes settles the request before the write', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      entered.resolve();
      await release.promise;
      return process(file, update);
    });
    let pending!: Promise<void>;
    f.api.createNodeForLink = async (_options, link) => {
      pending = link(f.node);
      void pending.catch(() => {});
      await entered.promise;
      return null;
    };
    const creation = menu(f.view, 'Notes…');
    const rejectedCreation = expect(creation).rejects.toThrow('request has finished');
    await entered.promise;
    // Reader observes the premature return but drains its dispatched write before
    // releasing the operation queue; close the callback scope before releasing I/O.
    await vi.waitFor(() => expect(f.probe.nodeCreation).toBeUndefined(), { interval: 1 });
    const rejected = expect(pending).rejects.toThrow('request has finished');
    release.resolve();
    await rejected;
    await rejectedCreation;
    expect((await f.store.read(f.article.path)).body).toBe('==words==');
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it('rejects a duplicate callback without attempting a second source write', async () => {
    const f = await fixture(),
      annotate = vi.spyOn(f.store, 'collectHighlight');
    f.api.createNodeForLink = async (_options, link) => {
      await link(f.node);
      await link(f.node);
      return f.node;
    };
    await expect(menu(f.view, 'Notes…')).rejects.toThrow('callback already ran');
    expect(annotate).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it.each([
    'disk-source',
    'snapshot',
    'displayed',
    'navigation',
    'cancel',
    'unload',
    'editor',
    'write',
    'source-swap',
    'source-rename',
  ] as const)(
    'rejects the callback on %s change, skips completion and preserves the target',
    async (kind) => {
      const f = await fixture(),
        completion = vi.fn(),
        targetBytes = await f.vault.read(f.target);
      const replacement = createDocument({ type: 'article' }, 'New source');
      f.api.createNodeForLink = async (_options, link) => {
        if (kind === 'disk-source') f.vault.bytes.set(f.article, replacement);
        if (kind === 'snapshot') {
          f.vault.bytes.set(f.article, replacement);
          f.probe.snapshot = { ...f.probe.snapshot, ...readDocument(replacement) };
        }
        if (kind === 'displayed') f.probe.surface.displayedBody = 'Different displayed source';
        if (kind === 'navigation') f.probe.generation++;
        if (kind === 'cancel') f.probe.articleLifetime.abort();
        if (kind === 'unload') f.signal.abort();
        if (kind === 'editor') f.vault.dirty.add(f.article);
        if (kind === 'write') f.vault.failWrite = true;
        if (kind === 'source-swap') {
          const file = { path: f.article.path };
          f.vault.files.set(file.path, file);
          f.vault.bytes.set(file, replacement);
        }
        if (kind === 'source-rename') await f.vault.move(f.article, 'Reading/Inbox/Renamed.md');
        await link(f.node);
        completion();
        return f.node;
      };
      await expect(menu(f.view, 'Notes…')).rejects.toThrow();
      expect(completion).not.toHaveBeenCalled();
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect((await f.store.read(f.article.path)).body).toBe(
        ['disk-source', 'snapshot', 'source-swap'].includes(kind) ? 'New source' : '==words==',
      );
      expect(await f.vault.read(f.target)).toBe(targetBytes);
      expect(f.vault.trashed).toEqual([]);
      expect(f.probe.dialog).toBe(false);
    },
  );

  it('rejects an uncertain callback after an already-dispatched write finishes across cancellation, without rollback', async () => {
    const f = await fixture(),
      process = f.vault.process.bind(f.vault),
      completion = vi.fn();
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      f.probe.articleLifetime.abort();
      return result;
    });
    f.api.createNodeForLink = async (_options, link) => {
      await link(f.node);
      completion();
      return f.node;
    };
    await expect(menu(f.view, 'Notes…')).rejects.toThrow(
      /source annotation was saved.*quotation was not filed/,
    );
    expect(completion).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
    expect(f.vault.file(f.target.path)).toBe(f.target);
    expect(f.vault.trashed).toEqual([]);
  });

  it('waits for position writes and preserves the position when the early callback commits', async () => {
    const f = await fixture(),
      entered = gate(),
      complete = gate();
    f.api.createNodeForLink = async (_options, link) => {
      entered.resolve();
      await complete.promise;
      await link(f.node);
      return f.node;
    };
    const creation = menu(f.view, 'Notes…');
    await entered.promise;
    f.probe.persistPosition('words');
    await f.probe.positionWrite;
    complete.resolve();
    await creation;
    expect((await f.store.read(f.article.path)).properties.bookmark).toBe('words');
    expect((await f.store.read(f.article.path)).body).toBe(f.linkedBody);
  });

  it.each(['missing', 'old', 'standalone', 'legacy-id'] as const)(
    'keeps legacy actions safe and reports unsupported hosted creation (%s)',
    async (mode) => {
      const original = '==legacy== and new words',
        f = await fixture(original);
      if (mode === 'missing') (f.app as any).plugins = undefined;
      else if (mode === 'old') (f.api as any).version = 1;
      else if (mode === 'standalone') delete f.api.createNodeForLink;
      else
        (f.app as any).plugins = {
          getPlugin: (id: string) => (id === 'obsidian-nodes' ? { api: f.api } : undefined),
        };
      await f.view.onOpen();
      await f.view.openArticle(f.article.path, true);
      const targetBefore = await f.vault.read(f.target);
      let expected = original,
        targetExpected = targetBefore;
      if (mode === 'standalone') {
        // Linked creation is optional for choosing an existing typed destination.
        mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node: f.node });
        await menu(f.view, 'Notes…');
        expected = expectedHosted(original, f.target.path);
        const blockId = paragraphAnchors(expected)[0].blockId;
        targetExpected = appendQuotation(
          targetBefore,
          'legacy',
          originLink(f.article.path, blockId, f.article.basename),
        ).raw;
        expect((await f.store.read(f.article.path)).body).toBe(expected);
        expect(await f.vault.read(f.target)).toBe(targetExpected);
        mocks.highlightPicker.mockResolvedValue({ kind: 'create', title: 'legacy', type: 'topic' });
        await expect(menu(f.view, 'Notes…')).rejects.toThrow('createNodeForLink support');
      } else {
        f.probe.surface.selectionValue = { quote: 'new words', before: 'legacy and ', after: '' };
        await expect(f.probe.saveSelection()).rejects.toThrow(/Fileclass Inline.*v2/);
        f.probe.surface.selectionValue = undefined;
        expect((await f.store.read(f.article.path)).body).toBe(original);
        expect(mocks.highlightPicker).not.toHaveBeenCalled();
      }
      expect((await f.store.read(f.article.path)).body).toBe(expected);
      f.probe.surface.body.innerHTML = '<mark>legacy</mark> and new words';
      f.probe.surface.body
        .querySelector('mark')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(passageLabels(f.view)).toEqual(
        expectedPassageActions({ linked: mode === 'standalone', provider: mode === 'standalone' }),
      );
      expectNoPassagePopup();
      await menu(f.view, 'Remove highlight (article only)');
      expect((await f.store.read(f.article.path)).body).toBe(
        changePassage(expected, passages(expected)[0], 'remove'),
      );
      expect(await f.vault.read(f.target)).toBe(targetExpected);
      expect(f.api.createNode).not.toHaveBeenCalled();
      expect(f.api.pickNodeForLink).not.toHaveBeenCalled();
      expect(f.vault.trashed).toEqual([]);
      f.view.stopForUnload();
    },
  );
});

describe('safe links and drawing', () => {
  it('decodes a single encoded href and rejects decoded schemes, authorities and malformed escapes', () => {
    expect(nativeLinkPath('/Notes/URI%20Path.md')).toBe('Notes/URI Path.md');
    expect(nativeLinkPath('Notes/100%25.md')).toBe('Notes/100%.md');
    for (const href of [
      'https://example.com',
      '%6Aavascript%3Aalert(1)',
      '/https%3Aevil',
      '//evil/path',
      '%2F%2Fevil',
      '#TOC',
      'bad%xx',
    ])
      expect(nativeLinkPath(href)).toBeUndefined();
  });

  it('opens only an existing identity and preserves subpaths; never invokes a create-capable link opener', async () => {
    const f = hostFixture(),
      target = await f.note('Notes/URI Path.md', '', 'topic');
    await openExistingNote(f.app, 'Notes/URI Path.md#Heading', 'Reading/Inbox/A.md');
    expect(f.opened.openFile).toHaveBeenCalledWith(target, {
      active: true,
      eState: { subpath: '#Heading' },
    });
    f.opened.openFile.mockClear();
    f.vault.files.delete(target.path);
    await expect(openExistingNote(f.app, target.path, '')).rejects.toThrow('no longer exists');
    expect(f.opened.openFile).not.toHaveBeenCalled();
    f.vault.files.set(target.path, target);
    vi.mocked(f.app.workspace.getLeaf).mockImplementation(() => {
      f.vault.files.set(target.path, { path: target.path });
      return f.opened as any;
    });
    await expect(openExistingNote(f.app, target.path, '')).rejects.toThrow('changed');
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });

  it('decodes an internal rendered Markdown href before opening its existing file', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md'),
      target = await f.note('Notes/URI Path.md', '', 'topic');
    await f.view.openArticle(article.path);
    f.probe.surface.body.innerHTML =
      '<a class="internal-link" href="/Notes/URI%20Path.md">note</a>';
    f.probe.clicked({ target: f.probe.surface.body.querySelector('a'), preventDefault: vi.fn() });
    await f.probe.operations;
    // openLinked's continuation runs after its awaited flush, never inside the operation queue.
    await Promise.resolve();
    expect(f.opened.openFile).toHaveBeenCalledWith(target, { active: true });
  });

  it('reveals a same-article heading without opening a vault note', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.body.innerHTML = '<h2 id="a-heading">Heading</h2><a href="#a-heading">TOC</a>';
    f.probe.clicked({ target: surface.body.querySelector('a'), preventDefault: vi.fn() });
    expect(surface.reveal).toHaveBeenCalledWith(surface.body.querySelector('h2'));
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
});

describe('Reader web-link capture', () => {
  async function fixture(href = 'https://publisher.test/story', folders = defaultFolders) {
    const f = hostFixture(folders);
    const article = await f.note(`${folders.articles}/Current.md`);
    await f.view.openArticle(article.path);
    f.probe.surface.body.innerHTML = `<a href="${href}">publisher</a>`;
    const event = { target: f.probe.surface.body.querySelector('a'), preventDefault: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(null);
    f.probe.clicked(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith(href, '_blank', 'noopener,noreferrer');
    const source = f.probe.snapshot,
      generation = f.probe.generation;
    return {
      ...f,
      article,
      save: (_signal: AbortSignal) => f.probe.saveWebLink(href, source, generation),
    };
  }
  it('offers saving from the keyboard context menu without a dialog', async () => {
    const f = await fixture();
    const link = f.probe.surface.body.querySelector('a');
    const event = new KeyboardEvent('keydown', { key: 'ContextMenu', cancelable: true });
    Object.defineProperty(event, 'target', { value: link });
    f.probe.linkMenu(event);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.menus.at(-1)?.has('Save to Inbox')).toBe(true);
    expect(mocks.confirmWebLink).not.toHaveBeenCalled();
  });
  it('opens without a modal and explicitly saves to Inbox without changing the article', async () => {
    const f = await fixture('HTTPS://publisher.test/story');
    expect(mocks.confirmWebLink).not.toHaveBeenCalled();
    expect(f.vault.files.size).toBe(1);
    const surface = f.probe.surface;
    await f.save(new AbortController().signal);
    const captured = f.store.catalog.findUrl('https://publisher.test/story')!;
    expect(captured.path).toMatch(/^Reading\/Inbox\//);
    expect(captured.status).toBe('inbox');
    expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(captured.path, true);
    expect(f.view.file).toBe(f.article);
    expect(f.probe.surface).toBe(surface);
    expect(f.opened.openFile).not.toHaveBeenCalled();
  });
  it.each(['inbox', 'feed', 'later', 'archive', undefined, 'invalid', null] as const)(
    'preserves duplicate status, bookmark, placement and authored bytes: %s',
    async (status) => {
      const folders = {
        articles: 'Capture',
        feeds: 'Subscriptions',
      };
      const f = await fixture('https://publisher.test/story', folders);
      const existing = await f.note('Unrelated/Existing.md');
      const raw = createDocument(
        {
          type: 'article',
          url: 'https://publisher.test/story',
          status,
          bookmark: 'authored words',
          custom: 'Preserve',
        },
        'authored ==words==',
      );
      f.vault.bytes.set(existing, raw);
      f.store.catalog.update(existing.path, readDocument(raw).properties);
      const move = vi.spyOn(f.store, 'move');
      await f.save(new AbortController().signal);
      expect(f.vault.files.size).toBe(2);
      expect(existing.path).toBe('Unrelated/Existing.md');
      expect(await f.vault.read(existing)).toBe(raw);
      const saved = await f.store.read(existing.path);
      expect(saved.properties.status).toBe(status);
      expect(Object.hasOwn(saved.properties, 'status')).toBe(status !== undefined);
      expect(saved.properties.bookmark).toBe('authored words');
      expect(saved.body).toBe('authored ==words==');
      expect(move).not.toHaveBeenCalled();
      expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(existing.path, true);
      expect(f.view.file).toBe(f.article);
    },
  );
  it('keeps web links inside highlights on the annotation-menu path', async () => {
    const f = hostFixture();
    const article = await f.note(
      'Reading/Inbox/Current.md',
      '==[passage](https://publisher.test/story)==',
    );
    await f.view.openArticle(article.path);
    f.probe.surface.body.innerHTML =
      '<mark><a href="https://publisher.test/story">passage</a></mark>';
    f.probe.clicked({ target: f.probe.surface.body.querySelector('a'), preventDefault: vi.fn() });
    expect(mocks.confirmWebLink).not.toHaveBeenCalled();
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ provider: false }));
    expectNoPassagePopup();
  });
  it.each(['navigation', 'unload', 'source edit', 'source delete'] as const)(
    'rejects a stale %s confirmation',
    async (kind) => {
      const f = await fixture(),
        modal = new AbortController();
      if (kind === 'navigation') await f.view.readingList();
      if (kind === 'unload') f.signal.abort();
      if (kind === 'source edit') {
        f.vault.bytes.set(f.article, createDocument({ type: 'article' }, 'New source body'));
        await f.view.changed({ path: f.article.path });
      }
      if (kind === 'source delete') f.vault.files.delete(f.article.path);
      const count = f.vault.files.size;
      await expect(f.save(modal.signal)).rejects.toThrow('cancelled');
      expect(f.vault.files.size).toBe(count);
    },
  );
  it('preserves a duplicate and skips acquisition when navigation cancels pending capture', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate();
    const existing = await f.store.capture({
      url: 'https://publisher.test/story',
      queue: 'Feed',
      body: 'Keep authored text',
    });
    const path = existing.path,
      raw = await f.vault.read(existing);
    const capture = f.store.capture.bind(f.store);
    vi.spyOn(f.store, 'capture').mockImplementationOnce(async (...args) => {
      const file = await capture(...args);
      entered.resolve();
      await release.promise;
      return file;
    });
    f.host.ingestion.acquire.mockClear();
    const save = f.save(new AbortController().signal).catch((error: unknown) => error);
    await entered.promise;
    await f.view.readingList();
    release.resolve();
    expect(await save).toMatchObject({ message: 'Reader capture was cancelled.' });
    expect(existing.path).toBe(path);
    expect(await f.vault.read(existing)).toBe(raw);
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });
});

describe('modal capture cancellation', () => {
  it('rechecks the modal signal at the queued create boundary', async () => {
    const f = await pluginFixture(),
      original = await f.note('Reading/Inbox/Current.md');
    await f.view.openArticle(original.path);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    const entered = gate(),
      release = gate(),
      create = f.vault.create.bind(f.vault);
    vi.spyOn(f.vault, 'create').mockImplementationOnce(async (path, content) => {
      entered.resolve();
      await release.promise;
      return create(path, content);
    });
    const prior = f.store.capture({ url: 'https://example.com/prior' });
    await entered.promise;
    f.plugin.capture();
    const signal = new AbortController();
    const capture = mocks.input.mock.calls.at(-1)![3](
      'https://example.com/cancelled',
      signal.signal,
    );
    const rejected = expect(capture).rejects.toThrow('cancelled');
    signal.abort();
    release.resolve();
    await prior;
    await rejected;
    expect(f.store.catalog.findUrl('https://example.com/cancelled')).toBeUndefined();
    expect(f.view.file).toBe(original);
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.app.workspace.getLeaf).not.toHaveBeenCalled();
  });

  it('retains a create already committed but does not navigate/acquire after cancellation', async () => {
    const f = await pluginFixture(),
      original = await f.note('Reading/Inbox/Current.md');
    await f.view.openArticle(original.path);
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    const signal = new AbortController(),
      create = f.vault.create.bind(f.vault);
    vi.spyOn(f.vault, 'create').mockImplementationOnce(async (path, content) => {
      const file = await create(path, content);
      signal.abort();
      return file;
    });
    f.plugin.capture();
    await mocks.input.mock.calls.at(-1)![3]('https://example.com/committed', signal.signal);
    expect(f.store.catalog.findUrl('https://example.com/committed')).toBeDefined();
    expect(f.view.file).toBe(original);
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });

  it('keeps the old article mounted when cancellation overtakes the target read', async () => {
    const f = await pluginFixture(),
      original = await f.note('Reading/Inbox/Current.md');
    await f.view.openArticle(original.path);
    const target = await f.store.capture({ url: 'https://example.com/target' });
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    const entered = gate(),
      release = gate(),
      read = f.store.read.bind(f.store);
    vi.spyOn(f.store, 'read').mockImplementation(async (path) => {
      if (path === target.path) {
        entered.resolve();
        await release.promise;
      }
      return read(path);
    });
    f.plugin.capture();
    const signal = new AbortController(),
      capture = mocks.input.mock.calls.at(-1)![3]('https://example.com/target', signal.signal);
    await entered.promise;
    const surface = f.probe.surface;
    expect(f.view.file).toBe(original);
    signal.abort();
    release.resolve();
    await capture;
    expect(f.view.file).toBe(original);
    expect(f.probe.surface).toBe(surface);
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.host.ingestion.acquire).not.toHaveBeenCalled();
  });

  it('creates a new tab without focus and detaches only its empty Reader on cancellation', async () => {
    const f = await pluginFixture(),
      entered = gate(),
      release = gate();
    const leaf: any = {
      app: f.app,
      detach: vi.fn(),
      setViewState: vi.fn(async () => {
        entered.resolve();
        await release.promise;
      }),
    };
    leaf.view = new ReaderView(leaf, f.plugin);
    vi.mocked(f.app.workspace.getLeaf).mockReturnValue(leaf);
    f.plugin.capture();
    const signal = new AbortController(),
      capture = mocks.input.mock.calls.at(-1)![3]('https://example.com/target', signal.signal);
    await entered.promise;
    signal.abort();
    release.resolve();
    await capture;
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: 'obsidian-reader',
      state: {},
      active: false,
    });
    expect(leaf.detach).toHaveBeenCalledOnce();
    expect(f.app.workspace.revealLeaf).not.toHaveBeenCalled();
    expect(f.plugin.ingestion.acquire).not.toHaveBeenCalled();
  });

  it('supports older submit callers that omit the modal signal', async () => {
    const f = await pluginFixture();
    vi.mocked(f.app.workspace.getActiveViewOfType).mockReturnValue(f.view);
    f.plugin.capture();
    await mocks.input.mock.calls.at(-1)![3]('https://example.com/saved');
    expect(f.view.file?.path).toBe(f.store.catalog.findUrl('https://example.com/saved')?.path);
    expect(f.app.workspace.revealLeaf).toHaveBeenCalledWith(f.leaf);
  });
});

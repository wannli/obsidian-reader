// @vitest-environment node
import {
  mocks,
  defaultHighlightPath,
  hostFixture,
  enableHighlightHost,
  enableTypedTopics,
  pluginFixture,
  actionName,
  passageButton,
  passageLabels,
  expectNoPassagePopup,
  expectedPassageActions,
  expectedHosted,
  expectedRemovedHosted,
  menu,
} from './helpers/reader-view-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import { createDocument, patchProperties, readDocument, replaceBody } from '../src/core/document';
import { changePassage, passages } from '../src/core/annotations';
import { paragraphAnchors } from '../src/core/hosted-highlights';
import { appendQuotation, originLink } from '../src/core/quotation';
import * as surfaceModule from '../src/reader/surface';
import type { NodesApi, NodeResult } from '../src/host/nodes';
import { gate } from './helpers/memory-vault';

describe('automatic selection event ownership', () => {
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
  beforeEach(async ({ task }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Bottom-navigation cases start unassociated; a remembered host makes Delete protected.
    f = await selectionFixture(!task.name.startsWith('uses the real bottom '));
  });
  afterEach(() => {
    f?.view.stopForUnload();
    document.getSelection()?.removeAllRanges();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('does not serialize text or update status during live selection adjustments or pointer holds', async () => {
    const capture = vi.spyOn(f.surface, 'selection'),
      status = vi.spyOn(f.probe, 'updateStatus'),
      serialize = vi.spyOn(Range.prototype, 'toString'),
      selectionText = vi.spyOn(document.getSelection()!, 'toString');
    gesture('pointerdown', f.surface.body, 'mouse');
    for (let i = 0; i < 20; i++) f.select(i % 2);
    vi.advanceTimersByTime(1200);
    expect(capture).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(selectionText).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    gesture('pointerup', f.surface.body, 'mouse');
    for (let i = 0; i < 20; i++) f.select(i % 2);
    vi.advanceTimersByTime(899);
    expect(capture).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(selectionText).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(capture).toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
  });

  it('rejects a range changed without selectionchange before the quiet timer fires', async () => {
    const capture = vi.spyOn(f.surface, 'selection');
    f.select(0);
    // jsdom also queues its own selectionchange task; hold delivery, as a native
    // event can remain queued when the quiet-period timer gets its turn first.
    vi.spyOn(f.probe, 'selectionChanged').mockImplementation(() => {});
    f.select(1, 4, false);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect(capture).not.toHaveBeenCalled();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
  });

  it('mounts one aligned article column with six persistent actions outside the scroller', () => {
    const column = f.view.contentEl.querySelector('.reader-article')!;
    const actions = column.querySelector('.reader-actions')!;
    expect([...actions.querySelectorAll('button')].map(actionName)).toEqual([
      'Related notes',
      'Change status',
      'Delete',
      'List',
      'Highlight mode',
      'Create node',
    ]);
    expect(actions.parentElement).toBe(f.surface.viewport.parentElement);
    expect(f.surface.viewport.contains(actions)).toBe(false);
    expect([...f.surface.flow.children]).toEqual([
      f.surface.title,
      f.surface.topics,
      f.surface.body,
    ]);
    expect(f.view.contentEl.querySelector('.reader-toolbar,.reader-finish')).toBeNull();
    expect(f.view.contentEl.textContent).not.toContain('End of article');
  });

  function armTapHighlight() {
    f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Highlight mode"]')!.click();
  }
  function tapAction(label: string) {
    return [
      ...f.view.contentEl.querySelectorAll<HTMLButtonElement>(
        '.reader-tap-highlight-actions button',
      ),
    ].find((button) => button.getAttribute('aria-label') === label)!;
  }
  async function tapWord(start = 0, end = 5, paragraph = 0) {
    const { TapText } = await import('../src/reader/tap-text');
    const range = document.createRange();
    const node = f.surface.body.querySelectorAll('p')[paragraph].firstChild!;
    range.setStart(node, start);
    range.setEnd(node, end);
    vi.spyOn(TapText.prototype, 'wordAt').mockReturnValueOnce(range);
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      });
      Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
      f.surface.body.dispatchEvent(event);
    }
    f.surface.body.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }),
    );
  }
  async function tapSettled() {
    await f.probe.operations;
    await Promise.resolve();
  }

  it.each([
    ['s', 'Sentence'],
    ['p', 'Paragraph'],
  ])('uses %s after the first tapped word to save a %s highlight', async (key, label) => {
    armTapHighlight();
    const before = new KeyboardEvent('keydown', { key, cancelable: true });
    f.view.key(before);
    expect(before.defaultPrevented).toBe(false); // Disabled until the first word.
    await tapWord();
    expect(tapAction(label).disabled).toBe(false);
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    f.view.key(event);
    expect(event.defaultPrevented).toBe(true);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    expect(f.probe.tapHighlighter.active).toBe(true);
    expect(tapAction('Done').getAttribute('aria-keyshortcuts')).toBe('D');
    const done = new KeyboardEvent('keydown', { key: 'd', cancelable: true });
    f.view.key(done);
    expect(done.defaultPrevented).toBe(true);
    expect(f.probe.tapHighlighter.active).toBe(false);
  });

  it.each(['Sentence', 'Paragraph'])(
    'saves a tap-%s highlight immediately through the guarded store and supports Undo',
    async (action) => {
      const bar = f.view.contentEl.querySelector('.reader-actions');
      armTapHighlight();
      expect(tapAction(action).disabled).toBe(true);
      await tapWord();
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      expect(tapAction(action).disabled).toBe(false);
      tapAction(action).click();
      await tapSettled();
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
      );
      expect(f.surface.body.querySelector('mark')?.textContent).toBe('Alpha phrase.');
      expect(document.getSelection()?.isCollapsed).toBe(true);
      expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
      expect(f.view.contentEl.querySelector('.reader-actions')).toBe(bar);
      expect(f.probe.tapHighlighter.active).toBe(true);
      expect(f.view.contentEl.querySelector('[aria-label="Sentence"]')).toBeNull();
      expectNoPassagePopup();
      expect(tapAction('Undo').hidden).toBe(false);
      tapAction('Undo').click();
      await tapSettled();
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'),
      );
      expect(f.surface.body.querySelector('mark')).toBeNull();
      expect(tapAction('Undo').hidden).toBe(true);
      expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    },
  );

  it('Undo synchronously cancels an uncooperative picker before queuing and clears passage actions', async () => {
    const target = await f.note('Nodes/Undo target.md', '', 'topic');
    const node: NodeResult = {
      path: target.path,
      title: 'Undo target',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const entered = gate();
    let requestSignal!: AbortSignal;
    let callback!: (node: NodeResult) => Promise<void>;
    const api: NodesApi = {
      ...f.highlight.api,
      searchNodes: () => [f.highlight.node, node],
      getNode: (path) => (path === node.path ? node : f.highlight.api.getNode(path)),
      createNodeForLink: (options, link) => {
        requestSignal = options.signal!;
        callback = link;
        entered.resolve();
        return new Promise(() => {});
      },
    };
    mocks.highlightPicker.mockResolvedValue({ kind: 'create', type: 'topic', title: node.title });
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    tapAction('Add highlight to notes…').click();
    await entered.promise;
    expect(requestSignal.aborted).toBe(false);
    tapAction('Undo').click();
    expect(requestSignal.aborted).toBe(true);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    expect(f.probe.dialog).toBe(false);
    await expect(callback(node)).rejects.toThrow(/finished|cancelled/);
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    expect(f.vault.file(target.path)).toBe(target);
  });

  it('saves only on the second word tap and restores article actions with one Done press', async () => {
    armTapHighlight();
    await tapWord();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    await tapWord();
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    tapAction('Done').click();
    expect(f.view.contentEl.querySelectorAll('.reader-actions > button')).toHaveLength(6);
    expect(f.view.contentEl.querySelector('.reader-tap-highlight-actions')).toBeNull();
    expect(f.probe.tapMode).toBe(false);
    expect(f.surface.body.classList.contains('reader-tap-highlight-mode')).toBe(false);
  });

  it('preserves a staged word across metadata changes and Undo never reverses Feed promotion', async () => {
    await f.probe.move('Feed');
    armTapHighlight();
    await tapWord();
    const raw = patchProperties(await f.vault.read(f.article), {
      title: 'Changed title',
    });
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path });
    expect(tapAction('Sentence').disabled).toBe(false);
    tapAction('Sentence').click();
    await tapSettled();
    expect((await f.store.read(f.article.path)).properties.status).toBe('later');
    tapAction('Undo').click();
    await tapSettled();
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toBe(expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'));
    expect(saved.properties.status).toBe('later');
    expect(saved.properties.title).toBe('Changed title');
  });

  it('Undo removes only its highlight and preserves metadata edited after the save', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const raw = patchProperties(await f.vault.read(f.article), {
      title: 'Edited after highlight',
      custom_property: 'Keep this value',
    });
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path });
    tapAction('Undo').click();
    await tapSettled();
    const saved = await f.store.read(f.article.path);
    expect(saved.body).toBe(expectedRemovedHosted('==Alpha phrase.==\n\nBeta phrase.'));
    expect(saved.properties.title).toBe('Edited after highlight');
    expect(saved.properties.custom_property).toBe('Keep this value');
  });

  it('refuses Undo against changed source bytes even before their metadata notification arrives', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const saved = await f.store.read(f.article.path);
    const changedBody = saved.body + '\n\nExternally authored paragraph.';
    const raw = replaceBody(await f.vault.read(f.article), saved.body, changedBody);
    f.vault.bytes.set(f.article, raw);
    tapAction('Undo').click();
    await expect(tapSettled()).rejects.toThrow('The note changed');
    expect((await f.store.read(f.article.path)).body).toBe(changedBody);
    expect(tapAction('Undo').hidden).toBe(true);
  });

  it('invalidates a staged word on external body replacement without applying it to the new text', async () => {
    armTapHighlight();
    await tapWord();
    const raw = replaceBody(await f.vault.read(f.article), f.body, 'Replacement article.');
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path });
    expect(tapAction('Sentence').disabled).toBe(true);
    expect((await f.store.read(f.article.path)).body).toBe('Replacement article.');
    expect(f.surface.body.textContent).toContain('Replacement article.');
  });

  it('clears a staged word on Done or article exit and never flushes it as a native highlight', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Done').click();
    vi.advanceTimersByTime(1200);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    armTapHighlight();
    await tapWord();
    f.view.showList();
    vi.advanceTimersByTime(7000);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    expect(f.view.contentEl.querySelector('.reader-tap-highlight-preview')).toBeNull();
  });

  it('expires Undo and suppresses article shortcuts while the contextual highlight bar is active', async () => {
    armTapHighlight();
    f.view.key(new KeyboardEvent('keydown', { key: 'j' }));
    await tapSettled();
    expect(f.view.file).toBe(f.article);
    await tapWord();
    tapAction('Paragraph').click();
    await tapSettled();
    expect(tapAction('Undo').hidden).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(tapAction('Undo').hidden).toBe(true);
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true }));
    expectNoPassagePopup();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
  });

  it('keeps passive native-selection saves outside tap mode until the saved mark is tapped', async () => {
    f.select(0);
    vi.advanceTimersByTime(900);
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    expect(f.probe.tapMode).toBe(false);
    expect(f.view.contentEl.querySelector('[aria-label="Highlight mode"]')).not.toBeNull();
    expect(f.view.contentEl.querySelector('[aria-label="Done"]')).toBeNull();
    document.getSelection()!.removeAllRanges();
    f.surface.refresh();
    f.surface.body
      .querySelector('mark')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true }));
    expect(f.probe.tapHighlighter.active).toBe(true);
    expectNoPassagePopup();
  });

  it.each([false, true])(
    'opens an existing mark in the same bar and removes only the tapped occurrence (already active=%s)',
    async (active) => {
      const body = '==Alpha phrase.==\n\n==Beta phrase.==';
      f.vault.bytes.set(f.article, replaceBody(await f.vault.read(f.article), f.body, body));
      await f.view.changed({ path: f.article.path });
      const bar = f.view.contentEl.querySelector('.reader-actions');
      if (active) armTapHighlight();
      const mark = f.surface.body.querySelectorAll('mark')[1];
      if (active) {
        const { TapText } = await import('../src/reader/tap-text');
        const word = document.createRange();
        word.setStart(mark.firstChild!, 0);
        word.setEnd(mark.firstChild!, 4);
        vi.spyOn(TapText.prototype, 'wordAt').mockReturnValueOnce(word);
      }
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(passageLabels(f.view)).toEqual(expectedPassageActions());
      expect(f.view.contentEl.querySelector('.reader-actions')).toBe(bar);
      expect(f.probe.tapHighlighter.active).toBe(true);
      expectNoPassagePopup();
      passageButton(f.view, 'Remove highlight (article only)').click();
      await tapSettled();
      expect((await f.store.read(f.article.path)).body).toBe('==Alpha phrase.==\n\nBeta phrase.');
      expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
      expect(tapAction('Sentence').disabled).toBe(true);
      expect(f.probe.tapHighlighter.active).toBe(true);
    },
  );

  it('starts the next word selection from a saved passage bar and ignores its detached action', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const oldRemove = passageButton(f.view, 'Remove highlight (article only)');
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    await tapWord(0, 4, 1);
    expect(f.view.contentEl.querySelector('[data-action="remove-highlight"]')).toBeNull();
    expect(tapAction('Sentence').disabled).toBe(false);
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\nBeta phrase.'),
    );
    oldRemove.click();
    await tapSettled();
    expect(annotate).not.toHaveBeenCalled();
    tapAction('Sentence').click();
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase.==\n\n==Beta phrase.=='),
    );
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
    expectNoPassagePopup();
  });

  it('preserves saved passage context for metadata-only changes and clears it on a body change', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const body = (await f.store.read(f.article.path)).body;
    const raw = patchProperties(await f.vault.read(f.article), {
      title: 'Metadata only',
      custom: 'keep',
    });
    f.vault.bytes.set(f.article, raw);
    f.store.catalog.update(f.article.path, readDocument(raw).properties);
    await f.view.changed({ path: f.article.path, metadataChanged: true });
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
    expect((await f.store.read(f.article.path)).body).toBe(body);
    const staleRemove = passageButton(f.view, 'Remove highlight (article only)');
    const replacement = replaceBody(raw, body, 'Replacement article.');
    f.vault.bytes.set(f.article, replacement);
    await f.view.changed({ path: f.article.path });
    expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    staleRemove.click();
    await tapSettled();
    expect(await f.vault.read(f.article)).toBe(replacement);
    expect(tapAction('Sentence').disabled).toBe(true);
    expectNoPassagePopup();
  });

  it('refuses a passage action against changed source bytes before a change notification', async () => {
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const body = (await f.store.read(f.article.path)).body;
    const replacement = replaceBody(
      await f.vault.read(f.article),
      body,
      body + '\n\nExternal text.',
    );
    f.vault.bytes.set(f.article, replacement);
    passageButton(f.view, 'Remove highlight (article only)').click();
    await expect(tapSettled()).rejects.toThrow('The note changed');
    expect(await f.vault.read(f.article)).toBe(replacement);
    expectNoPassagePopup();
  });

  it('refreshes destination/unlink passage actions against the saved body and Remove preserves the words', async () => {
    const target = await f.note('Nodes/One.md', 'Keep the target', 'topic');
    const node: NodeResult = {
      path: target.path,
      title: 'One',
      type: 'topic',
      classes: ['topic'],
      aliases: [],
    };
    const api: NodesApi = {
      ...f.highlight.api,
      searchNodes: () => [f.highlight.node, node],
      getNode: (path) => (path === node.path ? node : f.highlight.api.getNode(path)),
    };
    (f.app as any).plugins = { getPlugin: () => ({ api }) };
    mocks.highlightPicker.mockResolvedValue({ kind: 'existing', node });
    const bar = f.view.contentEl.querySelector('.reader-actions');
    const targetBefore = await f.vault.read(target);
    armTapHighlight();
    await tapWord();
    tapAction('Sentence').click();
    await tapSettled();
    const blockId = paragraphAnchors((await f.store.read(f.article.path)).body)[0].blockId;
    expect(passageLabels(f.view)).toEqual(expectedPassageActions({ linked: true, undo: true }));
    passageButton(f.view, 'Add highlight to notes…').click();
    await tapSettled();
    expect(mocks.highlightPicker).toHaveBeenCalledWith(
      f.app,
      api,
      expect.objectContaining({
        query: '',
        title: 'Add highlight to notes',
        multiple: true,
        minSelection: 0,
        selectedPaths: [defaultHighlightPath],
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.pickNodeForLink).not.toHaveBeenCalled();
    const linked = expectedHosted('==Alpha phrase.==\n\nBeta phrase.', target.path, blockId);
    expect((await f.store.read(f.article.path)).body).toBe(linked);
    expect(passageLabels(f.view).filter((label) => label !== 'Undo')).toEqual(
      expectedPassageActions({ linked: true }),
    );
    expect(f.view.contentEl.querySelector('.reader-actions')).toBe(bar);
    const collected = appendQuotation(
      targetBefore,
      'Alpha phrase.',
      originLink(f.article.path, blockId, f.article.basename),
    ).raw;
    expect(await f.vault.read(target)).toBe(collected);
    passageButton(f.view, 'Remove references (article only)').click();
    await tapSettled();
    const unlinked = changePassage(linked, passages(linked)[0], 'unlink');
    expect((await f.store.read(f.article.path)).body).toBe(unlinked);
    expect(passageLabels(f.view).filter((label) => label !== 'Undo')).toEqual(
      expectedPassageActions(),
    );
    passageButton(f.view, 'Remove highlight (article only)').click();
    await tapSettled();
    expect((await f.store.read(f.article.path)).body).toBe(
      changePassage(unlinked, passages(unlinked)[0], 'remove'),
    );
    expect((await f.store.read(f.article.path)).properties.topics).toEqual([
      '[[Nodes/Default]]',
      '[[Nodes/One]]',
    ]);
    expect(passageLabels(f.view)).toEqual(['Sentence', 'Paragraph', 'Done']);
    expect(f.probe.tapHighlighter.active).toBe(true);
    expect(await f.vault.read(target)).toBe(collected);
    expect(f.vault.trashed).toEqual([]);
    expectNoPassagePopup();
  });

  function gesture(
    type: string,
    target: EventTarget = f.surface.body,
    pointerType = 'touch',
    pointerId = 1,
  ): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      button: 0,
      pointerId,
      pointerType,
      changedTouches: [{ identifier: pointerId }],
    });
    target.dispatchEvent(event);
    return event;
  }

  it.each(['article', 'list', 'controls', 'margin'] as const)(
    'isolates the whole mobile gesture throughout Reader %s without cancelling defaults or same-element handlers',
    async (area) => {
      if (area === 'list') await f.view.readingList();
      const target =
        area === 'list'
          ? f.view.contentEl.querySelector('.reader-list-item')!
          : area === 'controls'
            ? f.view.contentEl.querySelector('.reader-actions button')!
            : area === 'margin'
              ? f.view.contentEl
              : f.surface.body;
      const workspace = vi.fn(),
        reader = vi.fn(),
        capture = vi.fn();
      const types = [
        'pointerdown',
        'touchstart',
        'pointermove',
        'touchmove',
        'pointerup',
        'pointercancel',
        'touchend',
        'touchcancel',
      ];
      for (const type of types) {
        f.view.containerEl.addEventListener(type, workspace);
        f.view.containerEl.addEventListener(type, capture, { capture: true });
        f.view.contentEl.addEventListener(type, reader);
        expect(gesture(type, target).defaultPrevented).toBe(false);
      }
      expect(workspace).not.toHaveBeenCalled();
      expect(reader).toHaveBeenCalledTimes(types.length);
      expect(capture).toHaveBeenCalledTimes(types.length); // Not a capture-phase barrier.
      expect(f.probe.selecting).toBe(false);
    },
  );

  it.each(
    ['touch', 'pen'].flatMap((kind) =>
      ['pointerup', 'pointercancel'].map((release) => ({ kind, release })),
    ),
  )(
    'preserves selection and saves exactly once 900ms after isolated $kind $release',
    async ({ kind, release }) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight'),
        workspace = vi.fn();
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend'])
        f.view.containerEl.addEventListener(type, workspace);
      gesture('pointerdown', f.surface.body, kind);
      if (kind === 'touch') gesture('touchstart');
      expect(f.surface.pointerActive).toBe(true);
      f.select(0);
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      gesture(release, f.surface.body, kind);
      expect(f.surface.pointerActive).toBe(false);
      if (kind === 'touch') {
        vi.advanceTimersByTime(1200); // A known touch remains even after pointer release/cancel.
        await f.probe.operations;
        expect(annotate).not.toHaveBeenCalled();
        gesture('touchend');
      }
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
      );
      expect(document.getSelection()!.toString()).toBe('Alpha');
      expect(workspace).not.toHaveBeenCalled();
    },
  );

  it.each(['pointerup', 'pointercancel'])(
    'saves pointer-only desktop selection after stopped %s and Surface capture release',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      f.surface.body.addEventListener(release, (event) => event.stopPropagation(), { once: true });
      gesture('pointerdown', f.surface.body, 'mouse', 17);
      f.select(0); // selectionchange arrives before release, while both trackers are held.
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      gesture(release, f.surface.body, 'mouse', 17);
      expect(f.surface.pointerActive).toBe(false);
      expect(f.probe.selecting).toBe(false);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
      expect(document.getSelection()!.toString()).toBe('Alpha');
    },
  );

  it.each(
    ['pointerup', 'pointercancel'].flatMap((pointerRelease) =>
      ['touchend', 'touchcancel'].flatMap((touchRelease) =>
        [true, false].map((pointerFirst) => ({ pointerRelease, touchRelease, pointerFirst })),
      ),
    ),
  )(
    'observes stopped mixed-stream termination: $pointerRelease / $touchRelease, pointer first=$pointerFirst',
    async ({ pointerRelease, touchRelease, pointerFirst }) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      const target = f.surface.body;
      for (const type of [pointerRelease, touchRelease])
        target.addEventListener(type, (event) => event.stopPropagation(), { once: true });
      gesture('pointerdown', target, 'touch', 17);
      gesture('touchstart', target, 'touch', 42);
      f.select(0);
      const pointer = () => gesture(pointerRelease, target, 'touch', 17);
      const touch = () => gesture(touchRelease, target, 'touch', 42);
      (pointerFirst ? pointer : touch)();
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      expect(f.probe.selecting).toBe(true);
      (pointerFirst ? touch : pointer)();
      expect(f.surface.pointerActive).toBe(false);
      expect(f.probe.selecting).toBe(false);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
      expect(document.getSelection()!.toString()).toBe('Alpha');
    },
  );

  function nativeTouch(type: string, changed: number[], active?: number[]): void {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, {
      changedTouches: changed.map((identifier) => ({ identifier })),
      ...(active === undefined ? {} : { touches: active.map((identifier) => ({ identifier })) }),
    });
    f.surface.body.dispatchEvent(event);
  }

  it.each(['touchend'])(
    'reconciles accumulated iOS pointers only at authoritative empty %s',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      gesture('pointerdown', f.surface.body, 'touch', 17);
      nativeTouch('touchstart', [42], [42]);
      gesture('pointerdown', f.surface.body, 'touch', 18);
      nativeTouch('touchstart', [43], [42, 43]);
      f.select(0);
      nativeTouch(release, [42, 43], [99]); // Active touch can be outside Reader.
      vi.advanceTimersByTime(1200);
      expect(f.probe.selecting).toBe(true);
      expect(f.surface.pointerActive).toBe(true);
      expect(annotate).not.toHaveBeenCalled();
      // A later pointerdown is not proof that earlier pointers lifted.
      gesture('pointerdown', f.surface.body, 'touch', 19);
      nativeTouch('touchstart', [44], [44]);
      nativeTouch(release, [44]); // Missing native list remains conservative.
      vi.advanceTimersByTime(1200);
      expect(f.probe.selecting).toBe(true);
      expect(f.surface.pointerActive).toBe(true);
      expect(annotate).not.toHaveBeenCalled();
      nativeTouch('touchcancel', [], []); // Native takeover is not proof of lift.
      vi.advanceTimersByTime(1200);
      expect(f.probe.selecting).toBe(true);
      expect(f.surface.pointerActive).toBe(true);
      expect(annotate).not.toHaveBeenCalled();
      nativeTouch(release, [], []); // Also clears stale native touch identifiers.
      expect(f.probe.selecting).toBe(false);
      expect(f.surface.pointerActive).toBe(false);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
    },
  );

  it('does not treat a lone zero-touch cancellation as a missing pointer release', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    gesture('pointerdown', f.surface.body, 'touch', 17);
    nativeTouch('touchstart', [42], [42]);
    f.select(0);
    nativeTouch('touchcancel', [42], []);
    vi.advanceTimersByTime(1200);
    await f.probe.operations;
    expect(f.probe.selecting).toBe(true);
    expect(f.surface.pointerActive).toBe(true);
    expect(annotate).not.toHaveBeenCalled();
  });

  it('keeps simultaneous mouse and pen guards after native touches lift', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    for (const [id, kind] of [
      [17, 'touch'],
      [18, 'mouse'],
      [19, 'pen'],
    ] as const)
      gesture('pointerdown', f.surface.body, kind, id);
    nativeTouch('touchstart', [42], [42]);
    f.select(0);
    nativeTouch('touchend', [], []);
    gesture('pointerup', f.surface.body, 'mouse', 18);
    vi.advanceTimersByTime(1200);
    expect(f.probe.selecting).toBe(true);
    expect(f.surface.pointerActive).toBe(true);
    expect(annotate).not.toHaveBeenCalled();
    gesture('pointerup', f.surface.body, 'pen', 19);
    expect(f.probe.selecting).toBe(false);
    expect(f.surface.pointerActive).toBe(false);
    vi.advanceTimersByTime(899);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(annotate).toHaveBeenCalledOnce();
  });

  it('restarts the full 900ms quiet period for every adjustment, including repeated text', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    f.select(0);
    vi.advanceTimersByTime(899);
    f.select(1);
    vi.advanceTimersByTime(899);
    f.select(1);
    vi.advanceTimersByTime(899);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(annotate).toHaveBeenCalledOnce();
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
    expect(document.getSelection()!.toString()).toBe('Beta');
  });

  it.each(['pointerup', 'pointercancel', 'touchend', 'touchcancel'])(
    'retains the outside-Reader %s fallback and its full quiet period',
    async (release) => {
      const annotate = vi.spyOn(f.store, 'collectHighlight');
      gesture(release.startsWith('touch') ? 'touchstart' : 'pointerdown');
      f.select(0);
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      expect(gesture(release, document.body).defaultPrevented).toBe(false);
      expect(f.surface.pointerActive).toBe(false);
      expect(f.probe.selecting).toBe(false);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect(annotate).toHaveBeenCalledOnce();
      expect(document.getSelection()!.toString()).toBe('Alpha');
    },
  );

  it('does not isolate mouse, click or keyboard events', () => {
    const workspace = vi.fn();
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'click',
      'keydown',
    ]) {
      f.view.containerEl.addEventListener(type, workspace);
      expect(gesture(type, f.surface.body, 'mouse').defaultPrevented).toBe(false);
    }
    expect(workspace).toHaveBeenCalledTimes(6);
  });

  it('leaves native headers, other leaves and dialogs outside the mobile boundary', () => {
    const header = document.createElement('button'),
      other = document.createElement('div'),
      dialog = document.createElement('dialog'),
      outside = vi.fn(),
      click = vi.fn(),
      events = new AbortController();
    f.view.containerEl.prepend(header);
    document.body.append(other, dialog);
    document.addEventListener('touchmove', outside, { signal: events.signal });
    header.addEventListener('click', click);
    try {
      for (const target of [header, other, dialog])
        expect(gesture('touchmove', target).defaultPrevented).toBe(false);
      header.click();
      expect(outside).toHaveBeenCalledTimes(3);
      expect(click).toHaveBeenCalledOnce();
    } finally {
      events.abort();
    }
  });

  it.each(['close', 'unload', 'host retirement'])(
    'removes mobile interception after %s',
    async (end) => {
      const workspace = vi.fn(),
        annotate = vi.spyOn(f.store, 'collectHighlight');
      f.view.containerEl.addEventListener('touchstart', workspace);
      if (end === 'close') await f.view.onClose();
      else if (end === 'unload') f.view.stopForUnload();
      else f.signal.abort();
      expect(gesture('touchstart', f.view.contentEl).defaultPrevented).toBe(false);
      expect(workspace).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1200);
      await f.probe.operations;
      expect(annotate).not.toHaveBeenCalled();
    },
  );

  it('keeps a touch-only adjustment held until every known touch releases', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight');
    gesture('touchstart', f.surface.body, 'touch', 1);
    gesture('touchstart', f.surface.body, 'touch', 2);
    f.select(0);
    gesture('touchend', f.surface.body, 'touch', 1);
    vi.advanceTimersByTime(1200);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    gesture('touchcancel', f.surface.body, 'touch', 2);
    vi.advanceTimersByTime(899);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await f.probe.operations;
    expect(annotate).toHaveBeenCalledOnce();
    expect(document.getSelection()!.toString()).toBe('Alpha');
  });

  it('cancels a pending automatic save on host retirement without isolating later gestures', async () => {
    const annotate = vi.spyOn(f.store, 'collectHighlight'),
      workspace = vi.fn();
    f.view.containerEl.addEventListener('touchmove', workspace);
    f.select(0);
    vi.advanceTimersByTime(899);
    f.signal.abort();
    document.dispatchEvent(new Event('selectionchange'));
    gesture('touchmove');
    vi.advanceTimersByTime(1200);
    await f.probe.operations;
    expect(annotate).not.toHaveBeenCalled();
    expect(workspace).toHaveBeenCalledOnce();
    expect(document.getSelection()!.toString()).toBe('Alpha');
  });

  it('saves 900ms after the last pointer releases, shows one transient acknowledgement, then paints without clearing native selection', async () => {
    vi.spyOn(f.surface.viewport, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 400, 300),
    );
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: () => [new DOMRect(20, 20, 100, 20)],
    });
    const restoreGeometry = () => {
      if (descriptor) Object.defineProperty(Range.prototype, 'getClientRects', descriptor);
      else delete (Range.prototype as any).getClientRects;
    };
    try {
      const pointer = (type: string, pointerId: number) => {
        const event = new MouseEvent(type, { bubbles: true, button: 0 });
        Object.defineProperty(event, 'pointerId', { value: pointerId });
        f.surface.body.dispatchEvent(event);
      };
      pointer('pointerdown', 1);
      pointer('pointerdown', 2);
      f.select(0);
      vi.advanceTimersByTime(1000);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      pointer('pointerup', 1);
      vi.advanceTimersByTime(1000);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      pointer('pointerup', 2);
      vi.advanceTimersByTime(899);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      vi.advanceTimersByTime(1);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
      );
      expect(document.getSelection()!.toString()).toBe('Alpha');
      const feedback = f.view.contentEl.querySelector<HTMLElement>('.reader-highlight-feedback')!;
      expect(feedback.hidden).toBe(false);
      expect(feedback.textContent).toBe('Highlight saved');
      expect(f.view.contentEl.querySelector('.reader-status')?.textContent).toBe('');
      expect(
        [...f.view.contentEl.querySelectorAll('[role="status"]')].filter(
          (node) => node.textContent === 'Highlight saved',
        ),
      ).toHaveLength(1);
      expect(f.surface.body.querySelector('mark')).toBeNull(); // Selection is still held, not forcibly repainted.
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      expect(f.surface.body.querySelector('mark')?.textContent).toBe('Alpha');
      expect(f.surface.body.classList.contains('reader-highlight-fallback')).toBe(true);
      expect(feedback.hidden).toBe(true);
      expect(f.view.contentEl.querySelector('.reader-status')?.textContent).toBe('');
      expect(mocks.notice).not.toHaveBeenCalled();
    } finally {
      restoreGeometry();
    }
  });

  it.each(['code', 'ambiguous'] as const)(
    'quietly skips expected %s passive mapping rejection but retains explicit mapping errors',
    async (kind) => {
      const context = 'x '.repeat(65),
        unit = `${context}same words${context}`;
      const body = kind === 'code' ? '`literal code`' : `${unit}\n\n${unit}`;
      f.vault.bytes.set(f.article, createDocument({ type: 'article' }, body));
      await f.view.changed({ path: f.article.path });
      const range = document.createRange();
      if (kind === 'code') range.selectNodeContents(f.surface.body.querySelector('code')!);
      else {
        const node = f.surface.body.querySelector('p')!.firstChild!;
        range.setStart(node, context.length);
        range.setEnd(node, context.length + 10);
      }
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      const before = await f.vault.read(f.article),
        annotate = vi.spyOn(f.store, 'collectHighlight');
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect(await f.vault.read(f.article)).toBe(before);
      expect(annotate).not.toHaveBeenCalled();
      expect(mocks.notice).not.toHaveBeenCalled();
      await expect(f.probe.saveSelection()).rejects.toThrow('cannot be matched safely');
    },
  );

  it.each(['Archive', 'Delete', 'Next'])(
    'uses the status picker, Delete button or J shortcut to advance via %s',
    async (label) => {
      const next = await f.note('Reading/Inbox/Z next.md');
      await f.view.openArticle(f.article.path, true);
      const original = await f.vault.read(f.article),
        originalPath = f.article.path;
      const click = (name: string) =>
        [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
          .find((button) => actionName(button) === name)!
          .click();
      if (label === 'Archive') {
        mocks.choose.mockResolvedValueOnce('Archive');
        click('Change status');
      } else if (label === 'Next') {
        const event = new KeyboardEvent('keydown', { key: 'j', cancelable: true });
        f.view.key(event);
        expect(event.defaultPrevented).toBe(true);
      } else click(label);
      if (label === 'Archive') await Promise.resolve(); // Picker resolves before finish queues its operation.
      await f.probe.operations;
      expect(f.view.file).toBe(next);
      expect(f.vault.trashed).toEqual([]); // Protected annotated article is retained.
      expect(await f.vault.read(f.article)).toBe(
        patchProperties(original, {
          dog_ear: undefined,
          ...(label === 'Next' ? {} : { status: 'archive' }),
        }),
      );
      expect(f.article.path).toBe(
        label === 'Next' ? originalPath : 'Reading/Treasury/Selection.md',
      );
      const nextKey = new KeyboardEvent('keydown', { key: 'j', cancelable: true });
      f.view.key(nextKey);
      expect(nextKey.defaultPrevented).toBe(true);
      await f.probe.operations;
      expect(f.view.file).toBeUndefined(); // Last-article J returns to the list.
      expect(f.view.contentEl.querySelector('.reader-list')).not.toBeNull();
    },
  );

  it('keeps the new Delete action behind the existing source guard', async () => {
    const external = createDocument({ type: 'article' }, 'Externally edited words.');
    f.vault.bytes.set(f.article, external);
    [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-actions button')]
      .find((button) => actionName(button) === 'Delete')!
      .click();
    await expect(f.probe.operations).rejects.toThrow();
    expect(f.view.file).toBe(f.article);
    expect(f.vault.trashed).toEqual([]);
    expect(await f.vault.read(f.article)).toBe(external);
    expect(mocks.notice).toHaveBeenCalled();
  });

  it('retains acquisition errors and Retry when an automatic highlight succeeds', async () => {
    f.vault.bytes.set(
      f.article,
      patchProperties(await f.vault.read(f.article), { error: 'Fetch failed' }),
    );
    await f.view.changed({ path: f.article.path });
    f.select(0);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toContain('==Alpha==');
    const status = f.view.contentEl.querySelector('.reader-status')!;
    expect(status.textContent).toContain('Fetch failed');
    status.querySelector<HTMLButtonElement>('button')!.click();
    expect(f.host.ingestion.acquire).toHaveBeenLastCalledWith(f.article.path, true);
  });

  it('does not silence genuine passive write failures', async () => {
    vi.spyOn(f.vault, 'process').mockRejectedValueOnce(new Error('Disk write failed'));
    f.select(0);
    vi.advanceTimersByTime(900);
    await expect(f.probe.operations).rejects.toThrow('Disk write failed');
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    expect(mocks.notice).toHaveBeenCalledWith('Disk write failed');
    expect(f.view.contentEl.querySelector('.reader-status')?.textContent).not.toBe(
      'Highlight saved',
    );
  });

  it.each(['operation', 'position', 'writing'] as const)(
    'does not let an old A job save B after the %s wait',
    async (wait) => {
      const entered = gate(),
        release = gate();
      if (wait === 'operation') {
        void f.probe.operation(async () => {
          entered.resolve();
          await release.promise;
        });
      } else if (wait === 'writing') {
        f.probe.writing = release.promise.finally(() => {
          f.probe.writing = undefined;
        });
        entered.resolve();
      } else {
        const position = f.store.position.bind(f.store);
        vi.spyOn(f.store, 'position').mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return position(...args);
        });
        f.probe.persistPosition('position sentinel');
      }
      await entered.promise;
      f.select(0);
      vi.advanceTimersByTime(900);
      const oldJob = f.probe.operations;
      // Let the automatic action enter its position wait, if that is the blocked path.
      await Promise.resolve();
      await Promise.resolve();
      f.select(1); // B has not satisfied its own 900ms debounce.
      release.resolve();
      await oldJob;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
      );
      if (wait === 'position')
        expect((await f.store.read(f.article.path)).properties.bookmark).toBe('position sentinel');
    },
  );

  it.each(['repeat', 'pointer', 'unreported'] as const)(
    'invalidates queued A on %s input even without a different delivered quote',
    async (kind) => {
      const entered = gate(),
        release = gate();
      void f.probe.operation(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      f.select(0);
      vi.advanceTimersByTime(900);
      const oldJob = f.probe.operations;
      if (kind === 'repeat') f.select(0); // Same text/context, but a new selection revision.
      if (kind === 'unreported') f.select(1, 4, false); // The native selectionchange task has not run yet.
      if (kind === 'pointer') {
        for (const type of ['pointerdown', 'pointerup']) {
          const event = new Event(type, { bubbles: true });
          Object.assign(event, { pointerId: 1, button: 0 });
          f.surface.body.dispatchEvent(event);
        }
      }
      release.resolve();
      await oldJob;
      expect((await f.store.read(f.article.path)).body).toBe(f.body);
      if (kind === 'unreported') document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect((await f.store.read(f.article.path)).body).toBe(
        expectedHosted(
          kind === 'unreported'
            ? 'Alpha phrase.\n\n==Beta== phrase.'
            : '==Alpha== phrase.\n\nBeta phrase.',
        ),
      );
    },
  );

  it('rechecks supersession inside the final write transform and leaves the new selection intact', async () => {
    const entered = gate(),
      release = gate(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      entered.resolve();
      await release.promise;
      return process(file, update);
    });
    f.select(0);
    vi.advanceTimersByTime(900);
    const oldJob = f.probe.operations;
    await entered.promise;
    f.select(1);
    release.resolve();
    await oldJob;
    expect((await f.store.read(f.article.path)).body).toBe(f.body);
    expect(document.getSelection()!.toString()).toBe('Beta');
    expect(mocks.notice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
  });

  it.each(['body', 'replacement'] as const)(
    'binds the candidate to its original displayed source and file across a %s change',
    async (kind) => {
      f.select(0);
      if (kind === 'body')
        f.vault.bytes.set(
          f.article,
          createDocument({ type: 'article' }, 'Alpha phrase.\n\nExternal source.'),
        );
      else {
        const replacement = Object.setPrototypeOf({ path: f.article.path }, TFile.prototype);
        f.vault.files.set(f.article.path, replacement);
        f.vault.bytes.set(replacement, f.vault.bytes.get(f.article)!);
      }
      await f.view.changed({ path: f.article.path });
      const before = await f.vault.read(f.vault.file(f.article.path)!);
      vi.advanceTimersByTime(900);
      await f.probe.operations;
      expect(await f.vault.read(f.vault.file(f.article.path)!)).toBe(before);
    },
  );

  it('allows keyboard-style selection changes, own deferred rendering and overlapping adjustment', async () => {
    f.select(0);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    const blockId = paragraphAnchors((await f.store.read(f.article.path)).body)[0].blockId;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    expect(f.surface.displayedBody).toBe(f.body);
    expect(document.getSelection()!.toString()).toBe('Alpha');
    f.select(0, 12);
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha phrase==.\n\nBeta phrase.', defaultHighlightPath, blockId),
    );
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(f.surface.displayedBody).toBe(
      expectedHosted('==Alpha phrase==.\n\nBeta phrase.', defaultHighlightPath, blockId),
    );
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect([...f.surface.body.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
      'Alpha phrase',
    ]);
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('preserves its own Feed promotion during an automatic highlight', async () => {
    const moved = await f.store.move(await f.store.read(f.article.path), 'Feed');
    await f.view.openArticle(moved.path);
    // The surface changed through real navigation; drive its real DOM handler.
    const node = f.probe.surface.body.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect(f.article.path).toBe('Reading/Later/Selection.md');
    expect((await f.store.read(f.article.path)).properties.status).toBe('later');
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('does not roll back an already-dispatched A write and gives B its own debounce', async () => {
    const dispatched = gate(),
      release = gate(),
      process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementationOnce(async (file, update) => {
      const raw = await process(file, update);
      dispatched.resolve();
      await release.promise;
      return raw;
    });
    f.select(0);
    vi.advanceTimersByTime(900);
    const oldJob = f.probe.operations;
    await dispatched.promise;
    f.select(1);
    release.resolve();
    await oldJob;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\nBeta phrase.'),
    );
    vi.advanceTimersByTime(900);
    await f.probe.operations;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('==Alpha== phrase.\n\n==Beta== phrase.'),
    );
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('still saves the captured close-time selection after an old queued job is invalidated', async () => {
    const entered = gate(),
      release = gate();
    void f.probe.operation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    f.select(0);
    vi.advanceTimersByTime(900);
    f.select(1);
    const closing = f.view.onClose();
    document.getSelection()!.removeAllRanges();
    release.resolve();
    await closing;
    expect((await f.store.read(f.article.path)).body).toBe(
      expectedHosted('Alpha phrase.\n\n==Beta== phrase.'),
    );
    expect(mocks.notice).not.toHaveBeenCalled();
  });
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

  it('captures the pending selection before an awaited close loses the native range', async () => {
    const f = hostFixture(),
      article = await f.note('Reading/Inbox/A.md');
    await enableHighlightHost(f, article);
    await f.view.openArticle(article.path);
    const surface = f.probe.surface;
    surface.selectionValue = { quote: 'words', before: 'before ', after: ' after' };
    const closing = f.view.onClose();
    surface.selectionValue = undefined;
    await closing;
    expect((await f.store.read(article.path)).body).toBe(expectedHosted('before ==words== after'));
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

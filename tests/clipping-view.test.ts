// @vitest-environment node
import { hostFixture, passageButton, mocks, articleAction } from './helpers/reader-view-fixture';
import { afterEach, expect, it, vi } from 'vitest';
import { ClippingStore, type ClippingPort } from '../src/core/clipping-store';
import { readDocument } from '../src/core/document';
import { readClipping } from '../src/core/clippings';
import { clippingMarks } from '../src/reader/clipping-marks';
import type { TFile } from 'obsidian';
import * as surfaceModule from '../src/reader/surface';
import { gate } from './helpers/memory-vault';

async function fixture(configured = true) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    body = 'Alpha **phrase**. More words.',
    article = await f.note('Reading/Inbox/Clipping.md', body);
  f.store.vault.resolveLink = (path) =>
    f.store.vault.file(path) ?? f.store.vault.file(path + '.md');
  const binding = { property: 'fileClass', type: 'Clipping' };
  const port: ClippingPort<TFile> = {
    bindings: () => [binding],
    revision: () => 0,
    candidates: () =>
      [...f.vault.files.values()]
        .filter((file) => file !== article)
        .map((file) => ({
          file: file as TFile,
          path: file.path,
          bytes: f.vault.bytes.get(file)!.length,
        })),
    prepare: vi.fn(async () => {
      if (!configured)
        throw new Error(
          'Choose a default clipping Fileclass in Reader settings before keeping passages.',
        );
      return {
        binding,
        folder: 'Nodes',
        check() {},
        validate: async () => {},
        verify: async () => {},
      };
    }),
  };
  f.host.clippings = new ClippingStore(f.store, port);
  f.host.configureClippings = vi.fn(async () => {
    configured = true;
  });
  await f.view.onOpen();
  await f.view.openArticle(article.path);
  const surface = f.probe.surface as surfaceModule.ReadingSurface;
  async function select() {
    const p = surface.body.querySelector('p')!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.querySelector('strong')!.firstChild!, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(901);
    await f.probe.operations;
  }
  return { ...f, article, body, surface, select, port, binding };
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('offers explicit Keep and collection on selection, then saves through the real core without a destination picker', async () => {
  const f = await fixture();
  await f.select();
  expect(passageButton(f.view, 'Keep passage')).toBeDefined();
  expect(passageButton(f.view, 'Collect into notes…')).toBeDefined();
  expect((await f.store.read(f.article.path)).body).toBe(f.body);
  expect(mocks.highlightPicker).not.toHaveBeenCalled();
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations;
  const card = f.vault.file('Nodes/Alpha phrase.md')!;
  expect(readClipping(await f.vault.read(card), [f.binding])?.quoteMarkdown).toBe(
    'Alpha **phrase**',
  );
  expect((await f.store.read(f.article.path)).body).toMatch(
    /^Alpha \*\*phrase\*\*\. More words\. \^reader-/u,
  );
  expect(f.view.contentEl.textContent).toContain('Clipping saved.');
  expect(mocks.highlightPicker).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(f.surface.body.querySelector('[data-reader-clipping]')).not.toBeNull(),
  );
  expect(f.surface.body.textContent).toContain('Alpha phrase. More words.');
  f.surface.body
    .querySelector<HTMLElement>('[data-reader-clipping]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(mocks.menus.at(-1)?.has('Open clipping')).toBe(true);
  expect(mocks.menus.at(-1)?.has('Delete clipping…')).toBe(true);
  expect(f.opened.openFile).not.toHaveBeenCalled();
  mocks.menus.at(-1)!.get('Open clipping')!();
  await vi.waitFor(() =>
    expect(f.opened.openFile).toHaveBeenCalledWith(card, expect.objectContaining({ active: true })),
  );
});
async function savedFixture() {
  const f = await fixture();
  await f.select();
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations;
  await vi.waitFor(() =>
    expect(f.surface.body.querySelector('[data-reader-clipping]')).not.toBeNull(),
  );
  passageButton(f.view, 'Done').click();
  const mark = f.surface.body.querySelector<HTMLElement>('[data-reader-clipping]')!;
  return { ...f, mark, card: f.vault.file('Nodes/Alpha phrase.md')! };
}

it('opens a native clipping action menu and only trashes after explicit confirmation', async () => {
  const f = await savedFixture();
  const source = await f.vault.read(f.article);
  f.vault.bytes.set(f.card, (await f.vault.read(f.card)) + '\nPersonal writing');
  f.mark.click();
  expect(f.mark.getAttribute('role')).toBe('button');
  expect(f.mark.getAttribute('aria-haspopup')).toBe('menu');
  mocks.menus.at(-1)!.get('Delete clipping…')!();
  await vi.waitFor(() => expect(mocks.confirmClippingDeletion).toHaveBeenCalledOnce());
  expect(f.vault.file(f.card.path)).toBe(f.card);
  expect(mocks.confirmClippingDeletion.mock.calls[0][1]).toBe(f.card.path);
  const trash = mocks.confirmClippingDeletion.mock.calls[0][2];
  await trash(new AbortController().signal);
  expect(f.vault.trashed).toContain(f.card.path);
  expect(await f.vault.read(f.article)).toBe(source);
  await vi.waitFor(() => expect(f.surface.body.querySelector('[data-reader-clipping]')).toBeNull());
  expect(f.view.contentEl.textContent).toContain('Clipping moved to vault trash.');
});
it('supports Space and held-key guards for clipping actions', async () => {
  const f = await savedFixture();
  f.mark.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  expect(mocks.menus).toHaveLength(1);
  f.mark.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }),
  );
  expect(mocks.menus).toHaveLength(1);
});
it('preserves modifier-click opening without showing the menu', async () => {
  const f = await savedFixture();
  f.mark.dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(f.opened.openFile).toHaveBeenCalled());
  expect(mocks.menus).toHaveLength(0);
  expect(mocks.confirmClippingDeletion).not.toHaveBeenCalled();
});
it('rejects edits made while confirmation is open and preserves the clipping mark', async () => {
  const f = await savedFixture();
  f.mark.click();
  mocks.menus.at(-1)!.get('Delete clipping…')!();
  await vi.waitFor(() => expect(mocks.confirmClippingDeletion).toHaveBeenCalledOnce());
  f.vault.bytes.set(f.card, (await f.vault.read(f.card)) + '\nNew writing after confirmation');
  await expect(
    mocks.confirmClippingDeletion.mock.calls[0][2](new AbortController().signal),
  ).rejects.toThrow('changed');
  expect(f.vault.trashed).toEqual([]);
  expect(f.surface.body.querySelector('[data-reader-clipping]')).not.toBeNull();
  expect(f.view.contentEl.textContent).toContain('clipping changed');
});
it('cancels clipping deletion when the article is left', async () => {
  const f = await savedFixture();
  f.mark.click();
  mocks.menus.at(-1)!.get('Delete clipping…')!();
  await vi.waitFor(() => expect(mocks.confirmClippingDeletion).toHaveBeenCalledOnce());
  const [, , trash, signal] = mocks.confirmClippingDeletion.mock.calls[0];
  await f.view.readingList();
  expect(signal.aborted).toBe(true);
  await trash(new AbortController().signal).catch(() => {});
  expect(f.vault.file(f.card.path)).toBe(f.card);
  expect(f.vault.trashed).toEqual([]);
});

it('keeps unconfigured capture non-mutating and offers one-time setup without replaying the selection', async () => {
  const f = await fixture(false);
  await f.select();
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations.catch(() => {});
  expect(f.vault.files.size).toBe(1);
  expect((await f.store.read(f.article.path)).body).toBe(f.body);
  passageButton(f.view, 'Configure clippings').click();
  await Promise.resolve();
  expect(f.host.configureClippings).toHaveBeenCalledOnce();
  expect(f.vault.files.size).toBe(1);
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations;
  expect(f.vault.files.size).toBe(2);
});
it('keeps incomplete background lookup quiet but explains a blocked Keep without writing', async () => {
  const f = await fixture();
  vi.spyOn(f.host.clippings!, 'scan').mockResolvedValue({
    items: [],
    referenced: false,
    complete: false,
    revision: 0,
    diagnostic: 'Could not resolve origin in: "Cards/Existing.md".',
  });
  f.view.refreshArticleControls();
  await vi.waitFor(() =>
    expect(f.view.contentEl.querySelector('[data-clipping-coverage="incomplete"]')).not.toBeNull(),
  );
  expect(f.view.contentEl.querySelector('.reader-status')?.textContent).toBe('');
  const before = await f.vault.read(f.article);
  await f.select();
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations.catch(() => {});
  expect(f.view.contentEl.querySelector('[role="alert"]')?.textContent).toContain(
    'Clipping lookup is incomplete',
  );
  expect(f.view.contentEl.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not resolve origin in: "Cards/Existing.md".',
  );
  expect(f.vault.files.size).toBe(1);
  expect(await f.vault.read(f.article)).toBe(before);
});
it('does not implicitly save an unconfirmed selection when leaving Reader', async () => {
  const f = await fixture();
  await f.select();
  await f.view.readingList();
  expect(f.vault.files.size).toBe(1);
  expect((await f.store.read(f.article.path)).body).toBe(f.body);
});
it('keeps Done and navigation usable while a provider ignores cancellation, without freeing the underlying capture slot early', async () => {
  const f = await fixture(),
    held = gate(),
    prepare = f.port.prepare;
  vi.spyOn(f.port, 'prepare').mockImplementationOnce(async (signal) => {
    await held.promise;
    return prepare(signal);
  });
  await f.select();
  passageButton(f.view, 'Keep passage').click();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(passageButton(f.view, 'Done').disabled).toBe(false);
  passageButton(f.view, 'Done').click();
  await f.probe.operations;
  await f.view.readingList();
  expect(f.probe.snapshot).toBeUndefined();
  held.resolve();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(f.vault.files.size).toBe(1);
  expect((await f.store.read(f.article.path)).body).toBe(f.body);
});
it('has a Keep mode in More without replacing existing highlight controls', async () => {
  const f = await fixture();
  expect(f.view.contentEl.querySelector('[aria-label="Highlight mode"]')).not.toBeNull();
  articleAction(f.view, 'Keep passage');
  expect(f.view.contentEl.textContent).toContain('Tap the first word to keep a clipping');
  expect(passageButton(f.view, 'Done').disabled).toBe(false);
  passageButton(f.view, 'Done').click();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('More article actions');
});
it('never chooses an arbitrary card when saved passages overlap', async () => {
  const f = await fixture();
  await f.select();
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations;
  const raw = await f.vault.read(f.vault.file('Nodes/Alpha phrase.md')!);
  await f.vault.create('Cards/Duplicate.md', raw);
  await f.view.changed({ path: 'Cards/Duplicate.md', metadataChanged: true });
  await vi.waitFor(() => expect(f.surface.body.querySelector('[data-reader-clipping]')).toBeNull());
  expect(f.view.contentEl.textContent).toContain('Some saved passages overlap');
});
it('never steals publisher links or hosted-highlight controls with clipping decorations', async () => {
  await fixture();
  const root = document.createElement('article');
  root.innerHTML =
    '<p data-reader-paragraph="a">Clear <strong>rules</strong> <a href="https://example.org">publisher</a> <mark>hosted</mark> words.</p>';
  clippingMarks(root, [
    {
      path: 'Cards/One.md',
      quote: 'Clear rules publisher hosted words.',
      location: { from: 0, to: 39, blockId: 'a', quote: 'Clear rules publisher hosted words.' },
    },
  ]);
  expect(root.querySelector('a mark')).toBeNull();
  expect(root.querySelector('mark:not([data-reader-clipping]) mark')).toBeNull();
  expect(root.querySelector('[data-reader-clipping]')).not.toBeNull();
  expect(root.textContent).toBe('Clear rules publisher hosted words.');
});
it('retains an independently edited quotation and stops marking words that no longer match', async () => {
  const f = await fixture();
  await f.select();
  passageButton(f.view, 'Keep passage').click();
  await f.probe.operations;
  const card = f.vault.file('Nodes/Alpha phrase.md')!;
  await f.vault.process(card, (raw) => raw.replace('Alpha **phrase**', 'A different quotation'));
  await f.view.changed({ path: card.path, metadataChanged: true });
  await vi.waitFor(() => expect(f.surface.body.querySelector('[data-reader-clipping]')).toBeNull());
  expect(readDocument(await f.vault.read(card)).body).toContain('A different quotation');
});

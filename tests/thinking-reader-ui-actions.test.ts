import { describe, expect, it, vi } from 'vitest';
import { hostFixture, mocks, pluginFixture } from './helpers/reader-view-fixture';
import { ThinkingRuntime } from '../src/host/thinking-runtime';
import { patchProperties, readDocument } from '../src/core/document';
import { ReaderView } from '../src/reader/view';

async function configured() {
  const f = hostFixture();
  const notebook = await f.note('Notes/Thinking.md', 'Authored introduction.\n', 'notebook');
  const raw = await f.vault.process(notebook, (raw) =>
    patchProperties(raw, { fileClass: 'Notebook' }),
  );
  f.cache.get(notebook).frontmatter = readDocument(raw).properties;
  Object.defineProperty(notebook, 'stat', {
    configurable: true,
    get: () => ({ size: new TextEncoder().encode(f.vault.bytes.get(notebook) ?? '').byteLength }),
  });
  const runtime = new ThinkingRuntime(f.app, f.store, f.signal.signal, {
    notebook: '[[Notes/Thinking.md]]',
    notebookType: 'Notebook',
    explorationType: 'Exploration',
    bindingProperty: 'fileClass',
  });
  f.host.thinking = runtime;
  return { ...f, runtime, notebook };
}
function selectWords(root: HTMLElement, words: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const at = (node.textContent ?? '').indexOf(words);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return range;
  }
  throw new Error('Fixture words not found');
}

describe('Reader real thinking actions', () => {
  it('ignores irrelevant global selection clears and reuses bounded material on a real Reader release', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    const source = await f.note(
      'Reading/Inbox/Quiet.md',
      'First selected words.\n\nSecond paragraph.',
    );
    await f.view.onOpen();
    await f.view.openArticle(source.path);
    await f.runtime.readSourceMaterial(() => true);
    const project = vi.spyOn(f.runtime, 'readSourceMaterial');
    f.runtime.invalidate(undefined, false);
    for (let index = 0; index < 5; index++) document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
    expect(project).not.toHaveBeenCalled();
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    document.dispatchEvent(new Event('selectionchange'));
    expect(project).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(project).toHaveBeenCalledOnce());
  });
  it('automatically repaints saved writing when dog-ear native observations supersede a held entry projection', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    const body = 'First paragraph.\n\nSecond paragraph.';
    const source = await f.note('Reading/Inbox/Entry race.md', body);
    await f.vault.process(source, (raw) => patchProperties(raw, { bookmark: 'Second paragraph.' }));
    const snapshot = await f.store.read(source.path);
    expect(
      (await f.runtime.comment('Saved before reopening.', snapshot, body.indexOf('\n\n'))).status,
    ).toBe('saved');
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const read = f.vault.read.bind(f.vault);
    let first = true;
    const reads = vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      if (file === f.notebook && first) {
        first = false;
        started();
        await held;
      }
      return read(file);
    });
    const dogEar = f.store.dogEar.bind(f.store);
    vi.spyOn(f.store, 'dogEar').mockImplementation(async (path, guard) => {
      await reading;
      const marked = await dogEar(path, guard);
      // Faithful native observation boundaries: vault modify, metadata changed,
      // then settled indexing, while openArticle still awaits its entry write.
      f.runtime.invalidate(source);
      f.cache.get(source).frontmatter = marked.properties;
      f.runtime.invalidate(source, false);
      f.runtime.metadataSettled(source);
      await f.view.changed({ path: source.path, metadataChanged: true });
      return marked;
    });
    try {
      await f.view.openArticle(source.path);
      release();
      await vi.waitFor(() =>
        expect(
          f.view.contentEl.querySelector('.reader-thinking-inline,.reader-thinking-coverage'),
        ).not.toBeNull(),
      );
      expect(
        f.view.contentEl.querySelector('.reader-thinking-inline')?.textContent ??
          f.view.contentEl.querySelector('.reader-thinking-coverage')?.textContent,
      ).toMatch(/Saved before reopening\.|Some saved thinking is not shown/);
      expect(reads.mock.calls.filter(([file]) => file === f.notebook).length).toBeLessThanOrEqual(
        2,
      );
      await f.view.openArticle(source.path);
      await vi.waitFor(() =>
        expect(f.view.contentEl.querySelector('.reader-thinking-inline')?.textContent).toContain(
          'Saved before reopening.',
        ),
      );
      expect(reads.mock.calls.filter(([file]) => file === f.notebook).length).toBeLessThanOrEqual(
        4,
      );
      const reopened = readDocument(await read(source));
      expect(reopened.body).toBe(body);
      expect(reopened.properties.bookmark).toBe('Second paragraph.');
      expect(f.probe.surface.restore).toHaveBeenCalledWith('Second paragraph.');
    } finally {
      release();
    }
  });
  it('catches up a superseded projection at a same-body source refresh without a selection event', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    const body = 'First paragraph.\n\nSecond paragraph.';
    const source = await f.note('Reading/Inbox/Source phase.md', body);
    await f.view.openArticle(source.path);
    await f.runtime.readSourceMaterial(() => true);
    expect(
      (
        await f.runtime.comment(
          'Writing from the source refresh.',
          await f.store.read(source.path),
          body.indexOf('\n\n'),
        )
      ).status,
    ).toBe('saved');
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const read = f.vault.read.bind(f.vault);
    let first = true;
    const reads = vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      if (file === f.notebook && first) {
        first = false;
        started();
        await held;
      }
      return read(file);
    });
    try {
      await f.view.changed({ path: source.path, metadataChanged: true });
      await reading;
      f.runtime.invalidate(source, false);
      f.runtime.metadataSettled(source);
      await f.view.changed({ path: source.path, metadataChanged: true });
      release();
      await vi.waitFor(() =>
        expect(f.view.contentEl.querySelector('.reader-thinking-inline')?.textContent).toContain(
          'Writing from the source refresh.',
        ),
      );
      expect(reads.mock.calls.filter(([file]) => file === f.notebook).length).toBeLessThanOrEqual(
        2,
      );
      expect(readDocument(await read(source)).body).toBe(body);
    } finally {
      release();
    }
  });
  it('shows honest unknown coverage if a settled-phase replacement is revoked too, without a scan retry loop', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    const body = 'First paragraph.\n\nSecond paragraph.';
    const source = await f.note('Reading/Inbox/Repeated observations.md', body);
    expect(
      (
        await f.runtime.comment(
          'Saved writing must not look completely absent.',
          await f.store.read(source.path),
          body.indexOf('\n\n'),
        )
      ).status,
    ).toBe('saved');
    const read = f.vault.read.bind(f.vault);
    const reads = vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      if (file === f.notebook) {
        f.runtime.invalidate(f.notebook, false);
        f.runtime.metadataSettled(f.notebook);
      }
      return read(file);
    });
    await f.view.openArticle(source.path);
    await vi.waitFor(() =>
      expect(f.view.contentEl.querySelector('.reader-thinking-coverage')?.textContent).toContain(
        'Some saved thinking is not shown',
      ),
    );
    await f.runtime.drain();
    expect(reads.mock.calls.filter(([file]) => file === f.notebook).length).toBeLessThanOrEqual(2);
    expect(f.view.contentEl.querySelector('.reader-thinking-inline')).toBeNull();
    expect(readDocument(await read(source)).body).toBe(body);
  });
  it('shows honest partial automatic source coverage with an explicit saved-material action', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    const unknown = await f.note('Notes/Unknown size.md', 'Authored text.', 'notebook');
    const raw = await f.vault.process(unknown, (raw) =>
      patchProperties(raw, { fileClass: 'Notebook' }),
    );
    f.cache.get(unknown).frontmatter = readDocument(raw).properties;
    const open = vi.fn();
    f.host.openSavedMaterial = open;
    const source = await f.note('Reading/Inbox/Partial.md', 'Article text.');
    await f.view.openArticle(source.path);
    await vi.waitFor(() =>
      expect(f.view.contentEl.querySelector('.reader-thinking-coverage')?.textContent).toContain(
        'Some saved thinking is not shown',
      ),
    );
    const coverage = f.view.contentEl.querySelector('.reader-thinking-coverage')!;
    expect(coverage.textContent).toContain('12 notebooks and 200,000 bytes');
    coverage.querySelector('button')!.click();
    expect(open).toHaveBeenCalledOnce();
    expect(readDocument(await f.vault.read(source)).body).toBe('Article text.');
  });
  it.each(['selection', 'gap'])(
    'offers an explicit existing-writing choice when a reopened %s comment matches native saved evidence',
    async (kind) => {
      const f = await configured();
      mocks.renderRealArticles = true;
      const open = vi.fn();
      f.host.openSavedMaterial = open;
      const source = await f.note(
        'Reading/Inbox/Retry.md',
        'First selected words.\n\nSecond paragraph.',
      );
      const edit = async () => {
        await f.view.openArticle(source.path);
        if (kind === 'selection') {
          selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
          f.view.contentEl
            .querySelector<HTMLButtonElement>('[aria-label="Comment on selection"]')!
            .click();
        } else {
          f.view.contentEl
            .querySelector('article p')!
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          mocks.menus.at(-1)!.get('Add comment here')!();
        }
        const field = document.querySelector<HTMLTextAreaElement>(
          '[aria-label="Comment Markdown"]',
        )!;
        expect(field).not.toBeNull();
        field.value = 'My existing writing.';
        [...field.parentElement!.querySelectorAll('button')]
          .find((button) => button.textContent === 'Save')!
          .click();
      };
      await edit();
      await vi.waitFor(() => expect(document.querySelector('.reader-thinking-editor')).toBeNull());
      const before = await f.vault.read(f.notebook);
      const comment = (await f.runtime.store.read(f.notebook.path)).records.find(
        (record) => record.kind === 'comment',
      )!;
      mocks.notice.mockClear();
      await edit();
      await vi.waitFor(() =>
        expect(document.querySelector('.reader-thinking-editor')?.textContent).toContain(
          'Open existing saved writing',
        ),
      );
      const modal = document.querySelector('.reader-thinking-editor')!;
      expect(modal.textContent).toContain('This draft was not saved again');
      expect(await f.vault.read(f.notebook)).toBe(before);
      expect(open).not.toHaveBeenCalled();
      expect(mocks.notice).not.toHaveBeenCalled();
      [...modal.querySelectorAll('button')]
        .find((button) => button.textContent?.startsWith('Open existing saved writing'))!
        .click();
      expect(open).toHaveBeenCalledWith(f.runtime.target(comment));
      expect(document.querySelector('.reader-thinking-editor')).toBeNull();
    },
  );
  it('offers and opens native existing free writing from the command palette with no active Reader', async () => {
    const f = await pluginFixture();
    const notebook = await f.note('Notes/Free writing.md', 'Authored introduction.', 'notebook');
    const raw = await f.vault.process(notebook, (raw) =>
      patchProperties(raw, { fileClass: 'Notebook' }),
    );
    f.cache.get(notebook).frontmatter = readDocument(raw).properties;
    const runtime = new ThinkingRuntime(f.app, f.store, f.signal.signal, {
      notebook: '[[Notes/Free writing.md]]',
      notebookType: 'Notebook',
      explorationType: 'Exploration',
      bindingProperty: 'fileClass',
    });
    f.plugin.thinking = runtime;
    expect(f.app.workspace.getActiveViewOfType(ReaderView)).toBeUndefined();
    const edit = () => {
      mocks.commands.get('free-comment')!.callback!();
      const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
      field.value = 'My free existing writing.';
      [...field.parentElement!.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save')!
        .click();
    };
    edit();
    await vi.waitFor(() => expect(document.querySelector('.reader-thinking-editor')).toBeNull());
    const existing = (await runtime.store.read(notebook.path)).records[0];
    await f.vault.process(
      notebook,
      (raw) =>
        raw + '\n\n' + existing.raw.replace(`^${existing.blockId}`, '^manual-second-copy') + '\n',
    );
    runtime.invalidate(notebook);
    const before = await f.vault.read(notebook);
    const open = vi.spyOn(f.plugin, 'openSavedMaterial');
    mocks.notice.mockClear();
    edit();
    await vi.waitFor(() =>
      expect(document.querySelector('.reader-thinking-editor')?.textContent).toContain(
        'Open existing saved writing',
      ),
    );
    const modal = document.querySelector('.reader-thinking-editor')!;
    expect(modal.textContent).toContain('This draft was not saved again');
    expect(await f.vault.read(notebook)).toBe(before);
    expect(mocks.notice).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    const choices = [...modal.querySelectorAll('button')].filter((button) =>
      button.textContent?.startsWith('Open existing saved writing'),
    );
    expect(choices).toHaveLength(2);
    choices.find((button) => button.textContent?.includes('(^manual-second-copy)'))!.click();
    expect(open).toHaveBeenCalledWith({ path: notebook.path, blockId: 'manual-second-copy' });
    expect(document.querySelector('.reader-thinking-editor')).toBeNull();
    await vi.waitFor(() =>
      expect(document.querySelector('.reader-thinking-browser')?.textContent).toContain(
        'My free existing writing.',
      ),
    );
    f.plugin.onunload();
  });
  it('keeps from the visible action through real core without source markup or a destination picker', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Example.md', 'before selected words after');
    await f.view.openArticle(source.path);
    const before = readDocument(await f.vault.read(source)).body;
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    const keep = f.view.contentEl.querySelector<HTMLButtonElement>('[aria-label="Keep passage"]')!;
    expect(keep).not.toBeNull();
    keep.click();
    await vi.waitFor(() => expect(f.view.contentEl.textContent).toContain('Saved locally'));
    const saved = await f.runtime.store.read(f.notebook.path);
    expect(saved.records.map((record) => [record.kind, record.body])).toEqual([
      ['passage', 'selected words'],
    ]);
    expect(readDocument(await f.vault.read(source)).body).toBe(before);
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
    expect(f.view.contentEl.textContent).toContain('Saved locally');
  });
  it('saves a selection comment and passage in one notebook commit with no provider', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Comment.md', 'before selected words after');
    await f.view.openArticle(source.path);
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    await f.view.captureThinking('comment');
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
    expect(field).not.toBeNull();
    field.value = 'My **unfinished** response.';
    const modal = field.parentElement!;
    [...modal.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click();
    await vi.waitFor(async () =>
      expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(2),
    );
    const saved = await f.runtime.store.read(f.notebook.path);
    expect(saved.records.map((record) => [record.kind, record.body])).toEqual([
      ['passage', 'selected words'],
      ['comment', 'My **unfinished** response.'],
    ]);
    expect(saved.records[1].about?.blockId).toBe(saved.records[0].blockId);
    expect(readDocument(await f.vault.read(source)).body).toBe('before selected words after');
  });
  it('does not turn selection or navigation into a shadow legacy highlight write', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Explicit.md', 'before selected words after');
    await f.view.openArticle(source.path);
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    document.dispatchEvent(new Event('selectionchange'));
    await f.view.flush();
    await f.view.readingList();
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(0);
    expect(readDocument(await f.vault.read(source)).body).toBe('before selected words after');
    expect(mocks.highlightPicker).not.toHaveBeenCalled();
  });
  it('reports Possibly saved after a settled native notebook append with rejected readback', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Uncertain.md', 'before selected words after');
    await f.view.openArticle(source.path);
    const process = f.vault.process.bind(f.vault),
      read = f.vault.read.bind(f.vault);
    let rejectReadback = false;
    vi.spyOn(f.vault, 'process').mockImplementation(async (file, update) => {
      const result = await process(file, update);
      if (file === f.notebook) rejectReadback = true;
      return result;
    });
    vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      if (file === f.notebook && rejectReadback) {
        rejectReadback = false;
        throw new Error('Readback unavailable');
      }
      return read(file);
    });
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    await f.view.captureThinking('keep');
    expect(f.view.contentEl.textContent).toContain('Possibly saved — open notebook to check');
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(1);
    await f.view.readingList();
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(1);
  });
  it('retains Feed before a failed notebook phase without changing the source body', async () => {
    const f = await configured();
    const source = await f.note('Reading/Stream/Retain.md', 'before selected words after');
    await f.view.openArticle(source.path);
    const process = f.vault.process.bind(f.vault);
    vi.spyOn(f.vault, 'process').mockImplementation((file, update) => {
      if (file === f.notebook) throw new Error('Notebook write unavailable');
      return process(file, update);
    });
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    await f.view.captureThinking('keep');
    expect(f.store.catalog.article(source.path)?.queue).toBe('Later');
    expect(readDocument(await f.vault.read(source)).body).toBe('before selected words after');
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(0);
    expect(f.view.contentEl.textContent).toContain('Source retained; notebook incomplete');
  });
  it('rejects a dirty notebook in the real write guard and displays a local error', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Dirty.md', 'before selected words after');
    await f.view.openArticle(source.path);
    f.vault.dirty.add(f.notebook);
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    await f.view.captureThinking('keep');
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(0);
    expect(f.view.contentEl.textContent).toContain('Native editor has unfinished edits');
  });
  it('rejects changed source bytes between preview and comment save', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Stale.md', 'before selected words after');
    await f.view.openArticle(source.path);
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    await f.view.captureThinking('comment');
    await f.vault.process(source, (raw) => raw.replace('selected words', 'new source words'));
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
    field.value = 'Do not attach me to changed source.';
    [...field.parentElement!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')!
      .click();
    await vi.waitFor(() =>
      expect(field.parentElement!.textContent).toContain('Source text changed'),
    );
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(0);
  });
  it('requires visible one-time setup rather than silently choosing another notebook', async () => {
    const f = hostFixture();
    f.host.thinking = new ThinkingRuntime(f.app, f.store, f.signal.signal, undefined);
    const source = await f.note('Reading/Inbox/Unset.md', 'before selected words after');
    await f.view.openArticle(source.path);
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    await f.view.captureThinking('keep');
    expect(f.view.contentEl.textContent).toContain('Configure saved thinking');
    expect([...f.vault.files.keys()]).toEqual([source.path]);
  });
  it('offers a paragraph secondary action, cancels without a write, then saves an inline gap comment', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    const source = await f.note('Reading/Inbox/Gap.md', 'First paragraph.\n\nSecond paragraph.');
    await f.view.openArticle(source.path);
    const paragraph = f.view.contentEl.querySelector('article p')!;
    paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    mocks.menus.at(-1)!.get('Add comment here')!();
    let field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
    expect(field.parentElement!.textContent).toContain('After: First paragraph.');
    [...field.parentElement!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!
      .click();
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(0);
    paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    mocks.menus.at(-1)!.get('Add comment here')!();
    field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
    field.value = 'Writing between these paragraphs.';
    [...field.parentElement!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')!
      .click();
    await vi.waitFor(() =>
      expect(f.view.contentEl.textContent).toContain('Writing between these paragraphs.'),
    );
    const [record] = (await f.runtime.store.read(f.notebook.path)).records;
    expect(record.kind).toBe('comment');
    expect(record.before).toContain('First paragraph.');
    expect(record.after).toContain('Second paragraph.');
    expect(f.view.contentEl.querySelector('.reader-thinking-unplaced')).toBeNull();
    expect(readDocument(await f.vault.read(source)).body).toBe(
      'First paragraph.\n\nSecond paragraph.',
    );
    await f.vault.process(source, (raw) => raw.replace('First paragraph.', 'Changed paragraph.'));
    await f.view.openArticle(source.path);
    await vi.waitFor(() =>
      expect(f.view.contentEl.querySelector('.reader-thinking-unplaced')?.textContent).toContain(
        'Writing between these paragraphs.',
      ),
    );
    expect((await f.runtime.store.read(f.notebook.path)).records[0].body).toBe(
      'Writing between these paragraphs.',
    );
  });
  it.each(['First paragraph. ^existing-anchor', 'First **paragraph.**'])(
    'reopens an exact parser-proven gap inline after %s without changing the source',
    async (paragraph) => {
      const f = await configured();
      mocks.renderRealArticles = true;
      const body = `${paragraph}\n\nSecond paragraph.\n`;
      const source = await f.note('Reading/Inbox/Anchored gap.md', body);
      await f.view.openArticle(source.path);
      f.view.contentEl
        .querySelector('article p')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      mocks.menus.at(-1)!.get('Add comment here')!();
      const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
      field.value = 'Writing after the anchored paragraph.';
      [...field.parentElement!.querySelectorAll('button')]
        .find((button) => button.textContent === 'Save')!
        .click();
      await vi.waitFor(() =>
        expect(f.view.contentEl.textContent).toContain('Writing after the anchored paragraph.'),
      );
      await f.view.openArticle(source.path);
      await vi.waitFor(() =>
        expect(f.view.contentEl.querySelector('.reader-thinking-inline')?.textContent).toContain(
          'Writing after the anchored paragraph.',
        ),
      );
      expect(f.view.contentEl.querySelector('.reader-thinking-unplaced')).toBeNull();
      expect(readDocument(await f.vault.read(source)).body).toBe(body);
    },
  );
  it('keeps an inline comment editor bound to the source rather than a superseded decoration paint', async () => {
    const f = await configured();
    mocks.renderRealArticles = true;
    await f.view.onOpen();
    const body = 'First paragraph.\n\nSecond paragraph.';
    const source = await f.note('Reading/Inbox/Edit.md', body);
    const snapshot = await f.store.read(source.path);
    expect(
      (await f.runtime.comment('Original writing.', snapshot, body.indexOf('\n\n'))).status,
    ).toBe('saved');
    await f.view.openArticle(source.path);
    await vi.waitFor(() =>
      expect(f.view.contentEl.querySelector('.reader-thinking-inline')?.textContent).toContain(
        'Original writing.',
      ),
    );
    selectWords(f.view.contentEl.querySelector('article')!, 'First paragraph.');
    document.dispatchEvent(new Event('selectionchange'));
    [...f.view.contentEl.querySelectorAll<HTMLButtonElement>('.reader-thinking-inline button')]
      .find((button) => button.textContent === 'Edit comment')!
      .click();
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Comment Markdown"]')!;
    const project = vi.spyOn(f.runtime, 'readSourceMaterial');
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    await vi.waitFor(() => expect(project).toHaveBeenCalledOnce());
    field.value = 'Revised private writing.';
    [...field.parentElement!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save')!
      .click();
    await vi.waitFor(() => expect(document.querySelector('.reader-thinking-editor')).toBeNull());
    await vi.waitFor(() =>
      expect(f.view.contentEl.querySelector('.reader-thinking-inline')?.textContent).toContain(
        'Revised private writing.',
      ),
    );
    expect(readDocument(await f.vault.read(source)).body).toBe(body);
  });
  it('exposes Continue reading and explicit adoption only for exact source inspection through the shared surface', async () => {
    const f = await configured();
    const source = await f.note('Reading/Inbox/Context.md', 'before selected words after');
    await f.view.openArticle(source.path);
    const saved = await f.runtime.keep(await f.store.read(source.path), 7, 21);
    const record = saved.affectedRecords![0];
    f.view.inspectThinkingContext(record);
    expect(f.view.contentEl.textContent).toContain('Continue reading');
    expect(f.view.contentEl.textContent).toContain('Read from here');
    [...f.view.contentEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Continue reading')!
      .click();
    expect(f.view.contentEl.textContent).not.toContain('Read from here');
    await f.vault.process(source, (raw) => raw.replace('selected words', 'different words'));
    await f.view.openArticle(source.path);
    f.view.inspectThinkingContext(record);
    expect(f.view.contentEl.textContent).toContain('Source context is uncertain');
    expect(f.view.contentEl.textContent).not.toContain('Read from here');
    expect((await f.runtime.store.read(f.notebook.path)).records[0].body).toBe('selected words');
  });
  it('registers real palette routes and a visible saved-material list control', async () => {
    const f = await pluginFixture();
    expect(mocks.commands.has('keep-passage')).toBe(true);
    expect(mocks.commands.has('comment-on-selection')).toBe(true);
    expect(mocks.commands.has('free-comment')).toBe(true);
    expect(mocks.commands.has('open-saved-material')).toBe(true);
    expect(mocks.commands.has('configure-saved-thinking')).toBe(true);
    expect(mocks.commands.has('audit-saved-material')).toBe(true);
    const notebook = await f.note('Notes/Palette.md', 'Preface.', 'notebook');
    const raw = await f.vault.process(notebook, (raw) =>
      patchProperties(raw, { fileClass: 'Notebook' }),
    );
    f.cache.get(notebook).frontmatter = readDocument(raw).properties;
    const runtime = new ThinkingRuntime(f.app, f.store, f.signal.signal, {
      notebook: '[[Notes/Palette.md]]',
      notebookType: 'Notebook',
      explorationType: 'Exploration',
      bindingProperty: 'fileClass',
    });
    f.host.thinking = runtime;
    f.plugin.thinking = runtime;
    f.view.showList();
    expect(f.view.contentEl.querySelector('[aria-label="Open saved material"]')).not.toBeNull();
    const source = await f.note('Reading/Inbox/Palette.md', 'before selected words after');
    await f.view.openArticle(source.path);
    (f.app.workspace.getActiveViewOfType as ReturnType<typeof vi.fn>).mockImplementation((type) =>
      type === ReaderView ? f.view : undefined,
    );
    selectWords(f.view.contentEl.querySelector('article')!, 'selected words');
    expect(mocks.commands.get('keep-passage')!.checkCallback!(true)).toBe(true);
    expect((await runtime.store.read(notebook.path)).records).toHaveLength(0);
    mocks.commands.get('keep-passage')!.checkCallback!(false);
    await vi.waitFor(async () =>
      expect((await runtime.store.read(notebook.path)).records).toHaveLength(1),
    );
    expect(readDocument(await f.vault.read(source)).body).toBe('before selected words after');
    mocks.commands.get('open-saved-material')!.callback!();
    await vi.waitFor(() =>
      expect(document.querySelector('.reader-thinking-browser')?.textContent).toContain(
        'Passage — selected words',
      ),
    );
    const browser = document.querySelector('.reader-thinking-browser')!;
    [...browser.querySelectorAll('button')]
      .find((button) => button.textContent === 'Passage — selected words')!
      .click();
    await vi.waitFor(() => expect(browser.textContent).toContain('Open source Markdown'));
    [...browser.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open source Markdown')!
      .click();
    await vi.waitFor(() =>
      expect(f.opened.openFile).toHaveBeenCalledWith(
        source,
        expect.objectContaining({ state: { mode: 'source' } }),
      ),
    );
    f.plugin.onunload();
  });
});

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

import { expect, it, vi } from 'vitest';
import { nativeStore, gate } from './helpers/native-store';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS, type FileStore, type HttpGet } from '../src/types';
import { parseNote } from '../src/storage/markdown';
import { StaleArticleWriteError } from '../src/storage/preconditions';
const path = 'Reading/Inbox/Typing.md';
const raw = '---\ntype: article\nurl: https://example.com/article\nstatus: inbox\ncustom: untouched\n---\n\n## Article\n\n## Comments\n\nExisting comments.\n\n## Custom\n\nKeep custom exactly.\n';
const html = '<html><head><title>Publisher</title></head><body><article><h1>Publisher</h1>' + '<p>Publisher text describes durable reading and keeping every user comment intact during acquisition. This article has useful explanations and examples for the reader.</p>'.repeat(20) + '</article></body></html>';
const http = () => vi.fn<HttpGet>().mockResolvedValue({ status: 200, text: html, headers: { 'content-type': 'text/html' }, url: 'https://example.com/article' });
for (const useDummyContent of [true, false]) {
  it(`negative control reproduces disk-only loss of individually verified unsaved typing (dummy=${useDummyContent})`, async () => {
    const f = nativeStore({ [path]: raw }), { editor } = f.open(path), settings = { ...DEFAULT_SETTINGS, useDummyContent };
    editor.caretAfter('Existing comments.'); let prefix = ''; for (const key of ' VERIFIED-PREFIX') { prefix += key; editor.type(key); expect(editor.value).toContain(prefix); }
    const diskOnly: FileStore = { list: () => f.store.list(), exists: p => f.store.exists(p), read: p => f.store.read(p), revision: p => f.store.revision(p), create: (p, text) => f.store.create(p, text), process: (p, update) => f.vault.process(f.files.get(p)!, update), rename: (from, to, options) => f.store.rename(from, to, options) };
    const controller = new ReaderController(new ReaderRepository(diskOnly, settings), http(), settings);
    try { await controller.acquire(path, true); expect(f.disk.get(path)).not.toContain(prefix); expect(editor.value).not.toContain(prefix); expect(editor.reloads).toBeGreaterThan(0); }
    finally { await controller.shutdown(); }
  });
  it(`latest-buffer acquisition keeps verified prefix, interleaved keystrokes, custom sections and caret (dummy=${useDummyContent})`, async () => {
    const f = nativeStore({ [path]: raw }), { editor, view, leaf } = f.open(path), held = gate(), settings = { ...DEFAULT_SETTINGS, useDummyContent }, get = http();
    view.gateSave = () => held.promise; editor.caretAfter('Existing comments.'); let prefix = '';
    for (const key of ' PREFIX-a:b-100%-読書 {{VALUE:url}}') { prefix += key; editor.type(key); expect(editor.value).toContain(prefix); }
    const repo = new ReaderRepository(f.store, settings), controller = new ReaderController(repo, get, settings);
    try {
      const operation = controller.acquire(path, true); expect(f.disk.get(path)).toBe(raw); expect(editor.value).toContain(prefix);
      for (const key of ' LATER-✓') { editor.type(key); prefix += key; expect(editor.value).toContain(prefix); void view.save(); }
      expect(editor.value.slice(0, editor.head).endsWith(prefix)).toBe(true); expect(view.started.every(snapshot => snapshot.includes(' PREFIX-a:b-100%-読書'))).toBe(true);
      held.release(); await operation.catch(error => { expect(error).toBeInstanceOf(StaleArticleWriteError); });
       expect(editor.value).toContain(prefix); expect(editor.value).toContain('## Custom\n\nKeep custom exactly.'); expect(editor.value.slice(0, editor.head).endsWith(prefix)).toBe(true);
      expect(parseNote(f.disk.get(path)!).doc.get('custom')).toBe('untouched'); expect(f.workspace.activeLeaf).toBe(leaf); expect(editor.reloads).toBe(0); expect(editor.setValue).not.toHaveBeenCalled(); expect(f.vault.process.mock.calls.every(([file]) => file.path === path)).toBe(true); expect(get.mock.calls.length).toBeLessThanOrEqual(useDummyContent ? 0 : 1);
    } finally { held.release(); await controller.shutdown(); }
  });
  it(`ambiguous editors defer without id/error/retry writes and resume through a native-change signal (dummy=${useDummyContent})`, async () => {
    const f = nativeStore({ [path]: raw }), first = f.open(path), extra = f.open(path, raw + 'DIVERGENT'), settings = { ...DEFAULT_SETTINGS, useDummyContent }, get = http();
    const repo = new ReaderRepository(f.store, settings), controller = new ReaderController(repo, get, settings); f.onModify(() => controller.vaultChanged());
    try {
      controller.setActive(true); await vi.waitFor(() => expect(controller.message).toContain('multiple Markdown views'));
      const attempts = get.mock.calls.length; await new Promise(resolve => setTimeout(resolve, 350)); expect(get).toHaveBeenCalledTimes(attempts);
      expect(f.disk.get(path)).toBe(raw); expect(first.editor.value).toBe(raw); expect(extra.editor.value).toBe(raw + 'DIVERGENT'); expect(f.events).toEqual([]);
      f.leaves.splice(f.leaves.indexOf(extra.leaf), 1); controller.vaultChanged();
      await vi.waitFor(async () => expect((await repo.getArticle(path)).body).toContain(useDummyContent ? 'Dummy article' : 'Publisher text'));
      expect(parseNote(f.disk.get(path)!).doc.has('error')).toBe(false); expect(parseNote(f.disk.get(path)!).doc.has('retryAfter')).toBe(false);
    } finally { await controller.shutdown(); }
  });
}
it.each(['https://example.com/replacement', '{{VALUE:url}}'])('latest unsaved URL cancels acquisition before any editor/disk/id/error mutation: %s', async url => {
  const f = nativeStore({ [path]: raw }), changed = raw.replace('https://example.com/article', JSON.stringify(url)), { editor, view } = f.open(path, changed), settings = { ...DEFAULT_SETTINGS };
  const controller = new ReaderController(new ReaderRepository(f.store, settings), http(), settings);
  try { await expect(controller.acquire(path, true)).rejects.toBeInstanceOf(StaleArticleWriteError); expect(editor.value).toBe(changed); expect(f.disk.get(path)).toBe(raw); expect(editor.transaction).not.toHaveBeenCalled(); expect(view.save).not.toHaveBeenCalled(); expect(f.events).toEqual([]); }
  finally { await controller.shutdown(); }
});
it('new authored source in the editor is protected rather than replaced by the older acquisition', async () => {
  const f = nativeStore({ [path]: raw }), authored = raw.replace('## Article\n\n', '## Article\n\nAuthor wrote this unsaved source.\n\n'), { editor } = f.open(path, authored), settings = { ...DEFAULT_SETTINGS };
  const controller = new ReaderController(new ReaderRepository(f.store, settings), http(), settings);
  try { await expect(controller.acquire(path, true)).rejects.toBeInstanceOf(StaleArticleWriteError); expect(editor.value).toContain('Author wrote this unsaved source.'); expect(f.disk.get(path)).toBe(raw); expect(editor.value).toContain('## Custom\n\nKeep custom exactly.'); expect(editor.value).not.toContain('Dummy article'); }
  finally { await controller.shutdown(); }
});

import { mark } from './markdown-helpers';
import { expect, it, vi } from 'vitest';
import { nativeStore, NativeEditor, gate } from './helpers/native-store';
import { editorEdits, editorTransaction } from '../src/editor-transaction';
import { ReaderRepository } from '../src/storage/repository';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS as BASE_SETTINGS, type HttpGet } from '../src/types';
const DEFAULT_SETTINGS = BASE_SETTINGS;
import { parseNote } from '../src/storage/markdown';
const path = 'Reading/Inbox/Undo.md', daily = 'Daily/2026-10-09.md';
const raw = '---\ntype: article\nurl: https://example.com/article\nstatus: inbox\n---\n\n## Article\n\nA useful quote.\n\n## Comments\n\nUser comments.\n';
// User-origin Undo/edit transactions, not adapter rollbacks or setValue restorations.
function userUndo(editor: NativeEditor, result: string) {
  editor.transaction(editorTransaction(editor as never, result, editorEdits(editor.getValue(), result)));
}
async function seeded() {
  const f = nativeStore({ [path]: raw, [daily]: '## Journal\n\nKeep daily text.\n' }), repo = new ReaderRepository(f.store, { ...DEFAULT_SETTINGS });
  const article = await mark(repo, path, { quote: 'A useful quote.' }); f.events.length = 0;
  return { f, repo, id: article.highlights[0].id };
}
for (const op of ['link', 'delete'] as const) {
  it(`${op}: undoing the visible source change never acknowledges completion or overwrites the user's undo`, async () => {
    const { f, repo, id } = await seeded(), before = f.disk.get(path)!, beforeDaily = f.disk.get(daily)!;
    const source = f.open(path), journal = f.open(daily), writer = gate(), undoSave = gate();
    source.view.gateSave = (_text, index) => index === 1 ? writer.promise : undoSave.promise;
    const operation = op === 'link' ? repo.setHighlightLink(path, id, 'Target') : repo.deleteHighlight(path, id);
    const outcome = operation.then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
    try {
      await vi.waitFor(() => expect(source.view.started.length).toBe(1));
      const undone = before + '\nUser edits after Undo.\n'; userUndo(source.editor, undone); void source.view.save();
      writer.release(); const result = await outcome;
      expect(result.ok).toBe(false); expect(String(result.error)).toContain('editor changed this operation');
      expect(source.editor.value).toBe(undone);
      expect(f.disk.get(daily)).toBe(beforeDaily); expect(journal.editor.value).toBe(beforeDaily);
      expect(journal.view.save).not.toHaveBeenCalled(); expect(journal.editor.transaction).not.toHaveBeenCalled();
      expect(source.editor.transaction).toHaveBeenCalledTimes(2); expect(source.editor.setValue).not.toHaveBeenCalled(); expect(source.editor.reloads).toBe(0);
      undoSave.release(); await vi.waitFor(() => expect(f.disk.get(path)).toBe(undone));
      const protectedFiles = Object.fromEntries(f.disk);
      expect(Object.fromEntries(f.disk)).toEqual(protectedFiles);
      expect([...f.disk.keys()].some(path => path.endsWith('.json'))).toBe(false);
    } finally { writer.release(); undoSave.release(); await outcome; await vi.waitFor(() => expect(source.view.saving).toBe(false)); }
  });
}
it('editing the applied operation while the durability read waits cannot acknowledge its captured older snapshot', async () => {
  const f = nativeStore({ [path]: raw }), source = f.open(path), reading = gate(), releaseRead = gate(); let acknowledged = false;
  f.vault.read.mockImplementation(async file => { const captured = f.disk.get(file.path)!; reading.release(); await releaseRead.promise; return captured; });
  const operation = f.store.process(path, text => text.replace('A useful quote.', 'Reader replacement.')).then(() => { acknowledged = true; });
  const outcome = operation.then(() => undefined, error => error);
  try {
    await reading.promise; const changed = source.editor.value.replace('Reader replacement.', 'User replacement.') + '\nLater user comments.\n';
    userUndo(source.editor, changed); await source.view.save(); releaseRead.release();
    expect(String(await outcome)).toContain('editor changed this operation'); expect(acknowledged).toBe(false); expect(source.editor.value).toBe(changed); expect(f.disk.get(path)).toBe(changed);
    expect(source.editor.transaction).toHaveBeenCalledTimes(2); expect(source.editor.setValue).not.toHaveBeenCalled(); expect(source.editor.reloads).toBe(0);
  } finally { releaseRead.release(); await outcome; }
});
it('background acquisition undone during save defers without acknowledgement, error stamping, or overwriting later user edits', async () => {
  const pending = raw.replace('A useful quote.', ''), f = nativeStore({ [path]: pending }), source = f.open(path), writer = gate(), undoSave = gate(), settings = { ...DEFAULT_SETTINGS };
  source.view.gateSave = (_text, index) => index === 1 ? writer.promise : undoSave.promise;
  const repo = new ReaderRepository(f.store, settings), controller = new ReaderController(repo, vi.fn<HttpGet>(), settings), stamp = vi.spyOn(repo, 'setArticleError'), save = repo.saveContent.bind(repo); let acknowledged = false;
  vi.spyOn(repo, 'saveContent').mockImplementation((...args) => save(...args).then(value => { acknowledged = true; return value; }));
  try {
    controller.setActive(true); await vi.waitFor(() => expect(source.view.started.length).toBe(1));
    const undone = pending + '\nUser continued typing after Undo.\n'; userUndo(source.editor, undone); void source.view.save(); writer.release();
    await vi.waitFor(() => expect(controller.message).toContain('editor changed this operation'));
    expect(acknowledged).toBe(false); expect(stamp).not.toHaveBeenCalled(); expect(source.editor.value).toBe(undone); expect(source.editor.transaction).toHaveBeenCalledTimes(2);
    expect(parseNote(source.editor.value).doc.has('error')).toBe(false); expect(parseNote(source.editor.value).doc.has('retryAfter')).toBe(false); expect(source.editor.setValue).not.toHaveBeenCalled();
    undoSave.release(); await vi.waitFor(() => expect(f.disk.get(path)).toBe(undone)); expect(source.editor.reloads).toBe(0);
  } finally { controller.setActive(false); writer.release(); undoSave.release(); await controller.shutdown(); await vi.waitFor(() => expect(source.view.saving).toBe(false)); }
});

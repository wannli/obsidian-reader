import { expect, it, vi } from 'vitest';
import { nativeStore, gate } from './helpers/native-store';
import { EditorWriteDeferredError, editorEdits } from '../src/editor-transaction';
import { StaleArticleWriteError } from '../src/storage/preconditions';
import { ReaderRepository } from '../src/storage/repository';
import { DEFAULT_SETTINGS } from '../src/types';
import { sidecarPath } from './sidecar-helpers';
const path = 'Reading/Articles/Typing.md';
const raw = '---\ntype: article\nurl: https://example.com/article\nstatus: inbox\ncustom: untouched\n---\n\n## Article\n\n## Comments\n\nExisting comments.\n\n## Custom\n\nKeep custom exactly.\n';
const replace = (text: string) => text.replace('## Article\n\n', '## Article\n\nNew acquired article.\n\n').replace('status: inbox', 'status: inbox\nid: allocated');
it('allows clean article/feed creates through ordinary native folder-create events', async () => {
  const f = nativeStore({}), repo = new ReaderRepository(f.store, DEFAULT_SETTINGS);
  const article = await repo.createArticle({ title: 'Folder event', url: 'https://example.com/folder-event', body: 'Saved text.' });
  const feed = await repo.createFeed('Folder event feed', 'https://example.com/folder-event.xml');
  expect(f.disk.get(article.path)).toContain('Saved text.');
  expect(f.disk.get(feed.path)).toContain('type: feed');
  expect(f.vault.createFolder).toHaveBeenCalledWith('Reading/Inbox');
  expect(f.vault.createFolder).toHaveBeenCalledWith('Reading/Wires');
  expect(f.events.some(event => event.kind === 'create' && event.path === article.path)).toBe(true);
  expect(f.events.some(event => event.kind === 'create' && event.path === feed.path)).toBe(true);
});
it('fences Markdown revisions but ignores ordinary folder creation, then releases observers', () => {
  const f = nativeStore({ [path]: raw }), start = f.store.revision();
  f.emit('create', { path: 'Reading/Articles' }); expect(f.store.revision(path)).toBe(start);
  f.emit('modify', { path: 'Reading/Articles/Other.md' }); expect(f.store.revision(path)).toBe(start + 1);
  f.emit('create', { path: 'Reading/Metadata/new.json' }); expect(f.store.revision(path)).toBe(start + 1);
  f.emit('editor-change'); expect(f.store.revision(path)).toBe(start + 2);
  f.store.dispose(); f.emit('modify', { path: 'Reading/Articles/Other.md' }); f.emit('create', { path: 'Reading/Metadata/new.json' });
  f.emit('editor-change'); expect(f.store.revision(path)).toBe(start + 2);
});
it('reads durable bytes, but atomically updates the latest buffer and preserves backward selection, custom sections, and leaf', async () => {
  const f = nativeStore({ [path]: raw }), { editor, leaf } = f.open(path, raw.replace('Existing comments.', 'UNSAVED Existing comments.'));
  const start = editor.value.indexOf('Existing'), end = start + 'Existing comments.'.length; editor.anchor = end; editor.head = start;
  const update = vi.fn(replace); expect(await f.store.read(path)).toBe(raw); await f.store.process(path, update);
  expect(update).toHaveBeenCalledExactlyOnceWith(raw.replace('Existing comments.', 'UNSAVED Existing comments.'));
  expect(editor.value).toBe(f.disk.get(path)); expect(editor.value).toContain('UNSAVED Existing comments.'); expect(editor.value).toContain('## Custom\n\nKeep custom exactly.');
  expect(editor.value.slice(editor.head, editor.anchor)).toBe('Existing comments.'); expect(editor.anchor).toBeGreaterThan(editor.head); expect(editor.setValue).not.toHaveBeenCalled(); expect(editor.reloads).toBe(0);
  expect(f.vault.process).not.toHaveBeenCalled(); expect(f.workspace.activeLeaf).toBe(leaf); expect(f.workspace.setActiveLeaf).not.toHaveBeenCalled(); expect(f.workspace.revealLeaf).not.toHaveBeenCalled();
});
it('caret stays in Comments when another section is appended at the exact EOF caret', async () => {
  const value = '## Comments\n\nUser prefix', f = nativeStore({ [path]: value }), { editor } = f.open(path); editor.caretAfter('User prefix');
  await f.store.process(path, text => text + '\n\n## Highlights\n\n> A quote\n'); editor.type(' CONTINUED');
  expect(editor.value).toContain('User prefix CONTINUED\n\n## Highlights'); expect(editor.value.slice(0, editor.head).endsWith('CONTINUED')).toBe(true);
});
for (const divergent of [false, true]) it(`defers multiple editable views before evaluating or mutating the update (divergent=${divergent})`, async () => {
  const f = nativeStore({ [path]: raw }), first = f.open(path), second = f.open(path, divergent ? raw + 'Different unsaved text' : raw), update = vi.fn(replace);
  await expect(f.store.process(path, update)).rejects.toBeInstanceOf(EditorWriteDeferredError); expect(update).not.toHaveBeenCalled();
  expect(f.disk.get(path)).toBe(raw); expect(first.editor.value).toBe(raw); expect(second.editor.value).toBe(divergent ? raw + 'Different unsaved text' : raw); expect(f.events).toEqual([]); expect(first.view.save).not.toHaveBeenCalled(); expect(second.view.save).not.toHaveBeenCalled();
});
it('unchanged buffer-only state is not a durable acknowledgement and is not forcibly saved', async () => {
  const f = nativeStore({ [path]: raw }), { editor, view } = f.open(path, raw + 'UNPERSISTED pending journal');
  await expect(f.store.process(path, text => text)).rejects.toBeInstanceOf(EditorWriteDeferredError); expect(await f.store.read(path)).toBe(raw);
  expect(editor.value).toContain('UNPERSISTED'); expect(editor.transaction).not.toHaveBeenCalled(); expect(view.save).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
});
it('throws preserve typed stale identity and never apply IDs, formatting, or save requests', async () => {
  const f = nativeStore({ [path]: raw }), { editor, view } = f.open(path, raw + 'UNSAVED'), stale = new StaleArticleWriteError();
  await expect(f.store.process(path, () => { throw stale; })).rejects.toBe(stale); expect(editor.value).toBe(raw + 'UNSAVED'); expect(f.disk.get(path)).toBe(raw); expect(editor.transaction).not.toHaveBeenCalled(); expect(view.save).not.toHaveBeenCalled();
});
it('already-inflight native save early-return cannot acknowledge the queued new version', async () => {
  const f = nativeStore({ [path]: raw }), { view, editor } = f.open(path), old = gate(), fresh = gate();
  view.gateSave = (_text, index) => index === 1 ? old.promise : fresh.promise;
  const previousSave = view.save(); editor.caretAfter('Existing comments.'); editor.type(' PREFIX');
  let done = false; const operation = f.store.process(path, replace).then(() => { done = true; });
  await vi.waitFor(() => expect(editor.transaction).toHaveBeenCalledTimes(1)); await new Promise(resolve => setTimeout(resolve, 50));
  expect(done).toBe(false); expect(f.disk.get(path)).toBe(raw); expect(editor.value).toContain(' PREFIX');
  editor.type(' LATER'); void view.save(); old.release(); await previousSave;
  await vi.waitFor(() => expect(view.started.length).toBeGreaterThanOrEqual(2)); expect(done).toBe(false); expect(f.disk.get(path)).not.toContain('New acquired article.');
  fresh.release(); await operation; await vi.waitFor(() => expect(f.disk.get(path)).toContain('PREFIX LATER'));
  expect(editor.value).toContain('PREFIX LATER'); expect(editor.value.slice(0, editor.head).endsWith('PREFIX LATER')).toBe(true); expect(editor.reloads).toBe(0); expect(f.vault.process).not.toHaveBeenCalled();
});
it('bounded unverifiable save defers rather than acknowledging; a late native save is never replayed over newer typing', async () => {
  vi.useFakeTimers(); const f = nativeStore({ [path]: raw }), { view, editor } = f.open(path), held = gate(); view.gateSave = () => held.promise;
  try {
    const operation = f.store.process(path, replace); const rejected = expect(operation).rejects.toBeInstanceOf(EditorWriteDeferredError);
    await vi.advanceTimersByTimeAsync(3100); await rejected; expect(f.disk.get(path)).toBe(raw);
    editor.caretAfter('Existing comments.'); editor.type(' LATEST'); held.release(); await vi.advanceTimersByTimeAsync(0);
    expect(editor.value).toContain('LATEST'); expect(editor.reloads).toBe(0); expect(editor.setValue).not.toHaveBeenCalled(); expect(f.vault.process).not.toHaveBeenCalled();
  } finally { held.release(); vi.useRealTimers(); }
});
it('patches reconstruct repeated lines, Unicode, and mixed insert/delete documents using original offsets', () => {
  let seed = 71; const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; }, parts = ['field: value\n', '---\n', '## Comments\n', 'hello📝読書%\n', '\n'];
  for (let sample = 0; sample < 200; sample++) {
    const before = Array.from({ length: 16 }, () => parts[random() % parts.length]).join(''); let after = before;
    for (let change = 0; change < 5; change++) { const at = random() % (after.length + 1); after = after.slice(0, at) + parts[random() % parts.length] + after.slice(Math.min(after.length, at + random() % 12)); }
    let result = before; const edits = editorEdits(before, after); for (const edit of [...edits].reverse()) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to); expect(result).toBe(after);
  }
});
it('patience changes reconstruct results without replacing unchanged custom sections', () => {
  const next = replace(raw), edits = editorEdits(raw, next), custom = raw.indexOf('## Custom'); let applied = raw;
  for (const edit of [...edits].reverse()) applied = applied.slice(0, edit.from) + edit.text + applied.slice(edit.to);
  expect(applied).toBe(next); expect(edits.every(edit => edit.to < custom)).toBe(true);
});

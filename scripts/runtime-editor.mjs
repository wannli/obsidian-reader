import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertRuntimeVault } from './cdp.mjs';
import { vaultPath } from './sandbox.mjs';

export function commentsSuffix(text) {
  const heading = /^## Comments[ \t]*\r?\n/m.exec(text);
  assert.ok(heading, 'The no-flag native template must retain its Comments heading');
  return text.slice(heading.index);
}

export async function sourceEditorSnapshot(page, path) {
  await assertRuntimeVault(page);
  return page.evaluate(({ vaultPath, path }) => {
    const app = window.app, leaf = app.workspace.activeLeaf, view = leaf?.view;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before native editor observation');
    if (view?.getViewType() !== 'markdown' || view.file?.path !== path || !view.editor || view.getState().mode !== 'source') {
      throw new Error('Explicit Open Markdown editing bypass was lost; refusing to type elsewhere');
    }
    const editor = view.editor, cursor = editor.getCursor();
    return { at: Date.now(), leafId: leaf.id, path, state: view.getState(), text: editor.getValue(), cursor,
      cursorOffset: editor.posToOffset(cursor), focused: editor.hasFocus() };
  }, { vaultPath, path });
}

// Actual native keystrokes, with a buffer/cursor check after EVERY character.
// A start/end timestamp alone cannot prove acquisition overlapped safe typing.
export async function typeCommentsWithTrace(page, path, text, { delayMs = 18, progress } = {}) {
  const initial = await sourceEditorSnapshot(page, path), original = commentsSuffix(initial.text);
  assert.equal(initial.cursorOffset, initial.text.length, 'QA typing must start at the existing Comments tail');
  const trace = { startedAt: Date.now(), leafId: initial.leafId, keystrokes: [] };
  let typed = '';
  for (const character of text) {
    const before = await sourceEditorSnapshot(page, path);
    assert.equal(before.leafId, initial.leafId, 'Worker changed the native editor leaf');
    assert.equal(commentsSuffix(before.text), original + typed, 'A worker write lost or moved already-typed Comments');
    assert.equal(before.cursorOffset, before.text.length, 'Worker moved the cursor away from the Comments tail');
    assert.ok(before.focused, 'Native editor lost keyboard focus');
    await page.keyboard.type(character); typed += character;
    const after = await sourceEditorSnapshot(page, path);
    assert.equal(commentsSuffix(after.text), original + typed, 'A native keystroke was lost or landed outside Comments');
    assert.equal(after.cursorOffset, after.text.length, 'Native cursor no longer follows the typed Comments');
    trace.keystrokes.push({ beforeAt: before.at, afterAt: after.at, typedLength: typed.length, cursor: after.cursor, bufferLength: after.text.length });
    progress?.({ typed, snapshot: after });
    await delay(delayMs);
  }
  return { ...trace, finishedAt: Date.now(), text: typed, expectedComments: original + typed };
}

export function requireInterleavedCommit({ writes, trace, originalComments, typed, releasedAt, quote, path, leafId }) {
  const commit = writes.find(event => event.at >= releasedAt && event.diskText?.includes(quote)
    && trace.keystrokes.some(key => key.afterAt < event.at)
    && trace.keystrokes.some(key => key.beforeAt > event.readAt)
    && event.buffer && commentsSuffix(event.buffer).length > originalComments.length
    && commentsSuffix(event.buffer).length < originalComments.length + typed.length);
  assert.ok(commit, 'No durable worker insertion was proven between native keystrokes; start/end timing alone is insufficient');
  assert.equal(commit.viewType, 'markdown'); assert.equal(commit.editorPath, path); assert.equal(commit.leafId, leafId);
  assert.ok(commentsSuffix(commit.buffer).startsWith(originalComments), 'Original Comments changed at the observed commit');
  const partial = commentsSuffix(commit.buffer).slice(originalComments.length);
  assert.ok(typed.startsWith(partial), 'Partial native typing was already corrupted at commit');
  return commit;
}

export async function observeNativeWrites(page, path) {
  await assertRuntimeVault(page);
  const key = 'reader-qa-editor-' + randomUUID();
  await page.evaluate(({ vaultPath, path, key }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before installing read-only QA observer');
    const state = { events: [], reads: [] };
    state.ref = app.vault.on('modify', file => {
      if (file.path !== path) return;
      const leaf = app.workspace.activeLeaf, view = leaf?.view;
      const event = { at: Date.now(), leafId: leaf?.id, viewType: view?.getViewType(), editorPath: view?.file?.path,
        buffer: view?.editor?.getValue(), cursor: view?.editor?.getCursor() };
      state.events.push(event);
      state.reads.push(app.vault.read(file).then(text => { event.diskText = text; event.readAt = Date.now(); }, error => { event.readError = String(error); }));
    });
    window[Symbol.for(key)] = state;
  }, { vaultPath, path, key });
  return { async finish() {
    await assertRuntimeVault(page);
    return page.evaluate(async ({ vaultPath, key }) => {
      const app = window.app, state = window[Symbol.for(key)];
      if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before removing QA observer');
      if (!state) return [];
      app.vault.offref(state.ref); delete window[Symbol.for(key)];
      await Promise.all(state.reads); return state.events;
    }, { vaultPath, key });
  } };
}

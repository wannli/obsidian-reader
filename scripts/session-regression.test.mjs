import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSession } from './runtime-session.mjs';
import { vaultPath } from './sandbox.mjs';

function nativeHost(t, dirtySecond = false) {
  const previous = { window: globalThis.window, document: globalThis.document };
  t.after(() => { globalThis.window = previous.window; globalThis.document = previous.document; });
  const leaves = ['first', 'second'].map((id, index) => {
    const file = { path: `${id}.md` }, text = index && dirtySecond ? 'Unsaved native typing' : file.path;
    const state = { type: 'markdown', state: { file: file.path, mode: 'source' } };
    return { id, getViewState: () => state, getEphemeralState: () => ({}), view: {
      file, getViewType: () => 'markdown', editor: { getValue: () => text, listSelections: () => [],
        getScrollInfo: () => ({ left: 0, top: 0 }), hasFocus: () => false },
    } };
  });
  // Actual Obsidian traversal short-circuits on a truthy callback result.
  const workspace = { activeLeaf: leaves[1], iterateAllLeaves: callback => {
    for (const leaf of leaves) if (callback(leaf)) break;
  } };
  globalThis.window = { app: { workspace, plugins: { plugins: {} },
    vault: { adapter: { getBasePath: () => vaultPath }, read: async file => file.path } } };
  globalThis.document = { querySelectorAll: () => [], getSelection: () => null };
  return { evaluate: async (callback, argument) => callback(argument) };
}

test('session capture visits every native editor when the host short-circuits truthy callbacks', async t => {
  const session = await captureSession(nativeHost(t));
  assert.deepEqual(session.leafIds, ['first', 'second']);
  assert.deepEqual(session.editors.map(editor => editor.file), ['first.md', 'second.md']);
  assert.equal(session.activeLeafId, 'second');
});

test('an unsaved second native editor blocks refresh without saving or replacing its buffer', async t => {
  await assert.rejects(captureSession(nativeHost(t, true)), /unsaved\/changing input: second\.md/);
});

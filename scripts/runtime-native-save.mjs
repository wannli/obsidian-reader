import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertRuntimeVault } from './cdp.mjs';
import { vaultPath } from './sandbox.mjs';

// Observe real public save() calls without replacing their work or returned
// promises. Start one real save inside the native editor-change notification so
// the adapter's following save encounters the host's already-saving branch.
export async function observeNativeSaveCoalescing(page, path, marker) {
  await assertRuntimeVault(page);
  const key = 'reader-native-save-' + randomUUID();
  await page.evaluate(({ vaultPath, path, marker, key }) => {
    const app = window.app, view = app.workspace.activeLeaf?.view;
    if (app.vault.adapter.getBasePath() !== vaultPath || view?.getViewType() !== 'markdown' || view.file?.path !== path) throw new Error('Wrong native save probe target');
    const original = view.save, own = Object.getOwnPropertyDescriptor(view, 'save');
    if (typeof original !== 'function') throw new Error('Public MarkdownView.save is unavailable');
    const state = { calls: [], pending: [], errors: [], kicked: false, explicit: false, restored: false };
    const wrapped = function (...args) {
      const call = { id: state.calls.length, at: performance.now(), wallAt: Date.now(), explicitProbe: state.explicit,
        stack: new Error().stack, pendingAtStart: state.calls.filter(call => call.finishedAt === undefined).map(call => call.id) };
      state.calls.push(call);
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { call.finishedAt = performance.now(); call.error = String(error); throw error; }
      state.pending.push(Promise.resolve(result).then(() => { call.finishedAt = performance.now(); }, error => { call.finishedAt = performance.now(); call.error = String(error); }));
      return result;
    };
    Object.defineProperty(view, 'save', { value: wrapped, configurable: true, writable: true });
    state.ref = app.workspace.on('editor-change', (editor, changedView) => {
      if (state.kicked || changedView !== view || !editor.getValue().includes(marker)) return;
      state.kicked = true; state.patchAt = performance.now(); state.bufferAtKick = editor.getValue();
      state.explicit = true;
      try { void Promise.resolve(view.save()).catch(error => state.errors.push(String(error))); }
      catch (error) { state.errors.push(String(error)); }
      finally { state.explicit = false; }
    });
    state.restore = () => {
      app.workspace.offref(state.ref);
      if (view.save !== wrapped) throw new Error('Native save observer changed unexpectedly; refusing to overwrite it');
      if (own) Object.defineProperty(view, 'save', own); else delete view.save;
      state.restored = true;
    };
    window[Symbol.for(key)] = state;
  }, { vaultPath, path, marker, key });
  return { async finish() {
    await assertRuntimeVault(page);
    return page.evaluate(async ({ vaultPath, key }) => {
      if (window.app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before save observer cleanup');
      const state = window[Symbol.for(key)]; if (!state) throw new Error('Save observer missing');
      try { let length; do { length = state.pending.length; await Promise.all(state.pending); } while (length !== state.pending.length); }
      finally { state.restore(); delete window[Symbol.for(key)]; }
      return { calls: state.calls, kicked: state.kicked, patchAt: state.patchAt, bufferAtKick: state.bufferAtKick, errors: state.errors,
        restored: state.restored, scope: 'Original public save and promises retained; one additional real save, no mocked disk, save flags, transaction or controller callback' };
    }, { vaultPath, key });
  } };
}
export function requireNativeSaveEarlyReturn(proof) {
  assert.equal(proof.kicked, true, 'No native editor-change save was started');
  assert.deepEqual(proof.errors, []); assert.equal(proof.restored, true);
  const first = proof.calls.find(call => call.explicitProbe);
  const early = proof.calls.find(call => !call.explicitProbe && /processEditor/.test(call.stack ?? '')
    && call.pendingAtStart.includes(first?.id) && call.finishedAt < first.finishedAt);
  assert.ok(early, 'No actual adapter save early-returned while the native save remained pending');
  assert.ok(!first.error && !early.error); return { nativeSave: first.id, adapterEarlyReturn: early.id, verifiedByOriginalPromiseSettlement: true };
}

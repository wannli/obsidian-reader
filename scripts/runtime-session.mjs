import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { inside, pluginId, pluginPath, regularFile, vaultPath } from './sandbox.mjs';

export async function captureSession(page) {
  await assertRuntimeVault(page);
  return page.evaluate(async ({ pluginId, vaultPath }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before session capture');
    const overlay = [...document.querySelectorAll('.modal-container, .menu')].some(element => element.getClientRects().length);
    if (overlay) throw new Error('Close the current native dialog/menu before refreshing; its unfinished input will not be discarded');
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode?.parentElement?.closest('.r2-article-body')) throw new Error('Finish the current Reader selection before refreshing');
    const leaves = []; app.workspace.iterateAllLeaves(leaf => { leaves.push(leaf); });
    const reader = [], editors = [];
    for (const leaf of leaves) {
      const view = leaf.view, state = leaf.getViewState(), ephemeral = leaf.getEphemeralState();
      if (view.getViewType() === 'reader') {
        // Compatibility read for the historical build, which did not serialize
        // file/queue. New Reader views expose these through public getState().
        const file = state.state?.file ?? view.reader?.active;
        if (typeof file !== 'string' || !app.vault.getFileByPath(file)) throw new Error('Cannot safely recover this Reader leaf’s current article');
        const owner = app.plugins.plugins[pluginId] ?? view.plugin;
        const article = await owner.controller.repository.getArticle(file);
        const scrollTop = view.containerEl.querySelector('.r2-reader-scroll')?.scrollTop;
        reader.push({ id: leaf.id, state: { ...state.state, file, queue: state.state?.queue ?? article.status,
          scrollTop: state.state?.scrollTop ?? scrollTop ?? 0 }, ephemeral });
      } else if (view.getViewType() === 'markdown' && state.state?.mode === 'source' && view.file && view.editor) {
        const text = view.editor.getValue(), disk = await app.vault.read(view.file);
        if (text !== disk || view.editor.getValue() !== text) throw new Error(`Native editor has unsaved/changing input: ${view.file.path}; refresh postponed without saving or replacing it`);
        editors.push({ id: leaf.id, file: view.file.path, state, ephemeral, text,
          selections: view.editor.listSelections(), scroll: view.editor.getScrollInfo(), focused: view.editor.hasFocus() });
      }
    }
    const plugin = app.plugins.plugins[pluginId];
    return { activeLeafId: app.workspace.activeLeaf?.id, activeViewState: app.workspace.activeLeaf?.getViewState(), leafIds: leaves.map(leaf => leaf.id).sort(), reader, editors,
      settings: structuredClone(plugin?.settings ?? {}), loadedBuildId: plugin?.constructor.__readerBuildId };
  }, { pluginId, vaultPath });
}

export async function restoreSession(page, session) {
  await assertNoSafetyHold('restore Reader views/session');
  await assertRuntimeVault(page);
  await page.evaluate(async ({ pluginId, vaultPath, session }) => {
    const app = window.app, plugin = app.plugins.plugins[pluginId];
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before session restoration');
    const leaves = new Map(); app.workspace.iterateAllLeaves(leaf => { leaves.set(leaf.id, leaf); });
    for (const saved of session.reader) {
      const leaf = leaves.get(saved.id); if (!leaf) throw new Error('Reader reload removed a leaf; refusing to create a replacement');
      await leaf.setViewState({ type: 'reader', state: saved.state }, saved.ephemeral);
    }
    for (const saved of session.editors) {
      const leaf = leaves.get(saved.id); if (!leaf) throw new Error('Reader reload removed a native editor leaf');
      if (leaf.view.getViewType() !== 'markdown' || leaf.view.file?.path !== saved.file) {
        if (typeof plugin.openMarkdown !== 'function') throw new Error('The new plugin cannot preserve the explicit Markdown editor visit');
        await plugin.openMarkdown(leaf, saved.file);
        await leaf.setViewState(saved.state, saved.ephemeral);
      }
      const editor = leaf.view.editor;
      if (!editor || editor.getValue() !== saved.text) throw new Error('Native editor contents changed; no buffer overwrite attempted');
      editor.setSelections(saved.selections); editor.scrollTo(saved.scroll.left, saved.scroll.top);
    }
    const active = leaves.get(session.activeLeafId);
    if (active && app.workspace.activeLeaf !== active) app.workspace.setActiveLeaf(active, { focus: false });
    const focused = session.editors.find(editor => editor.id === session.activeLeafId && editor.focused);
    if (focused) active.view.editor.focus();
  }, { pluginId, vaultPath, session });
  const after = await captureSession(page);
  assert.equal(after.activeLeafId, session.activeLeafId, 'Active leaf changed during Reader-only refresh');
  assert.deepEqual(after.leafIds, session.leafIds, 'The refresh added or removed workspace leaves');
  for (const [key, value] of Object.entries(session.settings)) assert.deepEqual(after.settings[key], value, `Reader setting changed: ${key}`);
  for (const prior of session.reader) {
    const current = after.reader.find(leaf => leaf.id === prior.id);
    assert.equal(current?.state.file, prior.state.file, 'Current article was not restored in its original leaf');
    assert.equal(current?.state.queue, prior.state.queue, 'Current reading queue changed');
  }
  for (const prior of session.editors) assert.equal(after.editors.find(editor => editor.id === prior.id)?.text, prior.text);
  return { activeLeafId: after.activeLeafId, reader: after.reader, editors: after.editors.map(({ text, ...editor }) => ({ ...editor, sha256: sha256(text) })),
    settingsPreserved: true, nativeEditorBuffersPreserved: true, leafIds: after.leafIds };
}

export async function snapshotNotesAndSettings(page) {
  await assertRuntimeVault(page);
  const paths = await page.evaluate(() => window.app.vault.getMarkdownFiles().map(file => file.path).sort());
  const files = {};
  for (const path of paths) {
    const full = inside(vaultPath, join(vaultPath, path));
    files[path] = { sha256: sha256(await regularFile(full)), mtimeMs: (await lstat(full)).mtimeMs };
  }
  return { files, readerSettingsSha256: sha256(await regularFile(join(pluginPath, 'data.json'))) };
}

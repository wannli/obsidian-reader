import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { assertRuntimeVault } from './cdp.mjs';
import { integrationPath, quickaddPath } from './quickadd-pin.mjs';
import { createOnly, pluginFiles, pluginPath, regularFile, repository, vaultPath } from './sandbox.mjs';

// Native-only QA must never run alongside a current or legacy Reader.
export async function assertIsolatedReaderAbsent(page) {
  await assertRuntimeVault(page);
  await page.evaluate(vaultPath => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed during Reader-absent inspection');
    if (['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) {
      throw new Error('Reader must remain unloaded and disabled for isolated QuickAdd verification');
    }
  }, vaultPath);
}

export async function bundleSnapshot() {
  const files = {};
  for (const name of pluginFiles) {
    files['installed/' + name] = sha256(await regularFile(join(pluginPath, name)));
    files['dist/' + name] = sha256(await regularFile(join(repository, 'dist', name)));
  }
  const metadata = await regularFile(join(repository, 'dist', 'build-meta.json'));
  return { files, distMetadataSha256: sha256(metadata), distBuildId: JSON.parse(metadata).buildId };
}
export async function unloadReaderForIsolation(page) {
  await assertRuntimeVault(page);
  return page.evaluate(async vaultPath => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before isolated Reader unload');
    if (['pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) {
      throw new Error('Legacy Reader is present; refuse isolation without unloading or modifying it');
    }
    const plugin = app.plugins.plugins['obsidian-reader'];
    const before = { loaded: Boolean(plugin), buildId: plugin?.constructor.__readerBuildId,
      useDummyContent: plugin?.settings.useDummyContent, persistedEnabled: app.plugins.enabledPlugins.has('obsidian-reader') };
    if (plugin) await app.plugins.disablePlugin('obsidian-reader');
    await app[Symbol.for('reader.shutdown')];
    if (['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id])) throw new Error('Reader did not unload or a legacy Reader appeared');
    return before;
  }, vaultPath);
}

export async function prepareIsolatedChoices(page, tag, evidence) {
  const choices = JSON.parse(await regularFile(join(integrationPath, 'choices.json')));
  await assertRuntimeVault(page);
  const originals = await page.evaluate(({ vaultPath, ids }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath || ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Unsafe native-choice inspection state');
    return ids.map(id => {
      const choice = app.plugins.plugins.quickadd.settings.choices.find(choice => choice.id === id);
      if (!choice || choice.type !== 'Template') throw new Error('Delivered native Template choice is missing');
      return structuredClone(choice);
    });
  }, { vaultPath, ids: choices.map(choice => choice.id) });
  await createOnly(join(evidence, 'quickadd-config-before.json'), await regularFile(join(quickaddPath, 'data.json')));
  await createOnly(join(evidence, 'choices-before.json'), JSON.stringify(originals, null, 2) + '\n');
  const folder = `Templates/Reader Native QA ${tag}`, templates = [];
  for (const name of ['Article.md', 'Article-quick.md']) {
    const bytes = await regularFile(join(integrationPath, name));
    assert.ok(!bytes.toString().includes('{{CURSOR}}'), 'The confirmed assets must not force the superseded capture cursor behavior');
    await createOnly(join(evidence, name + '.txt'), bytes);
    templates.push({ path: `${folder}/${name}`, text: bytes.toString(), sha256: sha256(bytes) });
  }
  const temporary = choices.map((choice, index) => ({ ...structuredClone(originals[index]), ...choice,
    templatePath: `${folder}/${choice.templatePath.split('/').at(-1)}` }));
  const plan = { folder, originals, temporary, templates, scope: 'Native delivered choices, with only template paths redirected to byte-identical temporary copies; canonical templates preserved' };
  try {
  await assertRuntimeVault(page);
  await page.evaluate(async ({ vaultPath, folder, templates, temporary }) => {
    const app = window.app, plugin = app.plugins.plugins.quickadd;
    if (app.vault.adapter.getBasePath() !== vaultPath || ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Unsafe isolation state');
    if (app.vault.getAbstractFileByPath(folder)) throw new Error('Refusing existing QA template folder');
    await app.vault.createFolder(folder);
    for (const file of templates) await app.vault.create(file.path, file.text);
    for (const choice of temporary) Object.assign(plugin.settings.choices.find(item => item.id === choice.id), choice);
    await plugin.saveSettings();
  }, { vaultPath, folder, templates, temporary });
  for (const template of templates) assert.equal(sha256(await regularFile(join(vaultPath, template.path))), template.sha256);
  return plan;
  } catch (error) { error.isolation = plan; throw error; }
}

export async function restoreIsolatedChoices(page, isolation) {
  await assertRuntimeVault(page);
  await page.evaluate(async ({ vaultPath, originals, temporary }) => {
    const app = window.app, plugin = app.plugins.plugins.quickadd;
    if (app.vault.adapter.getBasePath() !== vaultPath || ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Unsafe isolated-choice cleanup state');
    for (let i = 0; i < originals.length; i++) {
      const current = plugin.settings.choices.find(choice => choice.id === originals[i].id);
      if (JSON.stringify(current) !== JSON.stringify(temporary[i]) && JSON.stringify(current) !== JSON.stringify(originals[i])) throw new Error('QA choice changed unexpectedly; preserving it for inspection');
    }
    for (const original of originals) {
      const current = plugin.settings.choices.find(choice => choice.id === original.id);
      for (const key of Object.keys(current)) delete current[key]; Object.assign(current, original);
    }
    await plugin.saveSettings();
  }, { vaultPath, originals: isolation.originals, temporary: isolation.temporary });
  // Remove only this run's unchanged template copies, never canonical templates,
  // captured notes, user additions, or nonempty folders.
  await page.evaluate(async ({ vaultPath, folder, templates }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath || ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Unsafe QA-template cleanup state');
    for (const expected of templates) {
      const file = app.vault.getAbstractFileByPath(expected.path);
      if (file && await app.vault.read(file) !== expected.text) throw new Error('QA template changed; preserving it');
    }
    for (const expected of templates) {
      const file = app.vault.getAbstractFileByPath(expected.path); if (file) await app.vault.delete(file, true);
    }
    const parent = app.vault.getAbstractFileByPath(folder);
    if (parent?.children?.length === 0) await app.vault.delete(parent, true);
  }, { vaultPath, folder: isolation.folder, templates: isolation.templates });
  return { choicesRestored: true, temporaryTemplatesRemoved: true, readerLeftUnloaded: true };
}

export async function restoreIsolatedWorkspace(page, before, createdPaths) {
  await assertRuntimeVault(page);
  return page.evaluate(async ({ vaultPath, before, createdPaths }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath || ['obsidian-reader', 'pullman', 'obsidian-reader2'].some(id => app.plugins.plugins[id] || app.plugins.enabledPlugins.has(id))) throw new Error('Unsafe native workspace cleanup state');
    const leaves = []; app.workspace.iterateAllLeaves(leaf => { leaves.push(leaf); });
    for (const saved of before.editors) {
      const leaf = leaves.find(leaf => leaf.id === saved.id), view = leaf?.view;
      if (view?.getViewType() !== 'markdown' || view.file?.path !== saved.file || view.editor?.getValue() !== saved.text) {
        throw new Error('An existing native editor changed; preserving it instead of overwriting/restoring a stale buffer');
      }
      view.editor.setSelections(saved.selections); view.editor.scrollTo(saved.scroll.left, saved.scroll.top);
    }
    let closed = 0;
    for (const leaf of leaves) {
      if (before.leafIds.includes(leaf.id) || leaf.view.getViewType() !== 'markdown' || !createdPaths.includes(leaf.view.file?.path)) continue;
      if (leaf.view.getState().mode === 'source' && leaf.view.editor.getValue() !== await app.vault.read(leaf.view.file)) throw new Error('QA tab contains unsaved input; leaving it open');
      leaf.detach(); closed++;
    }
    const active = leaves.find(leaf => leaf.id === before.activeLeafId);
    if (active && before.activeViewState?.type === 'empty' && createdPaths.includes(active.view.file?.path)) {
      if (active.view.getState().mode === 'source' && active.view.editor.getValue() !== await app.vault.read(active.view.file)) throw new Error('Reused empty tab contains unsaved input; preserving it');
      await active.setViewState(before.activeViewState);
    }
    if (active) app.workspace.setActiveLeaf(active, { focus: false });
    return { closedOnlyCreatedCaptureTabs: closed, activeLeafId: app.workspace.activeLeaf?.id, nativeEditorBuffersPreserved: true };
  }, { vaultPath, before, createdPaths });
}

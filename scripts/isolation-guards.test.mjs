import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, snapshot } from './tooling-fixture.mjs';

async function isolatedFixture(t) {
  const f = await fixture(t), source = fileURLToPath(new URL('.', import.meta.url));
  for (const name of await readdir(source)) {
    if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) await cp(join(source, name), join(f.root, 'scripts', name));
  }
  await f.enableBuild();
  await cp(join(source, '../integrations/quickadd'), join(f.root, 'integrations/quickadd'), { recursive: true });
  const load = name => import(pathToFileURL(join(f.root, 'scripts', name)).href);
  const helpers = await load('quickadd-isolation.mjs'), ui = await load('quickadd-ui.mjs'), safe = await load('sandbox.mjs');
  const evidence = join(f.root, 'evidence'); await mkdir(evidence);
  const events = [];
  const mutate = name => async () => { events.push(name); };
  const app = {
    vault: { adapter: { getBasePath: () => f.vault }, getMarkdownFiles: () => [],
      getAbstractFileByPath: path => ({ path }), read: async () => 'unchanged',
      createFolder: mutate('createFolder'), create: mutate('create'), delete: mutate('delete') },
    plugins: { plugins: { quickadd: { settings: { choices: [] }, saveSettings: mutate('saveSettings') } },
      enabledPlugins: new Set(), disablePlugin: mutate('disablePlugin') },
    workspace: { getLeavesOfType: () => [], iterateAllLeaves: () => { events.push('workspace access'); },
      setActiveLeaf: mutate('setActiveLeaf') },
    commands: { commands: { 'quickadd:choice:reader-article-template': {} }, executeCommandById: mutate('command') },
  };
  const page = {
    evaluate: async (fn, arg) => new Function('window', 'arg', `return (${fn.toString()})(arg)` )({ app }, arg),
    locator() { throw new Error('UI touched despite Reader guard'); },
  };
  const isolation = { originals: [], temporary: [], folder: 'Templates/QA', templates: [{ path: 'Templates/QA/test.md', text: 'unchanged' }] };
  return { ...f, helpers, ui, safe, app, page, events, evidence, isolation };
}

for (const id of ['obsidian-reader', 'pullman', 'obsidian-reader2']) {
  for (const state of ['loaded', 'enabled']) {
    test(`isolated QA rejects ${state} ${id} before writes, commands or restoration`, async t => {
      const f = await isolatedFixture(t);
      if (state === 'loaded') f.app.plugins.plugins[id] = {};
      else f.app.plugins.enabledPlugins.add(id);
      const before = await snapshot(f.evidence);
      const calls = [
        () => f.helpers.assertIsolatedReaderAbsent(f.page),
        () => f.helpers.prepareIsolatedChoices(f.page, 'fixture', f.evidence),
        () => f.helpers.restoreIsolatedChoices(f.page, f.isolation),
        () => f.helpers.restoreIsolatedWorkspace(f.page, {}, []),
        () => f.ui.quickAddCommand(f.page, { opening: 'native' }),
        () => f.ui.captureFromURI(f.page, { url: 'https://example.invalid/fixture' }, 'Reader article', { opening: 'native' }),
      ];
      for (const call of calls) await assert.rejects(call(), /Reader|Unsafe/);
      assert.deepEqual(f.events, []);
      assert.deepEqual(await snapshot(f.evidence), before);
      assert.equal(await f.safe.statOrNull(f.vault), null);
    });
  }
}

for (const id of ['pullman', 'obsidian-reader2']) {
  test(`isolation never unloads ${id} or Reader when a legacy Reader is present`, async t => {
    const f = await isolatedFixture(t);
    f.app.plugins.plugins[id] = {};
    f.app.plugins.plugins['obsidian-reader'] = {};
    await assert.rejects(f.helpers.unloadReaderForIsolation(f.page), /Legacy Reader is present/);
    assert.deepEqual(f.events, []);
    assert.ok(f.app.plugins.plugins[id]); assert.ok(f.app.plugins.plugins['obsidian-reader']);
  });
  test(`late ${id} appearance blocks template deletion after choice restoration`, async t => {
    const f = await isolatedFixture(t), evaluate = f.page.evaluate;
    f.page.evaluate = async (fn, arg) => {
      const result = await evaluate(fn, arg);
      if (f.events.includes('saveSettings')) f.app.plugins.plugins[id] = {};
      return result;
    };
    await assert.rejects(f.helpers.restoreIsolatedChoices(f.page, f.isolation), /Unsafe QA-template cleanup/);
    assert.deepEqual(f.events, ['saveSettings']);
  });
}

test('Reader-absent guard remains read-only when all three identities are absent', async t => {
  const f = await isolatedFixture(t);
  await f.helpers.assertIsolatedReaderAbsent(f.page);
  assert.deepEqual(f.events, []);
});

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { App } from 'obsidian';
import { readTemplateExclusions, templateExclusionsFromConfig } from '../src/template-exclusions';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { ReaderController } from '../src/controller';
import { DEFAULT_SETTINGS, type HttpGet } from '../src/types';
function native(files: Record<string, string>) {
  const read = vi.fn(async (path: string) => { if (!(path in files)) throw new Error('Unreadable'); return files[path]; });
  return { read, app: { vault: { configDir: '.native-config', adapter: { exists: async (path: string) => path in files, read } } } as unknown as App };
}
describe('configured template safety adapter', () => {
  it('uses optional native configuration only; absent plugins do not add exclusions', async () => {
    const { app, read } = native({}); expect(await readTemplateExclusions(app)).toEqual({ folders: [], files: [] }); expect(read).not.toHaveBeenCalled();
  });
  it('reads delivered Template choices nested through native Multi, ignoring macros/capture formats', async () => {
    const choices = JSON.parse(readFileSync('integrations/quickadd/choices.json', 'utf8'));
    const { app, read } = native({ '.native-config/templates.json': JSON.stringify({ folder: './Templates//Common/' }), '.native-config/plugins/quickadd/data.json': JSON.stringify({ choices: [{ type: 'Multi', choices: [{ type: 'Multi', choices }] }, { type: 'Macro', templatePath: 'Do not guess.md' }, { type: 'Capture', templatePath: 'Also not a Template.md' }] }) });
    expect(await readTemplateExclusions(app)).toEqual({ folders: ['Templates/Common'], files: ['Templates/Reader/Article.md', 'Templates/Reader/Article-quick.md'] }); expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(['', '/', '///', './'])('never turns empty/root folder %j into a whole-vault exclusion', folder => {
    expect(templateExclusionsFromConfig({ folder }, undefined)).toEqual({ folders: [], files: [] });
  });
  it.each([{ folder: '../escape' }, { folder: '/absolute' }, { folder: 42 }, null])('refuses malformed or unsafe core config', core => {
    expect(() => templateExclusionsFromConfig(core, undefined)).toThrow();
  });
  it.each([{ choices: 'broken' }, { choices: [{ type: 'Template' }] }, { choices: [{ type: 'Multi', choices: null }] }])('refuses malformed configured Template/Multi shapes', quick => {
    expect(() => templateExclusionsFromConfig(undefined, quick)).toThrow();
  });
  it('fails closed without logging configuration contents; last successful snapshot remains usable', async () => {
    const files = { '.native-config/templates.json': '{"folder":"Templates"}' }, { app } = native(files); const snapshot = await readTemplateExclusions(app);
    files['.native-config/templates.json'] = '{"private":"DO_NOT_LOG';
    const failure = await readTemplateExclusions(app).catch(error => error as Error); expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain('Reader paused'); expect(String(failure)).not.toContain('DO_NOT_LOG'); expect(snapshot.folders).toEqual(['Templates']);
  });
  it.each([true, false])('literal-URL configured templates stay byte-identical, dummy=%s', async useDummyContent => {
    const text = '---\ntype: article\nstatus: inbox\nurl: https://example.com/literal-template\n---\n## Article\n\n## Comments\n';
    const store = new MemoryStore({ 'Templates/Common/Static.md': text, 'Assets/Native choice.md': text }); const settings = { ...DEFAULT_SETTINGS, useDummyContent };
    const exclusions = templateExclusionsFromConfig({ folder: 'Templates/Common' }, { choices: [{ type: 'Template', templatePath: 'Assets/Native choice.md' }] });
    const repo = new ReaderRepository(store, settings, () => exclusions), get = vi.fn<HttpGet>(), controller = new ReaderController(repo, get, settings);
    const before = store.snapshot(); controller.setActive(true); await new Promise(resolve => setTimeout(resolve, 200)); controller.setOnline(false); controller.setOnline(true); await new Promise(resolve => setTimeout(resolve, 200));
    expect(await repo.listArticles()).toEqual([]); await expect(controller.acquire('Assets/Native choice.md', true)).rejects.toThrow(); await controller.shutdown(); expect(store.snapshot()).toEqual(before); expect(get).not.toHaveBeenCalled();
  });
  it('policy refresh runs before direct/manual acquisition and prevents every write when safety is unknown', async () => {
    const path = 'Reading/Articles/Static.md', text = '---\ntype: article\nurl: https://example.com/static\n---\n'; const store = new MemoryStore({ [path]: text });
    const repo = new ReaderRepository(store, { ...DEFAULT_SETTINGS }), get = vi.fn<HttpGet>(), policy = vi.fn(async () => { throw new Error('Reader paused'); });
    const controller = new ReaderController(repo, get, { ...DEFAULT_SETTINGS }, policy), errors = vi.spyOn(repo, 'setArticleError');
    await expect(controller.acquire(path)).rejects.toThrow('Reader paused'); await expect(controller.fetchFullText(path)).rejects.toThrow('Reader paused'); expect(policy).toHaveBeenCalledTimes(2); expect(await store.read(path)).toBe(text); expect(errors).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); await controller.shutdown();
  });
});

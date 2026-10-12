import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { normalizeFeedSchedule } from '../src/feed-schedule';
import { DEFAULT_SETTINGS } from '../src/types';

it('starts independently without legacy storage preparation or old-plugin checks', async () => {
  const notices: string[] = [];
  const prepareStorage = vi.fn(() => { throw new Error('Legacy discovery must not run'); });
  const saved = { pollMinutes: 15 };
  class Plugin {
    constructor(public app: unknown) {}
    async loadData() { return saved; }
    registerView() { throw new Error('fixture: reached view registration'); }
  }
  class Notice { constructor(message: string) { notices.push(message); } }
  const device = () => ({ enabled: false, reverseButtons: false });
  const dependencies: Record<string, unknown> = {
    obsidian: { Plugin, Notice, FileView: class {}, Platform: { isAndroidApp: false } },
    './types': { DEFAULT_SETTINGS }, './feed-schedule': { normalizeFeedSchedule },
    './eink-device': { normalizeEinkDevice: device, readEinkDevice: device },
    './template-exclusions': { readTemplateExclusions: vi.fn(async () => ({})) },
    './storage/repository': { ReaderRepository: class { prepareStorage = prepareStorage; } },
    './obsidian-store': { ObsidianStore: class {} },
    './controller': { ReaderController: class { message = ''; } },
  };
  const js = ts.transpileModule(readFileSync('src/main.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {}; new Function('require', 'exports', js)((name: string) => dependencies[name] ?? {}, exports);
  const plugin = new exports.default({ vault: {}, workspace: {}, plugins: { plugins: { pullman: {} }, enabledPlugins: new Set(['pullman']) } });
  await expect(plugin.onload()).rejects.toThrow('fixture: reached view registration');
  expect(prepareStorage).not.toHaveBeenCalled();
  expect(notices).toEqual([]);
  expect(plugin.controller.message).toBe('');
  expect(plugin.settings.pollMinutes).toBe(15);
});

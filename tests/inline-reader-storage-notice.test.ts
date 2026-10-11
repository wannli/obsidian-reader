import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../src/types';
const warning = 'Reading/Inbox/Old.md: retained 1 legacy quote block(s)/IDs as inert excerpts to preserve existing backlinks; journal text was not changed.';
function fixture(report: { errors: string[]; warnings?: string[] }) {
  const notices: { message: string; timeout: number }[] = [];
  class Plugin {
    constructor(public app: unknown) {}
    async loadData() { return {}; }
    registerView() { throw new Error('fixture: stop after preparation reporting'); }
  }
  class Notice { constructor(message: string, timeout: number) { notices.push({ message, timeout }); } }
  const device = () => ({ enabled: false, reverseButtons: false });
  const dependencies: Record<string, unknown> = {
    obsidian: { Plugin, Notice, FileView: class {}, Platform: { isAndroidApp: false } },
    './types': { DEFAULT_SETTINGS },
    './eink-device': { normalizeEinkDevice: device, readEinkDevice: device },
    './template-exclusions': { readTemplateExclusions: vi.fn(async () => ({})) },
    './storage/repository': { ReaderRepository: class { async prepareStorage() { return report; } } },
    './obsidian-store': { ObsidianStore: class {} },
    './controller': { ReaderController: class { message = ''; } },
    './settings-migration': { settingsData: async (current: unknown) => ({ data: current as Record<string, unknown>, migrated: false }) },
  };
  const js = ts.transpileModule(readFileSync('src/main.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {}; new Function('require', 'exports', js)((name: string) => dependencies[name] ?? {}, exports);
  return { plugin: new exports.default({ vault: {}, workspace: {} }), notices };
}
it.each([
  { errors: [], warnings: [warning] },
  { errors: ['Another note was preserved after a conflict.'], warnings: [warning] },
])('reports conversion warnings persistently during native startup: %j', async report => {
  const { plugin, notices } = fixture(report);
  await expect(plugin.onload()).rejects.toThrow('fixture: stop after preparation reporting');
  expect(notices).toHaveLength(1); expect(notices[0].timeout).toBe(0);
  expect(notices[0].message).toContain(warning); expect(plugin.controller.message).toBe(notices[0].message);
  for (const error of report.errors) expect(notices[0].message).toContain(error);
});
it.each([{ errors: [], warnings: [] }, { errors: [] }])('does not show an empty preparation notice: %j', async report => {
  const { plugin, notices } = fixture(report);
  await expect(plugin.onload()).rejects.toThrow('fixture: stop after preparation reporting'); expect(notices).toHaveLength(0);
});

import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../src/types';
import * as typedHighlights from '../src/typed-highlights';

function load(path: string, dependencies: Record<string, unknown>) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', output)((name: string) => {
    if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
    return dependencies[name];
  }, exports);
  return exports;
}

it('does not expose retired journal settings controls', () => {
  const names: string[] = [];
  class Setting {
    setName(name: string) { names.push(name); return this; }
    setDesc() { return this; }
    addToggle() { return this; }
    addText() { return this; }
    addDropdown() { return this; }
    addButton() { return this; }
  }
  class PluginSettingTab { containerEl = { empty() {}, createEl() {}, createDiv() { return { empty() {} }; } }; }
  const { ReaderSettingsTab } = load('src/settings.ts', { obsidian: { Setting, PluginSettingTab }, './typed-highlights': typedHighlights });
  const plugin = { settings: DEFAULT_SETTINGS, saveSettings: vi.fn(), controller: {} };
  new ReaderSettingsTab({}, plugin).display();
  expect(names.join(' ')).not.toMatch(/journal|daily/i);
  expect(plugin.saveSettings).not.toHaveBeenCalled();
});

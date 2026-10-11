// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as eink from '../src/eink-device';
import { DEFAULT_SETTINGS } from '../src/types';
import { validReadingPosition as readingPosition } from '../src/reading-position';

// Exercise the native host class without opening an Obsidian vault.
function fixture(android = true, storageFails = false) {
  const notices: string[] = [], stored = new Map<string, string>(), leaves: any[] = [];
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => {
    if (storageFails) throw new Error('Storage denied'); stored.set(key, value);
  } };
  const app = { workspace: { getLeavesOfType: () => leaves, requestSaveLayout: vi.fn() }, vault: { getFileByPath: () => null } };
  class Plugin { app = app; saveData = vi.fn(); }
  class ItemView {
    contentEl = document.createElement('div'); app = app;
    constructor(public leaf: any) {}
    async setState() {}
  }
  const sdk = { Plugin, ItemView, FileView: ItemView, Platform: { isAndroidApp: android, isMobile: android }, Notice: class {
    constructor(message: string) { notices.push(message); }
  } };
  const code = ts.transpileModule(readFileSync('src/main.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output: any = { exports: {} };
  new Function('require', 'module', 'exports', 'window', `${code}\nexports.TestReaderView = ReaderView;`)(
    (name: string) => name === 'obsidian' ? sdk : name === './eink-device' ? eink : name === './reading-position' ? { validReadingPosition: readingPosition } : name === './types' ? { DEFAULT_SETTINGS } : {},
    output, output.exports, { localStorage: storage },
  );
  const plugin = new output.exports.default();
  const leaf: any = { app, updateHeader: vi.fn() };
  const view = new output.exports.TestReaderView(leaf, plugin); leaf.view = view; leaves.push(leaf);
  document.body.append(view.contentEl);
  return { plugin, view, notices, stored };
}

beforeEach(() => { document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

it('native Android opt-in is local only, not saved plugin settings; listeners unsubscribe', () => {
  const { plugin, stored } = fixture(); const changed = vi.fn();
  const before = JSON.stringify(plugin.settings), unsubscribe = plugin.subscribeEink(changed);
  expect(plugin.isEinkEnabled()).toBe(false);
  expect(plugin.setEinkDevice({ enabled: true, reverseButtons: true })).toBe(true);
  expect(plugin.isEinkEnabled()).toBe(true); expect(changed).toHaveBeenCalledTimes(1);
  expect([...stored.values()]).toEqual([JSON.stringify({ enabled: true, reverseButtons: true })]);
  expect(JSON.stringify(plugin.settings)).toBe(before); expect(plugin.saveData).not.toHaveBeenCalled();
  unsubscribe(); plugin.setEinkDevice({ enabled: false, reverseButtons: false });
  expect(changed).toHaveBeenCalledTimes(1);
});

it('non-Android hosts reject opting in, including a previously stored preference', () => {
  const { plugin, stored } = fixture(false);
  plugin.einkDevice = { enabled: true, reverseButtons: true };
  expect(plugin.isEinkEnabled()).toBe(false);
  expect(plugin.setEinkDevice({ enabled: true, reverseButtons: true })).toBe(false);
  expect(stored.size).toBe(0);
});

it('denied device storage is visibly session-only and never falls back to synced data', () => {
  const { plugin, notices } = fixture(true, true);
  expect(plugin.setEinkDevice({ enabled: true, reverseButtons: false })).toBe(true);
  expect(plugin.isEinkEnabled()).toBe(true);
  expect(notices).toHaveLength(1); expect(notices[0]).toContain('session only');
  expect(plugin.saveData).not.toHaveBeenCalled();
});

it('a Reader selection prevents remount; an unrelated note selection does not', () => {
  const { plugin, view, notices, stored } = fixture(); const changed = vi.fn(); plugin.subscribeEink(changed);
  view.contentEl.innerHTML = '<article class="r2-reading-page">Retain this selection</article>';
  const range = document.createRange(); range.selectNodeContents(view.contentEl.querySelector('article'));
  document.getSelection()!.addRange(range);
  expect(plugin.setEinkDevice({ enabled: true, reverseButtons: false })).toBe(false);
  expect(document.getSelection()!.toString()).toBe('Retain this selection');
  expect(stored.size).toBe(0); expect(changed).not.toHaveBeenCalled(); expect(notices[0]).toContain('Clear the selected text');
  document.getSelection()!.removeAllRanges();
  const outside = document.createElement('p'); outside.textContent = 'Native note'; document.body.append(outside);
  range.selectNodeContents(outside); document.getSelection()!.addRange(range);
  expect(plugin.setEinkDevice({ enabled: true, reverseButtons: false })).toBe(true);
});

it('native view state preserves and bounds valid text anchors, rejecting malformed offsets', async () => {
  const { view } = fixture();
  await view.setState({ readingPosition: { marker: 'a short saved marker' } }, {});
  expect(view.getState().readingPosition).toEqual({ marker: 'a short saved marker' });
  for (const marker of [42, null, 'x'.repeat(257), 'one two three four five six']) {
    await view.setState({ readingPosition: { marker } }, {});
    expect(view.getState().readingPosition).toBeUndefined();
  }
});

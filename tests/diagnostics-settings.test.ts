import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';
import { defaultFolders } from '../src/core/folders';
import {
  disposeReaderDebugLogging,
  initializeReaderDebugLogging,
  readerDebugLoggingEnabled,
  readReaderDebugLog,
  recordReaderDebug,
} from '../src/host/diagnostics';

const ui = vi.hoisted(() => ({ toggles: new Map<string, Toggle>() }));
class Toggle {
  value = false;
  change: (value: boolean) => void = () => {};
  setValue(value: boolean) {
    this.value = value;
    return this;
  }
  onChange(change: (value: boolean) => void) {
    this.change = change;
    return this;
  }
}
vi.mock('obsidian', () => ({
  Modal: class {},
  FuzzySuggestModal: class {},
  PluginSettingTab: class {
    containerEl = { empty: () => ui.toggles.clear(), createEl: () => {} };
  },
  Setting: class {
    name = '';
    setName(name: string) {
      this.name = name;
      return this;
    }
    setDesc() {
      return this;
    }
    addText() {
      return this;
    }
    addButton() {
      return this;
    }
    addToggle(add: (toggle: Toggle) => void) {
      const toggle = new Toggle();
      ui.toggles.set(this.name, toggle);
      add(toggle);
      return this;
    }
  },
}));
import { ReaderSettings } from '../src/host/settings';

let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  initializeReaderDebugLogging();
});
afterEach(() => {
  disposeReaderDebugLogging();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const row = () => ui.toggles.get('Debug logging (this device)')!;
function settings() {
  const saveFolders = vi.fn(async () => {}),
    savePaged = vi.fn();
  const tab = new ReaderSettings(
    {} as App,
    {} as Plugin,
    defaultFolders,
    false,
    saveFolders,
    savePaged,
  );
  tab.display();
  return { tab, saveFolders, savePaged };
}

it('restores the effective toggle on storage failure and reports an ordinary error', () => {
  settings();
  const failure = new Error('Device storage unavailable');
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw failure;
    },
  });
  row().value = true;
  row().change(true);
  expect(row().value).toBe(false);
  expect(readerDebugLoggingEnabled()).toBe(false);
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[Reader]', failure);
});

it('leaves logging off and clears the ring when persisting disable fails', () => {
  settings();
  row().change(true);
  recordReaderDebug({ event: 'operation.cancelled', operation: 'read', durationMs: 1 });
  vi.stubGlobal('localStorage', {
    getItem: () => '1',
    setItem: () => {
      throw new Error('Device storage unavailable');
    },
  });
  row().change(false);
  expect(row().value).toBe(false);
  expect(readerDebugLoggingEnabled()).toBe(false);
  expect(readReaderDebugLog()).toEqual([]);
  expect(console.error).toHaveBeenCalledWith('[Reader]', expect.any(Error));
});

it('offers an off-by-default local switch without changing the existing constructor or shared settings', () => {
  const { tab, saveFolders, savePaged } = settings();
  expect(row()).toBeDefined();
  expect(row().value).toBe(false);
  row().change(true);
  expect(readerDebugLoggingEnabled()).toBe(true);
  tab.display();
  expect(row().value).toBe(true);
  recordReaderDebug({ event: 'operation.completed', operation: 'save', durationMs: 1, count: 1 });
  row().change(false);
  expect(readReaderDebugLog()).toEqual([]);
  expect(readerDebugLoggingEnabled()).toBe(false);
  expect([...stored]).toEqual([['obsidian-reader:debug-logging', '0']]);
  expect(saveFolders).not.toHaveBeenCalled();
  expect(savePaged).not.toHaveBeenCalled();
});

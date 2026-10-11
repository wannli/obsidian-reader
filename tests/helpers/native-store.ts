import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { EditorPosition, EditorTransaction } from 'obsidian';
import type { ObsidianStore } from '../../src/obsidian-store';
import * as bridge from '../../src/editor-transaction';
import * as preconditions from '../../src/storage/preconditions';
import * as safety from '../../src/storage/safety';
import * as legacyDiscovery from '../../src/storage/legacy-discovery';
import * as sidecarFormat from '../../src/storage/sidecar-format';
export function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function offset(text: string, pos: EditorPosition) { const rows = text.split('\n'); return rows.slice(0, pos.line).reduce((sum, row) => sum + row.length + 1, 0) + pos.ch; }
function position(text: string, index: number) { const prefix = text.slice(0, index); return { line: prefix.split('\n').length - 1, ch: index - prefix.lastIndexOf('\n') - 1 }; }
export class NativeEditor {
  anchor = 0; head = 0; transactions: EditorTransaction[] = []; reloads = 0;
  constructor(public value: string) {}
  getValue() { return this.value; }
  posToOffset(pos: EditorPosition) { return offset(this.value, pos); }
  offsetToPos(index: number) { return position(this.value, index); }
  listSelections() { return [{ anchor: this.offsetToPos(this.anchor), head: this.offsetToPos(this.head) }]; }
  setValue = vi.fn(() => { throw new Error('Whole-editor replacement forbidden'); });
  transaction = vi.fn((transaction: EditorTransaction) => {
    this.transactions.push(transaction); const changes = (Array.isArray(transaction.changes) ? transaction.changes : [transaction.changes]).filter(Boolean).map(change => ({ from: this.posToOffset(change!.from), to: this.posToOffset(change!.to ?? change!.from), text: change!.text }));
    for (const change of changes.sort((a, b) => b.from - a.from)) this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
    const selection = transaction.selections?.[0]; if (selection) { this.anchor = this.posToOffset(selection.from); this.head = this.posToOffset(selection.to ?? selection.from); }
  });
  type(text: string) { const from = Math.min(this.anchor, this.head), to = Math.max(this.anchor, this.head); this.value = this.value.slice(0, from) + text + this.value.slice(to); this.anchor = this.head = from + text.length; }
  caretAfter(text: string) { this.anchor = this.head = this.value.indexOf(text) + text.length; }
  externalReload(text: string) { this.value = text; this.anchor = this.head = 0; this.reloads++; }
}
export function nativeStore(initial: Record<string, string>) {
  class TFile { constructor(public path: string) {} }
  class TFolder { constructor(public path: string) {} }
  const disk = new Map(Object.entries(initial)), files = new Map<string, TFile | TFolder>(Object.keys(initial).map(path => [path, new TFile(path)]));
  const events: { kind: string; path: string; text: string; from?: string }[] = [], leaves: any[] = [];
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const on = (event: string, callback: (...args: any[]) => void) => {
    const callbacks = listeners.get(event) ?? new Set<(...args: any[]) => void>();
    callbacks.add(callback); listeners.set(event, callbacks); return { event, callback };
  };
  const offref = (ref: { event: string; callback: (...args: any[]) => void }) => listeners.get(ref.event)?.delete(ref.callback);
  const emit = (event: string, ...args: any[]) => { for (const callback of listeners.get(event) ?? []) callback(...args); };
  const workspace = { activeLeaf: undefined as any, iterateAllLeaves: (callback: (leaf: any) => unknown) => { for (const leaf of leaves) if (callback(leaf)) break; }, setActiveLeaf: vi.fn(), revealLeaf: vi.fn(), on, offref };
  let modifyCallback = (_path: string) => {};
  const onModify = (path: string) => { modifyCallback(path); emit('modify', files.get(path)!); };
  const hooks: {
    beforeRead?: (file: TFile) => void | Promise<void>;
    beforeProcess?: (file: TFile) => void | Promise<void>;
    beforeRename?: (file: TFile, destination: string) => void | Promise<void>;
  } = {};
  const vault = {
    on, offref,
    trigger: (event: string, file: TFile | TFolder) => emit(event, file),
    getMarkdownFiles: () => [...files.values()].filter(file => file instanceof TFile && file.path.endsWith('.md')),
    getAllLoadedFiles: () => [...files.values()],
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    read: vi.fn(async (file: TFile) => { if (hooks.beforeRead) await hooks.beforeRead(file); if (!disk.has(file.path)) throw new Error('Missing file'); return disk.get(file.path)!; }),
    createFolder: vi.fn(async (path: string) => {
      if (files.has(path)) throw new Error('Exists');
      const folder = new TFolder(path); files.set(path, folder); emit('create', folder);
    }),
    create: vi.fn(async (path: string, text: string) => { if (files.has(path)) throw new Error('Exists'); const file = new TFile(path); files.set(path, file); disk.set(path, text); events.push({ kind: 'create', path, text }); onModify(path); return file; }),
    // Native Vault.rename moves one TFile without rewriting Markdown backlinks.
    rename: vi.fn(async (file: TFile, path: string) => {
      await hooks.beforeRename?.(file, path);
      const from = file.path;
      if (files.get(from) !== file || !disk.has(from)) throw new Error('Missing source');
      if ([...files.keys()].some(existing => existing.toLocaleLowerCase() === path.toLocaleLowerCase())) throw new Error('Exists');
      const text = disk.get(from)!;
      files.delete(from); disk.delete(from); file.path = path;
      files.set(path, file); disk.set(path, text);
      events.push({ kind: 'rename', from, path, text }); onModify(path);
    }),
    process: vi.fn(async (file: TFile, update: (current: string) => string) => {
      if (hooks.beforeProcess) await hooks.beforeProcess(file);
      const next = update(disk.get(file.path)!); disk.set(file.path, next); events.push({ kind: 'disk-process', path: file.path, text: next });
      // Negative control models the observed native external-write reload that loses unsaved typing.
      for (const leaf of leaves) if (leaf.view.file === file) leaf.view.editor.externalReload(next); onModify(file.path);
    }),
  };
  const output = ts.transpileModule(readFileSync('src/obsidian-store.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {}; new Function('require', 'exports', output)((name: string) => ({ obsidian: { TFile, TFolder, normalizePath: (path: string) => path }, './editor-transaction': bridge, './storage/preconditions': preconditions, './storage/safety': safety, './storage/legacy-discovery': legacyDiscovery, './storage/sidecar-format': sidecarFormat } as Record<string, unknown>)[name], exports);
  const store: ObsidianStore = new exports.ObsidianStore(vault, workspace);
  function open(path: string, text = disk.get(path)!) {
    const editor = new NativeEditor(text);
    const view = {
      file: files.get(path) as TFile, editor, mode: 'source', saving: false, queued: false, started: [] as string[],
      gateSave: undefined as ((snapshot: string, index: number) => Promise<void>) | undefined,
      getViewType: () => 'markdown', getMode() { return this.mode; }, getViewData() { return this.editor.getValue(); },
      save: vi.fn(async () => {
        // Obsidian 1.14.4: an already-running save returns early, scheduling another native save.
        if (view.saving) { view.queued = true; return; }
        view.saving = true; const snapshot = editor.getValue(); view.started.push(snapshot);
        try {
          await view.gateSave?.(snapshot, view.started.length);
          const savedPath = view.file.path;
          disk.set(savedPath, snapshot); events.push({ kind: 'native-save', path: savedPath, text: snapshot }); onModify(savedPath);
        }
        finally { view.saving = false; if (view.queued) { view.queued = false; queueMicrotask(() => { void view.save(); }); } }
      }),
    };
    const leaf = { view }; leaves.push(leaf); workspace.activeLeaf ??= leaf; return { view, editor, leaf };
  }
  return { store, newStore: (): ObsidianStore => new exports.ObsidianStore(vault, workspace), disk, files, events, leaves, workspace, vault, hooks, open, emit, onModify: (callback: (path: string) => void) => { modifyCallback = callback; } };
}

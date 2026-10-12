import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as adapter from '../src/nodes-api';
function fixture(quote = 'Countess') {
  const children: any[] = [], notices: string[] = [];
  class SuggestModal {
    inputEl = document.createElement('input');
    constructor(public app: unknown) {} setPlaceholder() {} onOpen() {} onClose() {}
    open() { this.onOpen(); } close() { this.onClose(); }
  }
  class ReaderPicker {
    finished?: () => void;
    constructor(_app: unknown, _label: string, public items: any[], _text: unknown, public choose: (item: any) => void) {}
    open() { children.push(this); } close() { this.finished?.(); }
    select() { this.close(); this.choose(this.items[0]); }
  }
  class ReaderInput {
    finished?: () => void;
    constructor(_app: unknown, _title: string, _label: string, public submit: (value: string) => Promise<void>) {}
    open() { children.push(this); } close() { this.finished?.(); }
  }
  const deps: Record<string, unknown> = { obsidian: { SuggestModal, Notice: class { constructor(message: string) { notices.push(message); } } }, '../nodes-api': adapter, './native-dialogs': { ReaderPicker, ReaderInput } };
  const output = ts.transpileModule(readFileSync('src/ui/node-picker.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {}; new Function('require', 'exports', output)((key: string) => deps[key], exports);
  const node = { path: 'Custom/Ada.md', title: 'Ada', type: 'Person', aliases: ['Countess'], color: 'blue' };
  const api = { version: 1, listTypes: () => [{ type: 'Person', label: 'Person', color: 'blue' }], searchNodes: vi.fn(() => [node]), getNode: vi.fn(() => node), createNode: vi.fn(async (_options: any): Promise<any> => node) };
  let live: unknown = api, current = true;
  const app = { plugins: { getPlugin: () => ({ api: live }) } }, choose = vi.fn(async () => {}), finished = vi.fn(), preflight = vi.fn(async () => {});
  const picker = new exports.NodePicker(app, quote, 'Reading/Inbox/Test.md', () => current, choose, finished, preflight);
  return { picker, node, api, children, notices, choose, finished, preflight, stale: () => { current = false; }, disable: () => { live = undefined; }, reload: () => { live = { ...api }; } };
}
it('prefills search and picks a live path, not the quote filename; matches aliases through API', async () => {
  const f = fixture(); f.picker.open(); expect(f.picker.inputEl.value).toBe('Countess');
  expect(f.picker.getSuggestions('Countess')[0]).toBe(f.node); expect(f.api.searchNodes).toHaveBeenCalledWith('Countess');
  f.api.getNode.mockReturnValue({ ...f.node, color: 'green' });
  f.picker.close(); f.picker.onChooseSuggestion(f.node);
  await vi.waitFor(() => expect(f.choose).toHaveBeenCalledExactlyOnceWith({ ...f.node, color: 'green' }));
  expect(f.finished).toHaveBeenCalledOnce();
});
it('Escape cancellation and child cancellation notify the underlying menu', async () => {
  const f = fixture(); f.picker.close(); await Promise.resolve(); expect(f.finished).toHaveBeenCalledOnce(); expect(f.choose).not.toHaveBeenCalled();
  const child = fixture(); child.picker.onChooseSuggestion({ create: true }); child.children[0].close(); await Promise.resolve();
  expect(child.finished).toHaveBeenCalledOnce(); expect(child.api.createNode).not.toHaveBeenCalled();
});
it('null cancellation from Nodes never links', async () => {
  const f = fixture(); f.api.createNode.mockResolvedValue(null); f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.finished).toHaveBeenCalled()); expect(f.choose).not.toHaveBeenCalled();
});
it('aborts the Nodes modal on disposal and keeps late-created nodes without linking', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.api.createNode.mockImplementation(() => new Promise(done => { resolve = done; }));
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.api.createNode).toHaveBeenCalled());
  const signal = f.api.createNode.mock.calls[0][0].signal as AbortSignal;
  f.stale(); f.picker.dispose(); expect(signal.aborted).toBe(true); resolve(f.node);
  await vi.waitFor(() => expect(f.notices.join()).toContain('kept')); expect(f.choose).not.toHaveBeenCalled();
});
it.each(['disable', 'reload'] as const)('does not link if Nodes %s during creation', async operation => {
  const f = fixture(); f.api.createNode.mockImplementation(async () => { f[operation](); return f.node; });
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.notices.join()).toContain('kept')); expect(f.choose).not.toHaveBeenCalled();
});
it('authoritative preflight blocks API creation even if the mounted UI remains current', async () => {
  const f = fixture(); f.preflight.mockRejectedValue(new Error('Source changed'));
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.notices.join()).toContain('Source changed')); expect(f.api.createNode).not.toHaveBeenCalled();
});
it('rechecks navigation after an awaited source preflight', async () => {
  const f = fixture(); f.preflight.mockImplementation(async () => { f.stale(); });
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.preflight).toHaveBeenCalled()); expect(f.api.createNode).not.toHaveBeenCalled();
});
it('long passage title cancellation never opens Nodes creation', async () => {
  const f = fixture('a long passage '.repeat(20)); f.picker.onChooseSuggestion({ create: true }); f.children[0].select(); f.children[1].close();
  expect(f.api.createNode).not.toHaveBeenCalled(); expect(f.finished).toHaveBeenCalled();
});
it('reports partial success on a failed link and never deletes the created node', async () => {
  const f = fixture(); f.choose.mockRejectedValue(new Error('Stale highlight'));
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.notices.join()).toContain('Node created and kept; linking failed'));
});

it('disposal alone blocks late selection callbacks and settles exactly once', async () => {
  const f = fixture(); f.picker.dispose(); f.picker.onChooseSuggestion(f.node); f.picker.onChooseSuggestion({ create: true });
  await Promise.resolve(); await Promise.resolve();
  expect(f.choose).not.toHaveBeenCalled(); expect(f.api.createNode).not.toHaveBeenCalled(); expect(f.children).toHaveLength(0); expect(f.finished).toHaveBeenCalledOnce();
});
it.each(['disable', 'stale', 'empty'] as const)('settles selected early exit %s exactly once', async operation => {
  const f = fixture(); if (operation === 'empty') f.api.listTypes = () => []; else f[operation]();
  f.picker.onChooseSuggestion({ create: true }); await Promise.resolve(); f.picker.dispose();
  expect(f.finished).toHaveBeenCalledOnce(); expect(f.api.createNode).not.toHaveBeenCalled();
});

it('closing the short-title input aborts a pending Nodes form and ignores late results', async () => {
  const f = fixture('long passage '.repeat(20)); let resolve!: (value: unknown) => void;
  f.api.createNode.mockImplementation(() => new Promise(done => { resolve = done; }));
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  const pending = f.children[1].submit('Short title');
  await vi.waitFor(() => expect(f.api.createNode).toHaveBeenCalled());
  const signal = f.api.createNode.mock.calls[0][0].signal as AbortSignal;
  f.children[1].close(); expect(signal.aborted).toBe(true); expect(f.finished).toHaveBeenCalledOnce();
  resolve(f.node); await pending;
  expect(f.choose).not.toHaveBeenCalled(); expect(f.finished).toHaveBeenCalledOnce();
});
it('opts into Nodes lifecycle and defers self-disposing refresh until registration completes', async () => {
  const f = fixture(), order: string[] = [];
  f.choose.mockImplementation(async () => { order.push('save'); return (() => { order.push('refresh'); f.picker.dispose(); }) as any; });
  const createNodeForLink = vi.fn(async (options, link) => {
    await link(f.node);
    expect(options.signal.aborted).toBe(false);
    order.push('register'); return f.node;
  });
  Object.assign(f.api, { createNodeForLink });
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.finished).toHaveBeenCalled());
  expect(order).toEqual(['save', 'register', 'refresh']);
  expect(f.api.createNode).not.toHaveBeenCalled();
});
it('disposal during opt-in link save aborts registration and does not refresh', async () => {
  const f = fixture(), refresh = vi.fn();
  f.choose.mockImplementation(async () => { f.picker.dispose(); return refresh as any; });
  Object.assign(f.api, { createNodeForLink: vi.fn(async (options, link) => {
    await link(f.node); expect(options.signal.aborted).toBe(true); return f.node;
  }) });
  f.picker.onChooseSuggestion({ create: true }); f.children[0].select();
  await vi.waitFor(() => expect(f.choose).toHaveBeenCalled()); expect(refresh).not.toHaveBeenCalled();
});

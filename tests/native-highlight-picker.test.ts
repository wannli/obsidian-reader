import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { isAcquisitionUrl } from '../src/acquisition-url';
import { defaultHighlightTarget } from '../src/ui/default-highlight-target';
import { highlightMenu } from '../src/ui/highlight-menu';
import type { HighlightLinkPicker } from '../src/ui/highlight-link-picker';
import type { nativeHighlightMenu, nativeLinkMenu } from '../src/ui/native-popups';
// A scoped SDK contract fixture, NOT native focus/Escape/touch acceptance.
function fixture() {
  function element() {
    const root = document.createElement('div');
    return Object.assign(root, { empty: () => root.replaceChildren(), createEl: (tag: string, options: { text?: string; attr?: Record<string, string> } = {}) => {
      const child = document.createElement(tag); child.textContent = options.text ?? ''; Object.entries(options.attr ?? {}).forEach(([key, value]) => child.setAttribute(key, value)); root.append(child); return child;
    } });
  }
  class Modal {
    contentEl = element(); fixtureClosed = false;
    constructor(public app: unknown) {}
    setTitle(title: string) { this.contentEl.setAttribute('aria-label', title); }
    open() { document.body.append(this.contentEl); (this as unknown as { onOpen(): void }).onOpen(); }
    close() { if (this.fixtureClosed) return; this.fixtureClosed = true; (this as unknown as { onClose(): void }).onClose(); this.contentEl.remove(); }
  }
  class Setting {
    root = document.createElement('div');
    constructor(parent: HTMLElement) { parent.append(this.root); }
    setName(name: string) { this.root.setAttribute('aria-label', name); return this; }
    private field(tag: 'input' | 'textarea', build: (value: unknown) => void) {
      const inputEl = document.createElement(tag); this.root.append(inputEl);
      const field = { inputEl, setValue(value: string) { inputEl.value = value; return field; }, onChange(callback: (value: string) => void) { inputEl.addEventListener('input', () => callback(inputEl.value)); return field; } }; build(field); return this;
    }
    addText(build: (value: unknown) => void) { return this.field('input', build); }
    addTextArea(build: (value: unknown) => void) { return this.field('textarea', build); }
    addButton(build: (value: unknown) => void) {
      const node = document.createElement('button'); this.root.append(node); const button = { setButtonText(value: string) { node.textContent = value; return button; }, setCta() { return button; }, onClick(fn: () => void) { node.addEventListener('click', fn); return button; } }; build(button); return this;
    }
  }
  const pickers: ReaderPicker[] = [];
  class ReaderPicker {
    finished?: () => void; closed = false;
    constructor(_app: unknown, public placeholder: string, public items: unknown[], public label: (item: unknown) => string, public choose: (item: unknown) => void) {}
    open() { pickers.push(this); }
    close() { if (this.closed) return; this.closed = true; this.finished?.(); }
    select(index: number) { this.close(); this.choose(this.items[index]); } // SDK closes before dispatching choice.
  }
  const menus: Menu[] = [];
  class Menu {
    actions = new Map<string, () => void>();
    constructor() { menus.push(this); }
    addItem(build: (value: unknown) => void) { let name = ''; const item = { setTitle(value: string) { name = value; return item; }, setIcon() { return item; }, onClick: (fn: () => void) => { this.actions.set(name, fn); return item; } }; build(item); }
    hide() {} showAtPosition() {}
  }
  function load(path: string, dependencies: Record<string, unknown>) {
    const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, unknown> = {}; new Function('require', 'exports', output)((key: string) => { if (!(key in dependencies)) throw new Error('Unexpected dependency ' + key); return dependencies[key]; }, exports); return exports;
  }
  const sdk = { Modal, Setting, Menu, Notice: vi.fn() };
  const Picker = load('src/ui/highlight-link-picker.ts', { obsidian: sdk, './native-dialogs': { ReaderPicker }, '../acquisition-url': { isAcquisitionUrl } }).HighlightLinkPicker as typeof HighlightLinkPicker;
  const popups = load('src/ui/native-popups.ts', { obsidian: sdk, './highlight-link-picker': { HighlightLinkPicker: Picker }, './default-highlight-target': { defaultHighlightTarget } });
  const menu = popups.nativeHighlightMenu as typeof nativeHighlightMenu, linkMenu = popups.nativeLinkMenu as typeof nativeLinkMenu;
  const app = { vault: { getMarkdownFiles: () => [{ path: 'Topics/Attention.md' }, { path: 'Work/Attention.md' }] } } as never;
  const click = (label: string) => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === label); expect(button).toBeDefined(); button!.click(); };
  return { Picker, menu, linkMenu, app, menus, pickers, click };
}
afterEach(() => document.body.replaceChildren());
it.each([false, true])('node-link save defers refresh but removal stays immediate (native=%s)', async native => {
  const f = fixture(), updated = vi.fn(), saved = { path: 'Article.md' }, node = { path: 'Nodes/Ada.md' };
  let choose!: (node: any, guard: () => void) => Promise<void | (() => void)>;
  const controller = { linkNode: vi.fn().mockResolvedValue(saved), deleteHighlight: vi.fn().mockResolvedValue(saved) };
  const host = { pickNode: (_q: string, _s: string, _current: unknown, callback: typeof choose) => { choose = callback; return () => {}; } };
  const menu = native ? f.menu(f.app) : highlightMenu;
  const stop = menu(document.body, saved as never, { id: 'h', quote: 'Ada' } as never, controller as never, host as never, { x: 0, y: 0 }, updated);
  const click = (label: string) => native ? f.menus[0].actions.get(label)!() : f.click(label);
  click('Link to node…');
  const refresh = await choose(node, () => {});
  expect(controller.linkNode).toHaveBeenCalled(); expect(updated).not.toHaveBeenCalled();
  expect(typeof refresh).toBe('function'); refresh!(); expect(updated).toHaveBeenCalledWith(saved); stop();
  updated.mockClear();
  const stop2 = menu(document.body, saved as never, { id: 'h', quote: 'Ada', link: 'Nodes/Ada.md', color: '🔵' } as never, controller as never, host as never, { x: 0, y: 0 }, updated);
  if (native) await f.menus[1].actions.get('Remove highlight')!(); else f.click('Remove highlight');
  await vi.waitFor(() => expect(updated).toHaveBeenCalled());
  expect(controller.deleteHighlight).toHaveBeenCalledWith('Article.md', 'h', true); stop2();
});
it('native Save as article remains available without a custom URI or reader navigation', async () => {
  const { linkMenu, menus } = fixture(), saved = vi.fn(), capture = vi.fn().mockResolvedValue({ path: 'Reading/Articles/Saved.md' });
  const dispose = linkMenu(document.body, 'https://example.com/article', 'Publisher title', { capture } as never, { x: 0, y: 0 }, saved);
  expect([...menus[0].actions.keys()]).toEqual(['Open in browser', 'Save as article']); await menus[0].actions.get('Save as article')!();
  expect(capture).toHaveBeenCalledExactlyOnceWith('https://example.com/article', 'Publisher title'); expect(saved).toHaveBeenCalledTimes(1); dispose();
});
it('invalid primary target retains the exact multiline quote and reason; Cancel writes nothing', () => {
  const { Picker, app, click } = fixture(), choose = vi.fn(), quote = 'First line\nsecond: line'; const picker = new Picker(app, quote, 'Choose a note without changing the quote.', choose); picker.open();
  expect(document.querySelector('textarea')!.value).toBe(quote); expect(document.querySelector('textarea')!.readOnly).toBe(true); expect(document.body.textContent).toContain('without changing the quote'); expect(choose).not.toHaveBeenCalled(); click('Cancel'); picker.close(); expect(choose).toHaveBeenCalledExactlyOnceWith(null); expect(document.body.children).toHaveLength(0);
});
it('existing-note choices show full paths, and close-before-choice does not dispatch cancellation', async () => {
  const { Picker, app, pickers } = fixture(), choose = vi.fn(), picker = new Picker(app, 'Selected words', undefined, choose); picker.open(); await Promise.resolve(); const child = pickers[0];
  expect(child.items.map(child.label)).toEqual(['Topics/Attention', 'Work/Attention', 'Link to an HTTP(S) URL…']); child.select(1); await Promise.resolve(); expect(choose).toHaveBeenCalledExactlyOnceWith('Work/Attention'); expect(document.body.children).toHaveLength(0);
});
it('SDK picker close/Escape delivers null once and late selection after disposal is inert', async () => {
  const { Picker, app, pickers } = fixture(), choose = vi.fn(), picker = new Picker(app, 'Selected words', undefined, choose); picker.open(); await Promise.resolve(); pickers[0].close(); await Promise.resolve(); pickers[0].choose(pickers[0].items[0]); expect(choose).toHaveBeenCalledExactlyOnceWith(null);
});
it('a URL-shaped quote never auto-links: HTTP(S) requires explicit confirmation', () => {
  const { Picker, app, click } = fixture(), choose = vi.fn(), quote = 'https://example.com/article', picker = new Picker(app, quote, 'Explicitly confirm an HTTP(S) link.', choose); picker.open();
  expect(document.querySelector('textarea')!.value).toBe(quote); const input = document.querySelector('input')!; expect(input.value).toBe(quote); expect(choose).not.toHaveBeenCalled(); input.value = 'javascript:alert(1)'; input.dispatchEvent(new Event('input')); click('Link URL'); expect(choose).not.toHaveBeenCalled(); expect(document.querySelector('[role="alert"]')!.textContent).toContain('HTTP(S)'); input.value = quote; input.dispatchEvent(new Event('input')); click('Link URL'); expect(choose).toHaveBeenCalledExactlyOnceWith(quote);
});
it('alternate picker URL choice returns to explicit URL confirmation without mutation', async () => {
  const { Picker, app, pickers, click } = fixture(), choose = vi.fn(), picker = new Picker(app, 'Quoted words', undefined, choose); picker.open(); await Promise.resolve(); pickers[0].select(2); await Promise.resolve(); expect(choose).not.toHaveBeenCalled(); expect(document.querySelector('textarea')!.value).toBe('Quoted words'); click('Cancel'); expect(choose).toHaveBeenCalledExactlyOnceWith(null);
});
it('native primary Link is verbatim; unsafe selection opens chooser and disposal prevents late mutation', async () => {
  const { menu, app, menus, pickers, click } = fixture(), controller = { linkHighlight: vi.fn().mockResolvedValue({}), deleteHighlight: vi.fn() }, updated = vi.fn();
  const show = (quote: string) => menu(app)(document.body, { path: 'Reading/Articles/Source.md' } as never, { id: 'hl', quote } as never, controller as never, {} as never, { x: 0, y: 0 }, updated);
  const stop = show('Selected words'); menus[0].actions.get('Link')!(); await Promise.resolve(); expect(controller.linkHighlight).toHaveBeenCalledWith('Reading/Articles/Source.md', 'hl', 'Selected words'); stop(); controller.linkHighlight.mockClear();
  const dispose = show('First line\nsecond line'); menus[1].actions.get('Link')!(); expect(document.querySelector('textarea')!.value).toBe('First line\nsecond line'); expect(controller.linkHighlight).not.toHaveBeenCalled(); click('Choose note'); dispose(); pickers[0].choose(pickers[0].items[0]); await Promise.resolve(); expect(controller.linkHighlight).not.toHaveBeenCalled(); expect(document.body.children).toHaveLength(0);
});

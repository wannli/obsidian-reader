import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// Native SDK lifecycle fixture: selecting a menu item hides Menu before a
// separate picker returns. Hiding the menu is not disposing the Reader target.
function fixture() {
  const menus: Menu[] = [];
  class Menu {
    items = new Map<string, () => unknown>(); hidden = false; hiddenCallback?: () => void;
    constructor() { menus.push(this); }
    addItem(make: (item: any) => void) { let title = ''; const item = { setTitle(value: string) { title = value; return item; }, setIcon() { return item; }, onClick(callback: () => unknown) { thisCallback = callback; return item; } }; let thisCallback!: () => unknown; make(item); this.items.set(title, thisCallback); return this; }
    onHide(callback: () => void) { this.hiddenCallback = callback; }
    showAtPosition() {}
    hide() { this.hidden = true; this.hiddenCallback?.(); }
  }
  let choose!: (target: string | null) => void;
  class Picker {
    constructor(_app: unknown, _quote: string, _reason: string | undefined, callback: typeof choose) { choose = callback; }
    open() {} close() { choose(null); }
  }
  const deps: Record<string, unknown> = { obsidian: { Menu, Notice: class {} }, './highlight-link-picker': { HighlightLinkPicker: Picker }, './default-highlight-target': { defaultHighlightTarget: () => ({ target: 'Words' }) } };
  const js = ts.transpileModule(readFileSync('src/ui/native-popups.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {}; new Function('require', 'exports', js)((name: string) => deps[name], exports);
  return { exports, menus, setChoose: (callback: typeof choose) => { choose = callback; }, finish: (target: string | null) => choose(target) };
}
it('offers configured type actions directly and runs them through the current-write guard', async () => {
  const f = fixture(), changed = vi.fn(), typeHighlight = vi.fn(async () => ({ body: 'typed' }));
  const type = { name: 'person', color: '🟡' }, controller = { settings: { typedHighlightTypes: [type] }, typeHighlight };
  let current = true; const runWrite = vi.fn(work => work());
  const close = f.exports.nativeHighlightMenu({})(document.createElement('div'), { path: 'article.md' }, { id: 'id', quote: 'Words' }, controller, {}, { x: 0, y: 0 }, changed, () => current, runWrite);
  expect([...f.menus[0].items.keys()]).toEqual(['🟡 person', 'Link', 'Link to…', 'Remove highlight']);
  await f.menus[0].items.get('🟡 person')!();
  expect(typeHighlight).toHaveBeenCalledWith('article.md', 'id', type); expect(runWrite).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith({ body: 'typed' }); current = false;
  await f.menus[0].items.get('🟡 person')!(); expect(typeHighlight).toHaveBeenCalledTimes(1);
  close();
});
it('typed node menu omits unsupported relinking and retains an explicit Open node action', async () => {
  const f = fixture(), host = { openNote: vi.fn() };
  const close = f.exports.nativeHighlightMenu({})(document.createElement('div'), { path: 'article.md' }, { id: 'id', quote: 'Words', color: '🟡', link: 'Nodes/Words' }, { settings: { typedHighlightTypes: [] } }, host, { x: 0, y: 0 }, vi.fn());
  expect([...f.menus[0].items.keys()]).toEqual(['Open node', 'Remove highlight']);
  await f.menus[0].items.get('Open node')!(); expect(host.openNote).toHaveBeenCalledWith('Nodes/Words', 'article.md'); close();
});
it.each(['link', 'highlight'])('native %s picker may complete after its Menu hides; disposal still blocks late callbacks', async kind => {
  const f = fixture(), parent = document.createElement('div'), changed = vi.fn(), edit = vi.fn(async () => ({}));
  const context = { internal: true, isCurrent: () => true, open() {}, edit, chooseTarget(callback: (target: string | null) => void) { f.setChoose(callback); return () => callback(null); } };
  const close = kind === 'link'
    ? f.exports.nativeLinkMenu(parent, 'Before', 'Words', {}, { x: 0, y: 0 }, changed, context)
    : f.exports.nativeHighlightMenu({})(parent, { path: 'article.md' }, { id: 'id', quote: 'Words' }, { linkHighlight: edit }, {}, { x: 0, y: 0 }, changed);
  f.menus[0].items.get(kind === 'link' ? 'Edit link…' : 'Link to…')!(); f.menus[0].hide(); f.finish('Chosen');
  await Promise.resolve(); expect(edit).toHaveBeenCalledTimes(1);
  close(); f.finish('Late'); await Promise.resolve(); expect(edit).toHaveBeenCalledTimes(1);
});

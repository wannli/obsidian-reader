import { Menu, Notice, type App } from 'obsidian';
import type { ReaderHost } from './reader';
import { HighlightLinkPicker } from './highlight-link-picker';
import { defaultHighlightTarget } from './default-highlight-target';
export function nativeHighlightMenu(app: App): NonNullable<ReaderHost['highlightMenu']> {
  return (_parent, article, highlight, controller, _host, point, updated, current = () => true, runWrite = work => work()) => {
    let disposed = false, busy = false, picker: HighlightLinkPicker | undefined;
    const menu = new Menu();
    const link = async (target: string) => {
      if (disposed || busy || !current()) return; busy = true;
      try { const saved = await runWrite(() => controller.linkHighlight(article.path, highlight.id, target)); if (!disposed) updated(saved); }
      catch (error) { if (!disposed) new Notice(error instanceof Error ? error.message : String(error)); }
      finally { busy = false; }
    };
    const choose = (reason?: string) => { if (disposed || !current()) return; picker = new HighlightLinkPicker(app, highlight.quote, reason, target => { if (!disposed && target !== null) void link(target); }); picker.open(); };
    for (const type of controller.settings?.typedHighlightTypes ?? []) {
      menu.addItem(item => item.setTitle(`${type.color} ${type.name}`).setIcon('highlighter').onClick(async () => {
        if (disposed || busy || !current()) return; busy = true;
        try { const saved = await runWrite(() => controller.typeHighlight(article.path, highlight.id, type)); if (!disposed && current()) updated(saved); }
        catch (error) { if (!disposed) new Notice(error instanceof Error ? error.message : String(error)); }
        finally { busy = false; }
      }));
    }
    if (highlight.color && highlight.link) menu.addItem(item => item.setTitle('Open node').setIcon('file').onClick(async () => {
      try { await _host.openNote(highlight.link!, article.path); } catch (error) { new Notice(String(error)); }
    }));
    if (!(highlight.color && highlight.link)) menu.addItem(item => item.setTitle('Link').setIcon('link').onClick(() => { const result = defaultHighlightTarget(highlight.quote); if ('target' in result) void link(result.target); else choose(result.reason); }));
    if (!(highlight.color && highlight.link)) menu.addItem(item => item.setTitle('Link to…').setIcon('file-search').onClick(() => choose()));
    menu.addItem(item => item.setTitle('Remove highlight').setIcon('trash').onClick(async () => {
      if (disposed || busy || !current()) return; busy = true;
      try { const saved = await runWrite(() => controller.deleteHighlight(article.path, highlight.id)); if (!disposed) updated(saved); }
      catch (error) { if (!disposed) new Notice(String(error)); }
      finally { busy = false; }
    }));
    menu.showAtPosition(point, _parent.ownerDocument);
    return () => { disposed = true; menu.hide(); picker?.close(); };
  };
}
export const nativeLinkMenu: NonNullable<ReaderHost['linkMenu']> = (parent, url, title, controller, point, saved, context) => {
  let disposed = false, busy = false, closePicker: (() => void) | void; const menu = new Menu();
  const current = () => !disposed && context?.isCurrent() !== false;
  const act = async (work: () => void | Promise<void>) => {
    if (!current() || busy) return; busy = true;
    try { await work(); }
    catch (error) { if (current()) new Notice(error instanceof Error ? error.message : String(error)); }
    finally { busy = false; }
  };
  menu.addItem(item => item.setTitle(context?.internal ? 'Open note' : 'Open in browser').setIcon(context?.internal ? 'file' : 'external-link').onClick(() => act(() => {
    if (context?.internal) return context.open();
    parent.ownerDocument.defaultView?.open(url, '_blank', 'noopener,noreferrer');
  })));
  if (/^https?:\/\//i.test(url)) menu.addItem(item => item.setTitle('Save as article').setIcon('bookmark-plus').onClick(() => act(async () => {
    await controller.capture(url, title); if (current()) { saved(); new Notice('URL saved'); }
  })));
  if (context?.edit && context.chooseTarget) menu.addItem(item => item.setTitle('Edit link…').setIcon('link').onClick(() => {
    if (!current()) return;
    closePicker = context.chooseTarget!(target => { if (target !== null) void act(() => context.edit!(target)); });
  }));
  if (context?.unlink) menu.addItem(item => item.setTitle('Unlink').setIcon('unlink').onClick(() => act(context.unlink!)));
  if (context?.removeHighlight) menu.addItem(item => item.setTitle('Remove highlight').setIcon('highlighter').onClick(() => act(context.removeHighlight!)));
  menu.showAtPosition(point, parent.ownerDocument); return () => { disposed = true; menu.hide(); closePicker?.(); };
};

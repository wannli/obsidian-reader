import { button, element } from '../src/ui/dom';
import { readerCommands, type ReaderCommand } from '../src/ui/commands';
import type { ReaderController } from '../src/controller';
import type { ReaderApp } from '../src/ui/app';
import type { ReaderHost } from '../src/ui/reader';
import type { Article, ArticleStatus } from '../src/types';
import { queueLabel } from '../src/reading-layout';
import type { BrowserStore } from './store';
import { defaultHighlightTarget } from '../src/ui/default-highlight-target';
import { isAcquisitionUrl } from '../src/acquisition-url';
import { RelationshipDraft } from '../src/ui/relationship-draft';
import { relationshipPicker } from '../src/ui/relationship-picker';
/** Browser-only stand-ins. Production instantiates Obsidian Menu/Modal/FuzzySuggestModal. */
export class PreviewNativeUI {
  active = true;
  commands: ReaderCommand[];
  private dialogs = new Set<HTMLDialogElement>();
  constructor(private controller: ReaderController, private reader: () => ReaderApp, private store: BrowserStore) {
    this.commands = readerCommands(controller, {
      active: () => this.active ? reader() : undefined, ensure: async () => reader(), external: url => { window.open(url, '_blank', 'noopener,noreferrer'); }, notice: message => this.notice(message),
      addUrl: () => this.input('Add URL', 'URL', async (url, current) => { const article = await controller.capture(url); if (current()) await reader().open(article.path); }),
      queue: current => this.picker('Switch queue', ['inbox', 'later', 'feed', 'archive'] as ArticleStatus[], queueLabel, status => { void current.openLibrary(status); }),
      feeds: () => { void this.feeds(); },
      topics: reader => { void this.relationships(reader, 'topics'); },
      authors: reader => { void this.relationships(reader, 'authors'); },
    });
  }
  run(name: string) { const command = this.commands.find(command => command.name === name || command.id === name), reader = this.active ? this.reader() : undefined; if (command?.available(reader)) return Promise.resolve(command.run(reader)).catch(error => { this.notice(String(error)); }); }
  notice(message: string): () => void { const node = element('div', 'preview-notice', message); node.setAttribute('role', 'status'); document.body.append(node); const timer = window.setTimeout(() => node.remove(), 6000); return () => { clearTimeout(timer); node.remove(); }; }
  private dialog(title: string): HTMLDialogElement {
    const dialog = element('dialog', 'preview-native-modal'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', title);
    dialog.append(element('h2', '', title)); document.body.append(dialog); this.dialogs.add(dialog);
    const root = document.querySelector<HTMLElement>('.r2-content')!;
    const position = () => { const bounds = root.getBoundingClientRect(); dialog.style.top = bounds.top + 8 + 'px'; dialog.style.maxHeight = Math.max(80, bounds.height - 16) + 'px'; };
    const observer = new ResizeObserver(position); observer.observe(root); position();
    dialog.addEventListener('close', () => { observer.disconnect(); this.dialogs.delete(dialog); dialog.remove(); }); dialog.showModal(); return dialog;
  }
  more = () => {
    const dialog = this.dialog('Reader commands');
    for (const command of this.commands.filter(command => command.id !== 'open-reader')) {
      const control = button(command.name, () => { dialog.close(); void this.run(command.id); }); control.disabled = !command.available(this.active ? this.reader() : undefined); dialog.append(control);
    }
    dialog.append(button('Close', () => dialog.close()));
  };
  picker<T>(title: string, items: T[], label: (item: T) => string, choose: (item: T) => void, cancel?: () => void) {
    let chosen = false; const dialog = this.dialog(title), input = element('input'), results = element('div', 'preview-suggestions'); input.type = 'search'; input.setAttribute('aria-label', 'Search');
    const render = () => { results.replaceChildren(); for (const item of items.filter(item => label(item).toLowerCase().includes(input.value.toLowerCase()))) results.append(button(label(item), () => { chosen = true; dialog.close(); choose(item); })); if (!results.childElementCount) results.append(element('p', '', 'No matching items.')); };
    input.addEventListener('input', render); dialog.append(input, results, button('Cancel', () => dialog.close())); render(); input.focus(); dialog.addEventListener('close', () => { if (!chosen) cancel?.(); }); return dialog;
  }
  pickArticle = (articles: Article[], queue: ArticleStatus, choose: (path: string) => void) => this.picker('Reading list · ' + queueLabel(queue), articles, article => article.title, article => choose(article.path));
  private input(title: string, label: string, save: (value: string, current: () => boolean) => Promise<void>) {
    const dialog = this.dialog(title), form = element('form'), field = element('input'), error = element('p'); field.setAttribute('aria-label', label); field.required = true; error.setAttribute('role', 'alert');
    const submit = element('button', '', 'Save'); submit.type = 'submit'; form.append(field, error, button('Cancel', () => dialog.close()), submit); dialog.append(form); field.focus();
    form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; try { await save(field.value, () => dialog.isConnected); dialog.close(); } catch (failure) { if (dialog.isConnected) { error.textContent = String(failure); submit.disabled = false; } } };
  }
  private async feeds() {
    const feeds = await this.controller.repository.listFeeds(), dialog = this.dialog('RSS feeds');
    for (const feed of feeds) dialog.append(element('p', '', feed.title));
    dialog.append(button('Add feed', () => { dialog.close(); this.input('Add feed', 'URL', async url => { await this.controller.subscribeFeed(url); void this.feeds(); }); }), button('Refresh feeds', async () => { await this.controller.refreshFeeds(); this.notice(this.controller.message); }), button('Done', () => dialog.close()));
  }
  private async relationships(reader: ReaderApp, property: 'topics' | 'authors') {
    const article = reader.getArticle(); if (!article) return;
    const dialog = this.dialog('Assign ' + property);
    const current = () => dialog.isConnected && this.active && reader.getArticle()?.path === article.path && reader.getArticle()?.id === article.id;
    dialog.append(element('p', '', 'Loading…'));
    try {
      const draft = await RelationshipDraft.load(this.controller, article.path, property, current);
      if (!current()) return;
      dialog.querySelector('p')?.remove();
      const picker = relationshipPicker(dialog, draft, () => dialog.close(), () => { this.notice(property + ' updated'); });
      dialog.addEventListener('cancel', event => { if (picker.isSaving()) event.preventDefault(); });
      dialog.addEventListener('close', () => picker.dispose());
    } catch (error) { if (dialog.isConnected) dialog.append(element('p', 'r2-error', String(error)), button('Cancel', () => dialog.close())); }
  }
  private linkTarget(quote: string, reason: string | undefined, chosen: (target: string | null) => void): () => void {
    const dialog = this.dialog('Link to…'); let finished = false, child: HTMLDialogElement | undefined;
    const finish = (target: string | null) => { if (finished) return; finished = true; child?.close(); dialog.close(); chosen(target); };
    if (reason) dialog.append(element('p', '', reason));
    const exact = element('textarea'); exact.readOnly = true; exact.value = quote; exact.setAttribute('aria-label', 'Selected text'); dialog.append(exact);
    const url = element('input'); url.setAttribute('aria-label', 'HTTP(S) URL'); url.value = /^https?:\/\//i.test(quote) ? quote : '';
    const notes = async () => { const paths = (await this.store.list()).filter(path => path.endsWith('.md')); if (finished) return;
      child = this.picker('Link to an existing note', [...paths, 'Link to an HTTP(S) URL…'], path => path.replace(/\.md$/, ''), path => { if (path.endsWith('.md')) finish(path.replace(/\.md$/, '')); else url.focus(); }, () => finish(null));
    };
    dialog.append(button('Choose note', notes), url, button('Link URL', () => { if (isAcquisitionUrl(url.value)) finish(url.value.trim()); else this.notice('Enter a complete HTTP(S) URL.'); }), button('Cancel', () => finish(null)));
    dialog.addEventListener('close', () => finish(null)); if (!reason) void notes(); return () => finish(null);
  }
  pickLinkTarget = (quote: string, chosen: (target: string | null) => void) => this.linkTarget(quote, undefined, chosen);
  highlightMenu: NonNullable<ReaderHost['highlightMenu']> = (_parent, article, highlight, controller, _host, _point, updated, isCurrent = () => true, runWrite = work => work()) => {
    let disposed = false, closePicker = () => {}; const dialog = this.dialog('Highlight actions');
    const link = async (target: string) => { if (disposed || !isCurrent()) return; try { const next = await runWrite(() => controller.linkHighlight(article.path, highlight.id, target)); if (!disposed && isCurrent()) updated(next); dialog.close(); } catch (error) { if (!disposed) this.notice(String(error)); } };
    const choose = (reason?: string) => { dialog.close(); closePicker = this.linkTarget(highlight.quote, reason, target => { if (target !== null) void link(target); }); };
    for (const type of controller.settings.typedHighlightTypes) dialog.append(button(`${type.color} ${type.name}`, async () => {
      if (disposed || !isCurrent()) return;
      try { const next = await runWrite(() => controller.typeHighlight(article.path, highlight.id, type)); if (!disposed && isCurrent()) updated(next); dialog.close(); }
      catch (error) { if (!disposed) this.notice(String(error)); }
    }));
    if (highlight.color && highlight.link) dialog.append(button('Open node', async () => {
      try { await _host.openNote(highlight.link!, article.path); dialog.close(); } catch (error) { if (!disposed) this.notice(String(error)); }
    }));
    if (!(highlight.color && highlight.link)) dialog.append(button('Link', () => { const result = defaultHighlightTarget(highlight.quote); if ('target' in result) void link(result.target); else choose(result.reason); }), button('Link to…', () => choose()));
    dialog.append(button('Remove highlight', async () => { if (disposed || !isCurrent()) return; try { const next = await runWrite(() => controller.deleteHighlight(article.path, highlight.id)); if (!disposed && isCurrent()) updated(next); dialog.close(); } catch (error) { if (!disposed) this.notice(String(error)); } }), button('Cancel', () => dialog.close()));
    return () => { disposed = true; dialog.close(); closePicker(); };
  };
  dispose() { for (const dialog of this.dialogs) dialog.close(); }
}

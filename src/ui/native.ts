import { Modal, Notice, type Menu, type Plugin } from 'obsidian';
import type { ReaderController } from '../controller';
import type { Article, ArticleStatus } from '../types';
import { queueLabel } from '../reading-layout';
import type { ReaderApp } from './app';
import { readerCommands, type ReaderCommand } from './commands';
import { ReaderPicker, ReaderInput, ReaderFeeds } from './native-dialogs';
import { ReaderTopics } from './native-topics';
import { HighlightLinkPicker } from './highlight-link-picker';
export class NativeReaderUI {
  private commands: ReaderCommand[];
  private modals = new Set<Modal>();
  private disposed = false;
  constructor(private plugin: Plugin, controller: ReaderController, private active: () => ReaderApp | undefined, ensure: () => Promise<ReaderApp>) {
    const assign = (reader: ReaderApp, property: 'topics' | 'authors') => {
      const article = reader.getArticle(), token = reader.articleToken(); if (!article || !token) return;
      this.open(new ReaderTopics(plugin.app, controller, article.path, property,
        () => !this.disposed && active() === reader && reader.articleToken() === token));
    };
    this.commands = readerCommands(controller, {
      active, ensure, external: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
      notice: message => { const notice = new Notice(message); return () => notice.hide(); },
      queue: reader => this.open(new ReaderPicker(plugin.app, 'Switch queue — does not move articles', ['inbox', 'later', 'feed', 'archive'] as ArticleStatus[], queueLabel, status => { void reader.openLibrary(status); })),
      addUrl: () => {
        const modal = new ReaderInput(plugin.app, 'Add URL', 'URL', async url => {
          const article = await controller.capture(url);
          if (this.disposed || !this.modals.has(modal)) return;
          const reader = await ensure(); if (!this.disposed && this.modals.has(modal)) await reader.open(article.path);
        }); this.open(modal);
      },
      feeds: () => this.open(new ReaderFeeds(plugin.app, controller, modal => this.open(modal))),
      topics: reader => assign(reader, 'topics'),
      authors: reader => assign(reader, 'authors'),
    });
    for (const command of this.commands) plugin.addCommand({ id: command.id, name: command.name, icon: command.icon, checkCallback: checking => {
      const reader = active(); if (this.disposed || !command.available(reader)) return false;
      if (!checking) this.invoke(command, reader); return true;
    } });
  }
  private open<T extends Modal & { finished?: () => void }>(modal: T): void {
    if (this.disposed) return;
    this.modals.add(modal); modal.finished = () => this.modals.delete(modal); modal.open();
  }
  private invoke(command: ReaderCommand, reader?: ReaderApp) {
    if (this.disposed || !command.available(reader)) return;
    void Promise.resolve().then(() => { if (!this.disposed) return command.run(reader); }).catch(error => { if (!this.disposed) new Notice(error instanceof Error ? error.message : String(error)); });
  }
  pickLinkTarget(quote: string, choose: (target: string | null) => void): () => void {
    const picker = new HighlightLinkPicker(this.plugin.app, quote, undefined, target => { if (!this.disposed) choose(target); });
    this.open(picker); return () => { this.modals.delete(picker); picker.close(); };
  }
  pickArticles(articles: Article[], queue: ArticleStatus, choose: (path: string) => void) {
    this.open(new ReaderPicker(this.plugin.app, 'Reading list · ' + queueLabel(queue), articles, article => article.title, article => choose(article.path)));
  }
  fillMenu(menu: Menu, reader?: ReaderApp): void {
    const path = reader?.getState().file;
    for (const command of this.commands.filter(command => command.id !== 'open-reader')) menu.addItem(item => item.setTitle(command.name).setIcon(command.icon).setDisabled(!command.available(reader)).onClick(() => {
      if (reader?.getState().file !== path) { new Notice('Article changed. Open the menu again.'); return; }
      this.invoke(command, reader);
    }));
  }
  dispose() { this.disposed = true; for (const modal of this.modals) { if (modal instanceof ReaderTopics) modal.closeForShutdown(); else modal.close(); } this.modals.clear(); }
}

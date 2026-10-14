import { Modal, Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { rootPath } from '../core/model';
import type { Ingestion } from './ingestion';
import type { ArticleStore } from '../core/store';
import type { TFile } from 'obsidian';
import { input } from './dialogs';

export function showFeeds(
  app: App,
  store: ArticleStore<TFile>,
  ingestion: Ingestion,
  signal: AbortSignal,
): void {
  class Feeds extends Modal {
    private closed = false;
    onOpen(): void {
      this.setTitle('Subscriptions');
      this.render();
    }
    private render(): void {
      if (this.closed) return;
      this.contentEl.empty();
      const run = async (action: () => Promise<void>) => {
        try {
          await action();
          this.render();
        } catch (error) {
          if (!this.closed) new Notice(error instanceof Error ? error.message : String(error));
        }
      };
      for (const feed of store.catalog.feeds())
        new Setting(this.contentEl)
          .setName(feed.title)
          .setDesc(feed.error ?? feed.url)
          .addToggle((toggle) =>
            toggle.setValue(feed.enabled).onChange((enabled) => {
              void run(() => ingestion.setFeed(feed, enabled));
            }),
          )
          .addButton((button) =>
            button
              .setButtonText('Unsubscribe')
              .setWarning()
              .onClick(() => {
                void run(() => ingestion.unsubscribe(feed));
              }),
          );
      this.contentEl.createEl('p', {
        text: 'Unsubscribing stops imports and trashes the subscription note. Existing articles are kept.',
      });
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Add feed').onClick(() => {
            input(
              app,
              'Subscribe to RSS or Atom',
              'Feed URL',
              async (url, lifetime) => {
                await ingestion.subscribe(url, lifetime);
                this.render();
              },
              signal,
            );
          }),
        )
        .addButton((button) =>
          button.setButtonText('Refresh feeds').onClick(() => {
            void run(() => ingestion.refreshAll());
          }),
        );
    }
    onClose(): void {
      this.closed = true;
      this.contentEl.empty();
      signal.removeEventListener('abort', abort);
    }
  }
  const modal = new Feeds(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}
export class ReaderSettings extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private root: string,
    private paged: boolean,
    private saveRoot: (root: string) => Promise<void>,
    private savePaged: (value: boolean) => void,
  ) {
    super(app, plugin);
  }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Reader' });
    let candidate = this.root;
    new Setting(this.containerEl)
      .setName('Reading folder')
      .setDesc(
        'Inbox, Later, Stream, Treasury and Wires live here. Changing this never moves notes. Reload Reader to apply.',
      )
      .addText((control) =>
        control.setValue(this.root).onChange((value) => {
          candidate = value;
        }),
      )
      .addButton((button) =>
        button.setButtonText('Save').onClick(async () => {
          try {
            this.root = rootPath(candidate);
            await this.saveRoot(this.root);
            new Notice('Reading folder saved. Reload Reader to apply it.');
          } catch (error) {
            new Notice(String(error));
          }
        }),
      );
    new Setting(this.containerEl)
      .setName('Boox / e-ink pagination (this device)')
      .setDesc(
        'Pages with touch controls and PageUp/PageDown. Reopen the article after changing this. Other devices are unaffected.',
      )
      .addToggle((control) =>
        control.setValue(this.paged).onChange((value) => {
          this.paged = value;
          this.savePaged(value);
        }),
      );
    this.containerEl.createEl('p', {
      text: 'Feeds refresh every four hours while Obsidian is active. Stream expires after one calendar month; adding highlights or links keeps articles in Inbox. Saved text works offline; remote images need a connection.',
    });
  }
}

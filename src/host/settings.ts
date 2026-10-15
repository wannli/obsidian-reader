import { Modal, Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { folderKeys, folderLabels, validateFolders, type ReaderFolders } from '../core/folders';
import { FolderPicker } from './folder-picker';
import type { Ingestion } from './ingestion';
import type { ArticleStore } from '../core/store';
import type { TFile } from 'obsidian';
import { input } from './dialogs';
import { articleStatuses, type ArticleStatus } from '../core/model';
import { validateStatusFolders, type StatusFolders } from '../core/status-folders';

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
        text: 'Adding saves a subscription without fetching. Edit its note before clicking Sync. Unsubscribing trashes only the subscription note; existing articles are kept.',
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
          button.setButtonText('Sync').onClick(() => {
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
    private folders: ReaderFolders,
    private paged: boolean,
    private saveFolders: (folders: ReaderFolders) => Promise<void>,
    private savePaged: (value: boolean) => void,
    private statusFolders: StatusFolders = {},
    private saveStatusFolders: (folders: StatusFolders) => Promise<void> = async () => {},
  ) {
    super(app, plugin);
  }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Reader' });
    const candidate = { ...this.folders };
    this.containerEl.createEl('p', {
      text: 'Choose creation destinations for new articles and feed subscriptions. Folders may be shared or nested; leave a path empty to use the vault root. Applying changes never moves existing files or changes their Markdown.',
    });
    for (const key of folderKeys) {
      const setting = new Setting(this.containerEl).setName(folderLabels[key]);
      setting.addText((control) => {
        control.setValue(candidate[key]).onChange((value) => {
          candidate[key] = value;
        });
        setting.addButton((button) =>
          button.setButtonText('Choose folder').onClick(() => {
            new FolderPicker(this.app, (path) => {
              candidate[key] = path;
              control.setValue(path);
            }).open();
          }),
        );
      });
    }
    new Setting(this.containerEl)
      .setName('Apply folder locations')
      .setDesc(
        'Both creation destinations are applied together. Reader returns to the reading list. Folders are created only when needed for a new note.',
      )
      .addButton((button) =>
        button
          .setButtonText('Apply folders')
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const folders = validateFolders(candidate);
              await this.saveFolders(folders);
              this.folders = folders;
              new Notice(
                'Reader folders applied; Reader returned to the reading list. Existing files were not moved.',
              );
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error));
            } finally {
              button.setDisabled(false);
            }
          }),
      );
    this.containerEl.createEl('h3', { text: 'Status folders (optional)' });
    this.containerEl.createEl('p', {
      text: 'When Reader changes a status, move the article to its mapped folder. Includes promotion to Later before annotations. Blank means no move; / means vault root. Observed YAML status changes also move mapped articles once native editors are safe. Applying mappings never moves existing notes.',
    });
    const mappings: Partial<Record<ArticleStatus, string>> = { ...this.statusFolders };
    for (const status of articleStatuses) {
      const setting = new Setting(this.containerEl).setName(`${status} folder`);
      setting.addText((control) => {
        control
          .setValue(mappings[status] === '' ? '/' : (mappings[status] ?? ''))
          .onChange((value) => {
            if (value === '') delete mappings[status];
            else mappings[status] = value === '/' ? '' : value;
          });
        setting.addButton((button) =>
          button.setButtonText('Choose folder').onClick(() => {
            new FolderPicker(this.app, (path) => {
              mappings[status] = path;
              control.setValue(path || '/');
            }).open();
          }),
        );
      });
    }
    new Setting(this.containerEl).setName('Apply status folders').addButton((button) =>
      button.setButtonText('Apply mappings').onClick(async () => {
        button.setDisabled(true);
        try {
          const next = validateStatusFolders(mappings);
          await this.saveStatusFolders(next);
          this.statusFolders = next;
          new Notice('Status folders applied. Existing files were not moved.');
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
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
      text: 'Feeds import only when you click Sync or run Refresh feeds. Only explicit Feed status expires after one calendar month; adding highlights or links keeps Feed articles in Later. Saved text works offline; remote images need a connection.',
    });
  }
}

import { Modal, Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { folderKeys, folderLabels, validateFolders, type ReaderFolders } from '../core/folders';
import { FolderPicker } from './folder-picker';
import { logReaderError } from './diagnostics';
import type { Ingestion } from './ingestion';
import type { ArticleStore } from '../core/store';
import type { TFile } from 'obsidian';
import { input } from './dialogs';
import { validateSettings as validateTypedNotes, type NodesSettings } from './fileclass/settings';
import { articleStatuses, type ArticleStatus } from '../core/model';
import {
  defaultStatusFolders,
  validateStatusFolders,
  type StatusFolders,
} from '../core/status-folders';

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
          if (!this.closed) logReaderError(error);
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
    private statusFolders: StatusFolders = defaultStatusFolders,
    private saveStatusFolders: (folders: StatusFolders) => Promise<void> = async () => {},
    private typedNotes?: NodesSettings,
    private saveTypedNotes: (settings: NodesSettings) => Promise<void> = async () => {},
  ) {
    super(app, plugin);
  }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Reader' });
    const candidate = { ...this.folders };
    this.containerEl.createEl('p', {
      text: 'New articles go to their queue folder below (manual captures to Inbox, imported entries to Feed). Choose where new feed subscription notes are created. Applying settings never moves existing files or changes their Markdown.',
    });
    for (const key of folderKeys.filter((key) => key === 'feeds')) {
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
        'Apply the feed subscription destination. Reader returns to the reading list. Existing articles remain in place.',
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
              logReaderError(error);
            } finally {
              button.setDisabled(false);
            }
          }),
      );
    this.containerEl.createEl('h3', { text: 'Article queue folders' });
    this.containerEl.createEl('p', {
      text: 'An article’s folder determines its reading list, even when its YAML status disagrees. The four folders must be distinct and cannot overlap or be inside Templates or .trash. Reader moves articles when you explicitly change their status; applying settings does not move existing notes.',
    });
    const mappings: Record<ArticleStatus, string> = {
      ...validateStatusFolders(this.statusFolders),
    };
    for (const status of articleStatuses) {
      const setting = new Setting(this.containerEl).setName(`${status} folder`);
      setting.addText((control) => {
        control.setValue(mappings[status]).onChange((value) => {
          mappings[status] = value;
        });
        setting.addButton((button) =>
          button.setButtonText('Choose folder').onClick(() => {
            new FolderPicker(this.app, (path) => {
              mappings[status] = path;
              control.setValue(path);
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
          logReaderError(error);
        } finally {
          button.setDisabled(false);
        }
      }),
    );
    if (this.typedNotes) {
      this.containerEl.createEl('h3', { text: 'Typed notes' });
      this.containerEl.createEl('p', {
        text: 'Reader uses Fileclass’s public API for existing classes and required fields. It creates new notes only in the folder below; applying these settings never moves or rewrites existing notes.',
      });
      const draft = { ...this.typedNotes };
      new Setting(this.containerEl).setName('New typed-note folder').addText((control) =>
        control.setValue(draft.nodesFolder).onChange((value) => {
          draft.nodesFolder = value;
        }),
      );
      new Setting(this.containerEl)
        .setName('Fallback class binding property')
        .setDesc('Used only when Fileclass does not expose its configured alias.')
        .addText((control) =>
          control.setValue(draft.classProperty).onChange((value) => {
            draft.classProperty = value;
          }),
        );
      new Setting(this.containerEl).setName('Apply typed-note settings').addButton((button) =>
        button.setButtonText('Apply').onClick(async () => {
          button.setDisabled(true);
          try {
            const invalid = validateTypedNotes(draft);
            if (invalid) throw new Error(invalid);
            await this.saveTypedNotes(draft);
            this.typedNotes = { ...draft };
            new Notice('Typed-note settings applied. Existing notes were not changed.');
          } catch (error) {
            logReaderError(error);
          } finally {
            button.setDisabled(false);
          }
        }),
      );
    }
    new Setting(this.containerEl)
      .setName('Boox / e-ink pagination (this device)')
      .setDesc(
        'Turn pages with the page controls or Up/Down and PageUp/PageDown. Reopen the article after changing this. Other devices are unaffected.',
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

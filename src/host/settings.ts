import { Modal, Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { folderKeys, folderLabels, validateFolders, type ReaderFolders } from '../core/folders';
import { FolderPicker } from './folder-picker';
import { logReaderError } from './diagnostics';
import { actionFailure, inlineFailure, SavedSettingsError } from './action-feedback';
import { readDocument } from '../core/document';
import { readTriageFlags, saveTriageFlag, triageFlags } from '../reader/feed-triage';
import type { Ingestion } from './ingestion';
import type { ArticleStore } from '../core/store';
import type { TFile } from 'obsidian';
import { input } from './dialogs';
import { nodesApi } from './nodes';
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
    private failures = new Map<string, string>();
    private pending = new Set<string>();
    onOpen(): void {
      this.setTitle('Subscriptions');
      this.render();
    }
    private render(): void {
      if (this.closed) return;
      this.contentEl.empty();
      const run = async (key: string, label: string, action: () => Promise<void>) => {
        if (this.closed || signal.aborted || this.pending.has(key)) return;
        this.pending.add(key);
        try {
          await action();
          this.failures.delete(key);
        } catch (error) {
          if (this.closed || signal.aborted) return;
          logReaderError(error, `feeds.${label}`);
          // A native write can finish before rejecting. Observe fresh bytes, never roll back.
          let uncertain = false;
          if (key !== 'sync') {
            try {
              const file = store.vault.file(key);
              if (file) {
                const revision = file.stat && { mtime: file.stat.mtime, size: file.stat.size };
                const indexed = store.catalog.feed(key);
                const raw = await store.vault.read(file);
                if (this.closed || signal.aborted) return;
                if (
                  !revision ||
                  file.path !== key ||
                  store.vault.file(key) !== file ||
                  file.stat.mtime !== revision.mtime ||
                  file.stat.size !== revision.size ||
                  store.catalog.feed(key) !== indexed
                ) {
                  // A newer observation owns the catalog; never publish this stale read.
                  uncertain = true;
                } else store.catalog.update(key, readDocument(raw).properties);
              } else store.catalog.remove(key);
            } catch {
              uncertain = true;
            }
          }
          if (this.closed || signal.aborted) return;
          this.failures.set(
            key,
            `${actionFailure(label, error)}${uncertain ? ' Current subscription state could not be verified; newer observed state was kept.' : ''} Check the subscription note before trying again. Saved articles are kept.`,
          );
        } finally {
          this.pending.delete(key);
          if (!this.closed && !signal.aborted) this.render();
        }
      };
      for (const feed of store.catalog.feeds()) {
        new Setting(this.contentEl)
          .setName(feed.title)
          .setDesc(feed.error ?? feed.url)
          .addToggle((toggle) =>
            toggle.setValue(feed.enabled).onChange((enabled) => {
              void run(feed.path, 'Change subscription', () => ingestion.setFeed(feed, enabled));
            }),
          )
          .addButton((button) =>
            button
              .setButtonText('Unsubscribe')
              .setWarning()
              .onClick(() => {
                void run(feed.path, 'Unsubscribe', () => ingestion.unsubscribe(feed));
              }),
          );
        const failure = this.failures.get(feed.path);
        if (failure) inlineFailure(this.contentEl).textContent = failure;
      }
      // Retain errors even when an uncertain unsubscribe removed its row.
      for (const [key, failure] of this.failures)
        if (key === 'sync' || !store.catalog.feeds().some((feed) => feed.path === key))
          inlineFailure(this.contentEl).textContent = failure;
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
            void run('sync', 'Sync feeds', async () => {
              const failures = await ingestion.refreshAll();
              if (failures?.length)
                throw new Error(
                  `${failures.join('; ')}. Some articles may already have been imported.`,
                );
            });
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
  private displayEpoch = 0;
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
    const epoch = ++this.displayEpoch;
    const report = (element: HTMLElement, action: string, error: unknown) => {
      logReaderError(error, `settings.${action}`);
      if (epoch === this.displayEpoch)
        element.textContent = `${actionFailure(action, error)} Review the values and apply again.`;
    };
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'Reader' });
    const candidate = { ...this.folders };
    this.containerEl.createEl('p', {
      text: 'Choose where new article and subscription files are created. Reading lists follow YAML status, not folders. Applying settings never moves existing files or changes their Markdown.',
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
    const folderError = inlineFailure(this.containerEl);
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
            const submitted = { ...candidate };
            try {
              folderError.textContent = '';
              const folders = validateFolders(submitted);
              await this.saveFolders(folders);
              this.folders = folders;
              new Notice(
                'Reader folders applied; Reader returned to the reading list. Existing files were not moved.',
              );
            } catch (error) {
              if (error instanceof SavedSettingsError) this.folders = submitted;
              report(folderError, 'Apply folders', error);
            } finally {
              button.setDisabled(false);
            }
          }),
      );
    this.containerEl.createEl('h3', { text: 'Article capture folders' });
    this.containerEl.createEl('p', {
      text: 'These destinations apply only when creating new articles. Manual captures start with status: inbox; feed imports start with status: feed. Changing status updates YAML without moving the file. Needs attention is derived from saved text and source information, not a status.',
    });
    const mappings: Record<ArticleStatus, string> = {
      ...validateStatusFolders(this.statusFolders),
    };
    for (const status of articleStatuses) {
      const setting = new Setting(this.containerEl).setName(`New ${status} articles`);
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
    const mappingError = inlineFailure(this.containerEl);
    new Setting(this.containerEl).setName('Apply article capture folders').addButton((button) =>
      button.setButtonText('Apply mappings').onClick(async () => {
        button.setDisabled(true);
        const submitted = { ...mappings };
        try {
          mappingError.textContent = '';
          const next = validateStatusFolders(submitted);
          await this.saveStatusFolders(next);
          this.statusFolders = next;
          new Notice('Article capture folders applied. Existing files were not moved.');
        } catch (error) {
          if (error instanceof SavedSettingsError) this.statusFolders = submitted;
          report(mappingError, 'Apply mappings', error);
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
      new Setting(this.containerEl)
        .setName('Default clipping Fileclass')
        .setDesc(
          'Keep creates one note per passage. Topics must be optional; no extra required fields. Existing notes are not converted.',
        )
        .addDropdown((control) => {
          control.addOption('', 'Not configured');
          const types = nodesApi(this.app)?.listTypes() ?? [];
          for (const type of types) control.addOption(type.type, type.label);
          if (draft.clippingType && !types.some((type) => type.type === draft.clippingType))
            control.addOption(draft.clippingType, `${draft.clippingType} (unavailable)`);
          control.setValue(draft.clippingType ?? '').onChange((value) => {
            draft.clippingType = value;
          });
        });
      const typedError = inlineFailure(this.containerEl);
      new Setting(this.containerEl).setName('Apply typed-note settings').addButton((button) =>
        button.setButtonText('Apply').onClick(async () => {
          button.setDisabled(true);
          const submitted = { ...draft };
          try {
            typedError.textContent = '';
            const invalid = validateTypedNotes(submitted);
            if (invalid) throw new Error(invalid);
            await this.saveTypedNotes(submitted);
            this.typedNotes = submitted;
            new Notice('Typed-note settings applied. Existing notes were not changed.');
          } catch (error) {
            if (error instanceof SavedSettingsError) this.typedNotes = submitted;
            report(typedError, 'Apply typed-note settings', error);
          } finally {
            button.setDisabled(false);
          }
        }),
      );
    }
    this.containerEl.createEl('h3', { text: 'Experimental Feed triage (this device)' });
    const flags = readTriageFlags();
    for (const flag of triageFlags) {
      const flagError = inlineFailure(this.containerEl);
      new Setting(this.containerEl)
        .setName(flag === 'feedPreviews' ? 'Feed previews' : 'Feed touch actions')
        .setDesc(
          (flag === 'feedPreviews'
            ? 'Show source, publication age and a short saved-text excerpt. No background fetching.'
            : 'Tap a Feed row to select it, then use Open, Later, Next or Delete.') +
            ' Reopen the Feed list after changing this. Off restores the original behavior.',
        )
        .addToggle((control) =>
          control.setValue(flags[flag]).onChange((value) => {
            try {
              flagError.textContent = '';
              saveTriageFlag(flag, value);
            } catch (error) {
              control.setValue(flags[flag]);
              report(flagError, 'Save device preference', error);
              return;
            }
            flags[flag] = value;
          }),
        );
    }
    const pagedError = inlineFailure(this.containerEl);
    new Setting(this.containerEl)
      .setName('Boox / e-ink pagination (this device)')
      .setDesc(
        'Turn pages with the page controls or Up/Down and PageUp/PageDown. Reopen the article after changing this. Other devices are unaffected.',
      )
      .addToggle((control) =>
        control.setValue(this.paged).onChange((value) => {
          pagedError.textContent = '';
          try {
            this.savePaged(value);
            this.paged = value;
          } catch (error) {
            control.setValue(this.paged);
            report(pagedError, 'Save pagination preference', error);
          }
        }),
      );
    this.containerEl.createEl('p', {
      text: 'Feeds import only when you click Sync or run Refresh feeds. Only explicit Feed status expires after one calendar month; adding highlights or links keeps Feed articles in Later. Saved text works offline; remote images need a connection.',
    });
  }
}

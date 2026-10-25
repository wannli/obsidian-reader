import {
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  type App,
  type Plugin,
} from 'obsidian';
import { folderKeys, folderLabels, validateFolders, type ReaderFolders } from '../core/folders';
import { FolderSuggest } from './folder-picker';
import type { Ingestion } from './ingestion';
import type { ArticleStore } from '../core/store';
import type { TFile } from 'obsidian';
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
  const lifetime = new AbortController();
  class Feeds extends Modal {
    private busy = false;
    private status!: HTMLElement;
    onOpen(): void {
      this.setTitle('Subscriptions');
      this.modalEl.classList.add('reader-feeds-modal');
      if (Platform.isMobile)
        queueMicrotask(() => {
          if (lifetime.signal.aborted) return;
          this.contentEl.tabIndex = -1;
          this.contentEl.focus();
        });
      this.render();
    }
    private element<K extends keyof HTMLElementTagNameMap>(
      parent: HTMLElement,
      tag: K,
      text = '',
    ): HTMLElementTagNameMap[K] {
      const element = parent.ownerDocument.createElement(tag);
      element.textContent = text;
      parent.append(element);
      return element;
    }
    private async run(action: () => Promise<void>, success: string): Promise<void> {
      if (this.busy || lifetime.signal.aborted) return;
      this.busy = true;
      this.status.textContent = 'Working…';
      this.contentEl
        .querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')
        .forEach((el) => (el.disabled = true));
      try {
        await action();
        if (!lifetime.signal.aborted) {
          this.render();
          this.status.textContent = success;
        }
      } catch (error) {
        if (!lifetime.signal.aborted)
          this.status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        this.busy = false;
        this.contentEl
          .querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')
          .forEach((el) => (el.disabled = false));
      }
    }
    private render(): void {
      if (lifetime.signal.aborted) return;
      this.contentEl.replaceChildren();
      const add = this.element(this.contentEl, 'form');
      add.className = 'reader-feed-add';
      const url = this.element(add, 'input');
      url.type = 'url';
      url.placeholder = 'Feed URL';
      url.setAttribute('aria-label', 'Feed URL');
      url.required = true;
      const submit = this.element(add, 'button', 'Add');
      submit.type = 'submit';
      add.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.run(async () => {
          await ingestion.subscribe(url.value.trim(), lifetime.signal);
        }, 'Subscription added. Sync when ready.').then(() => {
          if (!Platform.isMobile && !lifetime.signal.aborted)
            this.contentEl.querySelector<HTMLInputElement>('input[type=url]')?.focus();
        });
      });
      const list = this.element(this.contentEl, 'div');
      list.className = 'reader-feed-list';
      for (const feed of store.catalog.feeds()) {
        const row = this.element(list, 'details');
        this.element(row, 'summary', feed.title);
        const editor = this.element(row, 'div');
        let loaded = false;
        row.addEventListener('toggle', () => {
          if (!row.open || loaded) return;
          loaded = true;
          void (async () => {
            const file = store.vault.file(feed.path);
            if (!file) throw new Error('Subscription no longer exists.');
            const expected = await store.vault.read(file);
            if (lifetime.signal.aborted) return;
            const titleLabel = this.element(editor, 'label', 'Title');
            const title = this.element(titleLabel, 'input');
            title.value = feed.title;
            const prefixLabel = this.element(editor, 'label', 'Filename prefix');
            const prefix = this.element(prefixLabel, 'input');
            prefix.value = feed.prefix ?? '';
            const save = this.element(editor, 'button', 'Save');
            const commit = () =>
              this.run(
                () =>
                  ingestion.editFeed(feed, { title: title.value, prefix: prefix.value }, expected),
                'Subscription saved.',
              );
            save.addEventListener('click', () => void commit());
            editor.addEventListener('keydown', (event) => {
              if (
                event.key === 'Enter' &&
                (event.target === title || event.target === prefix) &&
                !event.isComposing &&
                !event.repeat
              ) {
                event.preventDefault();
                void commit();
              }
            });
            const open = this.element(editor, 'button', 'Open note');
            open.addEventListener('click', () => {
              this.close();
              void app.workspace.openLinkText(feed.path, '', false);
            });
            const toggle = this.element(
              editor,
              'button',
              feed.enabled ? 'Pause feed' : 'Enable feed',
            );
            toggle.addEventListener(
              'click',
              () =>
                void this.run(
                  () => ingestion.setFeed(feed, !feed.enabled),
                  'Subscription updated.',
                ),
            );
            const unsubscribe = this.element(editor, 'button', 'Unsubscribe');
            unsubscribe.addEventListener(
              'click',
              () =>
                void this.run(
                  () => ingestion.unsubscribe(feed),
                  'Unsubscribed. Existing articles were kept.',
                ),
            );
            this.element(editor, 'small', feed.error ?? feed.url);
          })().catch((error) => {
            this.status.textContent = String(error);
            loaded = false;
          });
        });
      }
      this.status = this.element(
        this.contentEl,
        'p',
        'Adding saves locally. Only Sync imports articles.',
      );
      this.status.setAttribute('role', 'status');
      this.status.setAttribute('aria-live', 'polite');
      const sync = this.element(this.contentEl, 'button', 'Sync');
      sync.addEventListener(
        'click',
        () => void this.run(() => ingestion.refreshAll(), 'Feeds synced.'),
      );
    }
    onClose(): void {
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      this.contentEl.replaceChildren();
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
        new FolderSuggest(this.app, control.inputEl, (path) => {
          candidate[key] = path;
          control.setValue(path);
        });
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
              new Notice(error instanceof Error ? error.message : String(error));
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
        new FolderSuggest(this.app, control.inputEl, (path) => {
          mappings[status] = path;
          control.setValue(path);
        });
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

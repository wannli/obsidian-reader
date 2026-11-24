import { FuzzySuggestModal, Modal, Setting, type App } from 'obsidian';
import { bindModalSubmit } from './modal-submit';

export function choose<T>(
  app: App,
  title: string,
  items: T[],
  label: (item: T) => string,
  signal?: AbortSignal,
): Promise<T | null> {
  return new Promise((resolve) => {
    let chosen = false;
    class Picker extends FuzzySuggestModal<T> {
      getItems(): T[] {
        return items;
      }
      getItemText(item: T): string {
        return label(item);
      }
      onChooseItem(item: T): void {
        if (!signal?.aborted) {
          chosen = true;
          resolve(item);
        }
      }
      onClose(): void {
        super.onClose();
        signal?.removeEventListener('abort', abort);
        queueMicrotask(() => {
          if (!chosen) resolve(null);
        });
      }
    }
    const modal = new Picker(app),
      abort = () => modal.close();
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    modal.setPlaceholder(title);
    modal.open();
  });
}
export function input(
  app: App,
  title: string,
  label: string,
  submit: (value: string, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): void {
  const lifetime = new AbortController();
  class Input extends Modal {
    onOpen(): void {
      this.setTitle(title);
      let value = '';
      let field!: HTMLInputElement;
      new Setting(this.contentEl).setName(label).addText((control) => {
        field = control.inputEl;
        control.onChange((next) => (value = next));
        field.focus();
      });
      const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      const save = async (button: HTMLButtonElement) => {
        if (signal?.aborted || lifetime.signal.aborted) return;
        button.disabled = true;
        field.disabled = true;
        error.textContent = '';
        try {
          await submit(value.trim(), lifetime.signal);
          this.close();
        } catch (failure) {
          if (lifetime.signal.aborted) return;
          error.textContent = failure instanceof Error ? failure.message : String(failure);
          button.disabled = false;
          field.disabled = false;
        }
      };
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) => {
          button
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
              void save(button.buttonEl);
            });
          field.addEventListener('keydown', (event) => {
            if (
              event.key === 'Enter' &&
              !event.metaKey &&
              !event.ctrlKey &&
              !button.buttonEl.disabled
            )
              void save(button.buttonEl);
          });
          bindModalSubmit(this, () => {
            if (!button.buttonEl.disabled) void save(button.buttonEl);
          });
        });
    }
    onClose(): void {
      lifetime.abort();
      this.contentEl.empty();
      signal?.removeEventListener('abort', abort);
    }
  }
  const modal = new Input(app),
    abort = () => modal.close();
  if (signal?.aborted) return;
  signal?.addEventListener('abort', abort, { once: true });
  modal.open();
}
export function confirmArticleReplacement(
  app: App,
  path: string,
  replace: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): void {
  const lifetime = new AbortController();
  class Replacement extends Modal {
    onOpen(): void {
      this.setTitle('Run Defuddle again?');
      this.contentEl.createEl('p', { text: path });
      this.contentEl.createEl('p', {
        text: 'Replace this article’s entire body, including all highlights and inline links, with newly downloaded content? Existing content is kept if downloading or extraction fails. This cannot be undone by Reader.',
      });
      const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      let pending = false;
      let replaceButton: HTMLButtonElement;
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) => {
          replaceButton = button.buttonEl;
          button
            .setButtonText('Replace content')
            .setWarning()
            .onClick(async () => {
              if (pending || lifetime.signal.aborted || signal.aborted) return;
              pending = true;
              button.setDisabled(true);
              try {
                await replace(lifetime.signal);
                this.close();
              } catch (failure) {
                if (lifetime.signal.aborted) return;
                error.textContent = failure instanceof Error ? failure.message : String(failure);
                pending = false;
                button.setDisabled(false);
              }
            });
        });
      bindModalSubmit(this, () => {
        if (!replaceButton.disabled) replaceButton.click();
      });
    }
    onClose(): void {
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Replacement(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

export function confirmClippingDeletion(
  app: App,
  path: string,
  trash: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): void {
  const lifetime = new AbortController();
  class Deletion extends Modal {
    onOpen(): void {
      this.setTitle('Delete clipping?');
      this.contentEl.createEl('p', { text: path });
      this.contentEl.createEl('p', {
        text: 'Move this entire clipping note, including any personal writing, to recoverable vault trash? The article, its paragraph reference and other clippings stay unchanged.',
      });
      const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      let pending = false;
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) =>
          button
            .setButtonText('Delete clipping')
            .setWarning()
            .onClick(async () => {
              if (pending || lifetime.signal.aborted || signal.aborted) return;
              pending = true;
              button.setDisabled(true);
              try {
                await trash(lifetime.signal);
                this.close();
              } catch (failure) {
                if (lifetime.signal.aborted) return;
                error.textContent = `${failure instanceof Error ? failure.message : String(failure)} Check the clipping note before trying again; deletion may already have completed.`;
                // A failed native operation may already have committed. Require a new confirmation.
              }
            }),
        );
    }
    onClose(): void {
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Deletion(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

export function confirmWebLink(
  app: App,
  url: string,
  save: (signal: AbortSignal) => Promise<void>,
  signals: AbortSignal[],
): void {
  const lifetime = new AbortController();
  const aborted = () => lifetime.signal.aborted || signals.some((signal) => signal.aborted);
  class WebLink extends Modal {
    onOpen(): void {
      this.setTitle('Save this link?');
      this.contentEl.createEl('p', { text: url });
      const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      let pending = false;
      let saveButton: HTMLButtonElement;
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) =>
          button.setButtonText('Open link').onClick(() => {
            if (pending || aborted()) return;
            window.open(url, '_blank', 'noopener,noreferrer');
            this.close();
          }),
        )
        .addButton((button) => {
          saveButton = button.buttonEl;
          button
            .setButtonText('Save to Inbox')
            .setCta()
            .onClick(async () => {
              if (pending || aborted()) return;
              pending = true;
              button.setDisabled(true);
              error.textContent = '';
              try {
                await save(lifetime.signal);
                this.close();
              } catch (failure) {
                if (lifetime.signal.aborted) return;
                error.textContent = failure instanceof Error ? failure.message : String(failure);
                pending = false;
                button.setDisabled(false);
              }
            });
        });
      bindModalSubmit(this, () => {
        if (!saveButton.disabled) saveButton.click();
      });
    }
    onClose(): void {
      lifetime.abort();
      for (const signal of signals) signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new WebLink(app),
    abort = () => modal.close();
  if (aborted()) return;
  for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

import { type App, Modal, Setting } from 'obsidian';
import { csvUrls } from '../core/csv-urls';

export function importCsvDialog(
  app: App,
  capture: (urls: string[], guard: () => void) => Promise<void>,
  signal: AbortSignal,
): void {
  const lifetime = new AbortController();
  class CsvImport extends Modal {
    onOpen(): void {
      this.setTitle('Add articles from URLs');
      this.contentEl.createEl('p', {
        text: 'Enter URLs separated by commas, semicolons or new lines. Links starting with www. use HTTPS. Existing URLs are reused.',
      });
      let field!: HTMLTextAreaElement;
      new Setting(this.contentEl).setName('Article URLs').addTextArea((control) => {
        field = control.inputEl;
        field.rows = 8;
        field.placeholder = 'www.google.com,www.bing.com;www.brave.com';
      });
      const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) =>
          button
            .setButtonText('Add articles')
            .setCta()
            .onClick(() => {
              const run = async () => {
                if (signal.aborted || lifetime.signal.aborted) return;
                button.setDisabled(true);
                field.disabled = true;
                error.textContent = '';
                try {
                  const urls = csvUrls(field.value);
                  await capture(urls, () => {
                    if (signal.aborted || lifetime.signal.aborted)
                      throw new Error('Reader URL import was cancelled.');
                  });
                  this.close();
                } catch (failure) {
                  if (lifetime.signal.aborted) return;
                  error.textContent = failure instanceof Error ? failure.message : String(failure);
                  button.setDisabled(false);
                  field.disabled = false;
                }
              };
              void run();
            }),
        );
      field.focus();
    }
    onClose(): void {
      lifetime.abort();
      this.contentEl.empty();
      signal.removeEventListener('abort', abort);
    }
  }
  const modal = new CsvImport(app);
  const abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

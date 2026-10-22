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
      this.setTitle('Add articles from CSV');
      this.contentEl.createEl('p', {
        text: 'Choose a CSV file or paste URLs separated by commas, semicolons or lines. A URL column header is supported. Existing URLs are reused.',
      });
      const file = this.contentEl.createEl('input', {
        attr: { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Choose CSV file' },
      });
      let field!: HTMLTextAreaElement;
      new Setting(this.contentEl).setName('Or paste CSV').addTextArea((control) => {
        field = control.inputEl;
        field.rows = 8;
        field.placeholder = 'url;title\nhttps://example.com/article;Example';
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
                file.disabled = true;
                error.textContent = '';
                try {
                  const source = file.files?.[0] ? await file.files[0].text() : field.value;
                  const urls = csvUrls(source);
                  await capture(urls, () => {
                    if (signal.aborted || lifetime.signal.aborted)
                      throw new Error('Reader CSV import was cancelled.');
                  });
                  this.close();
                } catch (failure) {
                  if (lifetime.signal.aborted) return;
                  error.textContent = failure instanceof Error ? failure.message : String(failure);
                  button.setDisabled(false);
                  field.disabled = false;
                  file.disabled = false;
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

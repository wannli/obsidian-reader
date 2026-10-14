import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from 'obsidian';

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
            if (event.key === 'Enter' && !button.buttonEl.disabled) void save(button.buttonEl);
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
export function chooseTopics(
  app: App,
  files: TFile[],
  selected: Set<string>,
  signal?: AbortSignal,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let accepted = false;
    const draft = new Set(selected);
    class Topics extends Modal {
      onOpen(): void {
        this.setTitle('Article topics');
        const search = this.contentEl.createEl('input', {
          type: 'search',
          placeholder: 'Search topics',
          attr: { 'aria-label': 'Search topics' },
        });
        const list = this.contentEl.createDiv({ cls: 'reader-topic-list' });
        const render = () => {
          list.empty();
          const query = search.value.toLocaleLowerCase();
          const matches = files.filter((file) => file.basename.toLocaleLowerCase().includes(query));
          for (const file of matches.slice(0, 100))
            new Setting(list)
              .setName(file.basename)
              .setDesc(file.path)
              .addToggle((toggle) =>
                toggle.setValue(draft.has(file.path)).onChange((on) => {
                  if (on) draft.add(file.path);
                  else draft.delete(file.path);
                }),
              );
          if (matches.length > 100)
            list.createEl('p', { text: 'Refine your search to see more topics.' });
        };
        search.addEventListener('input', render);
        render();
        search.focus();
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
          .addButton((button) =>
            button
              .setButtonText('Save')
              .setCta()
              .onClick(() => {
                if (!signal?.aborted) {
                  accepted = true;
                  resolve([...draft]);
                }
                this.close();
              }),
          );
      }
      onClose(): void {
        this.contentEl.empty();
        signal?.removeEventListener('abort', abort);
        if (!accepted) resolve(null);
      }
    }
    const modal = new Topics(app),
      abort = () => modal.close();
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    modal.open();
  });
}

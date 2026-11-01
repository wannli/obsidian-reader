import { App, Modal, Setting, SuggestModal } from 'obsidian';
import { renderClassIcon, styleSuggestionItem } from './suggestion-style';
import type { ClassInfo } from './fileclass-contract';
import { titleError } from './creation';

export function chooseClass(
  app: App,
  classes: ClassInfo[],
  title: string,
  signal: AbortSignal,
): Promise<ClassInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ClassInfo | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      resolve(value);
    };
    class ClassPicker extends SuggestModal<ClassInfo> {
      constructor() {
        super(app);
        this.shouldRestoreSelection = false;
        this.setPlaceholder(title ? `Create “${title}” as…` : 'Choose a Fileclass');
      }
      getSuggestions(query: string): ClassInfo[] {
        return classes.filter((item) =>
          item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        );
      }
      renderSuggestion(item: ClassInfo, el: HTMLElement): void {
        styleSuggestionItem(el);
        el.style.gap = 'var(--size-4-2, 8px)';
        if (item.icon) renderClassIcon(el, item.icon);
        const label = el.createSpan({ text: item.name });
        label.style.minWidth = '0';
        label.style.overflowWrap = 'anywhere';
      }
      onChooseSuggestion(item: ClassInfo): void {
        if (!signal.aborted) finish(item);
      }
      // SuggestModal closes before onChooseSuggestion. Do not interpret that as cancellation.
      onClose(): void {
        queueMicrotask(() => finish(null));
      }
    }
    const modal = new ClassPicker();
    const cancel = (): void => {
      finish(null);
      modal.close();
    };
    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    modal.open();
  });
}

export function chooseName(
  app: App,
  className: string,
  title: string,
  folder: string,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      resolve(value);
    };
    class NamePrompt extends Modal {
      private title = title;
      private error?: HTMLElement;
      constructor() {
        super(app);
        this.shouldRestoreSelection = false;
        for (const key of ['Ctrl', 'Meta'] as const)
          this.scope.register([key], 'Enter', () => {
            this.submit();
            return false;
          });
      }
      onOpen(): void {
        this.contentEl.createEl('h2', { text: `Create ${className}` });
        new Setting(this.contentEl)
          .setName('Name')
          .setDesc(`Create a Markdown note in ${folder}/. Optional fields will not be prompted.`)
          .addText((input) => {
            input.setValue(this.title).onChange((value) => {
              this.title = value;
            });
            input.inputEl.focus();
          });
        this.error = this.contentEl.createEl('p', { cls: 'mod-warning', attr: { role: 'alert' } });
        new Setting(this.contentEl)
          .addButton((button) =>
            button
              .setButtonText('Create')
              .setCta()
              .onClick(() => this.submit()),
          )
          .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
      }
      private submit(): void {
        if (settled || signal.aborted) return;
        const error =
          titleError(this.title) ??
          (app.vault.getAbstractFileByPath(`${folder}/${this.title}.md`)
            ? 'That filename already exists. Choose another name or link the existing note.'
            : null);
        if (error) {
          this.error?.setText(error);
          return;
        }
        finish(this.title);
        this.close();
      }
      onClose(): void {
        finish(null);
      }
    }
    const modal = new NamePrompt();
    const cancel = (): void => {
      finish(null);
      modal.close();
    };
    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    modal.open();
  });
}

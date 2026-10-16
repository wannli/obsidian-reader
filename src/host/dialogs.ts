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
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) =>
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
            }),
        );
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
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
        .addButton((button) =>
          button.setButtonText('Open link').onClick(() => {
            if (pending || aborted()) return;
            window.open(url, '_blank', 'noopener,noreferrer');
            this.close();
          }),
        )
        .addButton((button) =>
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
            }),
        );
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

export interface TopicCreation {
  disabledReason?: string;
  create?: (
    signal: AbortSignal,
    added: (file: TFile) => void,
    suggestedTitle?: string,
  ) => Promise<void>;
}

export function chooseTopics(
  app: App,
  files: TFile[],
  selected: Set<string>,
  signal?: AbortSignal,
  creation?: TopicCreation,
  commit?: (selected: string[]) => Promise<void>,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let accepted = false;
    const draft = new Set(selected);
    const controller = new AbortController();
    let busy = false;
    let pendingSave: Promise<void> | undefined;
    class Topics extends Modal {
      onOpen(): void {
        this.setTitle('Article topics');
        this.contentEl.classList.add('reader-topic-picker');
        const search = this.contentEl.createEl('input', {
          type: 'search',
          placeholder: 'Search topics',
          attr: { 'aria-label': 'Search topics' },
        });
        const summary = this.contentEl.createEl('p', { attr: { role: 'status' } });
        const chosen = this.contentEl.createDiv();
        chosen.classList.add('reader-topic-selected');
        const list = this.contentEl.createDiv();
        list.classList.add('reader-topic-list');
        const updateSelected = () => {
          summary.textContent = `${draft.size} selected`;
          chosen.replaceChildren();
          // Chips remain visible while searching, without moving candidate rows on selection.
          for (const path of [...draft].slice(0, 100)) {
            const chip = document.createElement('span');
            chip.textContent = files.find((file) => file.path === path)?.basename ?? path;
            chip.title = path;
            chosen.append(chip);
          }
          if (draft.size > 100) {
            const more = document.createElement('span');
            more.textContent = `+${draft.size - 100} more`;
            chosen.append(more);
          }
        };
        const render = () => {
          list.replaceChildren();
          updateSelected();
          const query = search.value.trim().toLocaleLowerCase();
          const matches = files.filter((file) => file.basename.toLocaleLowerCase().includes(query));
          for (const file of matches.slice(0, 100)) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'reader-topic-row';
            row.setAttribute('aria-pressed', String(draft.has(file.path)));
            row.setAttribute('aria-label', `${file.basename} — ${file.path}`);
            const name = document.createElement('span');
            name.textContent = file.basename;
            const path = document.createElement('small');
            path.textContent = file.path;
            const check = document.createElement('span');
            check.className = 'reader-topic-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = draft.has(file.path) ? '✓' : '';
            row.append(name, path, check);
            row.addEventListener('click', () => {
              if (busy) return;
              if (draft.has(file.path)) draft.delete(file.path);
              else draft.add(file.path);
              row.setAttribute('aria-pressed', String(draft.has(file.path)));
              check.textContent = draft.has(file.path) ? '✓' : '';
              updateSelected();
            });
            list.append(row);
          }
          if (matches.length > 100)
            list.createEl('p', { text: 'Refine your search to see more topics.' });
        };
        search.addEventListener('input', render);
        render();
        search.focus();
        this.contentEl.createEl('p', {
          text: creation?.create
            ? 'Add topic saves the new topic and its article link immediately. Cancel keeps them; other selections are saved only with Save.'
            : (creation?.disabledReason ??
              'Add topic requires Fileclass Inline topic creation support.'),
        });
        const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
        const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
        let saveButton: { setDisabled(value: boolean): unknown };
        new Setting(this.contentEl).addButton((button) =>
          button
            .setButtonText('Add topic')
            .setDisabled(!creation?.create)
            .onClick(async () => {
              if (busy || !creation?.create || controller.signal.aborted) return;
              busy = true;
              button.setDisabled(true);
              saveButton.setDisabled(true);
              error.textContent = '';
              status.textContent = 'Creating topic…';
              let linked = false;
              try {
                await creation.create(
                  controller.signal,
                  (file) => {
                    if (controller.signal.aborted) return;
                    linked = true; // Invoked only after the guarded article link has committed.
                    if (!files.some((candidate) => candidate.path === file.path)) files.push(file);
                    draft.add(file.path);
                    // Preserve the search and the visible selection; the new chip confirms the link.
                    render();
                  },
                  search.value.trim() || undefined,
                );
                if (!controller.signal.aborted) {
                  status.textContent = linked ? 'Topic created and linked.' : 'No topic was added.';
                  search.focus();
                }
              } catch (cause) {
                if (!controller.signal.aborted) {
                  status.textContent = '';
                  error.textContent = cause instanceof Error ? cause.message : String(cause);
                }
              } finally {
                busy = false;
                if (!controller.signal.aborted) {
                  button.setDisabled(false);
                  saveButton.setDisabled(false);
                }
              }
            }),
        );
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
          .addButton((button) =>
            (saveButton = button)
              .setButtonText('Save')
              .setCta()
              .onClick(() => {
                if (busy || controller.signal.aborted || signal?.aborted) return;
                busy = true;
                saveButton.setDisabled(true);
                error.textContent = '';
                status.textContent = 'Saving topics…';
                pendingSave = (async () => {
                  try {
                    await commit?.([...draft]);
                    if (controller.signal.aborted || signal?.aborted) return;
                    accepted = true;
                    resolve([...draft]);
                    this.close();
                  } catch (cause) {
                    if (!controller.signal.aborted) {
                      status.textContent = '';
                      error.textContent = cause instanceof Error ? cause.message : String(cause);
                    }
                  } finally {
                    busy = false;
                    if (!controller.signal.aborted) saveButton.setDisabled(false);
                  }
                })();
              }),
          );
      }
      onClose(): void {
        controller.abort();
        this.contentEl.empty();
        signal?.removeEventListener('abort', abort);
        if (!accepted) void (pendingSave ?? Promise.resolve()).then(() => resolve(null));
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

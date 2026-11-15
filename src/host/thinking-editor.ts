import { Modal, Notice, type App } from 'obsidian';

/** Explicit Markdown draft: cancellation never waits for provider/native settlement. */
export function editThinkingMarkdown(
  app: App,
  options: {
    title: string;
    preview?: string;
    body?: string;
    signal: AbortSignal;
    save(body: string, signal: AbortSignal): Promise<{ status: string; message?: string }>;
  },
): void {
  const lifetime = new AbortController();
  class Editor extends Modal {
    onOpen(): void {
      this.setTitle(options.title);
      this.contentEl.addClass('reader-thinking-editor');
      if (options.preview) this.contentEl.createEl('blockquote', { text: options.preview });
      const field = this.contentEl.createEl('textarea', {
        attr: { 'aria-label': 'Comment Markdown', spellcheck: 'true' },
      });
      field.value = options.body ?? '';
      const status = this.contentEl.createEl('p', {
        attr: { role: 'status', 'aria-live': 'polite' },
      });
      const actions = this.contentEl.createDiv({ cls: 'reader-thinking-actions' });
      const cancel = actions.createEl('button', { text: 'Cancel' });
      cancel.addEventListener('click', () => this.close());
      const save = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
      let pending = false;
      save.addEventListener('click', async () => {
        if (pending || lifetime.signal.aborted || !field.value.trim()) return;
        pending = true;
        save.disabled = true;
        field.disabled = true;
        status.textContent = 'Saving locally…';
        try {
          const result = await options.save(field.value, lifetime.signal);
          if (lifetime.signal.aborted) return;
          if (result.status === 'saved' || result.status === 'unchanged') {
            new Notice(
              result.status === 'unchanged'
                ? 'Already saved.'
                : 'Saved locally. Obsidian handles Sync.',
            );
            this.close();
          } else {
            status.textContent =
              result.message ??
              (result.status === 'possibly-saved'
                ? 'Possibly saved — open notebook to check. Do not repeat this save blindly.'
                : 'Not saved. Open the notebook and check before retrying.');
            cancel.textContent = 'Close';
            // An uncertain dispatch is never exposed as an automatic re-append.
          }
        } catch (error) {
          if (lifetime.signal.aborted) return;
          status.textContent = error instanceof Error ? error.message : String(error);
          pending = false;
          save.disabled = false;
          field.disabled = false;
        }
      });
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save.click();
        }
      });
      field.focus();
    }
    onClose(): void {
      lifetime.abort();
      options.signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Editor(app),
    abort = () => modal.close();
  if (options.signal.aborted) return;
  options.signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

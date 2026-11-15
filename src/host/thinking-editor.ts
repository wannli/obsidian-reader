import { Modal, Notice, type App } from 'obsidian';
import type { ThinkingRecord, ThinkingTarget } from '../core/thinking';

export interface ThinkingEditorResult {
  status: string;
  message?: string;
  actions?: readonly { label: string; run(): void | Promise<void> }[];
}
/** Native evidence offers choices; it does not make this new draft saved. */
export function thinkingEditorResult(
  result: { status: string; existingCandidates?: readonly ThinkingRecord[] },
  message: string,
  open: (target: ThinkingTarget) => void | Promise<void>,
): ThinkingEditorResult {
  const candidates = result.existingCandidates ?? [];
  return {
    status: result.status,
    message: candidates.length ? `This draft was not saved again. ${message}` : message,
    actions: candidates.map((record) => ({
      label: `Open existing saved writing — ${record.path} (^${record.blockId})`,
      run: () => open({ path: record.path, blockId: record.blockId }),
    })),
  };
}

/** Explicit Markdown draft: cancellation never waits for provider/native settlement. */
export function editThinkingMarkdown(
  app: App,
  options: {
    title: string;
    preview?: string;
    body?: string;
    signal: AbortSignal;
    save(body: string, signal: AbortSignal): Promise<ThinkingEditorResult>;
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
            for (const action of result.actions ?? []) {
              const choice = actions.createEl('button', { text: action.label });
              choice.addEventListener('click', () => {
                if (lifetime.signal.aborted) return;
                // Close/cancel synchronously, independently of any navigation work.
                this.close();
                try {
                  void Promise.resolve(action.run()).catch(
                    (error) => new Notice(error instanceof Error ? error.message : String(error)),
                  );
                } catch (error) {
                  new Notice(error instanceof Error ? error.message : String(error));
                }
              });
            }
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

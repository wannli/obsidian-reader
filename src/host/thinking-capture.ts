import { Modal, type App } from 'obsidian';

/** Touch targeting confirms source words, never a per-passage class or destination. */
export function previewThinkingSelection(
  app: App,
  quote: string,
  signal: AbortSignal,
  capture: (action: 'keep' | 'comment' | 'exploration') => void,
): void {
  class Preview extends Modal {
    onOpen(): void {
      this.setTitle('Selected source passage');
      this.contentEl.addClass('reader-thinking-browser');
      this.contentEl.createEl('blockquote', { text: quote });
      const actions = this.contentEl.createDiv({ cls: 'reader-thinking-actions' });
      for (const [label, action] of [
        ['Keep passage', 'keep'],
        ['Comment', 'comment'],
        ['Add to exploration', 'exploration'],
      ] as const)
        actions.createEl('button', { text: label }).addEventListener('click', () => {
          if (signal.aborted) return;
          this.close();
          capture(action);
        });
      actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    }
    onClose(): void {
      signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Preview(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

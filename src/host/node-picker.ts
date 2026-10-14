import { SuggestModal, setIcon, type App } from 'obsidian';
import type { NodesApi, NodeResult } from './nodes';

export function pickNode(
  app: App,
  api: NodesApi,
  query: string,
  signal: AbortSignal,
): Promise<NodeResult | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Public cache snapshots only; never enumerate the index or classes per rendered row.
    const types = new Map(api.listTypes().map((type) => [type.type, type]));
    let chosen = false;
    class Picker extends SuggestModal<NodeResult> {
      getSuggestions(query: string): NodeResult[] {
        return signal.aborted ? [] : api.searchNodes(query).slice(0, 100);
      }
      renderSuggestion(node: NodeResult, element: HTMLElement): void {
        element.createDiv({ text: node.title });
        const classes = element.createDiv({ cls: 'reader-node-classes' });
        for (const name of node.classes) {
          const schema = types.get(name);
          const badge = classes.createEl('small', { cls: 'reader-node-class' });
          const icon = schema?.icon ?? (name === node.type ? node.icon : undefined);
          if (icon) setIcon(badge.createEl('span', { attr: { 'aria-hidden': 'true' } }), icon);
          badge.createEl('span', { text: schema?.label ?? name });
        }
      }
      onChooseSuggestion(node: NodeResult): void {
        if (!signal.aborted) {
          chosen = true;
          resolve(node);
        }
      }
      onClose(): void {
        super.onClose();
        signal.removeEventListener('abort', abort);
        queueMicrotask(() => {
          if (!chosen) resolve(null);
        });
      }
    }
    const picker = new Picker(app),
      abort = () => picker.close();
    if (signal.aborted) {
      resolve(null);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    picker.setPlaceholder('Link passage to note by class');
    picker.open();
    picker.inputEl.value = query;
    picker.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

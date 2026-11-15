import { Modal, TFile, type App } from 'obsidian';
import { nodesApi } from './nodes';
import { FileclassBridge } from './fileclass/fileclass';
import { linkPath, vaultLink } from '../core/model';

export interface ThinkingSettings {
  notebook: string;
  notebookType: string;
  explorationType: string;
  bindingProperty: string;
}
export function loadThinkingSettings(data: unknown): ThinkingSettings | undefined {
  const candidate =
    data && typeof data === 'object' ? (data as Record<string, unknown>).thinking : undefined;
  if (!candidate || typeof candidate !== 'object') return;
  const value = candidate as Record<string, unknown>;
  if (
    ['notebook', 'notebookType', 'explorationType', 'bindingProperty'].some(
      (key) => typeof value[key] !== 'string' || !(value[key] as string).trim(),
    ) ||
    !linkPath(value.notebook as string)
  )
    return;
  return {
    notebook: value.notebook as string,
    notebookType: value.notebookType as string,
    explorationType: value.explorationType as string,
    bindingProperty: value.bindingProperty as string,
  };
}
/** A provider may ignore cancellation. Release the UI without undoing its created file. */
export async function providerResult<T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let abort!: () => void;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        abort = () => resolve(null);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export function configureThinking(
  app: App,
  current: ThinkingSettings | undefined,
  fallbackBinding: string,
  persist: (settings: ThinkingSettings) => Promise<void>,
  signal: AbortSignal,
): void {
  const lifetime = new AbortController();
  class Setup extends Modal {
    onOpen(): void {
      this.setTitle('Configure saved thinking');
      this.contentEl.addClass('reader-thinking-editor');
      this.contentEl.createEl('p', {
        text: 'Choose a Fileclass notebook once. Keep and Comment then save here without a class or destination prompt. No types are installed or changed.',
      });
      const api = nodesApi(app);
      const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
      if (!api) {
        error.textContent =
          'Enable Fileclass public API v1 to configure or create containers. Existing configured notebook body editing remains available without it.';
        return;
      }
      const types = api.listTypes();
      if (!types.length) {
        error.textContent =
          'Create the intended notebook and exploration types in Fileclass, then reopen Configure saved thinking.';
        return;
      }
      const select = (label: string, value?: string) => {
        const row = this.contentEl.createEl('label', { text: label });
        const field = row.createEl('select', { attr: { 'aria-label': label } });
        for (const type of types) field.createEl('option', { text: type.label, value: type.type });
        if (value && types.some((t) => t.type === value)) field.value = value;
        return field;
      };
      const notebookType = select('Notebook type', current?.notebookType);
      const explorationType = select('Exploration type', current?.explorationType);
      const row = this.contentEl.createEl('label', { text: 'Capture notebook' });
      const notebook = row.createEl('select', { attr: { 'aria-label': 'Capture notebook' } });
      const refresh = () => {
        notebook.empty();
        notebook.createEl('option', { text: 'Choose an existing notebook', value: '' });
        for (const node of api
          .searchNodes('')
          .filter((n) => n.classes.includes(notebookType.value)))
          notebook.createEl('option', { text: node.title + ' — ' + node.path, value: node.path });
        const path = current && linkPath(current.notebook);
        const file = path && app.metadataCache.getFirstLinkpathDest(path, '');
        if (file && [...notebook.options].some((o) => o.value === file.path))
          notebook.value = file.path;
      };
      notebookType.addEventListener('change', refresh);
      refresh();
      const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
      const controls = this.contentEl.createDiv({ cls: 'reader-thinking-actions' });
      const create = controls.createEl('button', { text: 'Create notebook through Fileclass' });
      create.addEventListener('click', async () => {
        if (create.disabled || lifetime.signal.aborted) return;
        create.disabled = true;
        error.textContent = '';
        try {
          const node = await providerResult(
            api.createNode({ type: notebookType.value, signal: lifetime.signal }),
            lifetime.signal,
          );
          if (lifetime.signal.aborted) return;
          if (nodesApi(app) !== api)
            throw new Error(
              'Fileclass changed. Any created note is preserved; reopen setup to select it.',
            );
          refresh();
          if (node) {
            notebook.createEl('option', { text: node.title + ' — ' + node.path, value: node.path });
            notebook.value = node.path;
            status.textContent = 'Notebook created. Review the destination and save configuration.';
          } else
            status.textContent =
              'Creation cancelled. Any already-created note is preserved; choose it above if needed.';
        } catch (failure) {
          error.textContent = failure instanceof Error ? failure.message : String(failure);
        } finally {
          create.disabled = false;
        }
      });
      controls.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
      const save = controls.createEl('button', { text: 'Use this notebook', cls: 'mod-cta' });
      save.addEventListener('click', async () => {
        if (save.disabled || lifetime.signal.aborted) return;
        save.disabled = true;
        try {
          if (nodesApi(app) !== api) throw new Error('Fileclass changed. Reopen setup.');
          const node = api.getNode(notebook.value),
            file = app.vault.getAbstractFileByPath(notebook.value);
          if (!node?.classes.includes(notebookType.value) || !(file instanceof TFile))
            throw new Error('Choose an eligible existing notebook first.');
          const bindingProperty = new FileclassBridge(app).bindingProperty(fallbackBinding);
          await persist({
            notebook: vaultLink(file.path),
            notebookType: notebookType.value,
            explorationType: explorationType.value,
            bindingProperty,
          });
          if (!lifetime.signal.aborted) this.close();
        } catch (failure) {
          error.textContent = failure instanceof Error ? failure.message : String(failure);
          save.disabled = false;
        }
      });
    }
    onClose(): void {
      lifetime.abort();
      signal.removeEventListener('abort', abort);
      this.contentEl.empty();
    }
  }
  const modal = new Setup(app),
    abort = () => modal.close();
  if (signal.aborted) return;
  signal.addEventListener('abort', abort, { once: true });
  modal.open();
}

import { Modal, type App } from 'obsidian';
import { hasNodeClass, nodeChoiceMatch, nodeChoiceSeed } from '../core/node-choices';
import type { HighlightHostApi, HighlightHostChoice } from './highlight-picker';

/** One type tap creates a new typed note; existing-note selection belongs to the highlight picker. */
export function choosePassageNode(
  app: App,
  api: HighlightHostApi,
  passage: string,
  signal?: AbortSignal,
): Promise<HighlightHostChoice | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: HighlightHostChoice | null) => {
      if (settled || (choice && signal?.aborted)) return;
      settled = true;
      resolve(choice);
      modal.close();
    };
    class PassageNodeDialog extends Modal {
      onOpen(): void {
        this.setTitle('New note');
        this.modalEl.classList.add('reader-highlight-picker-modal', 'reader-picker-node');
        this.contentEl.classList.add('reader-passage-node-picker');
        const doc = this.contentEl.ownerDocument;
        const title = doc.createElement('input');
        title.className = 'reader-passage-node-title';
        title.type = 'text';
        title.setAttribute('aria-label', 'New note title');
        title.placeholder = 'Note title';
        title.value = nodeChoiceSeed(passage, 48);
        const typesEl = doc.createElement('div');
        typesEl.className = 'reader-passage-node-types';
        this.contentEl.append(title, typesEl);
        typesEl.setAttribute('role', 'group');
        typesEl.setAttribute('aria-label', 'Create note as');
        const message = doc.createElement('div');
        message.className = 'reader-highlight-picker-message';
        this.contentEl.append(message);
        message.setAttribute('role', 'alert');
        message.hidden = true;
        const error = (reason: string) => {
          message.textContent = reason;
          message.hidden = false;
        };
        const refresh = () => {
          typesEl.replaceChildren();
          message.hidden = true;
          try {
            if (
              api.version !== 2 ||
              typeof api.listTypes !== 'function' ||
              typeof api.searchNodes !== 'function' ||
              typeof api.getNode !== 'function' ||
              typeof api.createNodeForLink !== 'function'
            )
              throw new Error('Fileclass linked-note creation is unavailable.');
            const listed = api.listTypes();
            if (!Array.isArray(listed)) throw new Error('Fileclass types are unavailable.');
            const types = [
              ...new Map(
                listed
                  .filter(
                    (entry) =>
                      typeof entry.type === 'string' &&
                      entry.type.trim() &&
                      !['article', 'feed'].includes(entry.type.toLocaleLowerCase()),
                  )
                  .map((entry) => [entry.type, entry]),
              ).values(),
            ];
            if (!types.length) throw new Error('No note types are available.');
            for (const type of types) {
              const button = doc.createElement('button');
              button.textContent = type.label || type.type;
              button.type = 'button';
              typesEl.append(button);
              button.setAttribute('aria-label', `Create ${type.label || type.type} note`);
              button.addEventListener('click', () => {
                if (settled || signal?.aborted) return;
                message.hidden = true;
                const name = title.value.replace(/\s+/gu, ' ').trim();
                if (!name) {
                  error('Enter a note title first.');
                  title.focus();
                  return;
                }
                try {
                  // Recheck live membership and collisions at the action boundary.
                  if (
                    api.version !== 2 ||
                    typeof api.createNodeForLink !== 'function' ||
                    !api.listTypes().some((entry) => entry.type === type.type)
                  )
                    throw new Error('This note type is no longer available.');
                  const found = api.searchNodes(name);
                  if (!Array.isArray(found)) throw new Error('Typed-note search is unavailable.');
                  if (
                    found.some((node) => {
                      const fresh = api.getNode(node.path);
                      return (
                        fresh &&
                        fresh.path === node.path &&
                        hasNodeClass(fresh, types, type.type) &&
                        ['Exact title', 'Exact alias'].includes(nodeChoiceMatch(fresh, name) ?? '')
                      );
                    })
                  ) {
                    error(
                      'A note with this title already exists. Change the title to create a new one.',
                    );
                    title.focus();
                    return;
                  }
                  finish({ kind: 'create', title: name, type: type.type });
                } catch (cause) {
                  error(
                    cause instanceof Error
                      ? cause.message
                      : 'Typed notes are unavailable. Try again.',
                  );
                }
              });
            }
          } catch (cause) {
            error(
              cause instanceof Error ? cause.message : 'Typed notes are unavailable. Try again.',
            );
          }
        };
        refresh();
        // Do not focus the input: opening the keyboard would hide the one-tap choices on phones.
      }
      onClose(): void {
        signal?.removeEventListener('abort', abort);
        this.contentEl.replaceChildren();
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    }
    const modal = new PassageNodeDialog(app);
    const abort = () => finish(null);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) finish(null);
    else modal.open();
  });
}

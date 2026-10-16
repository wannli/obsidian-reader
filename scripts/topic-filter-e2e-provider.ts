// Synthetic public Fileclass Inline v2 contract, NOT the native companion plugin.
import { Modal } from 'obsidian';
import { readDocument } from '../src/core/document';

export function syntheticTopicProvider(app, vault, note) {
  const trace = [];
  let enabled = true;
  const getNode = (path) => {
    const file = vault.file(path);
    if (!file) return null;
    const props = readDocument(vault.bytes.get(file)).properties;
    if (props.type !== 'topic') return null;
    return {
      path,
      title: props.title ?? file.basename,
      type: 'topic',
      classes: ['topic'],
      aliases: props.aliases ?? [],
    };
  };
  const api = {
    version: 2,
    listTypes: () => [{ type: 'topic', label: 'Topic', icon: 'tags' }],
    getNode,
    searchNodes: (query) =>
      [...vault.files.keys()]
        .map(getNode)
        .filter((node) => node && node.title.toLowerCase().includes(query.toLowerCase())),
    async createNode() {
      trace.push({ event: 'unexpected-createNode' });
      throw new Error('Harness expects public createNodeForLink, not createNode');
    },
    createNodeForLink(options, link) {
      trace.push({ event: 'requested', type: options.type, sourcePath: options.sourcePath });
      if (options.type !== 'topic') return Promise.reject(new Error('Expected exact topic type'));
      return new Promise((resolve) => {
        let settled = false,
          created = null;
        class CreateTopic extends Modal {
          finish(result) {
            if (settled) return;
            settled = true;
            resolve(result);
            this.close();
          }
          onClose() {
            options.signal?.removeEventListener('abort', abort);
            if (!settled) {
              settled = true;
              trace.push({ event: 'cancelled', path: created?.path });
              resolve(null);
            }
          }
          onOpen() {
            this.setTitle('Synthetic Fileclass: Create topic');
            this.contentEl.createEl('p', {
              text: 'Mock public v2 contract only — not native Fileclass proof.',
            });
            const name = this.contentEl.createEl('input', {
              placeholder: 'Topic name',
              attr: { 'aria-label': 'New topic name' },
            });
            name.value = options.suggestedTitle ?? '';
            const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
            const create = this.contentEl.createEl('button', { text: 'Create and link' });
            create.onclick = async () => {
              create.disabled = true;
              try {
                if (options.signal?.aborted) throw new Error('Creation aborted');
                const title = name.value.trim();
                if (!title || /[\\/#]/.test(title)) throw new Error('Enter a simple topic name');
                const path = `Topics/${title}.md`;
                await note(path, { type: 'topic', title });
                created = getNode(path);
                trace.push({ event: 'created', path });
                trace.push({ event: 'callback-start', path });
                await link(created);
                const source = vault.file(options.sourcePath);
                trace.push({
                  event: 'callback-complete',
                  path,
                  sourceRaw: source ? vault.bytes.get(source) : null,
                });
                if (settled || options.signal?.aborted) return;
                this.contentEl.empty();
                this.contentEl.createEl('p', {
                  text: 'Topic linked. Synthetic required-field completion follows.',
                });
                const required = this.contentEl.createEl('input', {
                  placeholder: 'Required detail',
                  attr: { 'aria-label': 'Required topic detail' },
                });
                const done = this.contentEl.createEl('button', {
                  text: 'Complete required fields',
                });
                done.onclick = () => {
                  if (!required.value.trim()) {
                    required.focus();
                    return;
                  }
                  trace.push({ event: 'required-complete', path });
                  this.finish(created);
                };
                const cancel = this.contentEl.createEl('button', { text: 'Cancel completion' });
                cancel.onclick = () => {
                  trace.push({ event: 'completion-cancelled', path });
                  this.finish(null);
                };
                trace.push({ event: 'required-form-shown', path });
                required.focus();
              } catch (failure) {
                error.textContent = String(failure);
                trace.push({ event: 'failure', message: String(failure) });
                create.disabled = false;
              }
            };
            const cancel = this.contentEl.createEl('button', { text: 'Cancel creation' });
            cancel.onclick = () => this.close();
            name.focus();
          }
        }
        const modal = new CreateTopic(app),
          abort = () => modal.close();
        if (options.signal?.aborted) {
          resolve(null);
          return;
        }
        options.signal?.addEventListener('abort', abort, { once: true });
        modal.open();
      });
    },
  };
  return {
    api,
    trace,
    get enabled() {
      return enabled;
    },
    set enabled(value) {
      enabled = !!value;
    },
  };
}

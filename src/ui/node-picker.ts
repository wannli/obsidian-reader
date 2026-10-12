import { SuggestModal, Notice, type App } from 'obsidian';
import { nodesApi, NODES_UNAVAILABLE, NODE_COLORS, suggestedNodeTitle, type NodeResult } from '../nodes-api';
import { ReaderPicker, ReaderInput } from './native-dialogs';
type Choice = NodeResult | { create: true };
export class NodePicker extends SuggestModal<Choice> {
  private abort = new AbortController();
  private selected = false;
  private settled = false;
  private finish() { if (this.settled) return; this.settled = true; this.abort.abort(); this.finished(); }
  private active() { return !this.settled && !this.abort.signal.aborted && this.current(); }
  onClose() { super.onClose(); queueMicrotask(() => { if (!this.selected) this.finish(); }); }
  private child?: { close(): void };
  dispose() { this.abort.abort(); this.child?.close(); this.close(); this.finish(); }
  constructor(app: App, private quote: string, private sourcePath: string, private current: () => boolean, private choose: (node: NodeResult) => Promise<void>, private finished: () => void = () => {}, private preflight: () => Promise<void> = async () => {}) { super(app); this.setPlaceholder('Find a node by name or alias'); }
  onOpen() { super.onOpen(); this.inputEl.value = this.quote; this.inputEl.dispatchEvent(new Event('input')); }
  getSuggestions(query: string): Choice[] { return [...(nodesApi(this.app)?.searchNodes(query).slice(0, 100) ?? []), { create: true }]; }
  renderSuggestion(item: Choice, el: HTMLElement) {
    if ('create' in item) { el.createDiv({ text: 'Create new node…' }); return; }
    el.createDiv({ text: item.title });
    el.createSpan({ text: item.type, cls: 'r2-node-badge' }).dataset.nodeColor = item.color ?? '';
    if (item.aliases.length) el.createDiv({ text: item.aliases.join(', '), cls: 'r2-muted' });
    el.createDiv({ text: item.path, cls: 'r2-muted' });
  }
  onChooseSuggestion(item: Choice) { if (this.selected || !this.active()) { if (!this.active()) this.finish(); return; } this.selected = true; void this.select(item).catch(error => { this.finish(); new Notice(String(error)); }); }
  private async select(item: Choice) {
    if (!this.active()) { this.finish(); return; }
    const api = nodesApi(this.app); if (!api) { this.finish(); new Notice(NODES_UNAVAILABLE); return; }
    if (!('create' in item)) { const node = api.getNode(item.path); if (!node) throw new Error('Node no longer exists. Reopen the picker.'); await this.choose(node); this.finish(); return; }
    const types = api.listTypes();
    if (!types.length) { this.finish(); new Notice('Create a schema in Nodes first.'); return; }
    const create = async (type: string, title?: string) => {
      try {
      if (!this.active()) { this.finish(); return; }
      await this.preflight();
      if (!this.active()) { this.finish(); return; }
      const live = nodesApi(this.app); if (!live) throw new Error(NODES_UNAVAILABLE);
      const node = await live.createNode({ type, suggestedTitle: title, sourcePath: this.sourcePath, signal: this.abort.signal });
      if (!node) { this.finish(); return; }
      if (nodesApi(this.app) !== live) { new Notice('Node kept. Nodes was disabled or reloaded; reopen the highlight.'); return; }
      if (!this.active()) { new Notice('Node created and kept. The highlight changed; reopen it to link.'); return; }
      try { await this.choose(node); } catch (error) { new Notice('Node created and kept; linking failed. ' + String(error)); }
      } finally { this.finish(); }
    };
    let choseType = false;
    const picker = new ReaderPicker(this.app, 'Choose a Nodes schema', types, type => `${type.color ? NODE_COLORS[type.color] + ' ' : ''}${type.label}`, type => {
      choseType = true;
      if (!this.active()) { this.finish(); return; }
      const title = suggestedNodeTitle(this.quote);
      if (title) void create(type.type, title).catch(error => { this.finish(); new Notice(String(error)); });
      else { const input = new ReaderInput(this.app, 'Create new node', 'Short node title (not the whole passage)', async title => {
        if (!title) throw new Error('Enter a short title.'); await create(type.type, title);
      }); input.finished = () => this.finish(); this.child = input; input.open(); }
    }); picker.finished = () => queueMicrotask(() => { if (!choseType) this.finish(); }); this.child = picker; picker.open();
  }
}

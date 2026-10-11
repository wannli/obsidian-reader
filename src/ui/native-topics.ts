import { Modal, Notice, type App } from 'obsidian';
import type { ReaderController } from '../controller';
import type { RelationshipProperty } from '../storage/topic-links';
import { RelationshipDraft } from './relationship-draft';
import { relationshipPicker } from './relationship-picker';
/** Save is the only confirmation point, including explicit node creation. */
export class ReaderTopics extends Modal {
  finished?: () => void;
  private closed = false;
  private picker?: ReturnType<typeof relationshipPicker>;
  constructor(app: App, private controller: ReaderController, private path: string,
    private property: RelationshipProperty = 'topics', private current: () => boolean = () => true) { super(app); }
  async onOpen() {
    this.closed = false; this.setTitle('Assign ' + this.property); this.contentEl.createEl('p', { text: `Loading ${this.property}…` });
    try {
      const draft = await RelationshipDraft.load(this.controller, this.path, this.property, () => !this.closed && this.current());
      if (this.closed) return;
      this.contentEl.empty();
      this.picker = relationshipPicker(this.contentEl, draft, () => this.close(), () => { new Notice(this.property === 'authors' ? 'Authors updated' : 'Topics updated'); });
    } catch (error) { if (!this.closed) this.contentEl.setText(error instanceof Error ? error.message : String(error)); }
  }
  close() { if (!this.picker?.isSaving()) super.close(); }
  closeForShutdown() { this.closed = true; this.picker?.dispose(); super.close(); }
  onClose() { this.closed = true; this.picker?.dispose(); this.contentEl.empty(); this.finished?.(); }
}

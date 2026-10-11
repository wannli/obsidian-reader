import { FuzzySuggestModal, Modal, Setting, Notice, type App } from 'obsidian';
import type { ReaderController } from '../controller';
export class ReaderPicker<T> extends FuzzySuggestModal<T> {
  finished?: () => void;
  constructor(app: App, placeholder: string, private items: T[], private label: (item: T) => string, private choose: (item: T) => void) { super(app); this.setPlaceholder(placeholder); }
  getItems(): T[] { return this.items; }
  getItemText(item: T): string { return this.label(item); }
  onChooseItem(item: T): void { this.choose(item); }
  onClose() { super.onClose(); this.finished?.(); }
}
export class ReaderInput extends Modal {
  finished?: () => void;
  private closed = false;
  constructor(app: App, private title: string, private label: string, private submit: (value: string) => Promise<void>, private initial = '') { super(app); }
  onOpen() {
    this.closed = false; this.setTitle(this.title); let value = this.initial;
    const field = new Setting(this.contentEl).setName(this.label).addText(text => { text.setValue(value).onChange(next => value = next); text.inputEl.setAttribute('aria-label', this.label); text.inputEl.focus(); });
    const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
    new Setting(this.contentEl).addButton(button => button.setButtonText('Cancel').onClick(() => this.close())).addButton(button => button.setButtonText('Save').setCta().onClick(async () => {
      button.setDisabled(true); error.textContent = ''; field.controlEl.querySelector('input')!.disabled = true;
      try { await this.submit(value.trim()); if (!this.closed) this.close(); }
      catch (failure) { if (!this.closed) { error.textContent = failure instanceof Error ? failure.message : String(failure); button.setDisabled(false); field.controlEl.querySelector('input')!.disabled = false; } }
    }));
  }
  onClose() { this.closed = true; this.contentEl.empty(); this.finished?.(); }
}
export class ReaderFeeds extends Modal {
  finished?: () => void;
  private closed = false;
  constructor(app: App, private controller: ReaderController, private openInput = (modal: ReaderInput) => modal.open()) { super(app); }
  async onOpen() {
    this.closed = false; this.setTitle('RSS feeds');
    const feeds = await this.controller.repository.listFeeds(); if (this.closed) return;
    for (const feed of feeds) new Setting(this.contentEl).setName(feed.title).setDesc(feed.error ?? feed.url).addToggle(toggle => toggle.setValue(feed.enabled).onChange(async enabled => {
      try { await this.controller.repository.updateFeed(feed.path, { enabled }); } catch (error) { new Notice(String(error)); toggle.setValue(feed.enabled); }
    }));
    new Setting(this.contentEl).addButton(button => button.setButtonText('Add feed').onClick(() => this.openInput(new ReaderInput(this.app, 'Add feed', 'URL', async url => {
      await this.controller.subscribeFeed(url); if (!this.closed) { this.contentEl.empty(); await this.onOpen(); }
    })))).addButton(button => button.setButtonText('Refresh feeds').onClick(async () => {
      button.setDisabled(true); try { await this.controller.refreshFeeds(); if (!this.closed) new Notice(this.controller.message); } catch (error) { if (!this.closed) new Notice(String(error)); } finally { if (!this.closed) button.setDisabled(false); }
    }));
  }
  onClose() { this.closed = true; this.contentEl.empty(); this.finished?.(); }
}

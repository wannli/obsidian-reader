import { Modal, Setting, type App, type TFile } from 'obsidian';
import { ReaderPicker } from './native-dialogs';
import { isAcquisitionUrl } from '../acquisition-url';
type Choice = { file: TFile } | { url: true };
/** Exact quote is retained in a native textarea; file selection never creates files. */
export class HighlightLinkPicker extends Modal {
  finished?: () => void;
  private completed = false;
  private closed = false;
  private picker?: ReaderPicker<Choice>;
  private urlInput?: HTMLInputElement;
  constructor(app: App, private quote: string, private reason: string | undefined, private choose: (target: string | null) => void) { super(app); }
  onOpen() {
    this.setTitle('Link to…');
    if (this.reason) this.contentEl.createEl('p', { text: this.reason });
    new Setting(this.contentEl).setName('Selected text').addTextArea(text => {
      text.setValue(this.quote); text.inputEl.readOnly = true; text.inputEl.setAttribute('aria-label', 'Selected text'); text.inputEl.rows = 3;
    });
    new Setting(this.contentEl).setName('Existing note').addButton(button => button.setButtonText('Choose note').onClick(() => this.openNotes()));
    let url = /^https?:\/\//i.test(this.quote) ? this.quote : '';
    new Setting(this.contentEl).setName('HTTP(S) URL').addText(text => { text.setValue(url).onChange(value => { url = value; }); this.urlInput = text.inputEl; text.inputEl.setAttribute('aria-label', 'HTTP(S) URL'); });
    const error = this.contentEl.createEl('p', { attr: { role: 'alert' } });
    new Setting(this.contentEl).addButton(button => button.setButtonText('Cancel').onClick(() => this.close())).addButton(button => button.setButtonText('Link URL').setCta().onClick(() => {
      if (!isAcquisitionUrl(url)) { error.textContent = 'Enter a complete HTTP(S) URL. The quote will not be changed.'; return; }
      this.finish(url.trim());
    }));
    if (!this.reason) queueMicrotask(() => this.openNotes());
  }
  private finish(target: string) { if (this.closed || this.completed) return; this.completed = true; this.close(); this.choose(target); }
  private openNotes() {
    if (this.closed) return; let chosen = false;
    const choices: Choice[] = [...this.app.vault.getMarkdownFiles().map(file => ({ file })), { url: true }];
    const picker = new ReaderPicker(this.app, 'Link to an existing note', choices, choice => 'file' in choice ? choice.file.path.replace(/\.md$/, '') : 'Link to an HTTP(S) URL…', choice => {
      chosen = true; if (this.closed) return;
      if ('file' in choice) this.finish(choice.file.path.replace(/\.md$/, '')); else this.urlInput?.focus();
    });
    picker.finished = () => queueMicrotask(() => { if (!chosen && !this.closed) this.close(); }); this.picker = picker; picker.open();
  }
  onClose() {
    if (this.closed) return; this.closed = true; this.picker?.close(); this.contentEl.empty(); this.finished?.();
    if (!this.completed) { this.completed = true; this.choose(null); }
  }
}

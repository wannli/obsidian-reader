import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import { HIGHLIGHT_COLORS, validateHighlightTypes } from './typed-highlights';
import type ReaderPlugin from './main';
export class ReaderSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: ReaderPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty(); this.containerEl.createEl('h2', { text: 'Reader' });
    this.containerEl.createEl('p', { text: 'Everything lives in Markdown. Unfinished articles acquire full text while Obsidian is active, Inbox and Later first. Nothing runs while iOS suspends Obsidian. Saved text works offline; remote images need a connection.' });
    this.containerEl.createEl('h3', { text: 'Typed highlights' });
    this.containerEl.createEl('p', { text: 'Click an existing highlight to create or reuse a normal note in Nodes. Type names and colors are saved together below.' });
    const draft = this.plugin.settings.typedHighlightTypes.map(type => ({ ...type }));
    const rows = this.containerEl.createDiv();
    const renderTypes = () => {
      rows.empty();
      draft.forEach((type, index) => {
        new Setting(rows).setName('Highlight type').addText(input => input.setValue(type.name).onChange(value => { type.name = value; }))
          .addDropdown(input => {
            HIGHLIGHT_COLORS.forEach(color => input.addOption(color, color));
            input.setValue(type.color).onChange(value => { type.color = value as typeof type.color; });
          }).addButton(button => button.setButtonText('Remove').onClick(() => { draft.splice(index, 1); renderTypes(); }));
      });
    };
    renderTypes();
    new Setting(this.containerEl).addButton(button => button.setButtonText('Add type').onClick(() => { draft.push({ name: '', color: '🟡' }); renderTypes(); }))
      .addButton(button => button.setButtonText('Save highlight types').onClick(async () => {
        const previous = this.plugin.settings.typedHighlightTypes;
        try { this.plugin.settings.typedHighlightTypes = validateHighlightTypes(draft); await this.plugin.saveSettings(); new Notice('Highlight types saved'); }
        catch (error) { this.plugin.settings.typedHighlightTypes = previous; new Notice(error instanceof Error ? error.message : String(error)); }
      }));
    if (this.plugin.supportsEink) {
      new Setting(this.containerEl).setName('Boox / e-ink pagination (this device)').setDesc('Off by default. Enable only for your Boox / e-ink device: Android is not e-ink detection. This device-local preference is not synced; desktop, iOS and other devices keep their current scrolling behavior.').addToggle(toggle => toggle.setValue(this.plugin.einkDevice.enabled).onChange(value => {
        if (!this.plugin.setEinkDevice({ ...this.plugin.einkDevice, enabled: value })) toggle.setValue(this.plugin.einkDevice.enabled);
      }));
      new Setting(this.containerEl).setName('Reverse page buttons (this device)').setDesc('Swap page-forward and page-back button directions in pagination mode. This device-local preference is not synced.').addToggle(toggle => toggle.setValue(this.plugin.einkDevice.reverseButtons).onChange(value => {
        if (!this.plugin.setEinkDevice({ ...this.plugin.einkDevice, reverseButtons: value })) toggle.setValue(this.plugin.einkDevice.reverseButtons);
      }));
    }
    new Setting(this.containerEl).setName('Use dummy article content').setDesc('On by default: save clearly labeled sample Markdown without fetching article HTML or running Defuddle. Feed checks may still use the network. Turn off for real extraction; authored text and highlighted snapshots stay protected.').addToggle(toggle => toggle.setValue(this.plugin.settings.useDummyContent).onChange(async value => {
      this.plugin.settings.useDummyContent = value; await this.plugin.saveSettings(); this.plugin.controller.scheduleAcquisition();
    }));
    new Setting(this.containerEl).setName('Article queues').setDesc('Reading/Inbox, Reading/Later, Reading/Stream and Reading/Treasury determine each article’s queue. Articles outside these folders remain readable but are not queued. Moving an article changes its folder.');
    new Setting(this.containerEl).setName('Wires folder').setDesc('Feed subscription notes are created here (default: Reading/Wires). Wires is not an article queue.').addText(input => input.setValue(this.plugin.settings.feedsFolder).onChange(async value => {
      const clean = value.trim();
      if (!clean || /[\r\n]/.test(clean) || clean.split('/').some(p => p === '..' || p === '.') || clean.startsWith('/')) return;
      this.plugin.settings.feedsFolder = clean; await this.plugin.saveSettings();
    }));
    new Setting(this.containerEl).setName('Refresh interval').setDesc('Minutes between foreground feed checks. No background execution on suspended iOS.').addText(input => input.setValue(String(this.plugin.settings.pollMinutes)).onChange(async value => {
      const minutes = Number(value); if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) return;
      this.plugin.settings.pollMinutes = minutes; await this.plugin.saveSettings();
    }));
    new Setting(this.containerEl).setName('Entries per feed refresh').setDesc('Limits file growth. Unfinished URL articles acquire full text automatically while Obsidian is active.').addText(input => input.setValue(String(this.plugin.settings.maxFeedItems)).onChange(async value => {
      const count = Number(value); if (!Number.isInteger(count) || count < 1 || count > 500) return;
      this.plugin.settings.maxFeedItems = count; await this.plugin.saveSettings();
    }));
  }
}

import { Setting } from 'obsidian';
import type { FileclassBackend, RequiredField } from './fileclass-contract';
import type { RequiredSession } from './required-ui';
import { multiChoices, singleChoices, touchTarget } from './required-ui-choices';
import {
  choiceTypes,
  fileChoice,
  message,
  multiple,
  unsupported,
  type Choice,
} from './required-ui-values';

export class RequiredRow {
  draft: unknown;
  choices: Choice[] = [];
  error = '';
  private loadingError = '';
  private busy = true;
  private controls: Array<(disabled: boolean) => void> = [];
  private errorEl?: HTMLElement;
  private readonly host: HTMLElement;
  constructor(
    parent: HTMLElement,
    readonly field: RequiredField,
    private session: RequiredSession,
    readonly requestField: RequiredField,
  ) {
    this.host = parent.createDiv();
  }
  async loadChoices(backend: FileclassBackend, path: string): Promise<void> {
    if (unsupported(this.field) || !choiceTypes.has(this.field.type)) return;
    try {
      // Backend descriptors carry identity/fingerprint WeakMap bindings: never send the UI snapshot.
      this.choices = await this.session.run(() => backend.choices(path, this.requestField));
      this.loadingError = '';
    } catch (error) {
      this.loadingError = `Cannot load choices: ${message(error)}`;
      throw error;
    }
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    for (const disable of this.controls) disable(busy);
  }
  setError(error: string): void {
    this.error = error;
    this.errorEl?.setText(error);
  }
  private change(value: unknown): void {
    if (this.busy || !this.session.active()) return;
    this.draft = value;
    this.setError('');
  }
  render(): void {
    this.host.empty();
    this.controls = [];
    const field = this.field;
    const setting = new Setting(this.host)
      .setName(`${field.name} *`)
      .setDesc(`${field.owner} · ${field.type}`);
    const issue = unsupported(field) || this.loadingError;
    if (field.type === 'Date' && !issue) {
      const format = field.options.dateFormat;
      const hint =
        typeof format === 'string' && format.trim()
          ? `Fileclass date format: ${format}`
          : 'Use your Fileclass date format; its global default is not exposed.';
      setting.setDesc(`${field.owner} · Date — ${hint}`);
    }
    if (issue) setting.setDesc(issue);
    else if (fileChoice(field) && !this.choices.length) {
      setting.setDesc('No candidate files. Use Fileclass to complete this required field.');
    } else if (field.type === 'Boolean') {
      setting.addDropdown((input) => {
        touchTarget(input.selectEl);
        input
          .addOption('', 'Not set')
          .addOption('true', 'True')
          .addOption('false', 'False')
          .setValue(typeof this.draft === 'boolean' ? String(this.draft) : '')
          .onChange((value) => this.change(value === '' ? undefined : value === 'true'));
        this.controls.push((disabled) => input.setDisabled(disabled));
      });
    } else if (choiceTypes.has(field.type) && this.choices.length) {
      (multiple(field) ? multiChoices : singleChoices)(setting, this.choices, {
        value: () => this.draft,
        change: (value) => this.change(value),
        active: () => !this.busy && this.session.active(),
        register: (disable) => this.controls.push(disable),
      });
    } else if (multiple(field)) {
      setting.addTextArea((input) => {
        touchTarget(input.inputEl);
        input
          .setPlaceholder('One per line')
          .setValue(Array.isArray(this.draft) ? this.draft.join('\n') : '')
          .onChange((value) =>
            this.change(
              value
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
            ),
          );
        this.controls.push((disabled) => input.setDisabled(disabled));
      });
    } else {
      setting.addText((input) => {
        touchTarget(input.inputEl);
        input.inputEl.type = field.type === 'Number' ? 'number' : 'text';
        if (field.type === 'Number') input.inputEl.setAttribute('step', 'any');
        input
          .setValue(typeof this.draft === 'string' ? this.draft : '')
          .setPlaceholder(field.type)
          .onChange((value) => this.change(value));
        this.controls.push((disabled) => input.setDisabled(disabled));
      });
    }
    this.errorEl = this.host.createEl('p', { cls: 'mod-warning', attr: { role: 'alert' } });
    this.errorEl.setText(this.error);
    this.setBusy(this.busy);
  }
}

import { type App, type ButtonComponent, Modal, Setting } from 'obsidian';
import {
  MetadataPendingError,
  type FileclassBackend,
  type RequiredField,
} from './fileclass-contract';
import type { RequiredSession } from './required-ui';
import { RequiredRow } from './required-ui-fields';
import { touchTarget } from './required-ui-choices';
import {
  choiceTypes,
  fieldKey,
  message,
  sameDefinition,
  snapshot,
  unsupported,
  validated,
} from './required-ui-values';

export class RequiredModal extends Modal {
  private rows: RequiredRow[] = [];
  private busy = true;
  private fieldsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private savedEl!: HTMLElement;
  private saveButton?: ButtonComponent;
  private saved = new Set<string>();
  constructor(
    app: App,
    private backend: FileclassBackend,
    private path: string,
    private initial: RequiredField[],
    private session: RequiredSession,
  ) {
    super(app);
    this.shouldRestoreSelection = false;
    for (const modifier of ['Ctrl', 'Meta'] as const)
      this.scope.register([modifier], 'Enter', () => {
        void this.save();
        return false;
      });
  }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: 'Complete required fields' });
    this.contentEl.createEl('p', {
      text: 'Note already created; saved fields are kept. Optional fields can be edited later in Fileclass.',
    });
    this.fieldsEl = this.contentEl.createDiv();
    this.savedEl = this.contentEl.createEl('p', { attr: { role: 'status' } });
    this.errorEl = this.contentEl.createEl('p', { cls: 'mod-warning', attr: { role: 'alert' } });
    new Setting(this.contentEl)
      .addButton((button) => {
        this.saveButton = button;
        touchTarget(button.buttonEl);
        button
          .setButtonText('Save required values')
          .setCta()
          .setTooltip('Ctrl+Enter or ⌘+Enter')
          .setDisabled(true)
          .onClick(() => this.save());
      })
      .addButton((button) => {
        touchTarget(button.buttonEl);
        button.setButtonText('Close').onClick(() => this.close());
      });
    void this.refresh(this.initial)
      .catch((error) => {
        if (this.session.active()) this.errorEl.setText(message(error));
      })
      .finally(() => {
        if (!this.session.active()) return;
        this.setBusy(false);
        // Native Modal may initially focus Close while required controls are loading.
        if (
          !this.session.active() ||
          this.fieldsEl.contains(this.contentEl.ownerDocument.activeElement)
        )
          return;
        this.fieldsEl
          .querySelector<HTMLElement>(
            'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])',
          )
          ?.focus({ preventScroll: true });
      });
  }
  onClose(): void {
    this.setBusy(true);
    this.session.close();
    this.contentEl.empty();
  }
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveButton?.setDisabled(busy);
    for (const row of this.rows) row.setBusy(busy);
  }
  private async refresh(fields: RequiredField[]): Promise<void> {
    if (!this.session.active()) return;
    const previous = this.rows;
    this.rows = [];
    this.fieldsEl.empty();
    // Snapshot every definition before the first asynchronous choice lookup.
    for (const issued of fields) {
      const field = snapshot(issued);
      const old =
        previous.find(
          (item) => fieldKey(item.field) === fieldKey(field) && item.field.issue === field.issue,
        ) ?? previous.find((item) => item.field.name === field.name);
      const unchanged = old && sameDefinition(old.field, field);
      // Keep the original backend binding across refreshes of the same displayed definition.
      const row = new RequiredRow(
        this.fieldsEl,
        field,
        this.session,
        unchanged ? old.requestField : issued,
      );
      if (unchanged) {
        row.draft = old.draft;
        row.error = old.error;
      } else if (old)
        row.error = 'Field definition changed. Review this field before saving again.';
      this.rows.push(row);
      row.render();
    }
    for (const row of this.rows) {
      try {
        await row.loadChoices(this.backend, this.path);
      } catch (error) {
        if (this.session.active()) row.error = message(error);
      }
      if (!this.session.active()) return;
      row.render();
    }
  }
  private async current(row: RequiredRow): Promise<RequiredField | undefined> {
    const fields = await this.session.run(() => this.backend.requiredFields(this.path));
    const matching = fields.filter((field) => field.name === row.field.name);
    if (!matching.length) return undefined; // Another editor already filled it: never overwrite.
    if (matching.length !== 1)
      throw new Error('Ambiguous required field name. Use Fileclass to complete this field.');
    if (!sameDefinition(row.field, matching[0])) {
      throw new Error('Field definition changed. Review this field before saving again.');
    }
    const issue = unsupported(matching[0]);
    if (issue) throw new Error(issue);
    return matching[0];
  }
  private async save(): Promise<void> {
    if (this.busy || !this.session.active()) return;
    this.setBusy(true);
    this.errorEl.setText('');
    // Values are captured once; controls cannot change a write already in progress.
    const submitted = this.rows.map((row) => ({ row, draft: structuredClone(row.draft) }));
    try {
      for (const { row, draft } of submitted) {
        if (!this.session.active()) return;
        row.setError('');
        try {
          let field = await this.current(row);
          if (!this.session.active()) return;
          if (!field) continue;
          if (choiceTypes.has(field.type)) {
            await row.loadChoices(this.backend, this.path);
            if (!this.session.active()) return;
            row.render();
            // Choice lookup can wait; recheck missingness/definition after that wait too.
            field = await this.current(row);
            if (!this.session.active()) return;
            if (!field) continue;
          }
          const value = validated(field, draft, row.choices);
          // The backend also guards target existence, metadata and choices at the actual write.
          await this.session.run(() =>
            this.backend.setValue(this.path, row.requestField, value, this.session.signal),
          );
          if (!this.session.active()) return;
          this.saved.add(`${field.name} (${field.owner})`);
          this.savedEl.setText(`Saved: ${[...this.saved].join(', ')}.`);
        } catch (error) {
          if (!this.session.active()) return;
          row.setError(message(error));
          if (error instanceof MetadataPendingError) {
            this.saved.add(`${row.field.name} (${row.field.owner})`);
            this.savedEl.setText(`Saved: ${[...this.saved].join(', ')}.`);
            row.setError(`Saved; metadata pending. ${message(error)}`);
            this.errorEl.setText(
              'Later required fields were not attempted. Wait for Fileclass metadata, then select Save required values to retry, or continue in Fileclass.',
            );
            // Do not refresh rows/choices: dependent fields must wait for an explicit retry.
            return;
          }
        }
      }
      const remaining = await this.session.run(() => this.backend.requiredFields(this.path));
      if (!this.session.active()) return;
      if (!remaining.length) {
        this.close();
        return;
      }
      for (const row of this.rows) {
        if (!row.error && remaining.some((field) => field.name === row.field.name)) {
          row.setError(
            'Fileclass still reports this required field as incomplete. Review its value.',
          );
        }
      }
      await this.refresh(remaining);
      if (this.session.active())
        this.errorEl.setText(
          'Required fields remain. Review the messages below each field; unsupported fields must be completed in Fileclass.',
        );
    } catch (error) {
      if (this.session.active())
        this.errorEl.setText(`Could not recheck required fields: ${message(error)}`);
    } finally {
      if (this.session.active()) this.setBusy(false);
    }
  }
}

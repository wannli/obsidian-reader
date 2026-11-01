import { Setting, type ButtonComponent, type DropdownComponent } from 'obsidian';
import type { Choice } from './required-ui-values';

interface ChoiceEditor {
  value(): unknown;
  change(value: unknown): void;
  active(): boolean;
  register(disable: (disabled: boolean) => void): void;
}
interface Entry extends Choice {
  key: string;
  search: string;
}
const SINGLE_LIMIT = 30,
  MULTI_LIMIT = 40;
export function touchTarget(el: HTMLElement): void {
  el.style.minHeight = '44px';
  el.style.minWidth = '44px';
  el.style.transition = 'none';
  el.style.animation = 'none';
}
function entries(choices: Choice[], selected: string[]): Entry[] {
  const known = new Set(choices.map((choice) => choice.value));
  const unavailable = selected
    .filter((value) => !known.has(value))
    .map((value) => ({ value, label: `${value} (no longer available)` }));
  return [...choices, ...unavailable].map((choice, index) => ({
    ...choice,
    key: String(index),
    search: `${choice.label}\n${choice.value}`.toLowerCase(),
  }));
}
function filterBox(
  host: HTMLElement,
  editor: ChoiceEditor,
  changed: (query: string) => void,
): () => void {
  let clear = (): void => {};
  new Setting(host).addText((input) => {
    clear = () => {
      input.setValue('');
    };
    input.setPlaceholder('Filter choices').onChange((value) => {
      if (editor.active()) changed(value.trim().toLowerCase());
    });
    input.inputEl.setAttribute('aria-label', 'Filter choices');
    touchTarget(input.inputEl);
    editor.register((disabled) => input.setDisabled(disabled));
  });
  return clear;
}

export function singleChoices(setting: Setting, choices: Choice[], editor: ChoiceEditor): void {
  const draft = editor.value();
  const all = entries(choices, typeof draft === 'string' ? [draft] : []);
  const large = all.length > SINGLE_LIMIT;
  const host = large ? setting.controlEl.createDiv() : undefined;
  if (host) host.style.width = '100%';
  let query = '',
    dropdown: DropdownComponent;
  let count: HTMLElement | undefined;
  const render = (): void => {
    const matching = all.filter((choice) => choice.search.includes(query));
    const selected = all.find((choice) => choice.value === editor.value());
    const visible = selected
      ? [selected, ...matching.filter((choice) => choice !== selected).slice(0, SINGLE_LIMIT - 1)]
      : matching.slice(0, SINGLE_LIMIT);
    dropdown.selectEl.empty();
    dropdown.addOption('', 'Not set');
    for (const choice of visible) dropdown.addOption(choice.key, choice.label);
    dropdown.setValue(selected?.key ?? '');
    count?.setText(
      matching.length
        ? `${matching.length} matching choices; ${visible.length} shown. Filter to narrow the list.`
        : `No matching choices.${selected ? ' Current selection retained.' : ''}`,
    );
  };
  if (host)
    filterBox(host, editor, (value) => {
      query = value;
      render();
    });
  (host ? new Setting(host) : setting).addDropdown((input) => {
    dropdown = input;
    touchTarget(input.selectEl);
    input.onChange((key) => {
      if (editor.active()) editor.change(key === '' ? undefined : all[Number(key)]?.value);
    });
    editor.register((disabled) => input.setDisabled(disabled));
  });
  if (host) count = host.createEl('p', { attr: { role: 'status' } });
  render();
}

export function multiChoices(setting: Setting, choices: Choice[], editor: ChoiceEditor): void {
  const selected = (): string[] => {
    const value = editor.value();
    return Array.isArray(value) ? value : [];
  };
  const all = entries(choices, selected());
  const large = all.length > MULTI_LIMIT;
  const host = setting.controlEl.createDiv();
  host.style.width = '100%';
  let query = '',
    page = 0,
    selectedOnly = false,
    disabled = true;
  let visibleInputs: HTMLInputElement[] = [],
    matches: Entry[] = [];
  let selectedButton: ButtonComponent | undefined,
    previous: ButtonComponent | undefined,
    next: ButtonComponent | undefined;
  let count: HTMLElement | undefined;
  const status = (): void => {
    const size = selected().length;
    count?.setText(
      matches.length
        ? `Showing ${page * MULTI_LIMIT + 1}–${Math.min((page + 1) * MULTI_LIMIT, matches.length)} of ${matches.length}; ${size} selected.`
        : `No matching choices; ${size} selected.`,
    );
    selectedButton
      ?.setButtonText(selectedOnly ? 'Show all choices' : `Show selected (${size})`)
      .setDisabled(disabled || (!selectedOnly && !size));
    previous?.setDisabled(disabled || page === 0);
    next?.setDisabled(disabled || (page + 1) * MULTI_LIMIT >= matches.length);
    if (previous && next)
      previous.buttonEl.hidden = next.buttonEl.hidden = matches.length <= MULTI_LIMIT;
  };
  const render = (): void => {
    const values = new Set(selected());
    matches = all.filter(
      (choice) => choice.search.includes(query) && (!selectedOnly || values.has(choice.value)),
    );
    // Keep selections accessible first; subsequent checkbox changes do not move the focused row.
    if (large)
      matches = [
        ...matches.filter((choice) => values.has(choice.value)),
        ...matches.filter((choice) => !values.has(choice.value)),
      ];
    page = Math.min(page, Math.max(0, Math.ceil(matches.length / MULTI_LIMIT) - 1));
    list.empty();
    visibleInputs = [];
    for (const choice of matches.slice(page * MULTI_LIMIT, (page + 1) * MULTI_LIMIT)) {
      const label = list.createEl('label');
      touchTarget(label);
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '8px';
      const input = label.createEl('input', {
        type: 'checkbox',
        attr: { 'aria-label': choice.label },
      });
      input.checked = values.has(choice.value);
      input.disabled = disabled;
      label.createSpan({ text: choice.label }).style.overflowWrap = 'anywhere';
      input.style.flexShrink = '0';
      visibleInputs.push(input);
      input.addEventListener('change', () => {
        if (!editor.active()) return;
        const current = selected();
        editor.change(
          input.checked
            ? [...new Set([...current, choice.value])]
            : current.filter((value) => value !== choice.value),
        );
        status();
      });
    }
    status();
  };
  const clearFilter = large
    ? filterBox(host, editor, (value) => {
        query = value;
        page = 0;
        render();
      })
    : () => {};
  const list = host.createDiv();
  if (all.length > 6) {
    list.style.maxHeight = 'min(35vh, 264px)';
    list.style.overflowY = 'auto';
    list.style.overscrollBehavior = 'contain';
  }
  if (large) {
    count = host.createEl('p', { attr: { role: 'status' } });
    const actions = new Setting(host);
    actions.controlEl.style.flexWrap = 'wrap';
    actions
      .addButton((button) => {
        selectedButton = button;
        touchTarget(button.buttonEl);
        button.onClick(() => {
          if (editor.active()) {
            selectedOnly = !selectedOnly;
            query = '';
            clearFilter();
            page = 0;
            render();
          }
        });
      })
      .addButton((button) => {
        previous = button;
        touchTarget(button.buttonEl);
        button.setButtonText('Previous choices').onClick(() => {
          if (editor.active() && page > 0) {
            page--;
            render();
          }
        });
      })
      .addButton((button) => {
        next = button;
        touchTarget(button.buttonEl);
        button.setButtonText('Next choices').onClick(() => {
          if (editor.active() && (page + 1) * MULTI_LIMIT < matches.length) {
            page++;
            render();
          }
        });
      });
  }
  // One live registration, not one closure per checkbox on every search keystroke.
  editor.register((value) => {
    disabled = value;
    for (const input of visibleInputs) input.disabled = value;
    status();
  });
  render();
}

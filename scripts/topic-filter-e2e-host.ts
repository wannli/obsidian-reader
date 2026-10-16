// Browser-only synthetic Obsidian boundary. Never opens a filesystem vault.
Object.assign(HTMLElement.prototype, {
  empty() {
    this.replaceChildren();
  },
  addClass(...names) {
    this.classList.add(...names);
  },
  removeClass(...names) {
    this.classList.remove(...names);
  },
  createEl(tag, options = {}) {
    const el = document.createElement(tag);
    if (typeof options === 'string') options = { cls: options };
    if (options.text) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    for (const [key, value] of Object.entries(options.attr ?? {}))
      el.setAttribute(key, String(value));
    for (const key of ['type', 'placeholder', 'value']) if (options[key]) el[key] = options[key];
    this.append(el);
    return el;
  },
  createDiv(options = {}) {
    return this.createEl('div', options);
  },
  createSpan(options = {}) {
    return this.createEl('span', options);
  },
  setText(value) {
    this.textContent = value;
  },
});
export class TFile {
  path = '';
  get basename() {
    return this.path.split('/').pop().replace(/\.md$/, '');
  }
}
export class ItemView {
  app;
  containerEl;
  contentEl;
  constructor(public leaf) {
    this.app = leaf.app;
    this.containerEl = document.querySelector('#reader');
    this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
  }
  async onOpen() {}
  async onClose() {}
  async setState() {}
}
export const setTooltip = (el, title) => {
  el.title = title;
  el.setAttribute('aria-label', title);
};
// Icon names are visible host placeholders, not native Lucide rendering.
export const setIcon = (el, name) => {
  el.textContent = name;
  el.dataset.icon = name;
};
export const parseLinktext = (value) => {
  const [path, ...rest] = value.split('#');
  return { path, subpath: rest.length ? '#' + rest.join('#') : '' };
};
export class Notice {
  constructor(message) {
    document.querySelector('#notices').textContent = String(message);
  }
}
export class Modal {
  containerEl = document.createElement('div');
  contentEl;
  titleEl;
  private previousFocus: Element | null = null;
  private opened = false;
  constructor(public app) {
    this.containerEl.className = 'modal-container';
    this.containerEl.setAttribute('role', 'dialog');
    this.containerEl.setAttribute('aria-modal', 'true');
    this.titleEl = this.containerEl.createEl('h2');
    this.titleEl.id = `synthetic-modal-title-${++modalTitleId}`;
    this.containerEl.setAttribute('aria-labelledby', this.titleEl.id);
    this.contentEl = this.containerEl.createDiv();
  }
  setTitle(title) {
    this.titleEl.textContent = title;
  }
  private onKeydown = (event: KeyboardEvent) => {
    // A nested provider dialog takes Escape first; never dismiss its parent too.
    if (
      event.key !== 'Escape' ||
      [...document.querySelectorAll('.modal-container')].at(-1) !== this.containerEl
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };
  open() {
    if (this.opened) return;
    this.opened = true;
    this.previousFocus = document.activeElement;
    document.body.append(this.containerEl);
    document.addEventListener('keydown', this.onKeydown);
    this.onOpen();
  }
  close() {
    if (!this.opened) return;
    this.opened = false;
    document.removeEventListener('keydown', this.onKeydown);
    this.containerEl.remove();
    this.onClose();
    if (this.previousFocus instanceof HTMLElement && this.previousFocus.isConnected)
      this.previousFocus.focus();
  }
  onOpen() {}
  onClose() {}
}
let modalTitleId = 0;
export class FuzzySuggestModal extends Modal {
  inputEl = document.createElement('input');
  placeholder = '';
  setPlaceholder(value) {
    this.placeholder = value;
  }
  onOpen() {
    this.inputEl.placeholder = this.placeholder;
    this.contentEl.append(this.inputEl);
    const list = this.contentEl.createDiv();
    const render = () => {
      list.empty();
      for (const item of this.getItems().filter((item) =>
        this.getItemText(item).toLowerCase().includes(this.inputEl.value.toLowerCase()),
      )) {
        const b = list.createEl('button', { text: this.getItemText(item) });
        b.onclick = () => {
          this.onChooseItem(item);
          this.close();
        };
      }
    };
    this.inputEl.oninput = render;
    render();
    this.inputEl.focus();
  }
}
export class Setting {
  settingEl;
  constructor(parent) {
    this.settingEl = parent.createDiv({ cls: 'setting-item' });
  }
  setName(value) {
    this.settingEl.createSpan({ text: value });
    return this;
  }
  setDesc(value) {
    this.settingEl.createEl('small', { text: value });
    return this;
  }
  addButton(callback) {
    const buttonEl = this.settingEl.createEl('button');
    const control = {
      buttonEl,
      setButtonText(v) {
        buttonEl.textContent = v;
        return this;
      },
      setCta() {
        return this;
      },
      setWarning() {
        return this;
      },
      setDisabled(v) {
        buttonEl.disabled = v;
        return this;
      },
      onClick(fn) {
        buttonEl.onclick = fn;
        return this;
      },
    };
    callback(control);
    return this;
  }
  addText(callback) {
    const inputEl = this.settingEl.createEl('input');
    callback({
      inputEl,
      onChange(fn) {
        inputEl.oninput = () => fn(inputEl.value);
        return this;
      },
    });
    return this;
  }
  addToggle(callback) {
    const el = this.settingEl.createEl('input', { type: 'checkbox' });
    callback({
      setValue(v) {
        el.checked = v;
        return this;
      },
      onChange(fn) {
        el.onchange = () => fn(el.checked);
        return this;
      },
    });
    return this;
  }
}
export class Menu {
  el = document.createElement('div');
  constructor() {
    this.el.className = 'menu';
  }
  addItem(fn) {
    const b = this.el.createEl('button');
    const item = {
      setTitle(v) {
        b.textContent = v;
        return this;
      },
      setIcon() {
        return this;
      },
      setDisabled(v) {
        b.disabled = v;
        return this;
      },
      onClick(fn) {
        b.onclick = () => {
          this.el?.remove();
          fn();
        };
        return this;
      },
    };
    fn(item);
    return this;
  }
  addSeparator() {
    return this;
  }
  showAtMouseEvent() {
    document.body.append(this.el);
  }
  showAtPosition() {
    document.body.append(this.el);
  }
}

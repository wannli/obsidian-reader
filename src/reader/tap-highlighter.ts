import { setIcon, setTooltip } from 'obsidian';
import { TapText } from './tap-text';

export interface TapToolbarAction {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  run(): void | Promise<unknown>;
}

interface TapHighlightOptions {
  active: boolean;
  mode?: 'highlight' | 'node';
  canUndo: boolean;
  modeChanged(active: boolean, mode?: 'node'): void;
  save(range: Range, mode?: 'node'): Promise<void>;
  undo(): Promise<void>;
  notify(error: unknown): void;
  passageActions?(): readonly TapToolbarAction[] | undefined;
  onPassage?(word: Range, event: MouseEvent): boolean;
  onTarget?(event: MouseEvent): boolean;
  clearPassage?(intent: boolean): void;
}

/** Discrete word taps, without touching native Selection or changing rendered article text. */
export class TapHighlighter {
  private readonly events: AbortController;
  private readonly picker: TapText;
  private readonly original: Node[];
  private readonly normal: Node[];
  private readonly trigger: HTMLButtonElement;
  private readonly nodeTrigger: HTMLButtonElement;
  private mode: 'highlight' | 'node' = 'highlight';
  private readonly layout: HTMLElement;
  private readonly normalClearance: string;
  private readonly normalClearancePriority: string;
  private readonly normalGrid: string;
  private readonly normalGridPriority: string;
  private readonly panel: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly preview: HTMLDivElement;
  private readonly sentence: HTMLButtonElement;
  private readonly paragraph: HTMLButtonElement;
  private readonly done: HTMLButtonElement;
  private readonly undo: HTMLButtonElement;
  private readonly resize?: ResizeObserver;
  private actionSet?: readonly TapToolbarAction[];
  private actionButtons: HTMLButtonElement[] = [];
  private first?: Range;
  private down?: { id: number; x: number; y: number; started: number; root: Node | null };
  private moved = false;
  private busy = false;
  private dead = false;
  private enabled = false;
  private undoAvailable: boolean;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly body: HTMLElement,
    private readonly toolbar: HTMLElement,
    private readonly options: TapHighlightOptions,
  ) {
    const doc = body.ownerDocument;
    this.events = new doc.defaultView!.AbortController();
    const events = { signal: this.events.signal };
    this.picker = new TapText(body);
    this.undoAvailable = options.canUndo;
    this.original = [...toolbar.childNodes];
    this.layout = viewport.parentElement!;
    this.normalClearance = this.layout.style.getPropertyValue('--reader-controls-clearance');
    this.normalClearancePriority = this.layout.style.getPropertyPriority(
      '--reader-controls-clearance',
    );
    const trigger = (this.trigger = doc.createElement('button'));
    trigger.type = 'button';
    trigger.className = 'reader-icon-button reader-tap-highlight-trigger';
    trigger.setAttribute('aria-label', 'Highlight mode');
    trigger.title = 'Highlight mode';
    setTooltip(trigger, 'Highlight mode (H)');
    trigger.setAttribute('aria-label', 'Highlight mode');
    this.shortcut(trigger, 'h');
    setIcon(trigger, 'highlighter');
    trigger.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    trigger.addEventListener('click', () => this.setActive(true, true, 'highlight'), events);
    toolbar.append(trigger);
    this.nodeTrigger = doc.createElement('button');
    this.nodeTrigger.type = 'button';
    this.nodeTrigger.className = 'reader-icon-button reader-tap-node-trigger';
    this.nodeTrigger.setAttribute('aria-label', 'Create node');
    this.nodeTrigger.title = 'Create node';
    setTooltip(this.nodeTrigger, 'Create node (C)');
    this.nodeTrigger.setAttribute('aria-label', 'Create node');
    this.shortcut(this.nodeTrigger, 'c');
    setIcon(this.nodeTrigger, 'file-plus-2');
    this.nodeTrigger.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    this.nodeTrigger.addEventListener('click', () => this.setActive(true, true, 'node'), events);
    toolbar.append(this.nodeTrigger);
    this.normal = [...toolbar.childNodes];
    this.normalGrid = toolbar.style.getPropertyValue('grid-template-columns');
    this.normalGridPriority = toolbar.style.getPropertyPriority('grid-template-columns');
    this.panel = doc.createElement('div');
    this.panel.className = 'reader-tap-highlight-actions';
    this.sentence = this.button('Sentence', 'text-select', () => this.choose('sentence'), 's');
    this.paragraph = this.button('Paragraph', 'pilcrow', () => this.choose('paragraph'), 'p');
    this.undo = this.button(
      'Undo',
      'undo-2',
      () => {
        if (this.undoAvailable) void this.run(() => options.undo());
      },
      'u',
    );
    this.done = this.button('Done', 'check', () => this.setActive(false), 'd');
    this.hint = doc.createElement('div');
    // Announce state without a visible explainer or extra space above the bar.
    this.hint.className = 'reader-tap-highlight-status';
    this.hint.setAttribute('role', 'status');
    this.hint.setAttribute('aria-live', 'polite');
    this.preview = doc.createElement('div');
    this.preview.className = 'reader-tap-highlight-preview';
    this.preview.setAttribute('aria-hidden', 'true');
    this.panel.append(this.hint);
    viewport.parentElement!.append(this.preview);
    body.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.enabled) return;
        if (!event.isPrimary || event.button !== 0) {
          this.down = undefined;
          this.moved = true;
          return;
        }
        this.down = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          started: event.timeStamp,
          root: this.body.firstChild,
        };
        this.moved = false;
      },
      events,
    );
    doc.addEventListener(
      'pointermove',
      (event) => {
        if (
          this.down?.id === event.pointerId &&
          Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 8
        )
          this.moved = true;
      },
      { ...events, passive: true, capture: true },
    );
    doc.addEventListener(
      'pointercancel',
      () => {
        this.moved = true;
        this.down = undefined;
      },
      { ...events, capture: true },
    );
    doc.addEventListener(
      'pointerup',
      (event) => {
        if (
          this.down?.id === event.pointerId &&
          (this.down.root !== this.body.firstChild || event.timeStamp - this.down.started > 700)
        )
          this.moved = true;
      },
      { ...events, capture: true },
    );
    body.addEventListener(
      'contextmenu',
      (event) => {
        if (!this.enabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.moved = true;
      },
      { ...events, capture: true },
    );
    body.addEventListener(
      'click',
      (event) => {
        if (!this.enabled) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (
          this.busy ||
          this.moved ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        if (this.down && this.down.root !== this.body.firstChild) return;
        if (this.mode === 'highlight' && options.onTarget?.(event)) return;
        const word = this.picker.wordAt(event.clientX, event.clientY);
        if (!word) return;
        if (!this.first) {
          if (this.mode === 'highlight' && options.onPassage?.(word, event)) {
            if (!this.dead) this.update();
            return;
          }
          options.clearPassage?.(true);
          if (this.dead || !this.enabled) return;
          this.first = word;
          this.update();
          return;
        }
        const range = this.picker.between(this.first, word);
        if (!range) {
          const message = 'Choose words in the same paragraph, or press Escape to start again.';
          this.hint.textContent = message;
          options.notify(new Error(message));
          return;
        }
        this.save(range);
      },
      { ...events, capture: true },
    );
    doc.addEventListener(
      'scroll',
      () => {
        if (this.down) this.moved = true;
        this.paint();
      },
      { ...events, capture: true, passive: true },
    );
    doc.defaultView!.addEventListener('resize', () => this.paint(), events);
    doc.defaultView!.visualViewport?.addEventListener('resize', () => this.paint(), events);
    doc.defaultView!.visualViewport?.addEventListener('scroll', () => this.paint(), events);
    const Resize = doc.defaultView!.ResizeObserver;
    if (Resize) {
      this.resize = new Resize(() => this.paint());
      this.resize.observe(viewport);
      this.resize.observe(toolbar);
    }
    doc.addEventListener(
      'keydown',
      (event) => {
        if (
          !this.enabled ||
          event.key !== 'Escape' ||
          this.busy ||
          event.defaultPrevented ||
          (event.target instanceof doc.defaultView!.Element &&
            event.target.closest(
              'input, textarea, select, [contenteditable="true"], .modal-container, [role="dialog"]',
            ))
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (this.first) {
          this.first = undefined;
          this.update();
        } else this.setActive(false);
      },
      { ...events, capture: true },
    );
    this.setActive(options.active, false, options.mode);
  }

  get active(): boolean {
    return this.enabled;
  }

  reset(): void {
    if (this.dead) return;
    this.first = undefined;
    this.down = undefined;
    this.moved = true; // A source update also cancels any pointer gesture already in flight.
    this.options.clearPassage?.(false);
    this.update();
  }

  refreshActions(): void {
    if (!this.dead) this.update();
  }

  setUndoAvailable(available: boolean): void {
    this.undoAvailable = available;
    if (!this.dead) this.update();
  }

  setActive(active: boolean, notify = true, mode: 'highlight' | 'node' = 'highlight'): void {
    if (this.dead || this.busy) return;
    if (!active) this.options.clearPassage?.(notify);
    this.mode = mode;
    this.enabled = active;
    this.first = undefined;
    this.down = undefined;
    this.moved = false;
    this.body.classList.toggle('reader-tap-highlight-mode', active);
    this.toolbar.classList.toggle('reader-tap-highlight-toolbar', active);
    this.toolbar.classList.toggle('reader-tap-node-toolbar', active && mode === 'node');
    this.preview.classList.toggle('reader-tap-node-preview', active && mode === 'node');
    this.toolbar.replaceChildren(...(active ? [this.panel] : this.normal));
    this.update();
    if (notify)
      if (mode === 'node' && active) this.options.modeChanged(active, 'node');
      else this.options.modeChanged(active);
  }

  private shortcut(button: HTMLButtonElement, key: string): void {
    button.dataset.readerKey = key;
    button.setAttribute('aria-keyshortcuts', key.toUpperCase());
  }

  private button(label: string, icon: string, action: () => void, key?: string): HTMLButtonElement {
    const element = this.body.ownerDocument.createElement('button');
    element.type = 'button';
    element.className = 'reader-icon-button';
    element.setAttribute('aria-label', label);
    element.title = label;
    setTooltip(element, key ? `${label} (${key.toUpperCase()})` : label);
    element.setAttribute('aria-label', label);
    if (key) this.shortcut(element, key);
    setIcon(element, icon);
    element.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    element.addEventListener(
      'click',
      () => {
        if (
          !this.dead &&
          this.enabled &&
          this.toolbar.contains(this.panel) &&
          this.panel.contains(element)
        )
          action();
      },
      { signal: this.events.signal },
    );
    this.panel.append(element);
    return element;
  }

  private choose(kind: 'sentence' | 'paragraph'): void {
    if (!this.first || this.busy || this.actionSet) return;
    const range = this.picker[kind](this.first);
    if (range) this.save(range);
  }

  private save(range: Range): void {
    if (this.mode === 'highlight') {
      void this.run(() => this.options.save(range));
      return;
    }
    // The provider's picker may never settle. Keep Done/Escape and navigation
    // available; a new intent or exit cancels the source-bound request.
    this.first = undefined;
    this.update();
    void this.options.save(range, 'node').catch((error: unknown) => {
      if (!this.dead) this.options.notify(error);
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.dead || !this.enabled || this.busy) return;
    this.busy = true;
    this.first = undefined;
    this.update();
    try {
      await action();
    } catch (error) {
      if (!this.dead) this.options.notify(error);
    } finally {
      this.busy = false;
      if (!this.dead) this.update();
    }
  }

  private update(): void {
    const actions = this.mode === 'highlight' ? this.options.passageActions?.() : undefined;
    const actionSet = actions?.length ? actions : undefined;
    if (actionSet !== this.actionSet) {
      this.actionSet = actionSet;
      this.actionButtons =
        actionSet?.map((action) => {
          const element = this.button(action.label, action.icon, () => {
            // A detached button must never revive a superseded passage's intent.
            if (
              this.busy ||
              action.disabled ||
              this.actionSet !== actionSet ||
              this.options.passageActions?.() !== actionSet
            )
              return;
            try {
              // Shared pickers may never settle. Only Save/Undo use the write lock.
              void Promise.resolve(action.run()).catch((error: unknown) => {
                if (!this.dead) this.options.notify(error);
              });
            } catch (error) {
              if (!this.dead) this.options.notify(error);
            }
          });
          element.dataset.action = action.id;
          const key = {
            'link-note': 'a',
            'convert-node': 'c',
            'open-note': 'o',
            'remove-highlight': 'r',
            unlink: 'x',
            'retry-note-updates': 't',
            'cancel-send': 'b',
          }[action.id];
          if (key) {
            this.shortcut(element, key);
            setTooltip(element, `${action.label} (${key.toUpperCase()})`);
            element.setAttribute('aria-label', action.label);
          }
          return element;
        }) ?? [];
      this.panel.replaceChildren(
        ...(actionSet ? this.actionButtons : [this.sentence, this.paragraph]),
        this.undo,
        this.done,
        this.hint,
      );
    }
    for (const [index, button] of this.actionButtons.entries())
      button.disabled = this.busy || !!this.actionSet?.[index].disabled;
    this.sentence.disabled = this.paragraph.disabled = this.busy || !this.first;
    this.done.disabled = this.busy;
    this.undo.hidden = this.mode === 'node' || !this.undoAvailable;
    this.undo.disabled = this.busy;
    this.hint.hidden = !this.enabled;
    this.hint.textContent = this.busy
      ? this.mode === 'node'
        ? 'Creating…'
        : 'Saving…'
      : this.first
        ? 'Tap the last word, or choose below'
        : this.actionSet
          ? 'Highlight selected'
          : this.mode === 'node'
            ? 'Tap the first word to create a note'
            : 'Tap the first word';
    this.paint();
  }

  private paint(): void {
    if (!this.dead && this.enabled) {
      const width = this.viewport.parentElement?.clientWidth ?? 0;
      if (width > 0) {
        const count =
          (this.actionSet?.length ?? 2) +
          1 +
          Number(this.mode === 'highlight' && this.undoAvailable);
        // Leave room for the bar's padding and edge clearance, then balance rows.
        const capacity = Math.max(1, Math.floor((width - 28) / 48));
        const columns = Math.ceil(count / Math.ceil(count / capacity));
        this.panel.style.maxWidth = `${columns * 48 - 4}px`;
      }
    }
    if (!this.dead && !this.enabled) {
      const width = this.viewport.parentElement?.clientWidth ?? 0;
      if (width > 0) {
        const count = this.normal.filter(
          (node) => node.nodeType === 1 && (node as Element).tagName === 'BUTTON',
        ).length;
        const capacity = Math.max(1, Math.floor((width - 4) / 48));
        const columns = Math.ceil(count / Math.ceil(count / capacity));
        // Balance narrow-pane rows rather than stranding one new action below seven icons.
        this.toolbar.style.setProperty('grid-template-columns', `repeat(${columns}, 44px)`);
      }
    }
    if (!this.dead && this.toolbar.offsetHeight) {
      const height = this.toolbar.offsetHeight + 12;
      this.viewport.parentElement?.style.setProperty(
        '--reader-controls-clearance',
        `calc(${height}px + var(--reader-controls-bottom))`,
      );
    }
    this.preview.replaceChildren();
    if (!this.first || !this.enabled || this.dead) return;
    const frame = this.viewport.getBoundingClientRect();
    const parent = this.preview.getBoundingClientRect();
    const scaleX = parent.width / this.preview.offsetWidth || 1;
    const scaleY = parent.height / this.preview.offsetHeight || 1;
    for (const rect of this.first.getClientRects()) {
      const left = Math.max(rect.left, frame.left),
        top = Math.max(rect.top, frame.top);
      const right = Math.min(rect.right, frame.right),
        bottom = Math.min(rect.bottom, frame.bottom);
      if (right <= left || bottom <= top) continue;
      const marker = this.body.ownerDocument.createElement('span');
      Object.assign(marker.style, {
        left: `${(left - parent.left) / scaleX}px`,
        top: `${(top - parent.top) / scaleY}px`,
        width: `${(right - left) / scaleX}px`,
        height: `${(bottom - top) / scaleY}px`,
      });
      this.preview.append(marker);
    }
  }

  dispose(): void {
    if (this.dead) return;
    const children = [...this.toolbar.childNodes];
    const ownsToolbar =
      (children.length === 1 && children[0] === this.panel) ||
      (children.length === this.normal.length &&
        children.every((node, index) => node === this.normal[index]));
    this.dead = true;
    this.enabled = false;
    this.events.abort();
    this.resize?.disconnect();
    this.preview.remove();
    this.hint.remove();
    this.trigger.remove();
    this.nodeTrigger.remove();
    if (ownsToolbar) {
      this.toolbar.replaceChildren(...this.original);
      this.body.classList.remove('reader-tap-highlight-mode');
      this.toolbar.classList.remove('reader-tap-highlight-toolbar');
      if (this.normalClearance)
        this.layout.style.setProperty(
          '--reader-controls-clearance',
          this.normalClearance,
          this.normalClearancePriority,
        );
      else this.layout.style.removeProperty('--reader-controls-clearance');
      if (this.normalGrid)
        this.toolbar.style.setProperty(
          'grid-template-columns',
          this.normalGrid,
          this.normalGridPriority,
        );
      else this.toolbar.style.removeProperty('grid-template-columns');
    }
    this.actionSet = undefined;
    this.actionButtons = [];
  }
}

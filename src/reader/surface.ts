import { bookmarkRange, renderBody, selectedPassage, textBookmark } from './render';
import { VisibleText } from './text';

const GAP = 32;

/** Owns only the current article DOM and device layout; never persists or indexes notes. */
export class ReadingSurface {
  readonly viewport: HTMLDivElement;
  readonly flow: HTMLDivElement;
  readonly body: HTMLElement;
  readonly finish: HTMLDivElement;
  private disposeBody?: () => void;
  private readonly resize: ResizeObserver;
  private readonly events: AbortController;
  private readonly window: Window;
  private content?: string;
  private url = '';
  private index?: VisibleText;
  private next?: { body: string; url: string };
  private marker = '';
  // Device-local position for image/finish-only viewports; never sent to position().
  private fallback?: { page: number; left: number; top: number };
  private explicitRestore = false;
  private readonly pointers = new Set<number>();
  private dead = false;
  private restoring = false;
  private layoutPending = false;
  private restorePending = false;
  private restoreFrame?: number;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    parent: HTMLElement,
    readonly paged: boolean,
    private position: (marker: string) => void,
    private renderError?: (error: unknown) => void,
  ) {
    const document = parent.ownerDocument,
      view = document.defaultView;
    if (!view) throw new Error('ReadingSurface requires a document window.');
    this.window = view;
    this.events = new view.AbortController();
    this.viewport = document.createElement('div');
    this.viewport.className = 'reader-viewport';
    this.flow = document.createElement('div');
    this.flow.className = 'reader-flow';
    this.body = document.createElement('article');
    this.body.className = 'reader-document markdown-rendered';
    this.finish = document.createElement('div');
    this.finish.className = 'reader-finish';
    this.flow.append(this.body, this.finish);
    this.viewport.append(this.flow);
    parent.append(this.viewport);
    this.viewport.classList.toggle('reader-paged', paged);
    this.resize = new ResizeObserver(() => this.reflow());
    this.resize.observe(this.viewport);
    this.viewport.addEventListener(
      'scroll',
      () => {
        if (this.dead || this.restoring) return;
        // Keep the current viewport safe even before the debounced text lookup runs.
        if (!this.explicitRestore) this.fallback = this.viewportPosition();
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
          this.saveTimer = undefined;
          this.capture();
        }, 300);
      },
      { passive: true, signal: this.events.signal },
    );
    this.body.addEventListener('load', () => this.reflow(), {
      capture: true,
      signal: this.events.signal,
    });
    document.addEventListener('selectionchange', () => this.refresh(), {
      signal: this.events.signal,
    });
    this.viewport.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.dead && event.button === 0) this.pointers.add(event.pointerId);
      },
      { capture: true, passive: true, signal: this.events.signal },
    );
    const release = (event: PointerEvent) => {
      if (!this.dead && this.pointers.delete(event.pointerId)) this.refresh();
    };
    document.addEventListener('pointerup', release, { capture: true, signal: this.events.signal });
    document.addEventListener('pointercancel', release, {
      capture: true,
      signal: this.events.signal,
    });
    view.addEventListener(
      'blur',
      () => {
        if (this.dead) return;
        this.pointers.clear();
        this.refresh();
      },
      { signal: this.events.signal },
    );
  }

  setBody(body: string, url: string): void {
    if (this.dead) return;
    // A newer snapshot can revert a queued change, or change only the URL base.
    this.next = body === this.content && url === this.url ? undefined : { body, url };
    this.refresh();
  }

  /** The source actually represented by the DOM, not the most recently queued body. */
  get displayedBody(): string | undefined {
    return this.dead ? undefined : this.content;
  }

  refresh(): void {
    if (this.dead || this.nativeSelection()) return;
    try {
      this.refreshNow();
    } catch (error) {
      // Deferred pointer/selection/load callbacks must fail as safely as initial render.
      this.content = undefined;
      this.dispose();
      if (this.renderError) this.renderError(error);
      else throw error;
    }
  }

  private refreshNow(): void {
    // Don't restore an older anchor if an update overtakes the scroll debounce.
    if (this.next && this.saveTimer !== undefined && !this.restorePending) this.flush();
    if (this.dead || this.nativeSelection()) return;
    if (this.next) {
      const next = this.next;
      this.next = undefined;
      const dispose = this.disposeBody;
      this.disposeBody = undefined;
      dispose?.();
      if (this.dead) return;
      this.disposeBody = renderBody(next.body, this.body, next.url);
      this.index = new VisibleText(this.body);
      this.content = next.body;
      this.url = next.url;
      this.layoutPending = this.restorePending = true;
    }
    if (this.layoutPending) {
      this.layoutPending = false;
      this.layout();
    }
    if (this.restorePending) {
      this.restorePending = false;
      this.explicitRestore = false;
      this.restoreNow();
    }
  }

  selection(): ReturnType<typeof selectedPassage> {
    return this.dead ? undefined : selectedPassage(this.body);
  }

  /** Protect the gesture before a range exists, and ranges crossing article/UI boundaries. */
  private nativeSelection(): boolean {
    if (this.pointers.size) return true;
    const selection = this.body.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      if (selection.getRangeAt(i).intersectsNode(this.viewport)) return true;
    }
    return false;
  }

  private reflow(): void {
    if (this.dead) return;
    if (this.saveTimer !== undefined && !this.nativeSelection()) this.flush();
    if (this.dead) return;
    this.layoutPending = this.restorePending = true;
    this.refresh();
  }

  private layout(): void {
    if (!this.paged) return;
    const height = `${Math.max(100, this.viewport.clientHeight)}px`;
    this.flow.style.height = height;
    this.flow.style.setProperty('--reader-page-height', height);
    this.flow.style.columnWidth = `${this.columnWidth()}px`;
    this.flow.style.columnGap = `${GAP}px`;
    this.flow.style.columnFill = 'auto';
  }

  private columnWidth(): number {
    return Math.max(100, this.viewport.clientWidth);
  }

  private viewportPosition(): { page: number; left: number; top: number } {
    // Before a resize layout(), the old column width still describes scrollLeft.
    const stride = (parseFloat(this.flow.style.columnWidth) || this.columnWidth()) + GAP;
    return {
      page: Math.round(this.viewport.scrollLeft / stride),
      left: this.viewport.scrollLeft,
      top: this.viewport.scrollTop,
    };
  }

  private pageCount(): number {
    return Math.max(1, Math.ceil((this.flow.scrollWidth + GAP) / (this.columnWidth() + GAP)));
  }

  private capture(): void {
    if (this.dead || this.restoring || this.restorePending || !this.index || this.nativeSelection())
      return;
    const marker = textBookmark(this.body, this.viewport, this.index);
    // Retain the last persistent text anchor, but do not use it to reflow a later blank page.
    this.fallback = marker ? undefined : this.viewportPosition();
    if (!marker) return;
    this.marker = marker;
    this.position(marker);
  }

  flush(): void {
    if (this.dead) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.capture();
  }

  page(direction: -1 | 1): void {
    if (this.dead || !this.paged || this.nativeSelection()) return;
    this.stopRestoring();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const stride = this.columnWidth() + GAP;
    const current = Math.round(this.viewport.scrollLeft / stride);
    this.viewport.scrollLeft =
      Math.min(this.pageCount() - 1, Math.max(0, current + direction)) * stride;
    this.fallback = this.viewportPosition();
    this.capture();
  }

  restore(marker: string): void {
    if (this.dead) return;
    this.marker = marker;
    this.fallback = undefined;
    this.explicitRestore = this.restorePending = true;
    this.refresh();
  }

  reveal(element: HTMLElement): void {
    if (this.dead || !this.index || !this.body.contains(element)) return;
    const nodes = this.body.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = nodes.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const marker = this.index.marker(node, 0);
      if (marker) {
        this.restore(marker);
        return;
      }
    }
  }

  private stopRestoring(): void {
    if (this.restoreFrame !== undefined) this.window.cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = undefined;
    this.restoring = false;
  }

  private restoreNow(): void {
    this.stopRestoring();
    const range =
      !this.fallback && this.index && this.marker
        ? bookmarkRange(this.body, this.marker, this.index)
        : undefined;
    if (!this.fallback && !range) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.restoring = true;
    if (this.fallback) {
      this.viewport.scrollLeft = this.paged
        ? Math.min(this.pageCount() - 1, Math.max(0, this.fallback.page)) *
          (this.columnWidth() + GAP)
        : this.fallback.left;
      this.viewport.scrollTop = this.fallback.top;
      this.fallback = this.viewportPosition();
    } else if (range) {
      const frame = this.viewport.getBoundingClientRect(),
        rect = range.getBoundingClientRect();
      if (this.paged) {
        const stride = this.columnWidth() + GAP;
        this.viewport.scrollLeft =
          Math.max(0, Math.floor((rect.left - frame.left + this.viewport.scrollLeft) / stride)) *
          stride;
      } else this.viewport.scrollTop += rect.top - frame.top;
    }
    const request = this.window.requestAnimationFrame(() => {
      if (this.dead || this.restoreFrame !== request) return;
      this.restoreFrame = undefined;
      this.restoring = false;
    });
    this.restoreFrame = request;
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.stopRestoring();
    this.events.abort();
    this.resize.disconnect();
    this.next = undefined;
    this.index = undefined;
    this.fallback = undefined;
    this.pointers.clear();
    const dispose = this.disposeBody;
    this.disposeBody = undefined;
    dispose?.();
  }
}

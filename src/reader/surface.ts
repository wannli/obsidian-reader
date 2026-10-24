import { bookmarkRange, renderBody, selectedPassage, textBookmark } from './render';
import type { ReferenceIcon } from './render';
import { VisibleText } from './text';
import { HighlightFeedback } from './highlight-feedback';
import { ArticleAnalysis } from './article-analysis';
import { articleTopicPill, type ArticleTopic } from './topic-pills';

const GAP = 32;

/** Owns only the current article DOM and device layout; never persists or indexes notes. */
export class ReadingSurface {
  readonly analysis = new ArticleAnalysis();
  readonly viewport: HTMLDivElement;
  readonly flow: HTMLDivElement;
  readonly body: HTMLElement;
  readonly title: HTMLHeadingElement;
  readonly topics: HTMLDivElement;
  private topicsKey = '';
  private nextTopics?: { key: string; node?: HTMLElement };
  private readonly feedback: HighlightFeedback;
  private titleText = '';
  private disposeBody?: () => void;
  private readonly resize: ResizeObserver;
  private readonly events: AbortController;
  private readonly window: Window;
  private content?: string;
  private url = '';
  private index?: VisibleText;
  private next?: { body: string; url: string };
  private marker = '';
  // Device-local position for image-only viewports; never sent to position().
  private fallback?: { page: number; left: number; top: number };
  private explicitRestore = false;
  private readonly pointers = new Map<number, string>();
  private dead = false;
  private restoring = false;
  private layoutPending = false;
  private restorePending = false;
  private restoreFrame?: number;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private boundaryRevision = 0;
  private reachableEnd?: { position: number; geometry: string; visual: boolean };

  constructor(
    parent: HTMLElement,
    readonly paged: boolean,
    private position: (marker: string) => void,
    private renderError?: (error: unknown) => void,
    private referenceIcon?: ReferenceIcon,
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
    this.title = document.createElement('h1');
    this.title.className = 'reader-article-title';
    this.title.hidden = true;
    this.topics = document.createElement('div');
    this.topics.className = 'reader-article-topics';
    this.topics.setAttribute('role', 'group');
    this.topics.setAttribute('aria-label', 'Article topics');
    this.flow.append(this.title, this.body);
    this.viewport.append(this.flow);
    parent.append(this.viewport);
    this.feedback = new HighlightFeedback(this.viewport, this.body);
    this.viewport.classList.toggle('reader-paged', paged);
    this.resize = new ResizeObserver(() => this.reflow());
    this.resize.observe(this.viewport);
    for (const type of ['loadingdone', 'loadingerror'])
      document.fonts?.addEventListener(type, () => this.invalidateEnd(), {
        signal: this.events.signal,
      });
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
        if (!this.dead && event.button === 0) this.pointers.set(event.pointerId, event.pointerType);
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
    const releaseTouches = (event: TouchEvent) => {
      if (this.dead || event.touches?.length !== 0) return;
      // iOS native selection can omit pointerup. Touch IDs cannot identify
      // pointer IDs; an empty native list releases only touch-type pointers.
      let released = false;
      for (const [id, type] of this.pointers)
        if (type === 'touch') released = this.pointers.delete(id) || released;
      if (released) this.refresh();
    };
    document.addEventListener('touchend', releaseTouches, {
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

  setTitle(title: string): void {
    if (this.dead || this.titleText === title) return;
    this.titleText = title;
    this.reflow();
  }

  setTopics(topics: readonly ArticleTopic[]): void {
    if (this.dead) return;
    const node = articleTopicPill(this.body.ownerDocument, topics, this.referenceIcon),
      key = node?.outerHTML ?? '';
    if (key === (this.nextTopics?.key ?? this.topicsKey)) return;
    this.nextTopics = key === this.topicsKey ? undefined : { key, node };
    this.reflow();
  }

  setBody(body: string, url: string): void {
    if (this.dead) return;
    // A newer snapshot can revert a queued change, or change only the URL base.
    this.next = body === this.content && url === this.url ? undefined : { body, url };
    // Position-only saves call setBody too; they must not revoke a confirmed clamp.
    if (this.next) this.invalidateEnd();
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
    if (this.nextTopics) {
      const { key, node } = this.nextTopics;
      this.nextTopics = undefined;
      this.topics.replaceChildren(...(node ? [node] : []));
      if (node) this.body.before(this.topics);
      else this.topics.remove();
      this.topicsKey = key;
      this.layoutPending = this.restorePending = true;
    }
    if (this.next) {
      const next = this.next;
      this.next = undefined;
      const dispose = this.disposeBody;
      this.disposeBody = undefined;
      dispose?.();
      if (this.dead) return;
      this.disposeBody = renderBody(
        next.body,
        this.body,
        next.url,
        this.referenceIcon,
        this.analysis,
      );
      this.index = new VisibleText(this.body);
      this.content = next.body;
      this.url = next.url;
      this.layoutPending = this.restorePending = true;
    }
    // Keep every authored heading/text node in the body and its source index.
    // Only Reader's synthetic title is redundant when the leading heading matches.
    const leading = this.body.firstElementChild;
    const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');
    const hidden =
      !this.titleText ||
      !!(
        leading?.matches('h1,h2,h3,h4,h5,h6') &&
        normalize(leading.textContent ?? '') === normalize(this.titleText)
      );
    if (this.title.textContent !== this.titleText || this.title.hidden !== hidden) {
      this.title.textContent = this.titleText;
      this.title.hidden = hidden;
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

  get pointerActive(): boolean {
    return !this.dead && this.pointers.size > 0;
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

  highlightFeedback(range: Range): () => void {
    return this.feedback.prepare(range);
  }

  private reflow(): void {
    if (this.dead) return;
    this.invalidateEnd();
    this.feedback.dismiss();
    if (this.saveTimer !== undefined && !this.nativeSelection()) this.flush();
    if (this.dead) return;
    this.layoutPending = this.restorePending = true;
    this.refresh();
  }

  private layout(): void {
    this.flow.style.setProperty('--reader-image-height', `${this.viewport.clientHeight * 0.3}px`);
    if (!this.paged) return;
    const height = `${Math.max(100, this.viewport.clientHeight)}px`,
      width = `${this.columnWidth()}px`;
    this.flow.style.height = height;
    this.flow.style.setProperty('--reader-page-height', height);
    // column-width is preferred, not exact: a fractional 100% flow stretches every
    // column and accumulates a micro-page. Pin the flow to the navigation width too.
    this.flow.style.width = width;
    this.flow.style.columnWidth = width;
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

  atBoundary(direction: -1 | 1): boolean {
    if (
      this.dead ||
      this.restoring ||
      this.restorePending ||
      !this.index ||
      this.viewport.clientHeight <= 0
    )
      return false;
    if (this.paged) {
      if (this.viewport.clientWidth <= 0 || this.flow.scrollWidth <= 0) return false;
      const last = (this.pageCount() - 1) * (this.columnWidth() + GAP),
        extent = this.viewport.scrollWidth;
      // Integer column metrics can put the nominal last page beyond scrollLeft's
      // fractional, clamped limit. Bound by the scroller, not rounded canPage().
      // An unmeasured extent must not turn the start of a long article into its end.
      const end =
        extent > 0 ? Math.min(last, Math.max(0, extent - this.viewport.clientWidth)) : last;
      if (direction === -1) return this.viewport.scrollLeft <= 1;
      if (this.viewport.scrollLeft >= end - 1) return true;
      // This is observed reachability, not a larger geometric tolerance.
      return !!(
        this.reachableEnd &&
        this.boundaryGeometry()?.key === this.reachableEnd.geometry &&
        this.viewport.scrollLeft >= this.reachableEnd.position - 1 &&
        (!this.reachableEnd.visual || this.finalContentVisible())
      );
    }
    if (this.viewport.scrollHeight <= 0) return false;
    return direction === -1
      ? this.viewport.scrollTop <= 1
      : this.viewport.scrollTop + this.viewport.clientHeight >= this.viewport.scrollHeight - 1;
  }

  canPage(direction: -1 | 1): boolean {
    if (this.dead || !this.paged) return false;
    // A rounded phantom column must not trap Next after the guarded endpoint is reached.
    if (direction === 1 && this.atBoundary(1)) return false;
    const current = Math.round(this.viewport.scrollLeft / (this.columnWidth() + GAP));
    return direction < 0 ? current > 0 : current < this.pageCount() - 1;
  }

  private invalidateEnd(): void {
    this.boundaryRevision++;
    this.reachableEnd = undefined;
  }

  private boundaryGeometry(): { key: string; scale: number } | undefined {
    if (
      this.dead ||
      !this.paged ||
      !this.index ||
      this.next ||
      this.restoring ||
      this.restorePending ||
      this.layoutPending ||
      this.nativeSelection()
    )
      return;
    const viewport = this.viewport,
      frame = viewport.getBoundingClientRect();
    const zoom = (viewport as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
    const scale = zoom ?? frame.width / viewport.offsetWidth;
    const metrics = [
      viewport.clientWidth,
      viewport.clientHeight,
      viewport.scrollWidth,
      this.flow.scrollWidth,
      frame.width,
      frame.height,
      scale,
    ];
    if (
      metrics.some((value) => !Number.isFinite(value) || value <= 0) ||
      ![frame.left, frame.top].every(Number.isFinite)
    )
      return;
    const style = this.window.getComputedStyle(viewport);
    const flowStyle = this.window.getComputedStyle(this.flow);
    if (
      style.scrollSnapType !== 'none' ||
      style.direction !== 'ltr' ||
      flowStyle.direction !== 'ltr' ||
      (flowStyle.writingMode && flowStyle.writingMode !== 'horizontal-tb')
    )
      return;
    return {
      scale,
      // Do not include scroll-behavior: the temporary instant override is restored.
      key: [
        this.boundaryRevision,
        ...metrics,
        viewport.offsetWidth,
        viewport.scrollHeight,
        frame.left,
        frame.top,
        this.window.devicePixelRatio,
        this.window.visualViewport?.scale,
        style.scrollSnapType,
        style.writingMode,
        flowStyle.writingMode,
        style.borderLeftWidth,
        style.borderRightWidth,
        style.borderTopWidth,
        style.borderBottomWidth,
        style.paddingLeft,
        style.paddingRight,
      ].join('|'),
    };
  }

  private finalContentVisible(): boolean {
    // A device may clamp before the nominal last column even when its measured
    // scroll extent says otherwise. Only the rendered tail can justify probing
    // a larger discrepancy; rounded column numbers alone cannot.
    const range = this.viewport.ownerDocument.createRange();
    if (typeof range.getClientRects !== 'function') return false;
    // Marked may leave whitespace text nodes after the final block. Walk back
    // only over trailing non-rendered nodes, never measure the whole article.
    let node: ChildNode | null = this.body.lastChild ?? this.title;
    for (let checked = 0; node && checked < 32; checked++, node = node.previousSibling) {
      range.selectNodeContents(node);
      let tail: DOMRect | DOMRectReadOnly | undefined;
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) tail = rect;
      if (!tail && node.nodeType === Node.ELEMENT_NODE) {
        // Empty rendered elements such as a final horizontal rule have no contents.
        range.selectNode(node);
        for (const rect of range.getClientRects())
          if (rect.width > 0 && rect.height > 0) tail = rect;
      }
      if (!tail) continue;
      const frame = this.viewport.getBoundingClientRect();
      return (
        tail.left >= frame.left - 1 &&
        tail.right <= frame.right + 1 &&
        tail.top >= frame.top - 1 &&
        tail.bottom <= frame.bottom + 1
      );
    }
    return false;
  }

  /** Explicit keyboard motions stay inside this article and never infer a neighbour. */
  moveByPage(direction: -1 | 1, fraction: 0.5 | 1): void {
    if (this.dead || this.restoring || this.restorePending || !this.index || this.nativeSelection())
      return;
    if (this.paged) {
      if (fraction === 1) {
        this.page(direction);
        return;
      }
      this.invalidateEnd();
      this.viewport.scrollLeft = Math.min(
        Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth),
        Math.max(0, this.viewport.scrollLeft + direction * (this.columnWidth() + GAP) * fraction),
      );
    } else {
      this.viewport.scrollTop = Math.min(
        Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight),
        Math.max(0, this.viewport.scrollTop + direction * this.viewport.clientHeight * fraction),
      );
    }
    this.fallback = this.viewportPosition();
    this.capture();
  }

  jumpTo(direction: -1 | 1): void {
    if (this.dead || this.restoring || this.restorePending || !this.index || this.nativeSelection())
      return;
    if (this.paged) {
      this.invalidateEnd();
      this.viewport.scrollLeft =
        direction === -1 ? 0 : Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth);
    } else
      this.viewport.scrollTop =
        direction === -1 ? 0 : Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
    this.fallback = this.viewportPosition();
    this.capture();
  }

  page(direction: -1 | 1): void {
    if (this.dead || !this.paged || this.nativeSelection()) return;
    // A page may cancel restoration, but that unsettled request cannot prove EOF.
    const geometry = direction === 1 ? this.boundaryGeometry() : undefined;
    this.reachableEnd = undefined;
    this.stopRestoring();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const stride = this.columnWidth() + GAP;
    const lastIndex = this.pageCount() - 1,
      last = lastIndex * stride;
    const current = Math.round(this.viewport.scrollLeft / stride);
    const target = Math.min(lastIndex, Math.max(0, current + direction)) * stride;
    const style = this.viewport.style;
    const behavior = style.getPropertyValue('scroll-behavior');
    const priority = style.getPropertyPriority('scroll-behavior');
    const styled = this.viewport.hasAttribute('style');
    try {
      style.setProperty('scroll-behavior', 'auto', 'important');
      const instant = this.window.getComputedStyle(this.viewport).scrollBehavior === 'auto';
      this.viewport.scrollLeft = target;
      const landed = this.viewport.scrollLeft;
      const end = Math.min(
        last,
        Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth),
      );
      const quantum = geometry ? Math.max(1, Math.ceil(1 / geometry.scale)) : 0;
      const nominalClamp = Math.round(landed / stride) === lastIndex && end - landed <= quantum;
      const visualClamp =
        !nominalClamp &&
        !!geometry &&
        instant &&
        target === last &&
        end - landed > 1 &&
        quantum < stride / 2 &&
        this.finalContentVisible();
      if (
        geometry &&
        instant &&
        target === last &&
        end - landed > 1 &&
        quantum < stride / 2 &&
        (nominalClamp || visualClamp) &&
        this.boundaryGeometry()?.key === geometry.key
      ) {
        // Request beyond one quantization step, but no more than one extra stride.
        // Any extra progress is still paging, never permission to hand off this press.
        this.viewport.scrollLeft = Math.min(
          last + stride,
          Math.max(last + quantum + 1, this.viewport.scrollWidth),
        );
        if (
          this.viewport.scrollLeft === landed &&
          this.window.getComputedStyle(this.viewport).scrollBehavior === 'auto' &&
          this.boundaryGeometry()?.key === geometry.key
        )
          this.reachableEnd = { position: landed, geometry: geometry.key, visual: visualClamp };
      }
    } finally {
      if (behavior) style.setProperty('scroll-behavior', behavior, priority);
      else style.removeProperty('scroll-behavior');
      if (!styled && !style.length) this.viewport.removeAttribute('style');
    }
    this.fallback = this.viewportPosition();
    this.capture();
  }

  restore(marker: string): void {
    if (this.dead) return;
    this.invalidateEnd();
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
    this.invalidateEnd();
    this.dead = true;
    this.analysis.clear();
    this.feedback.dispose();
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

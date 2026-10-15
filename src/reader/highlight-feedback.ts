/** Transient save acknowledgement, outside the article DOM and native selection. */
export class HighlightFeedback {
  private readonly events: AbortController;
  private readonly status: HTMLDivElement;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private dead = false;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly body: HTMLElement,
  ) {
    const doc = body.ownerDocument;
    const win = doc.defaultView!;
    this.events = new win.AbortController();
    const options = { signal: this.events.signal };
    this.status = doc.createElement('div');
    this.status.className = 'reader-highlight-feedback';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    this.status.hidden = true;
    viewport.parentElement!.append(this.status);
    const dismiss = () => this.dismiss();
    doc.addEventListener('scroll', dismiss, { ...options, capture: true, passive: true });
    doc.addEventListener('pointerdown', dismiss, { ...options, capture: true });
    doc.addEventListener('selectionchange', dismiss, options);
    doc.addEventListener('keydown', dismiss, options);
    doc.addEventListener('visibilitychange', dismiss, options);
    win.addEventListener('resize', dismiss, options);
    win.addEventListener('blur', dismiss, options);
    win.visualViewport?.addEventListener('resize', dismiss, options);
    win.visualViewport?.addEventListener('scroll', dismiss, options);
  }

  /** Capture before awaiting persistence; never acknowledge an obsolete interaction. */
  prepare(range: Range): () => void {
    const revision = this.revision;
    const captured = range.cloneRange();
    return () => {
      const doc = this.body.ownerDocument;
      const selection = doc.getSelection();
      if (
        this.dead ||
        revision !== this.revision ||
        !this.viewport.isConnected ||
        doc.visibilityState === 'hidden' ||
        !selection?.rangeCount ||
        selection.isCollapsed ||
        !this.body.contains(captured.startContainer) ||
        !this.body.contains(captured.endContainer)
      )
        return;
      const current = selection.getRangeAt(0);
      if (
        current.startContainer !== captured.startContainer ||
        current.startOffset !== captured.startOffset ||
        current.endContainer !== captured.endContainer ||
        current.endOffset !== captured.endOffset
      )
        return;
      const frame = this.viewport.getBoundingClientRect();
      const win = doc.defaultView!;
      const visual = win.visualViewport;
      const left = Math.max(frame.left, visual?.offsetLeft ?? 0) + 8;
      const top = Math.max(frame.top, visual?.offsetTop ?? 0) + 8;
      const right =
        Math.min(frame.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? win.innerWidth)) - 8;
      const bottom =
        Math.min(frame.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? win.innerHeight)) - 8;
      if (right <= left || bottom <= top) return;
      const rect = [...captured.getClientRects()]
        .filter(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom >= top &&
            rect.top <= bottom &&
            rect.right >= left &&
            rect.left <= right,
        )
        .pop();
      if (!rect) return;
      clearTimeout(this.timer);
      this.status.textContent = '';
      this.status.hidden = false;
      // Clamp in viewport coordinates, then place inside the leaf-owned absolute
      // containing block. Containment/transforms can change that block's origin.
      const parent = (this.status.offsetParent as HTMLElement | null) ?? this.status.parentElement!;
      const origin = parent.getBoundingClientRect();
      const scale = (rendered: number, layout: number) => {
        const ratio = rendered / layout;
        return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      };
      const scaleX = scale(origin.width, parent.offsetWidth),
        scaleY = scale(origin.height, parent.offsetHeight);
      this.status.style.maxWidth = `${(right - left) / scaleX}px`;
      this.status.textContent = 'Highlight saved';
      const box = this.status.getBoundingClientRect();
      if (box.height > bottom - top) {
        this.dismiss();
        return;
      }
      const x = Math.max(left, Math.min(rect.left, right - box.width));
      // Prefer immediately below the final selected line; clamp at the pane/window edge.
      const y = Math.max(top, Math.min(rect.bottom + 6, bottom - box.height));
      // offsetParent rectangles include borders; absolute offsets start at padding.
      this.status.style.left = `${(x - origin.left) / scaleX - parent.clientLeft + parent.scrollLeft}px`;
      this.status.style.top = `${(y - origin.top) / scaleY - parent.clientTop + parent.scrollTop}px`;
      this.timer = setTimeout(() => this.dismiss(), 2200);
    };
  }

  dismiss(): void {
    this.revision++;
    clearTimeout(this.timer);
    this.status.hidden = true;
    this.status.textContent = '';
  }

  dispose(): void {
    this.dead = true;
    this.dismiss();
    this.events.abort();
    this.status.remove();
  }
}

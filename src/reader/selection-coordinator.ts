/** Own native gesture tracking and quiet-period scheduling, not source/write authority. */
export class SelectionCoordinator {
  selecting = false;
  revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  invalidate(): number {
    this.cancel();
    return ++this.revision;
  }
  schedule(action: () => void, delay: number): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      action();
    }, delay);
  }
  install(
    root: HTMLElement,
    signal: AbortSignal,
    hostSignal: AbortSignal,
    active: () => boolean,
    changed: () => void,
  ): void {
    const doc = root.ownerDocument,
      options = { signal };
    const pointers = new Map<number, string>(),
      touches = new Set<number>();
    const release = (event: Event) => {
      if (!active()) return;
      if (event.type.startsWith('touch')) {
        for (const touch of Array.from((event as TouchEvent).changedTouches ?? []))
          touches.delete(touch.identifier);
        const remaining = (event as TouchEvent).touches;
        if (remaining) {
          touches.clear();
          for (const touch of Array.from(remaining)) touches.add(touch.identifier);
          // Touch identifiers and pointer IDs are unrelated. Cancellation can be takeover.
          if (event.type === 'touchend' && remaining.length === 0)
            for (const [id, type] of pointers) if (type === 'touch') pointers.delete(id);
        }
      } else pointers.delete((event as PointerEvent).pointerId);
      this.selecting = pointers.size > 0 || touches.size > 0;
      this.invalidate();
      // Surface can release its document-capture tracker after this listener.
      // Check the range only after both trackers finish the current dispatch.
      this.schedule(changed, 0);
    };
    doc.addEventListener('selectionchange', changed, options);
    root.addEventListener(
      'pointerdown',
      (event) => {
        if (!active()) return;
        pointers.set(event.pointerId, event.pointerType);
        this.selecting = true;
        this.invalidate();
      },
      options,
    );
    for (const type of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'])
      doc.addEventListener(type, release, { ...options, capture: true });
    doc.defaultView?.addEventListener(
      'blur',
      () => {
        pointers.clear();
        touches.clear();
        this.selecting = false;
        changed();
      },
      options,
    );
    const gestures = new AbortController();
    const stop = () => {
      gestures.abort();
      this.invalidate();
    };
    signal.addEventListener('abort', stop, { once: true });
    hostSignal.addEventListener('abort', stop, { ...options, once: true });
    if (signal.aborted || hostSignal.aborted) stop();
    const isolate = (event: Event) => {
      if (!active()) return;
      if (
        event.type.startsWith('pointer') &&
        !['touch', 'pen'].includes((event as PointerEvent).pointerType)
      )
        return;
      if (event.type === 'touchstart') {
        const remaining = (event as TouchEvent).touches;
        if (remaining) touches.clear();
        for (const touch of Array.from(remaining ?? (event as TouchEvent).changedTouches ?? []))
          touches.add(touch.identifier);
        this.selecting = true;
        this.invalidate();
      }
      // Isolate workspace swipes, not native selection, scrolling or zoom.
      event.stopPropagation();
    };
    for (const type of [
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
    ])
      root.addEventListener(type, isolate, { passive: true, signal: gestures.signal });
  }
}

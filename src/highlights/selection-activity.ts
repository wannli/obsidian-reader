import { rangeIsInside } from './text-index';

type Boundary = readonly [Node, number, Node, number];
const sameBoundary = (a: Boundary | null, b: Boundary | null) =>
  !!a && !!b && a.every((value, index) => value === b[index]);

/** Track document-wide input: native selection handles can sit outside the article. */
export function watchSelectionActivity(
  root: HTMLElement, changed: () => void, aborted: () => void,
): { blocked: () => boolean; dispose: () => void } {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const pointers = new Map<number, string>();
  const keys = new Set<string>();
  const removers: (() => void)[] = [];
  let touches = 0;
  let suspended = false;
  let touchOriginInside = false;
  let touchOwnerPointerId: number | null = null, pairedPointerCancel = false;
  let native: 'none' | 'menu' | 'handles' | 'settling' = 'none';
  let takeoverBoundary: Boundary | null = null, permittedBoundary: Boundary | null = null;
  let adjusted = false;
  const held = () => pointers.size > 0 || touches > 0 || keys.size > 0;
  function boundary(): Boundary | null {
    const selection = document.getSelection();
    if (!root.isConnected || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    return rangeIsInside(root, range) ? [range.startContainer, range.startOffset, range.endContainer, range.endOffset] : null;
  }
  function forgetNative() {
    native = 'none'; touchOriginInside = false; touchOwnerPointerId = null;
    pairedPointerCancel = false; adjusted = false;
    takeoverBoundary = permittedBoundary = null;
  }
  function inspectNative() {
    if (native !== 'handles' && native !== 'settling') return;
    const current = boundary();
    if (!current) { abort(); return; }
    if (!sameBoundary(current, takeoverBoundary)) adjusted = true;
    // A completion cue authorizes only those exact boundaries. A hidden handle
    // adjustment, including one detected only at the timer, needs a fresh cue.
    if (native === 'settling' && !sameBoundary(current, permittedBoundary)) {
      native = 'handles'; permittedBoundary = null; suspended = true;
    }
  }
  function takeover() {
    const current = boundary();
    if (native !== 'menu' || held() || !current) return false;
    takeoverBoundary = current; native = 'handles';
    suspended = true;
    changed(); // Pause, not hard-abort: this selection has not been delivered.
    return true;
  }
  function beginInput() {
    // Unrelated input must not flush an old native-handle candidate.
    if (native === 'handles' || native === 'settling') abort(); else forgetNative();
    suspended = false;
  }
  function listen(target: EventTarget, type: string, handler: (event: Event) => void, capture = true) {
    target.addEventListener(type, handler, { capture, passive: true });
    removers.push(() => target.removeEventListener(type, handler, capture));
  }
  function abort() {
    forgetNative(); suspended = true;
    aborted();
  }
  function reset() {
    pointers.clear(); keys.clear(); touches = 0;
    abort();
  }
  listen(document, 'pointerdown', event => {
    const pointer = event as PointerEvent;
    beginInput(); touchOriginInside = pointer.pointerType === 'touch' && root.contains(event.target as Node);
    touchOwnerPointerId = touchOriginInside ? pointer.pointerId : null;
    pointers.set(pointer.pointerId, pointer.pointerType);
    changed();
  });
  listen(document, 'pointermove', event => {
    const pointer = event as PointerEvent;
    // Also catch an already-active drag if the watcher mounted after pointerdown.
    if (pointer.buttons || pointers.has(pointer.pointerId)) {
      pointers.set(pointer.pointerId, pointer.pointerType); changed();
    }
  });
  listen(document, 'pointerup', event => {
    pointers.delete((event as PointerEvent).pointerId);
    if (native === 'menu' && !held()) forgetNative();
    changed();
  });
  listen(document, 'pointercancel', event => {
    const id = (event as PointerEvent).pointerId;
    pointers.delete(id);
    // A native takeover has a *pair* of cancellations for the originating
    // touch, not an arbitrary touchcancel following a compatibility menu.
    if (native === 'menu' && id === touchOwnerPointerId && touches > 0) pairedPointerCancel = true;
    if (touches) changed(); else abort();
  });
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    listen(document, type, event => {
      touches = (event as TouchEvent).touches.length;
      if (type === 'touchstart') {
        beginInput(); touchOriginInside = touches === 1 && root.contains(event.target as Node);
        touchOwnerPointerId = touchOriginInside
          ? ([...pointers].find(([, kind]) => kind === 'touch')?.[0] ?? null) : null;
      }
      if (!touches) {
        for (const [id, kind] of pointers) if (kind === 'touch') pointers.delete(id);
      }
      if (type === 'touchcancel') { if (!pairedPointerCancel || !takeover()) abort(); }
      else { if (native === 'menu' && !held()) forgetNative(); changed(); }
    });
  }
  listen(document, 'selectionchange', inspectNative);
  listen(document, 'contextmenu', event => {
    const menu = event as PointerEvent;
    if (!event.isTrusted || document.visibilityState === 'hidden') return;
    inspectNative();
    const current = boundary();
    if (!current) return;
    // Boox's later native-menu event is retargeted outside the article and uses
    // a mouse pointer. The initial touch menu establishes ownership, not release.
    if (native === 'handles' && adjusted && !held() && !root.contains(event.target as Node) &&
      menu.pointerType === 'mouse' && menu.buttons === 0) {
      native = 'settling'; permittedBoundary = current; suspended = false; changed();
    } else if (native === 'none' && touchOriginInside && root.contains(event.target as Node) &&
      menu.pointerType === 'touch' && !keys.size && (touches || [...pointers.values()].includes('touch'))) {
      native = 'menu';
    }
  });
  listen(document, 'keydown', event => {
    const key = event as KeyboardEvent;
    if (key.key === 'Escape') { abort(); return; }
    beginInput(); keys.add(key.code || key.key); changed();
  });
  listen(document, 'keyup', event => {
    const key = event as KeyboardEvent;
    keys.delete(key.code || key.key); changed();
  });
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') reset();
  });
  if (window) {
    listen(window, 'blur', reset, false); // Native element blur does not bubble to window.
    listen(window, 'pagehide', reset);
  }
  return {
    blocked: () => {
      inspectNative();
      return suspended || !root.isConnected || document.visibilityState === 'hidden' || held();
    },
    dispose: () => { for (const remove of removers.splice(0)) remove(); forgetNative(); pointers.clear(); keys.clear(); },
  };
}

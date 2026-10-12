import { canTurnEinkPage } from './eink-input';

/** Native DOM compatibility boundary: only the active Reader may own shared chrome. */
const owners = new WeakMap<Document, () => void>();
export function nativeReadingChrome(content: HTMLElement, active: () => boolean) {
  const doc = content.ownerDocument;
  let disposed = false, wantedHidden = false;
  const owned = new Set<HTMLElement>();
  const quiet = new Set<HTMLElement>();
  function clear() {
    for (const element of owned) element.classList.remove('reader-chrome-hidden');
    owned.clear();
    for (const element of quiet) element.classList.remove('reader-chrome-instant');
    quiet.clear();
    if (owners.get(doc) === clear) owners.delete(doc);
  }
  const changes = new doc.defaultView!.MutationObserver(() => { if (!disposed) adapter.setHidden(wantedHidden); });
  changes.observe(doc.body, { subtree: true, childList: true });
  const adapter = {
    setHidden(hidden: boolean) {
      if (disposed) return;
      wantedHidden = hidden;
      clear();
      if (!active()) return;
      if (owners.get(doc) !== clear) owners.get(doc)?.();
      owners.set(doc, clear);
      const header = content.closest('.workspace-leaf-content')?.querySelector<HTMLElement>('.view-header');
      const targets = [...doc.querySelectorAll<HTMLElement>('.mobile-navbar, .mobile-toolbar'), ...(header ? [header] : [])];
      for (const element of targets) {
        // Never take ownership of a class supplied by another actor.
        if (!element.classList.contains('reader-chrome-instant')) {
          element.classList.add('reader-chrome-instant'); quiet.add(element);
        }
        if (hidden && !element.classList.contains('reader-chrome-hidden')) {
          element.classList.add('reader-chrome-hidden'); owned.add(element);
        }
      }
    },
    dispose() { if (disposed) return; changes.disconnect(); clear(); disposed = true; },
  };
  return adapter;
}

/** Direction comes only from an explicit reading gesture, never restore/reflow. */
export function watchReadingChrome(scroll: HTMLElement, shell: HTMLElement, options: {
  active(): boolean;
  setHidden(hidden: boolean): void;
  onActiveChange?(callback: () => void): () => void;
}) {
  const doc = scroll.ownerDocument, win = doc.defaultView!;
  let hidden = false, disposed = false, intent = 0, distance = 0, last = scroll.scrollTop;
  let touchY: number | undefined, settling = false, frame = 0, expires = 0;
  const reveal = doc.createElement('button');
  reveal.className = 'r2-reveal-chrome'; reveal.textContent = '⌄'; reveal.hidden = true;
  reveal.setAttribute('aria-label', 'Show controls'); reveal.title = 'Show controls'; shell.append(reveal);
  function blocked() {
    return !canTurnEinkPage(shell, options.active);
  }
  function reset() { intent = 0; distance = 0; last = scroll.scrollTop; }
  function settle() {
    reset(); settling = true; win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      frame = win.requestAnimationFrame(() => { settling = false; reset(); });
    });
  }
  function setHidden(value: boolean) {
    if (disposed || value === hidden || value && blocked()) return;
    hidden = value; reveal.hidden = !value; options.setHidden(value); settle();
  }
  function direction(delta: number) {
    if (settling || blocked() || !delta) { reset(); return; }
    const next = Math.sign(delta);
    if (intent !== next) distance = 0;
    intent = next; expires = Date.now() + 1200;
  }
  function scrolled() {
    const top = Math.max(0, scroll.scrollTop), delta = top - last; last = top;
    if (settling || blocked() || Date.now() > expires || Math.sign(delta) !== intent) return;
    distance += Math.abs(delta);
    if (top <= 0 || distance >= 12) setHidden(intent > 0 && top > 0);
  }
  const wheel = (event: WheelEvent) => { if (event.target === scroll || event.target instanceof win.Node && scroll.contains(event.target)) direction(event.deltaY); };
  const start = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; reset(); };
  const move = (event: TouchEvent) => {
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined) direction(touchY - next);
    touchY = next;
  };
  const key = (event: KeyboardEvent) => {
    if (!options.active() || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') { setHidden(false); return; }
    if (event.target instanceof win.Node && shell.contains(event.target)) {
      if (event.key === ' ') direction(event.shiftKey ? -1 : 1);
      if (['ArrowDown', 'PageDown'].includes(event.key)) direction(1);
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) direction(-1);
    }
  };
  const show = () => setHidden(false);
  const selectionChanged = () => { if (blocked()) show(); };
  options.setHidden(false);
  const stopActive = options.onActiveChange?.(() => { show(); options.setHidden(false); reset(); });
  const observer = typeof win.ResizeObserver === 'undefined' ? undefined : new win.ResizeObserver(settle);
  observer?.observe(scroll);
  scroll.addEventListener('scroll', scrolled, { passive: true });
  scroll.addEventListener('wheel', wheel, { passive: true });
  scroll.addEventListener('touchstart', start, { passive: true });
  scroll.addEventListener('touchmove', move, { passive: true });
  doc.addEventListener('keydown', key); doc.addEventListener('selectionchange', selectionChanged);
  doc.addEventListener('focusin', selectionChanged); reveal.addEventListener('click', show);
  return {
    turn(delta: number) { if (!blocked()) setHidden(delta > 0); },
    reset: settle,
    dispose() {
      if (disposed) return;
      show(); disposed = true; options.setHidden(false); stopActive?.(); observer?.disconnect(); win.cancelAnimationFrame(frame);
      scroll.removeEventListener('scroll', scrolled); scroll.removeEventListener('wheel', wheel);
      scroll.removeEventListener('touchstart', start); scroll.removeEventListener('touchmove', move);
      doc.removeEventListener('keydown', key); doc.removeEventListener('selectionchange', selectionChanged);
      doc.removeEventListener('focusin', selectionChanged); reveal.remove();
    },
  };
}

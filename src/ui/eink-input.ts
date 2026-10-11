const EDITABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
export function canTurnEinkPage(root: HTMLElement, active: () => boolean, event?: KeyboardEvent): boolean {
  const doc = root.ownerDocument, win = doc.defaultView;
  if (!win || !root.isConnected || !active() || doc.hidden || root.closest('[inert]')) return false;
  if (event && (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)) return false;
  const path = event?.composedPath() ?? [];
  if ([doc.activeElement, ...path].some(node => (node as Element)?.nodeType === 1 && (node as Element).closest(EDITABLE))) return false;
  if (event) {
    const focus = doc.activeElement, origin = path[0] ?? event.target;
    const neutral = (node: EventTarget | null | undefined) => !node || node === doc || node === doc.body || node === doc.documentElement;
    if (!neutral(focus) && !root.contains(focus)) return false;
    if (!neutral(origin) && !path.includes(root) && !(origin instanceof win.Node && root.contains(origin))) return false;
  }
  if ([...doc.querySelectorAll<HTMLElement>('.r2-highlight-menu,.r2-dialog-shade,.r2-sidebar:not([hidden]),.modal-container,.prompt,.menu,.suggestion-container,[role="dialog"],[role="menu"]')]
    .some(el => el.getClientRects().length && win.getComputedStyle(el).visibility !== 'hidden')) return false;
  return doc.getSelection()?.isCollapsed !== false;
}
export interface EinkKeyOptions {
  active(): boolean;
  reverse(): boolean;
  turn(delta: number): boolean;
  onActiveChange?(callback: () => void): () => void;
}
/** Page keys are reader-local and exist only while Boox pagination is mounted. */
export function watchEinkKeys(root: HTMLElement, options: EinkKeyOptions): () => void {
  const doc = root.ownerDocument, win = doc.defaultView, held = new Set<string>();
  if (!win) return () => {};
  const reset = () => held.clear();
  const key = (event: KeyboardEvent) => event.key && event.key !== 'Unidentified' ? event.key : event.code;
  const down = (event: KeyboardEvent) => {
    const name = key(event); if (name !== 'PageUp' && name !== 'PageDown') return;
    if (!canTurnEinkPage(root, options.active, event)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || held.has(name)) return;
    held.add(name); options.turn((name === 'PageDown' ? 1 : -1) * (options.reverse() ? -1 : 1));
  };
  const up = (event: KeyboardEvent) => held.delete(key(event));
  const stopActive = options.onActiveChange?.(reset);
  doc.addEventListener('keydown', down, true); doc.addEventListener('keyup', up, true);
  doc.addEventListener('visibilitychange', reset); doc.addEventListener('pointerdown', reset, true); win.addEventListener('blur', reset);
  return () => {
    doc.removeEventListener('keydown', down, true); doc.removeEventListener('keyup', up, true);
    doc.removeEventListener('visibilitychange', reset); doc.removeEventListener('pointerdown', reset, true); win.removeEventListener('blur', reset);
    stopActive?.(); held.clear();
  };
}

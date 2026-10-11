/** Reader-local desktop navigation; never a workspace/global shortcut override. */
export function watchReaderKeys(root: HTMLElement, active: () => boolean, navigate: (delta: number) => void, mobile = false, queueAction?: (delta: number, move: boolean) => boolean, canNavigate: (delta: number) => boolean = () => true): () => void {
  const doc = root.ownerDocument, view = doc.defaultView;
  const keydown = (event: KeyboardEvent) => {
    if (!view || !root.isConnected || !active() || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (mobile) return;
    const key = event.shiftKey ? event.key.toLowerCase() : event.key;
    const queueKey = key === 'h' || key === 'l';
    if (!queueKey && (event.shiftKey || (key !== 'j' && key !== 'k'))) return;
    // Holding a move key must not relocate a run of articles.
    if (queueKey && event.shiftKey && event.repeat) return;
    if (event.composedPath().some(node => node instanceof Element && !!node.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))) return;
    if (root.querySelector('.r2-highlight-menu,.r2-dialog-shade,.r2-sidebar:not([hidden])')) return;
    if ([...doc.querySelectorAll<HTMLElement>('[role="dialog"],.modal-container,.prompt,.menu')].some(node => !root.contains(node) && node.getClientRects().length && view.getComputedStyle(node).visibility !== 'hidden')) return;
    if (queueKey) {
      if (queueAction?.(key === 'l' ? 1 : -1, event.shiftKey)) event.preventDefault();
      return;
    }
    const delta = event.key === 'j' ? 1 : -1;
    if (!canNavigate(delta)) return;
    event.preventDefault(); navigate(delta);
  };
  doc.addEventListener('keydown', keydown);
  return () => doc.removeEventListener('keydown', keydown);
}

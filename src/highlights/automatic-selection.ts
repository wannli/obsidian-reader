import { captureSelection } from './selection';
import { watchSelectionActivity } from './selection-activity';
import { rangeIsInside } from './text-index';
import type { SelectionSnapshot } from './types';

export interface CompletedSelectionOptions { settleMs?: number }
interface Boundary {
  startContainer: Node; startOffset: number; endContainer: Node; endOffset: number;
}
function sameBoundary(a: Boundary | null, b: Boundary | null): boolean {
  return a === b || !!(a && b && a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer && a.endOffset === b.endOffset);
}

/**
 * Auto-save candidate, once per native selection revision, after release + quiet.
 * Never changes selection, focus, touch-action, or default input behavior. A pause
 * during an observed pointer/touch/key gesture cannot complete a selection.
 * Native WKWebView handles may hide DOM input events: no timer can prove those
 * gestures ended. Physical iOS verification remains required, not inferred here.
 * The caller owns durable writes, serialization/retries and error presentation.
 */
export function watchCompletedSelection(
  root: HTMLElement, articleVersion: string, onComplete: (snapshot: SelectionSnapshot) => void,
  options: CompletedSelectionOptions = {},
): () => void {
  const document = root.ownerDocument;
  const window = document.defaultView;
  if (!window) return () => {};
  const requested = options.settleMs ?? 650;
  const delay = Number.isFinite(requested) ? Math.max(0, Math.min(10000, requested)) : 650;
  let timer: number | undefined;
  let boundary: Boundary | null = null;
  let revision = 0;
  let delivered = -1;
  let disposed = false;
  function inspect() {
    const selection = document.getSelection();
    const range = selection?.rangeCount === 1 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const next: Boundary | null = range && rangeIsInside(root, range) ? {
      startContainer: range.startContainer, startOffset: range.startOffset,
      endContainer: range.endContainer, endOffset: range.endOffset,
    } : null;
    if (!sameBoundary(boundary, next)) { boundary = next; revision++; }
  }
  function cancel() {
    if (timer !== undefined) window!.clearTimeout(timer);
    timer = undefined;
  }
  function abort() {
    cancel(); inspect(); delivered = revision; // Do not save a stale selection on refocus.
  }
  function schedule() {
    cancel(); inspect();
    if (disposed || activity.blocked() || !boundary || delivered === revision) return;
    const candidate = captureSelection(root, articleVersion);
    if (!candidate) return;
    const expectedRevision = revision;
    const signature = JSON.stringify(candidate.anchor);
    timer = window!.setTimeout(() => {
      timer = undefined;
      if (disposed || activity.blocked()) return;
      inspect();
      // Re-read native boundaries, even if a selectionchange event was missed.
      if (revision !== expectedRevision) { schedule(); return; }
      const snapshot = captureSelection(root, articleVersion);
      if (!snapshot) return;
      if (JSON.stringify(snapshot.anchor) !== signature) { schedule(); return; }
      delivered = revision;
      onComplete(snapshot);
    }, delay);
  }
  const activity = watchSelectionActivity(root, schedule, abort);
  document.addEventListener('selectionchange', schedule, { passive: true });
  schedule();
  return () => {
    if (disposed) return;
    disposed = true; cancel(); activity.dispose(); boundary = null;
    document.removeEventListener('selectionchange', schedule);
  };
}

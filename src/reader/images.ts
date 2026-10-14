/** Transient image controls; only already-loaded, sanitized image URLs are reused. */
export function imageViewer(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const events = new doc.defaultView!.AbortController();
  let dialog: HTMLDialogElement | undefined;
  let opener: HTMLImageElement | undefined;
  const dismiss = (restore = true) => {
    if (!dialog) return;
    dialog.querySelector('img')?.removeAttribute('src');
    dialog.remove();
    dialog = undefined;
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = undefined;
  };
  const open = (image: HTMLImageElement) => {
    const src = image.getAttribute('src');
    if (!src || dialog) return;
    opener = image;
    dialog = doc.createElement('dialog');
    dialog.className = 'reader-image-viewer modal-container';
    dialog.setAttribute('aria-label', image.alt || 'Enlarged image');
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = 'Close image';
    close.addEventListener('click', () => dismiss());
    const enlarged = doc.createElement('img');
    enlarged.alt = image.alt;
    enlarged.referrerPolicy = 'no-referrer';
    enlarged.src = src;
    dialog.append(close, enlarged);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      dismiss();
    });
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        close.focus({ preventScroll: true });
      }
    });
    doc.body.append(dialog);
    dialog.showModal();
    close.focus({ preventScroll: true });
  };
  for (const image of root.querySelectorAll('img')) {
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-haspopup', 'dialog');
    image.setAttribute('aria-label', `Enlarge image${image.alt ? `: ${image.alt}` : ''}`);
  }
  const activate = (event: MouseEvent | KeyboardEvent) => {
    const image = event.target as HTMLElement;
    if (image.tagName !== 'IMG') return;
    if (event instanceof doc.defaultView!.KeyboardEvent && !['Enter', ' '].includes(event.key))
      return;
    event.preventDefault();
    event.stopPropagation();
    open(image as HTMLImageElement);
  };
  root.addEventListener('click', activate, { capture: true, signal: events.signal });
  root.addEventListener('keydown', activate, { capture: true, signal: events.signal });
  return () => {
    events.abort();
    dismiss(false);
  };
}

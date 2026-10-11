import type { ReaderController } from '../controller';
import { button, element, messageOf } from './dom';
export interface LinkActions {
  internal: boolean;
  isCurrent(): boolean;
  open(): void | Promise<void>;
  chooseTarget?(choose: (target: string | null) => void): (() => void) | void;
  edit?(target: string): Promise<void>;
  unlink?(): Promise<void>;
  removeHighlight?(): Promise<void>;
}
export function linkMenu(parent: HTMLElement, url: string, title: string, controller: ReaderController, at: { x: number; y: number }, saved: () => void, context?: LinkActions): () => void {
  const doc = parent.ownerDocument, view = doc.defaultView, viewport = view?.visualViewport;
  const previous = doc.activeElement as HTMLElement | null;
  const panel = element('div', 'r2-highlight-menu'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Link actions');
  const description = element('p', 'r2-menu-quote', title || url); description.title = url;
  const error = element('p', 'r2-error'); error.setAttribute('role', 'alert');
  let closed = false, busy = false, choosing = false;
  let closePicker: (() => void) | void;
  const close = (restore = true) => {
    if (closed) return; closed = true; closePicker?.(); const focused = panel.contains(doc.activeElement); panel.remove();
    resize?.disconnect(); doc.removeEventListener('pointerdown', outside); doc.removeEventListener('keydown', keyboard);
    view?.removeEventListener('resize', position); viewport?.removeEventListener('resize', position); viewport?.removeEventListener('scroll', position);
    if (restore && focused && previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const outside = (e: PointerEvent) => { if (!choosing && !panel.contains(e.target as Node)) close(false); };
  const keyboard = (e: KeyboardEvent) => {
    if (choosing) return; // The native/synthetic modal owns dismissal and focus.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], first = controls[0], last = controls.at(-1);
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  const actions = element('div', 'r2-menu-actions');
  const save = button('Save as article', async () => {
    if (closed || context?.isCurrent() === false) return;
    save.disabled = true; save.textContent = 'Saving…'; error.textContent = '';
    try { await controller.capture(url, title); if (!closed && context?.isCurrent() !== false) saved(); close(); }
    catch (e) { if (!closed) { save.disabled = false; save.textContent = 'Save as article'; error.textContent = messageOf(e); position(); } }
  });
  async function act(work: () => void | Promise<void>) {
    if (closed || busy || context?.isCurrent() === false) return;
    busy = true; error.textContent = '';
    try { await work(); close(); }
    catch (e) { if (!closed) { error.textContent = messageOf(e); position(); } }
    finally { busy = false; }
  }
  actions.append(button(context?.internal ? 'Open note' : 'Open link ↗', () => act(() => context?.internal ? context.open() : void view?.open(url, '_blank', 'noopener,noreferrer'))));
  if (/^https?:\/\//i.test(url)) actions.append(save);
  if (context?.edit) actions.append(button('Edit link…', () => {
    if (closed || choosing || !context.isCurrent()) return;
    if (context.chooseTarget) {
      choosing = true;
      try { closePicker = context.chooseTarget(target => {
        choosing = false;
        if (target !== null) void act(() => context.edit!(target)); else close();
      }); } catch (e) { choosing = false; error.textContent = messageOf(e); position(); }
      return;
    }
    const form = element('form'), input = element('input'); input.value = url; input.setAttribute('aria-label', 'Note or URL'); input.required = true;
    const submit = element('button', '', 'Update link'); submit.type = 'submit'; form.append(input, submit);
    form.addEventListener('submit', event => { event.preventDefault(); void act(() => context.edit!(input.value.trim())); });
    actions.replaceChildren(form, button('Cancel', () => close())); position(); input.focus({ preventScroll: true });
  }));
  if (context?.unlink) actions.append(button('Unlink', () => act(context.unlink!)));
  if (context?.removeHighlight) actions.append(button('Remove highlight', () => act(context.removeHighlight!)));
  actions.append(button('Cancel', () => close()));
  function position() {
    if (closed) return;
    const bounds = parent.getBoundingClientRect();
    const left = Math.max(bounds.left, viewport?.offsetLeft ?? 0), top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
    const right = Math.min(bounds.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? view?.innerWidth ?? bounds.right));
    const bottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? view?.innerHeight ?? bounds.bottom));
    panel.style.maxHeight = Math.max(0, bottom - top - 16) + 'px';
    panel.style.left = Math.max(left + 8, Math.min(at.x, right - panel.offsetWidth - 8)) - bounds.left + 'px';
    panel.style.top = Math.max(top + 8, Math.min(at.y + 10, bottom - panel.offsetHeight - 8)) - bounds.top + 'px';
  }
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position); resize?.observe(parent);
  panel.append(description, actions, error); parent.append(panel); position();
  doc.addEventListener('pointerdown', outside); doc.addEventListener('keydown', keyboard); view?.addEventListener('resize', position);
  viewport?.addEventListener('resize', position); viewport?.addEventListener('scroll', position);
  actions.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); return () => close(false);
}

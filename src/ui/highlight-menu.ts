import type { Article, Highlight } from '../types';
import type { ReaderController } from '../controller';
import type { ReaderHost } from './reader';
import { button, element, messageOf } from './dom';
import { defaultHighlightTarget } from './default-highlight-target';
export function highlightMenu(parent: HTMLElement, article: Article, highlight: Highlight, controller: ReaderController, host: ReaderHost, at: {x: number; y: number}, updated: (article: Article) => void, current: () => boolean = () => true, runWrite: (work: () => Promise<Article>) => Promise<Article> = work => work()): () => void {
  const doc = parent.ownerDocument, view = doc.defaultView, viewport = view?.visualViewport;
  const previous = doc.activeElement as HTMLElement | null;
  let closed = false, busy = false, choosing = false, closePicker: (() => void) | void;
  const panel = element('div', 'r2-highlight-menu'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Highlight actions'); panel.tabIndex = -1;
  const title = element('p', 'r2-menu-quote', highlight.quote.length > 90 ? highlight.quote.slice(0, 90) + '…' : highlight.quote);
  const error = element('p', 'r2-error'); error.setAttribute('role', 'alert');
  const close = (restore = true) => {
    if (closed) return; closed = true; closePicker?.();
    const focused = panel.contains(doc.activeElement);
    panel.remove(); resize?.disconnect(); doc.removeEventListener('pointerdown', outside); doc.removeEventListener('keydown', keyboard);
    view?.removeEventListener('resize', position); viewport?.removeEventListener('resize', position); viewport?.removeEventListener('scroll', position);
    if (restore && focused && previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const outside = (e: PointerEvent) => { if (!choosing && !panel.contains(e.target as Node)) close(false); };
  const keyboard = (e: KeyboardEvent) => {
    if (choosing) return; // The chooser, not this underlying menu, owns keyboard focus.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
    const first = controls[0], last = controls.at(-1);
    if (!first) { e.preventDefault(); panel.focus({ preventScroll: true }); }
    else if (e.shiftKey && (doc.activeElement === first || !panel.contains(doc.activeElement))) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (doc.activeElement === last || !panel.contains(doc.activeElement))) { e.preventDefault(); first.focus(); }
  };
  const actions = element('div', 'r2-menu-actions');
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
  async function act(action: () => Promise<Article>, propagate = false) {
    if (busy || closed || !current()) return; busy = true; error.textContent = ''; panel.setAttribute('aria-busy', 'true');
    panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button,input').forEach(control => control.disabled = true);
    try { const next = await runWrite(action); if (!closed && current()) updated(next); close(); }
    catch (e) {
      if (!closed) {
        error.textContent = messageOf(e); panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>('button,input').forEach(control => control.disabled = false);
        position(); panel.querySelector<HTMLElement>('input,button')?.focus({ preventScroll: true });
      }
      if (propagate) throw e;
    } finally { busy = false; panel.removeAttribute('aria-busy'); }
  }
  function linkForm() {
    actions.replaceChildren(); const form = element('form'); const input = element('input');
    input.type = 'text'; input.placeholder = 'Note name or https://…'; input.value = highlight.link ?? ''; input.setAttribute('aria-label', 'Note or URL'); input.required = true;
    const save = element('button', 'r2-primary', 'Link'); save.type = 'submit';
    const description = element('p', 'r2-muted', 'The words stay the same. The Markdown gets a link.');
    form.append(input, description); savedLinkActions(form); form.append(save, button('Cancel', () => close())); actions.append(form); position(); input.focus({ preventScroll: true });
    form.addEventListener('submit', e => { e.preventDefault(); void act(() => controller.linkHighlight(article.path, highlight.id, input.value.trim())); });
  }
  function savedLinkActions(form: HTMLElement) {
    if (highlight.link) form.append(button(linkedNode ? 'Open node' : 'Open saved link ↗', async () => {
      try { if (/^https?:\/\//i.test(highlight.link!)) view?.open(highlight.link, '_blank', 'noopener,noreferrer'); else await host.openNote(highlight.link!, article.path); close(); }
      catch (e) { if (!closed) { error.textContent = messageOf(e); position(); } }
    }));
    if (highlight.link && /^https?:\/\//i.test(highlight.link)) {
      const saveUrl = button('Save as article', async () => {
        saveUrl.disabled = true; saveUrl.textContent = 'Saving…';
        try { await controller.capture(highlight.link!, highlight.quote); if (!closed) { saveUrl.textContent = 'Saved URL'; saveUrl.setAttribute('aria-label', 'URL saved'); } }
        catch (e) { if (!closed) { error.textContent = messageOf(e); saveUrl.disabled = false; saveUrl.textContent = 'Save as article'; position(); } }
      }); form.append(saveUrl);
    }
  }
  const choose = () => {
    if (closed || choosing || !current()) return;
    if (host.pickLinkTarget) {
      choosing = true;
      try { closePicker = host.pickLinkTarget(highlight.quote, target => {
        choosing = false;
        if (target !== null) void act(() => controller.linkHighlight(article.path, highlight.id, target)); else close();
      }); } catch (e) { choosing = false; error.textContent = messageOf(e); position(); }
    } else linkForm();
  };
  const linkedNode = !!highlight.link && (!!highlight.color || !!host.nodeForLink?.(highlight.link, article.path));
  actions.append(button(linkedNode ? 'Change linked node…' : 'Link to node…', () => {
    if (!host.pickNode) { error.textContent = 'Enable a compatible Nodes plugin to link nodes. Ordinary links still work.'; return; }
    choosing = true;
    closePicker = host.pickNode(highlight.quote, article.path, () => !closed && current(), async (node, guard) => {
      choosing = false;
      await act(() => controller.linkNode(article.path, highlight.id, node, guard), true);
    }, () => { choosing = false; }, () => controller.repository.validateNodeHighlight(article.path, highlight.id));
  }));
  if (linkedNode) {
    savedLinkActions(actions);
    actions.append(button('Unlink', () => act(() => controller.linkNode(article.path, highlight.id, null))));
  } else actions.append(button('Link', () => { const result = defaultHighlightTarget(highlight.quote); if ('target' in result) void act(() => controller.linkHighlight(article.path, highlight.id, result.target)); else choose(); }), button('Link to…', choose));
  actions.append(button('Remove highlight', () => act(() => controller.deleteHighlight(article.path, highlight.id, linkedNode)), 'r2-delete'));
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position); resize?.observe(parent);
  panel.append(title, actions, error); parent.append(panel); position();
  doc.addEventListener('pointerdown', outside); doc.addEventListener('keydown', keyboard);
  view?.addEventListener('resize', position); viewport?.addEventListener('resize', position); viewport?.addEventListener('scroll', position);
  actions.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  return () => close(false);
}

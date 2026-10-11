import { createEinkAnchors } from './eink-anchor';
import type { EinkAnchor, EinkGeometry, EinkPagination, EinkPaginationOptions, ReadingPosition } from './eink-types';
export type { EinkPagination, EinkPaginationOptions, ReadingPosition } from './eink-types';

/** CSS fragmentation only: the canonical body and its native highlight ranges stay intact. */
export function createEinkPagination(
  viewport: HTMLElement, page: HTMLElement, body: HTMLElement, options: EinkPaginationOptions = {},
): EinkPagination {
  const doc = viewport.ownerDocument, win = doc.defaultView!;
  const anchors = createEinkAnchors(viewport, page, body);
  let current = 0, total = 1, contentTotal = 1, ready = false, disposed = false, frame = 0, dirty = true, signature = '';
  let endPage: HTMLElement | undefined, atEnd = false;
  let geometry: EinkGeometry = { flow: 1, stride: 1, gutter: 0, width: 1, height: 1 };
  let anchor: EinkAnchor = { position: { ...(options.initialPosition ?? { marker: '' }) } };
  const original = new Map<string, [string, string]>(), applied = new Map<string, string>();
  function style(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      if (!original.has(key)) original.set(key, [page.style.getPropertyValue(key), page.style.getPropertyPriority(key)]);
      if (page.style.getPropertyValue(key) !== value) page.style.setProperty(key, value);
      applied.set(key, value);
    }
  }
  const usable = () => !disposed && viewport.isConnected && viewport.clientWidth > 0 && viewport.clientHeight > 0
    && win.getComputedStyle(viewport).visibility !== 'hidden';
  function resetScroll() { if (!disposed) viewport.scrollLeft = viewport.scrollTop = 0; }
  function paint() {
    style({ transform: `translateX(${-Math.min(current, contentTotal - 1) * geometry.stride * geometry.flow}px)` });
    viewport.classList.toggle('r2-eink-finish', ready && atEnd);
    if (endPage) {
      if ((!ready || !atEnd) && endPage.contains(doc.activeElement)) viewport.focus({ preventScroll: true });
      endPage.hidden = !ready || !atEnd;
    }
    resetScroll();
  }
  function unavailable() {
    const wasReady = ready; ready = false; style({ visibility: 'hidden' }); paint();
    if (wasReady) options.onChange?.();
  }
  function paginate() {
    if (disposed) return;
    if (!usable()) { unavailable(); return; }
    const previous = [current, total, ready, geometry.stride, geometry.height, geometry.flow].join(':');
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const computed = win.getComputedStyle(page), text = win.getComputedStyle(body);
    const line = parseFloat(text.lineHeight) || (parseFloat(text.fontSize) || 18) * 1.6;
    const key = [width, height, computed.direction, computed.maxWidth, computed.font, computed.letterSpacing,
      text.font, text.lineHeight, text.letterSpacing, text.wordSpacing].join(':');
    if (!dirty && ready && key === signature) return;
    if (width < 140 || height - 32 < Math.max(80, line * 2.5)) { unavailable(); return; }
    const maxWidth = parseFloat(computed.maxWidth) || 700;
    const gutter = Math.max(18, (width - Math.min(maxWidth, width - 40)) / 2);
    geometry = { flow: computed.direction === 'rtl' ? -1 : 1, stride: width, gutter, width: width - gutter * 2, height: height - 32 };
    style({ width: `${geometry.width}px`, height: `${geometry.height}px`, left: `${gutter}px`, top: '16px',
      'column-width': `${geometry.width}px`, 'column-gap': `${gutter * 2}px`, transform: 'none',
      '--r2-eink-page-height': `${geometry.height}px`, visibility: original.get('visibility')?.[0] ?? '' });
    contentTotal = anchors.count(geometry);
    total = contentTotal + (endPage ? 1 : 0);
    current = atEnd && endPage ? total - 1 : Math.min(contentTotal - 1, anchors.pageFor(anchor, geometry, 0));
    ready = true; dirty = false; signature = key;
    paint();
    if (previous !== [current, total, ready, geometry.stride, geometry.height, geometry.flow].join(':')) options.onChange?.();
    // Never recapture after reflow: retain the precise character, avoiding resize drift.
  }
  function cancel() { win.cancelAnimationFrame(frame); frame = 0; }
  function schedule(force = false) {
    if (disposed) return;
    dirty ||= force;
    if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; paginate(); });
  }
  function settle() { cancel(); paginate(); }
  const reflow = () => schedule(true), resize = () => schedule();
  const observer = typeof win.ResizeObserver === 'function'
    ? new win.ResizeObserver(entries => schedule(entries.some(entry => entry.target === body))) : undefined;
  observer?.observe(viewport); observer?.observe(body);
  const ui = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-reader-ui]');
  const changes = new win.MutationObserver(records => {
    let changed = false, force = false;
    for (const record of records) {
      if (ui(record.target)) continue;
      if (record.type === 'childList' && ![...record.addedNodes, ...record.removedNodes].some(node => !ui(node))) continue;
      changed = true;
      // Our own transform/geometry writes should check typography, not trigger a loop.
      if (!(record.target === page && record.type === 'attributes' && record.attributeName === 'style')) force = true;
    }
    if (changed) schedule(force);
  });
  changes.observe(page, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['style', 'class', 'dir', 'hidden', 'src', 'width', 'height'] });
  for (let parent = viewport; parent; parent = parent.parentElement!) {
    changes.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'dir', 'hidden'] });
  }
  // Obsidian font/theme settings can update a stylesheet without resizing the viewport.
  if (doc.head) changes.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true });
  viewport.addEventListener('scroll', resetScroll);
  page.addEventListener('load', reflow, true); page.addEventListener('error', reflow, true);
  win.addEventListener('resize', resize); win.visualViewport?.addEventListener('resize', resize);
  doc.addEventListener('visibilitychange', reflow);
  doc.fonts?.addEventListener('loadingdone', reflow);
  void doc.fonts?.ready?.then(() => { if (!disposed) reflow(); });
  paginate();
  return {
    turn(delta) {
      if (disposed || !Number.isFinite(delta) || !Math.trunc(delta)) return false;
      // A queued resize never holds an older anchor; settle before accepting new navigation.
      settle(); if (!ready) return false;
      const next = Math.max(0, Math.min(total - 1, current + Math.trunc(delta)));
      if (next === current) return false;
      current = next; atEnd = !!endPage && current === total - 1;
      paint(); anchor = anchors.capture(geometry, Math.min(current, contentTotal - 1)); options.onChange?.(); return true;
    },
    reveal(range) {
      if (disposed) return false;
      const position = anchors.positionForRange(range);
      if (!position) return false;
      settle();
      const next = ready ? anchors.rangePage(range, geometry, current) : null;
      anchor = { position };
      atEnd = false;
      if (next !== null) { current = Math.max(0, Math.min(contentTotal - 1, next)); paint(); }
      else schedule(true); // A hidden view will resolve the body anchor when shown.
      options.onChange?.(); return true;
    },
    getPosition() { return { ...anchor.position }; },
    restore(position: ReadingPosition) {
      if (disposed) return;
      anchor = { position: { ...position } }; atEnd = false; dirty = true; settle();
    },
    setEndPage(element: HTMLElement) {
      if (disposed || endPage === element) return;
      endPage?.remove(); endPage = element; endPage.hidden = true;
      viewport.append(endPage); schedule(true);
    },
    refresh() { schedule(true); },
    progress() { return { page: current + 1, total, ready: ready && usable() }; },
    dispose() {
      if (disposed) return;
      disposed = true; cancel(); observer?.disconnect(); changes.disconnect();
      viewport.classList.remove('r2-eink-finish'); if (endPage) endPage.hidden = true;
      viewport.removeEventListener('scroll', resetScroll);
      page.removeEventListener('load', reflow, true); page.removeEventListener('error', reflow, true);
      win.removeEventListener('resize', resize); win.visualViewport?.removeEventListener('resize', resize);
      doc.removeEventListener('visibilitychange', reflow); doc.fonts?.removeEventListener('loadingdone', reflow);
      for (const [key, [value, priority]] of original) {
        if (page.style.getPropertyValue(key) !== applied.get(key)) continue;
        if (value) page.style.setProperty(key, value, priority); else page.style.removeProperty(key);
      }
    },
  };
}

import type { Article, ArticleStatus } from '../types';
import type { ReaderController } from '../controller';
import { captureSelection, watchCompletedSelection, paintHighlights, hitTestHighlights } from '../highlights/index';
import { buildCanonicalTextIndex, rangeFromPosition } from '../highlights/text-index';
import { parseInlineMarkdown } from '../inline/parser';
import type { SelectionSnapshot, ResolvedHighlight } from '../highlights/types';
import { element, messageOf } from './dom';
import { renderArticle } from './render';
import { highlightMenu } from './highlight-menu';
import { linkMenu } from './link-menu';
import { createEinkPagination, type EinkPagination } from './eink-pagination';
import { trackScrollPosition } from './scroll-position';
import { persistPosition } from './persist-position';
import type { ReadingPosition } from './eink-types';
import { canTurnEinkPage, watchEinkKeys } from './eink-input';
import { watchReadingChrome } from './reading-chrome';
export interface ReaderHost {
  confirmTrash?(eligible: number, skipped: number): Promise<boolean>;
  nodeForLink?(target: string, source: string): import('../nodes-api').NodeResult | null;
  pickNode?(quote: string, source: string, current: () => boolean, choose: (node: import('../nodes-api').NodeResult, guard: () => void) => Promise<void | (() => void)>, finished?: () => void, preflight?: () => Promise<void>): () => void;
  openNote(path: string, source?: string): void | Promise<void>;
  pickLinkTarget?(quote: string, choose: (target: string | null) => void): (() => void) | void;
  visibleOverlays?(): readonly HTMLElement[];
  openMarkdown?(path: string): void | Promise<void>;
  autoOpen?: boolean;
  isMobile?: boolean;
  setChromeHidden?(hidden: boolean): void;
  shouldFocus?(): boolean;
  onStateChange?(): void;
  einkEnabled?(): boolean;
  reversePageButtons?(): boolean;
  onEinkChange?(callback: () => void): () => void;
  onActiveChange?(callback: () => void): () => void;
  notify?(message: string): void;
  pickArticle?(articles: Article[], queue: ArticleStatus, choose: (path: string) => void): void;
  highlightMenu?: typeof highlightMenu;
  linkMenu?: typeof linkMenu;
}
export type ReaderMount = (() => void | Promise<void>) & {
  getPosition?(): ReadingPosition;
  flushPosition?(): Promise<void>;
  /** Raw CAS baseline advanced only by this mount's confirmed writes. */
  getWriteRevision?(): string | undefined;
  remapPosition?(path: string): void;
  restorePosition?(position: ReadingPosition): void;
  revealRange?(range: Range): boolean;
  update?(article: Article): boolean;
  setArticleEnd?(element: HTMLElement): void;
  canLeave?(): boolean;
  setNavigationBusy?(busy: boolean): void;
};
export function mountReader(target: HTMLElement, initial: Article, controller: ReaderController, host: ReaderHost, _refresh: () => void): ReaderMount {
  let article = initial, disposed = false, saving = false, navigationBusy = false, pending: SelectionSnapshot | null = null;
  let staleDOM = false, needsRender = false, positionEpoch = 0, navigationEpoch = 0, canonicalEpoch = 0, annotationWrites = 0;
  const failedWrites = new Map<string, string>();
  let articleEnd: HTMLElement | undefined;
  const generation = controller.repository.articleGeneration(initial.path);
  let clearPaint = () => {}, closeMenu = () => {};
  let resolved: ResolvedHighlight[] = [];
  let pagination: EinkPagination | undefined, stopPageKeys = () => {};
  let positionChanged = () => {};
  let positionPath = initial.path, positionGeneration = controller.repository.articleGeneration(initial.path);
  // Raw bytes from getArticle: two idless notes can occupy the same filename
  // before a native generation event reaches the reader.
  let positionRevision = initial.revision;
  const shell = element('div', 'r2-reader');
  const saveState = element('span', 'r2-save-state'); saveState.setAttribute('role', 'status'); saveState.setAttribute('data-reader-ui', 'save-state');
  const scroll = element('div', 'r2-reader-scroll'); scroll.tabIndex = -1;
  const page = element('article', 'r2-reading-page markdown-rendered');
  const title = element('h1', 'r2-article-title', article.title); title.tabIndex = -1;
  const excerpt = article.extractor === 'summary' && !!article.body.trim();
  const warning = element('p', 'r2-warning', article.error ?? (excerpt ? 'Feed excerpt' : '')); warning.hidden = !warning.textContent; warning.classList.toggle('r2-warning-info', excerpt && !article.error);
  const body = element('div', 'r2-article-body');
  let parsed = renderArticle(article.body, body, { stripTitle: article.title });
  const version = parsed.revision; body.dataset.articleVersion = version;
  const error = element('p', 'r2-error'); error.setAttribute('role', 'alert');
  if (!article.body.trim()) body.append(element('p', 'r2-empty', article.url ? 'Full text is pending.' : 'This article has no text yet.'));
  const summary = element('p', 'r2-highlight-summary');
  page.append(title, warning, body, summary, error, saveState); scroll.append(page);
  shell.append(scroll); target.replaceChildren(shell);
  const chrome = host.isMobile && host.setChromeHidden ? watchReadingChrome(scroll, shell, {
    active: () => host.shouldFocus?.() ?? false,
    setHidden: hidden => host.setChromeHidden!(hidden), onActiveChange: host.onActiveChange,
  }) : undefined;
  if (host.einkEnabled?.()) {
    shell.classList.add('r2-eink');
    scroll.tabIndex = -1;
    const active = () => host.shouldFocus?.() ?? shell.contains(shell.ownerDocument.activeElement);
    const turn = (delta: number) => {
      const turned = canTurnEinkPage(shell, active) && !!pagination?.turn(delta);
      if (turned) chrome?.turn(delta);
      return turned;
    };
    const updatePages = () => {
      if (pagination) {
        const { page, total, ready } = pagination.progress();
        shell.dataset.page = ready ? String(page) : '';
        shell.dataset.pageTotal = ready ? String(total) : '';
      }
      host.onStateChange?.(); positionChanged();
    };
    pagination = createEinkPagination(scroll, page, body, { onChange: updatePages }); updatePages();
    stopPageKeys = watchEinkKeys(shell, { active, reverse: () => host.reversePageButtons?.() ?? false, turn, onActiveChange: host.onActiveChange });
  }
  const scrollPosition = pagination ? undefined : trackScrollPosition(scroll, body);
  const getPosition = () => pagination?.getPosition() ?? scrollPosition!.getPosition();
  const persistence = persistPosition(scroll, () => staleDOM ? undefined : getPosition(),
    async position => {
      if (staleDOM) return; // Never persist an anchor sampled from an externally stale selected DOM.
      if (controller.repository.articleGeneration(positionPath) !== positionGeneration) throw new Error('Article changed; reading position was not saved.');
      if (positionRevision === undefined) {
        // Synthetic mounts without a raw revision retain the legacy test adapter;
        // real ReaderApp mounts always originate from repository.getArticle.
        await controller.repository.saveReadingPosition(positionPath, position, positionGeneration);
      } else {
        const expected = positionRevision;
        const saved = await controller.repository.saveReadingPositionRevision(positionPath, position, positionGeneration, expected);
        if (positionRevision === expected) positionRevision = saved.revision;
      }
    },
    cause => { const message = 'Could not save reading position: ' + messageOf(cause); if (!disposed) error.textContent = message; host.notify?.(message); }, () => positionEpoch);
  positionChanged = persistence.changed;
  function isCurrent() { return !disposed && controller.repository.articleGeneration(initial.path) === generation; }
  function selectedInBody() {
    const selection = body.ownerDocument.getSelection();
    return !!selection && !selection.isCollapsed && [...Array(selection.rangeCount).keys()].some(i => selection.getRangeAt(i).intersectsNode(body));
  }
  function accept(next: Article, ownWrite = false) {
    if (disposed) return;
    if (article.body !== next.body || article.title !== next.title) {
      closeMenu();
      const updated = parseInlineMarkdown(next.body, { stripTitle: next.title });
      if (updated.canonicalText !== parsed.canonicalText) canonicalEpoch++;
      if (!ownWrite || updated.canonicalText !== parsed.canonicalText) positionEpoch++;
      staleDOM = buildCanonicalTextIndex(body).text !== updated.canonicalText || (!ownWrite && selectedInBody());
      parsed = updated; needsRender = true;
      if (staleDOM) { pending = null; error.textContent = 'Article changed. Clear the selection and select again.'; }
    }
    // Only a confirmed write from this mount may advance the raw CAS baseline.
    // External refresh can be a same-path replacement before generation changes.
    if (ownWrite && next.revision !== undefined) positionRevision = next.revision;
    article = next; title.textContent = next.title;
    warning.textContent = next.error ?? (next.extractor === 'summary' && next.body.trim() ? 'Feed excerpt' : ''); warning.hidden = !warning.textContent;
    body.dataset.articleVersion = parsed.revision;
    flushRender(); repaint();
  }
  function flushRender() {
    if (disposed || saving || !needsRender || selectedInBody()) return;
    const top = scroll.scrollTop, position = pagination?.getPosition();
    clearPaint(); parsed = renderArticle(article.body, body, { stripTitle: article.title }); needsRender = false; staleDOM = false;
    repaint(); scroll.scrollTop = top; if (position) pagination?.restore(position);
  }
  function repaint() {
    if (disposed) return;
    clearPaint(); resolved = []; let missing = 0;
    const index = buildCanonicalTextIndex(body);
    if (!staleDOM) for (const item of parsed.highlights) {
      try { resolved.push({ id: item.id, range: rangeFromPosition(index, item.anchor), colour: ({ '🟡': 'yellow', '🟠': 'orange', '🔵': 'blue', '🟢': 'green', '🟣': 'purple', '🔴': 'red' } as const)[item.color ?? '🟡'] }); }
      catch { missing++; }
    }
    clearPaint = paintHighlights(body, resolved);
    summary.textContent = [...(parsed.warnings ?? []), ...(missing ? [missing + ' highlights could not be located in this text.'] : [])].join(' ');
    body.dataset.highlightCount = String(resolved.length); pagination?.refresh();
  }
  // Retry identity survives verified canonical-text-preserving syntax edits,
  // unlike source offsets and revision-bound IDs. Never reuse it after text edits.
  // Execution still uses the current menu revision/ID and repository guards.
  function failureKey(kind: 'selection' | 'highlight' | 'link', position: { start: number; end: number }, quote: string) {
    return JSON.stringify([kind, canonicalEpoch, position.start, position.end, quote]);
  }
  // Menus have their own busy flags (including native menus). Track their writes
  // here too: collapsing a selection/dismissing a menu is not durable completion.
  function showSaved() {
    saveState.textContent = failedWrites.size ? 'Not fully saved' : 'Saved';
    if (failedWrites.size) error.textContent = [...failedWrites.values()].at(-1)!;
  }
  async function annotationWrite(key: string, work: () => Promise<Article>): Promise<Article> {
    annotationWrites++;
    try {
      // A Stream annotation can rename the file before this promise returns.
      // Persist its position while the current raw revision still applies.
      if (article.status === 'feed') await persistence.flush();
      const next = await work(), recovered = failedWrites.delete(key);
      if (!disposed) { if (recovered && !failedWrites.size) error.textContent = ''; showSaved(); }
      return next;
    } catch (cause) {
      failedWrites.set(key, messageOf(cause));
      if (!disposed) { saveState.textContent = 'Not fully saved'; error.textContent = messageOf(cause); }
      throw cause;
    } finally { annotationWrites--; }
  }
  function savedSelection(selected: SelectionSnapshot) {
    const { position, quote } = selected.anchor;
    return parsed.highlights.some(item => item.anchor.version === parsed.revision
      && item.anchor.start === position.start && item.anchor.end === position.end && item.quote === quote.exact);
  }
  function canLeave() {
    if (!isCurrent() || staleDOM || saving || pending || annotationWrites || failedWrites.size) return false;
    if (!selectedInBody()) return true;
    const selected = captureSelection(body, parsed.revision);
    // Unsupported/cross-boundary selections can fail capture. Never mistake that
    // for no selection, or trust persisted legacy highlight arrays/painted ranges.
    return !!selected && savedSelection(selected);
  }
  const protectSelection = (event: PointerEvent) => {
    if (articleEnd?.contains(event.target as Node) && !canLeave()) event.preventDefault();
  };
  scroll.addEventListener('pointerdown', protectSelection);
  async function save(selected: SelectionSnapshot) {
    if (disposed || navigationBusy || target.closest('[inert]')) return;
    if (staleDOM || !isCurrent()) { error.textContent = 'Article changed. Clear the selection and select again.'; return; }
    pending = selected; closeMenu(); if (saving) return; saving = true;
    try {
      while (pending && !disposed) {
        const current = pending; pending = null; saveState.textContent = 'Saving…'; error.textContent = '';
        const { quote, position } = current.anchor;
        if (!isCurrent() || staleDOM) throw new Error('Article changed. Select the text again.');
        // The DOM text is unchanged by our own syntax edits; rebind queued positions
        // only to that verified canonical text, never to an externally edited body.
        if (savedSelection(current)) { showSaved(); continue; }
        const key = failureKey('selection', position, quote.exact);
        const updated = await annotationWrite(key, () => controller.highlight(article.path, quote.exact, { ...position, prefix: quote.prefix, suffix: quote.suffix, version: parsed.revision }));
        if (!disposed && isCurrent()) { accept(updated, true); showSaved(); }
      }
    } catch (e) {
      if (!disposed) {
        saveState.textContent = 'Not fully saved'; error.textContent = messageOf(e);
        pending = null;
        try { const latest = await controller.repository.getArticle(article.path); if (!disposed && isCurrent()) accept(latest); } catch { /* Keep original error. */ }
      }
    } finally { saving = false; flushRender(); }
  }
  const unwatch = watchCompletedSelection(body, version, selected => { void save(selected); }, { settleMs: 900 });
  const onClick = (event: MouseEvent) => {
    if (navigationBusy || target.closest('[inert]')) { event.preventDefault(); return; }
    if (disposed || saving || staleDOM || !isCurrent()) return;
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!body.ownerDocument.getSelection()?.isCollapsed) { if (link) event.preventDefault(); return; }
    const typedMark = (event.target as HTMLElement).closest<HTMLElement>('mark[data-inline-highlight-id]');
    const nodeMark = typedMark && (typedMark.dataset.highlightColor || (link && host.nodeForLink?.(link.getAttribute('href') ?? '', article.path)));
    if (link && (!nodeMark || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) {
      const href = link.getAttribute('href') ?? '', internal = !/^(?:https?|mailto):/i.test(href);
      const item = parsed.links.find(item => item.id === link.dataset.inlineLinkId);
      const enclosingMark = item && parsed.highlights.find(mark => mark.source.start <= item.source.start && mark.source.end >= item.source.end);
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        if (internal) { event.preventDefault(); void Promise.resolve(host.openNote(href, article.path)).catch(e => { error.textContent = messageOf(e); }); }
        return;
      }
      event.preventDefault(); closeMenu();
      const revision = parsed.revision, epoch = navigationEpoch;
      const current = () => isCurrent() && !navigationBusy && !staleDOM && navigationEpoch === epoch && parsed.revision === revision;
      // Retry identity follows the mutated annotation, not the clicked link:
      // removing an enclosing mark must agree with its own highlight menu.
      const write = (key: string, work: () => Promise<Article>) => {
        if (!current() || !item) throw new Error('Article changed. Open the link again.');
        return annotationWrite(key, work);
      };
      const rect = link.getBoundingClientRect();
      closeMenu = (host.linkMenu ?? linkMenu)(shell, href, link.textContent?.trim() ?? '', controller, { x: event.clientX || rect.left, y: event.clientY || rect.bottom }, () => {
        if (current()) saveState.textContent = 'Saved URL';
      }, {
        internal, isCurrent: current, open: () => host.openNote(href, article.path),
        chooseTarget: host.pickLinkTarget ? choose => host.pickLinkTarget!(item?.quote ?? link.textContent ?? '', choose) : undefined,
        edit: item ? async target => { const next = await write(failureKey('link', item.anchor, item.quote), () => controller.setLinkTarget(article.path, item.id, target)); if (current()) accept(next, true); } : undefined,
        unlink: item ? async () => { const next = await write(failureKey('link', item.anchor, item.quote), () => controller.unlink(article.path, item.id)); if (current()) accept(next, true); } : undefined,
        removeHighlight: enclosingMark ? async () => { const next = await write(failureKey('highlight', enclosingMark.anchor, enclosingMark.quote), () => controller.deleteHighlight(article.path, enclosingMark.id)); if (current()) accept(next, true); } : undefined,
      }); return;
    }
    if (typedMark) event.preventDefault();
    const hits = hitTestHighlights(body, resolved, event.clientX, event.clientY);
    const mark = (event.target as HTMLElement).closest<HTMLElement>('[data-inline-highlight-id]');
    const item = parsed.highlights.find(h => mark?.dataset.inlineHighlightId === h.id || hits.some(hit => hit.id === h.id)); if (!item) return;
    const revision = parsed.revision, epoch = navigationEpoch;
    const current = () => isCurrent() && !navigationBusy && !staleDOM && navigationEpoch === epoch && parsed.revision === revision;
    closeMenu(); closeMenu = (host.highlightMenu ?? highlightMenu)(shell, article, item, controller, host, { x: event.clientX, y: event.clientY }, updated => {
      if (!current()) return; accept(updated, true); showSaved();
    }, current, work => {
      if (!current()) throw new Error('Article changed. Open the highlight again.');
      return annotationWrite(failureKey('highlight', item.anchor, item.quote), work);
    });
  };
  body.addEventListener('click', onClick); repaint();
  body.ownerDocument.addEventListener('selectionchange', flushRender);
  const dispose = () => {
    const write = persistence.dispose();
    if (!disposed) { disposed = true; pending = null; chrome?.dispose(); stopPageKeys(); pagination?.dispose(); scrollPosition?.dispose(); unwatch(); clearPaint(); closeMenu(); body.removeEventListener('click', onClick); body.ownerDocument.removeEventListener('selectionchange', flushRender); scroll.removeEventListener('pointerdown', protectSelection); }
    return write;
  };
  return Object.assign(dispose, {
    update: (next: Article) => {
      if (disposed || next.path !== article.path) return false;
      if (!saving) accept(next);
      return true;
    },
    getPosition,
    canLeave,
    setNavigationBusy: (busy: boolean) => {
      if (disposed || navigationBusy === busy) return;
      // Set the guard before closing pickers: disposal can itself call a chooser.
      // An old callback stays invalid even after an aborted move unlocks the body.
      navigationBusy = busy; body.toggleAttribute('inert', busy);
      if (busy) {
        navigationEpoch++; closeMenu();
        if (selectedInBody()) body.ownerDocument.getSelection()?.removeAllRanges();
      }
    },
    setArticleEnd: (element: HTMLElement) => {
      // UI only, outside the source/selection/position index. In Boox mode
      // page keys reach a separate completion page after the text columns.
      if (disposed) return;
      if (articleEnd !== element) articleEnd?.remove();
      articleEnd = element;
      if (pagination) pagination.setEndPage(element);
      else if (element.parentElement !== page) page.append(element);
    },
    flushPosition: persistence.flush,
    getWriteRevision: () => positionRevision,
    remapPosition: (path: string) => {
      if (positionPath === path) return;
      positionPath = path; positionGeneration = controller.repository.articleGeneration(path);
      // Promotion already flushed this mount before writing annotation bytes.
      // Its pre-annotation CAS baseline must not be replayed during native remount.
      if (article.status === 'feed' && annotationWrites) persistence.restored();
      else persistence.remapped();
    },
    restorePosition: (position: ReadingPosition) => {
      chrome?.reset();
      if (pagination) pagination.restore(position);
      else scrollPosition!.restorePosition(position);
      persistence.restored();
    },
    revealRange: pagination ? (range: Range) => pagination!.reveal(range) : undefined,
  });
}

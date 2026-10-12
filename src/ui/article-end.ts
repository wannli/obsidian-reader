import type { Article, ArticleStatus } from '../types';
import { queueLabel } from '../reading-layout';
import { button, element, messageOf } from './dom';

export interface ArticleEndState {
  article: Article;
  queue: ArticleStatus;
  next?: Article;
  busy?: boolean;
  deleting?: boolean;
  error?: string;
}
export interface ArticleEndActions {
  archive(): void | Promise<void>;
  delete?(): void | Promise<void>;
  deleteNewer?(): void | Promise<void>;
  next(): void | Promise<void>;
  library(): void | Promise<void>;
}

/** Reading controls, never source content. Keep stable nodes so refreshes preserve focus. */
export function createArticleEnd(actions: ArticleEndActions) {
  const root = element('nav', 'r2-article-end');
  root.setAttribute('aria-label', 'After reading');
  root.dataset.readerUi = 'article-end';
  const context = element('p', 'r2-article-end-context');
  const title = element('p', 'r2-article-end-title');
  const controls = element('div', 'r2-article-end-actions');
  const error = element('p', 'r2-error r2-article-end-error'); error.setAttribute('role', 'alert');
  let state: ArticleEndState | undefined;
  function invoke(action: () => void | Promise<void>) {
    if (!state || state.busy) return;
    const path = state.article.path;
    void Promise.resolve().then(action).catch(cause => {
      if (root.isConnected && state?.article.path === path) { error.hidden = false; error.textContent = messageOf(cause); }
    });
  }
  const archive = button('Archive & next', () => invoke(actions.archive), 'r2-article-end-primary mod-cta');
  archive.title = 'Move this article to Treasury and continue in the current queue';
  const next = button('Next without archiving', () => invoke(actions.next), 'r2-article-end-next');
  const library = button('Back to reading list', () => invoke(actions.library), 'r2-article-end-library');
  const remove = button('Delete & next', () => invoke(() => actions.delete?.()), 'r2-article-end-delete');
  remove.title = 'Move this article to recoverable trash and continue in the current queue';
  const newer = button('Delete newer articles…', () => invoke(() => actions.deleteNewer?.()), 'r2-article-end-delete-newer');
  controls.append(archive, remove, newer, next, library); root.append(context, title, controls, error);
  return {
    element: root,
    update(value: ArticleEndState) {
      state = value;
      const hasText = !!value.article.body.trim();
      const canArchive = value.article.status !== 'archive' && hasText;
      context.textContent = value.next ? 'Up next in ' + queueLabel(value.queue)
        : hasText ? 'End of ' + queueLabel(value.queue) : queueLabel(value.queue) + ' reading list';
      title.textContent = value.next?.title ?? ''; title.hidden = !value.next;
      archive.hidden = !canArchive;
      archive.textContent = value.busy && !value.deleting ? 'Archiving…' : value.next ? 'Archive & next' : 'Archive & return to list';
      remove.hidden = !actions.delete;
      newer.hidden = value.queue !== 'feed' || !actions.deleteNewer;
      remove.textContent = value.busy && value.deleting ? 'Deleting…' : value.next ? 'Delete & next' : 'Delete & return to list';
      next.hidden = !value.next;
      next.textContent = canArchive ? 'Next without archiving' : 'Next article';
      next.classList.toggle('mod-cta', !canArchive);
      next.classList.toggle('r2-article-end-primary', !canArchive);
      for (const control of [archive, remove, newer, next, library]) control.disabled = !!value.busy;
      root.setAttribute('aria-busy', String(!!value.busy));
      error.textContent = value.error ?? ''; error.hidden = !value.error;
    },
  };
}

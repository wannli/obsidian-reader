interface ListArticle {
  path: string;
  title: string;
}
interface Row {
  path: string;
  button: HTMLElement;
  title: HTMLElement;
}
interface ListActions {
  button(
    label: string,
    action: () => void | Promise<void>,
    icon?: string,
    shortcut?: string,
  ): HTMLElement;
  open(path: string): void | Promise<void>;
  more(): void | Promise<void>;
}
/** One mounted list. Reconcile by path without replacing retained rows or their evidence. */
export class ListRows {
  private entries = new Map<string, Row>();
  private more?: HTMLElement;
  private empty?: HTMLElement;
  constructor(
    private list: HTMLElement,
    private actions: ListActions,
  ) {}
  get rows(): ReadonlyMap<HTMLElement, string> {
    return new Map([...this.entries.values()].map((row) => [row.button, row.path]));
  }
  rename(from: string, to: string): void {
    const row = this.entries.get(from);
    if (!row || from === to) return;
    this.entries.delete(from);
    const replaced = this.entries.get(to);
    if (replaced && replaced !== row) replaced.button.remove();
    row.path = to;
    row.button.dataset.readerPath = to;
    this.entries.set(to, row);
  }
  update(articles: readonly ListArticle[], hasMore: boolean, emptyMessage: string): void {
    const scrollTop = this.list.scrollTop;
    const active = this.list.ownerDocument.activeElement as HTMLElement | null;
    const ownedFocus = !!active && this.list.contains(active);
    const oldRows = [...this.list.querySelectorAll<HTMLElement>('.reader-list-item')];
    const focusIndex = oldRows.findIndex((row) => row === active || row.contains(active));
    const focusedMore = active === this.more;
    const wanted = new Set(articles.map((article) => article.path));
    for (const [path, row] of this.entries) {
      if (wanted.has(path)) continue;
      row.button.remove();
      this.entries.delete(path);
    }
    const ordered: Row[] = [];
    for (const article of articles) {
      let row = this.entries.get(article.path);
      if (!row) {
        const entry = { path: article.path } as Row;
        entry.button = this.actions.button('', () => this.actions.open(entry.path));
        entry.button.classList.add('reader-list-item');
        entry.title = this.list.ownerDocument.createElement('span');
        entry.title.className = 'reader-list-title';
        entry.button.append(entry.title);
        this.entries.set(article.path, entry);
        row = entry;
      }
      row.button.dataset.readerPath = article.path;
      if (row.title.textContent !== article.title) row.title.textContent = article.title;
      ordered.push(row);
    }
    // Insert only out-of-order/new rows, retaining native scroll and existing evidence nodes.
    let before: Element | null = this.list.querySelector('.reader-list-item');
    for (const row of ordered) {
      if (row.button !== before) this.list.insertBefore(row.button, before);
      before = row.button.nextElementSibling;
    }
    if (!articles.length) {
      this.empty ??= this.list.ownerDocument.createElement('p');
      this.empty.textContent = emptyMessage;
      this.list.append(this.empty);
    } else this.empty?.remove();
    if (hasMore) {
      this.more ??= this.actions.button(
        'Show more',
        () => this.actions.more(),
        'chevrons-down',
        'm',
      );
      if (this.list.lastElementChild !== this.more) this.list.append(this.more);
    } else this.more?.remove();
    if (ownedFocus) {
      const retained = active?.isConnected && this.list.contains(active) ? active : undefined;
      const fallback = focusedMore
        ? ordered.at(-1)?.button
        : ordered[Math.max(0, Math.min(focusIndex, ordered.length - 1))]?.button;
      const target = retained ?? fallback ?? (hasMore ? this.more : undefined);
      if (target && this.list.ownerDocument.activeElement !== target)
        target.focus({ preventScroll: true });
    }
    this.list.scrollTop = scrollTop;
  }
}

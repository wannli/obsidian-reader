import { Modal, type App } from 'obsidian';
import { renderBody } from '../reader/render';
import type { NoteFile, Snapshot } from '../core/store';
import type {
  ThinkingStore,
  ThinkingTarget,
  ThinkingRecord,
  ThinkingDocument,
  ThinkingResult,
} from '../core/thinking';

/** Creation is delegated to Reader's existing Fileclass flow, never synthesized here. */
export interface ThinkingCreatedNote {
  status: 'saved' | 'possibly-saved' | 'partial' | 'cancelled' | 'failed';
  target?: ThinkingTarget;
  message?: string;
}
export interface ThinkingBrowserHost<File extends NoteFile> {
  store: ThinkingStore<File>;
  signal: AbortSignal;
  guard(): boolean;
  notebookPaths(): readonly string[];
  explorationPaths(): readonly string[];
  sources(): readonly { path: string; title: string }[];
  openNative(target: ThinkingTarget): Promise<void>;
  sourceSnapshot?(path: string): Promise<Snapshot<File>>;
  /** Runtime owns normal article entry and transient context inspection, not this modal. */
  openSource(target: ThinkingTarget, record?: ThinkingRecord): Promise<void>;
  createStructuredNote?(origin: ThinkingTarget, signal: AbortSignal): Promise<ThinkingCreatedNote>;
  createExploration?(signal: AbortSignal): Promise<ThinkingCreatedNote>;
  /** Recheck the captured provider identity and current Fileclass-bound target. */
  canConnectStructuredNote?(target: ThinkingTarget): boolean;
}

const same = (a: ThinkingTarget, b: ThinkingTarget) =>
  a.path === b.path && (a.blockId ?? '') === (b.blockId ?? '');
const title = (target: ThinkingTarget) =>
  target.label || `${target.path}${target.blockId ? `#^${target.blockId}` : ''}`;
const recordTarget = (record: ThinkingRecord): ThinkingTarget => ({
  path: record.path,
  blockId: record.blockId,
});

/** Command/list entry. No article body renderer or independent reading-position state. */
export function openThinkingBrowser<File extends NoteFile>(
  app: App,
  host: ThinkingBrowserHost<File>,
  initial?: ThinkingTarget,
): { close(): void } {
  const browser = new ThinkingBrowser(app, host, initial);
  if (!host.signal.aborted && host.guard()) browser.open();
  return browser;
}

/** Selection/capture callers can reuse the same explicit inclusion picker. */
export function addThinkingToExploration<File extends NoteFile>(
  app: App,
  host: ThinkingBrowserHost<File>,
  target: ThinkingTarget,
): { close(): void } {
  const browser = new ThinkingBrowser(app, host);
  browser.inclusion = target;
  if (!host.signal.aborted && host.guard()) browser.open();
  return browser;
}

class ThinkingBrowser<File extends NoteFile> extends Modal {
  inclusion?: ThinkingTarget;
  private lifetime = new AbortController();
  private readController?: AbortController;
  private revision = 0;
  private documents: ThinkingDocument<File>[] = [];
  private failures: string[] = [];
  private overview = false;
  private lens = '';
  private query = '';
  private searchVisible = false;
  private selected?: ThinkingTarget;
  private status!: HTMLElement;
  private body!: HTMLElement;
  private toolbar!: HTMLElement;
  private busy = false;
  private screen = 0;
  private disposers: (() => void)[] = [];
  private abort = () => this.close();

  constructor(
    app: App,
    private host: ThinkingBrowserHost<File>,
    initial?: ThinkingTarget,
  ) {
    super(app);
    this.selected = initial;
  }
  private active = () =>
    !this.lifetime.signal.aborted && !this.host.signal.aborted && this.host.guard();
  private guard = () => {
    if (!this.active()) throw new Error('Reader is no longer active. Reopen saved material.');
  };
  onOpen(): void {
    this.setTitle('Saved material');
    this.contentEl.classList.add('reader-thinking-browser');
    this.toolbar = this.element('div', this.contentEl, undefined, 'reader-thinking-toolbar');
    this.status = this.element('p', this.contentEl, undefined, 'reader-thinking-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.body = this.element('div', this.contentEl, undefined, 'reader-thinking-list');
    this.host.signal.addEventListener('abort', this.abort, { once: true });
    this.controls();
    void this.load();
  }
  onClose(): void {
    this.clearBody();
    this.lifetime.abort();
    this.readController?.abort();
    this.host.signal.removeEventListener('abort', this.abort);
    this.revision++;
  }
  private clearBody(): void {
    this.screen++;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.body?.replaceChildren();
  }
  private markdown(parent: HTMLElement, body: string, sourcePath: string): void {
    const root = this.element('div', parent, undefined, 'reader-thinking-body');
    this.disposers.push(renderBody(body, root, ''));
    root.addEventListener('click', (event) => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a.internal-link');
      if (!link) return;
      event.preventDefault();
      const raw = decodeURI(link.getAttribute('href') ?? '');
      const [path, blockId] = raw.split('#^');
      void this.host.openNative({ path: path || sourcePath, ...(blockId ? { blockId } : {}) });
    });
  }
  private element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    parent: HTMLElement,
    text?: string,
    className?: string,
  ): HTMLElementTagNameMap[K] {
    const el = parent.ownerDocument.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    parent.append(el);
    return el;
  }
  private button(parent: HTMLElement, text: string, run: () => void | Promise<void>) {
    const button = this.element('button', parent, text);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (!this.active()) return;
      const failed = () => {
        if (this.active())
          this.status.textContent = 'Action failed. Open Markdown to inspect current saved work.';
      };
      try {
        void Promise.resolve(run()).catch(failed);
      } catch {
        failed();
      }
    });
    return button;
  }
  private controls(): void {
    this.toolbar.replaceChildren();
    for (const [name, overview] of [
      ['All', false],
      ['Overview', true],
    ] as const) {
      const button = this.button(this.toolbar, name, () => {
        this.selected = undefined;
        this.overview = overview;
        this.controls();
        return this.load();
      });
      button.setAttribute('aria-pressed', String(this.overview === overview));
    }
    this.button(this.toolbar, 'Search', () => {
      this.searchVisible = !this.searchVisible;
      if (!this.searchVisible) this.query = '';
      this.controls();
      if (this.searchVisible) this.toolbar.querySelector('input')?.focus();
      else void this.load();
    });
    if (this.searchVisible) {
      const field = this.element('input', this.toolbar);
      field.type = 'search';
      field.setAttribute('aria-label', 'Search saved material');
      field.value = this.query;
      field.addEventListener('input', () => {
        this.query = field.value;
        void this.load();
      });
    }
    if (this.overview) {
      const label = this.element('label', this.toolbar, 'Exploration lens');
      const select = this.element('select', label);
      for (const [value, name] of [
        ['', 'All memberships'],
        ['unassigned', 'Unassigned'],
        ...this.host.explorationPaths().map((path) => [path, path]),
      ]) {
        const option = this.element('option', select, name);
        option.value = value;
      }
      select.value = this.lens;
      select.addEventListener('change', () => {
        this.lens = select.value;
        void this.load();
      });
    }
    this.button(this.toolbar, 'Close', () => this.close());
  }
  private async load(): Promise<void> {
    const revision = ++this.revision;
    this.readController?.abort();
    const controller = new AbortController();
    this.readController = controller;
    const current = () => this.active() && revision === this.revision;
    this.status.textContent = 'Loading saved material…';
    const documents: ThinkingDocument<File>[] = [],
      failures: string[] = [];
    // Serial reads keep occupancy bounded; no startup/background notebook scans.
    for (const path of new Set([...this.host.notebookPaths(), ...this.host.explorationPaths()])) {
      if (!current()) return;
      try {
        documents.push(await this.host.store.read(path));
      } catch {
        failures.push(path);
      }
    }
    if (!current()) return;
    this.documents = documents;
    this.failures = failures;
    this.status.textContent = failures.length
      ? 'Some configured documents are unavailable. Coverage is incomplete; open Markdown to inspect.'
      : '';
    if (this.inclusion) return this.showInclusion(this.inclusion);
    if (this.selected) return this.showItem(this.selected);
    await this.showList(controller.signal, current);
  }
  private records(): ThinkingRecord[] {
    return this.documents.flatMap((doc) => doc.records);
  }
  private async showList(signal: AbortSignal, current: () => boolean): Promise<void> {
    this.clearBody();
    const records = this.records();
    let items: { target: ThinkingTarget; record?: ThinkingRecord; evidence?: string }[] = [
      ...this.host
        .sources()
        .map((source) => ({ target: { path: source.path, label: source.title } })),
      ...records.map((record) => ({ target: recordTarget(record), record })),
    ];
    if (this.query.trim()) {
      const result = await this.host.store.search(
        [
          ...new Set([
            ...this.host.sources().map((source) => source.path),
            ...this.host.notebookPaths(),
            ...this.host.explorationPaths(),
          ]),
        ],
        this.query,
        { signal, maxReads: 200, limit: 100, guard: this.guard },
      );
      if (!current()) return;
      items = result.hits.map((hit) => ({
        target: hit.record ? recordTarget(hit.record) : { path: hit.path },
        record: hit.record,
        evidence: `${hit.evidence === 'source-link' ? 'Explicit source link' : 'Literal text'}: ${hit.text}`,
      }));
      this.status.textContent = result.complete
        ? 'Search uses exact text and explicit source-link evidence, not inferred associations.'
        : 'Search coverage is limited. Narrow the query or open Markdown.';
    }
    if (this.overview) {
      this.element(
        'p',
        this.body,
        'Dates are explicit collection dates only. Sources without collection dates appear under Undated. Exploration lenses overlap; no activity history or inferred progress.',
        'reader-thinking-evidence',
      );
      const memberships = this.documents.filter((doc) =>
        this.host.explorationPaths().includes(doc.path),
      );
      if (this.lens)
        items = items.filter((item) => {
          const included = memberships.filter((doc) =>
            doc.memberships.some((member) => same(member.target, item.target)),
          );
          return this.lens === 'unassigned'
            ? !included.length
            : included.some((doc) => doc.path === this.lens);
        });
      items.sort((a, b) => (b.record?.collected ?? '').localeCompare(a.record?.collected ?? ''));
    }
    if (!items.length)
      this.element(
        'p',
        this.body,
        this.query
          ? 'No matching saved material.'
          : 'No saved material here yet. Use Keep passage or Comment while reading. Unassigned entries will appear here too.',
      );
    let day = '';
    for (const item of items) {
      const date = item.record?.collected || 'Undated';
      if (this.overview && date !== day) {
        day = date;
        this.element('h3', this.body, date);
      }
      const row = this.element('section', this.body, undefined, 'reader-thinking-item');
      this.button(
        row,
        item.record
          ? `${item.record.kind === 'passage' ? 'Passage' : 'Comment'} — ${item.record.body.slice(0, 100)}`
          : title(item.target),
        () => {
          this.selected = item.target;
          this.showItem(item.target);
        },
      );
      if (item.record?.readOnly)
        this.element(
          'p',
          row,
          'Read-only — inspect original Markdown.',
          'reader-thinking-evidence',
        );
      if (item.evidence) this.element('p', row, item.evidence, 'reader-thinking-evidence');
    }
    if (this.host.explorationPaths().length) {
      this.element('h3', this.body, 'Explorations');
      for (const path of this.host.explorationPaths())
        this.button(this.body, path, () => this.showExploration(path));
    }
    if (this.host.createExploration)
      this.button(this.body, 'Create exploration', () => this.createExploration());
  }
  private back(): void {
    this.selected = undefined;
    this.inclusion = undefined;
    this.controls();
    void this.load();
  }
  private showItem(target: ThinkingTarget): void {
    this.clearBody();
    this.button(this.body, 'Back', () => this.back());
    this.element('h3', this.body, title(target));
    const matches = this.records().filter((record) => same(recordTarget(record), target));
    const record = matches.length === 1 ? matches[0] : undefined;
    if (record) {
      this.element(
        'p',
        this.body,
        record.kind === 'passage'
          ? 'Saved quotation — attention, not agreement'
          : 'Personal comment',
        'reader-thinking-evidence',
      );
      this.markdown(this.body, record.body, record.path);
      this.element(
        'p',
        this.body,
        `Collected: ${record.collected || 'Unknown'}`,
        'reader-thinking-evidence',
      );
      if (record.source) {
        this.element('p', this.body, `Source: ${title(record.source)}`, 'reader-thinking-evidence');
        if (record.url)
          this.element('p', this.body, `Publisher URL: ${record.url}`, 'reader-thinking-evidence');
        const placement = this.element(
          'p',
          this.body,
          'Source placement unverified. The saved snapshot remains authoritative.',
          'reader-thinking-evidence',
        );
        const screen = this.screen;
        if (this.host.sourceSnapshot)
          void this.host
            .sourceSnapshot(record.source.path)
            .then((source) => {
              if (!this.active() || screen !== this.screen) return;
              const context = this.host.store.context(record, source);
              placement.textContent =
                context.status === 'exact'
                  ? 'Unique source context found. Back to source inspects it without replacing reading progress.'
                  : context.status === 'unplaced'
                    ? 'Unplaced comment — its original source gap is no longer uniquely supported.'
                    : context.status === 'ambiguous'
                      ? 'Uncertain source match — snapshot retained; no position inferred.'
                      : 'Source context missing — snapshot retained; article-level return remains available.';
            })
            .catch(() => {
              if (this.active() && screen === this.screen)
                placement.textContent =
                  'Source unavailable or unresolved — saved snapshot retained.';
            });
        this.button(this.body, 'Back to source', () =>
          this.host.openSource(record.source!, record),
        );
        this.button(this.body, 'Open source Markdown', () => this.host.openNative(record.source!));
      } else if (record.about)
        this.button(this.body, `About: ${title(record.about)}`, () => this.showItem(record.about!));
      else
        this.element('p', this.body, 'No source — local free comment.', 'reader-thinking-evidence');
      for (const connection of record.connections)
        this.button(
          this.body,
          `${connection.label ? `${connection.label} → ` : 'Connection → '}${title(connection.target)}`,
          () => this.showItem(connection.target),
        );
      const incoming = this.records().filter((owner) =>
        owner.connections.some((connection) => same(connection.target, target)),
      );
      for (const owner of incoming)
        this.button(this.body, `Connected from: ${owner.body.slice(0, 80)}`, () =>
          this.showItem(recordTarget(owner)),
        );
      const attached = this.records().filter(
        (comment) => comment.about && same(comment.about, target),
      );
      for (const comment of attached)
        this.button(this.body, `Comment: ${comment.body.slice(0, 80)}`, () =>
          this.showItem(recordTarget(comment)),
        );
      if (record.readOnly)
        this.element(
          'p',
          this.body,
          'Read-only or unresolved record. Edit its original Markdown; Reader will not repair or delete it.',
        );
      else {
        if (record.kind === 'comment')
          this.button(this.body, 'Edit comment', () => this.editComment(record));
        this.button(this.body, 'Connect', () => this.showConnect(record));
        if (this.host.createStructuredNote)
          this.button(this.body, 'Create structured note', () => this.createStructured(record));
      }
    } else if (target.blockId)
      this.element(
        'p',
        this.body,
        'Unresolved saved entry. Its original link remains available; no replacement was inferred.',
      );
    else this.button(this.body, 'Open source', () => this.host.openSource(target));
    this.button(this.body, 'Open Markdown', () => this.host.openNative(target));
    if (!target.blockId || (record && !record.readOnly))
      this.button(this.body, 'Add to exploration', () => this.showInclusion(target));
  }
  private editor(
    label: string,
    value: string,
    save: (text: string) => Promise<void>,
    cancel: () => void,
  ): void {
    this.clearBody();
    const wrapper = this.element('div', this.body, undefined, 'reader-thinking-editor');
    const fieldLabel = this.element('label', wrapper, label);
    const field = this.element('textarea', fieldLabel);
    field.value = value;
    this.element(
      'p',
      wrapper,
      'Ordinary Markdown. Changes are saved only with Save.',
      'reader-thinking-evidence',
    );
    const saveButton = this.button(wrapper, 'Save', async () => {
      if (this.busy) return;
      saveButton.disabled = true;
      try {
        await save(field.value);
      } finally {
        if (this.active() && !saveButton.hasAttribute('data-reader-uncertain'))
          saveButton.disabled = false;
      }
    });
    this.button(wrapper, 'Cancel', cancel);
    field.focus();
  }
  private editComment(record: ThinkingRecord): void {
    this.editor(
      'Edit comment Markdown',
      record.body,
      (text) =>
        this.mutate(
          () => this.host.store.editComment({ record, body: text, guard: this.guard }),
          () => this.showItem(recordTarget(record)),
        ),
      () => this.showItem(recordTarget(record)),
    );
  }
  private showConnect(record: ThinkingRecord): void {
    this.clearBody();
    this.element('h3', this.body, 'Connect saved entries');
    this.element(
      'p',
      this.body,
      'Choose one saved passage or comment. Only Confirm writes a directed connection. Structured-note relations remain Fileclass-owned.',
    );
    const list = this.element('div', this.body, undefined, 'reader-thinking-list');
    let chosen: ThinkingRecord | undefined;
    let query = '';
    let label = '';
    let confirm!: HTMLButtonElement;
    const render = () => {
      list.replaceChildren();
      const candidates = this.records().filter(
        (candidate) =>
          !same(recordTarget(candidate), recordTarget(record)) &&
          (!query || candidate.body.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
      );
      if (!candidates.length)
        this.element('p', list, 'No eligible saved entries. Keep a passage or comment first.');
      for (const candidate of candidates) {
        const duplicates =
          this.records().filter((other) => same(recordTarget(other), recordTarget(candidate)))
            .length !== 1;
        const button = this.button(
          list,
          `${candidate.kind}: ${candidate.body.slice(0, 100)}`,
          () => {
            chosen = candidate;
            confirm.disabled = false;
            render();
          },
        );
        button.disabled = candidate.readOnly || duplicates || !candidate.blockId;
        button.setAttribute('aria-pressed', String(chosen === candidate));
        if (button.disabled)
          this.element(
            'p',
            list,
            'Read-only or unresolved — inspect native Markdown; cannot connect.',
          );
      }
      for (const path of this.failures)
        this.element(
          'p',
          list,
          `Unavailable notebook: ${path}. Its unresolved entries cannot be chosen.`,
        );
    };
    this.button(this.body, 'Search entries', () => {
      if (this.body.querySelector('input[type="search"]')) return;
      const field = this.element('input', this.body);
      field.type = 'search';
      field.setAttribute('aria-label', 'Search connection candidates');
      field.addEventListener('input', () => {
        query = field.value;
        render();
      });
      field.focus();
    });
    this.button(this.body, 'Add label', () => {
      if (this.body.querySelector('input[type="text"]')) return;
      const wrapper = this.element('label', this.body, 'Optional connection label');
      const field = this.element('input', wrapper);
      field.type = 'text';
      field.addEventListener('input', () => {
        label = field.value;
      });
      field.focus();
    });
    confirm = this.button(this.body, 'Confirm', () => {
      if (!chosen || /[\r\n\x00-\x1f\x7f]/u.test(label)) {
        this.status.textContent = 'Choose an eligible entry and use a single-line plain label.';
        return;
      }
      return this.mutate(
        () =>
          this.host.store.connect({
            record,
            target: recordTarget(chosen!),
            label: label.trim() || undefined,
            guard: this.guard,
          }),
        () => this.showItem(recordTarget(record)),
      );
    });
    confirm.disabled = true;
    this.button(this.body, 'Cancel', () => this.showItem(recordTarget(record)));
    render();
  }
  private async createStructured(record: ThinkingRecord): Promise<void> {
    if (!this.host.createStructuredNote || this.busy) return;
    this.guard();
    this.busy = true;
    let created: ThinkingCreatedNote;
    try {
      created = await this.host.createStructuredNote(recordTarget(record), this.lifetime.signal);
    } finally {
      this.busy = false;
    }
    if (!this.active()) return;
    this.creationStatus(created);
    if (created.target || created.status === 'possibly-saved' || created.status === 'partial') {
      for (const button of this.body.querySelectorAll('button'))
        if (button.textContent === 'Create structured note') button.disabled = true;
    }
    if (created.target)
      this.button(this.body, 'Open created note', () => this.host.openNative(created.target!));
    if (created.status !== 'saved' || !created.target) return;
    // No source anchor/quotation writes. Creation callback preserves existing origin.
    const eligibility = () => {
      this.guard();
      if (!this.host.canConnectStructuredNote?.(created.target!))
        throw new Error(
          'Fileclass changed or the created note is no longer eligible. The note is saved but unlinked.',
        );
    };
    if (!this.host.canConnectStructuredNote?.(created.target)) {
      this.status.textContent =
        'Structured note saved; connection incomplete because Fileclass is unavailable or changed. Open the preserved note to inspect.';
      return;
    }
    await this.mutate(() =>
      this.host.store.connect({
        record,
        target: created.target!,
        ...{ allowFileTarget: true },
        guard: eligibility,
      }),
    );
    if (!this.active()) return;
    if (this.status.textContent?.startsWith('Saved'))
      this.status.textContent = 'Saved structured note and explicit connection locally.';
    else
      this.status.textContent = `Structured note saved; connection incomplete. ${this.status.textContent} The created note was preserved.`;
  }
  private creationStatus(result: ThinkingCreatedNote): void {
    this.status.textContent =
      result.status === 'saved'
        ? 'Created locally through Fileclass.'
        : result.status === 'cancelled'
          ? 'Cancelled. Any already-created note is preserved.'
          : result.status === 'possibly-saved'
            ? 'Possibly saved — inspect the created note before retrying.'
            : result.status === 'partial'
              ? 'Partially saved — created work is preserved. Inspect it before retrying.'
              : 'Creation failed. Existing work was preserved.';
    if (result.message) this.status.textContent += ` ${result.message}`;
  }
  private async createExploration(target?: ThinkingTarget): Promise<void> {
    if (!this.host.createExploration || this.busy) return;
    this.guard();
    this.busy = true;
    let created: ThinkingCreatedNote;
    try {
      created = await this.host.createExploration(this.lifetime.signal);
    } finally {
      this.busy = false;
    }
    if (!this.active()) return;
    this.creationStatus(created);
    if (created.target || created.status === 'possibly-saved' || created.status === 'partial') {
      for (const button of this.body.querySelectorAll('button'))
        if (button.textContent === 'Create exploration') button.disabled = true;
    }
    if (created.target)
      this.button(this.body, 'Open created exploration', () =>
        this.host.openNative(created.target!),
      );
    if (created.status !== 'saved' || !created.target) return;
    const document = await this.host.store.read(created.target.path);
    if (!this.active()) return;
    this.documents = [...this.documents.filter((doc) => doc.path !== document.path), document];
    if (target) await this.include(document, target);
    else this.showExploration(document.path);
  }
  private showInclusion(target: ThinkingTarget): void {
    this.clearBody();
    this.element('h3', this.body, 'Add to exploration');
    this.element('p', this.body, title(target), 'reader-thinking-evidence');
    const explorations = this.documents.filter((doc) =>
      this.host.explorationPaths().includes(doc.path),
    );
    if (!explorations.length)
      this.element(
        'p',
        this.body,
        'No exploration available. Create a typed exploration through Fileclass, or configure an existing one.',
      );
    for (const document of explorations) {
      const included = document.memberships.some((member) => same(member.target, target));
      const add = this.button(
        this.body,
        `${included ? 'Included: ' : 'Add: '}${document.path}`,
        () => this.include(document, target),
      );
      add.disabled = included;
    }
    if (this.host.createExploration)
      this.button(this.body, 'Create exploration', () => this.createExploration(target));
    else
      this.element(
        'p',
        this.body,
        'Creation requires Fileclass. Existing exploration body editing remains available.',
      );
    this.button(this.body, 'Cancel', () => (this.inclusion ? this.close() : this.showItem(target)));
  }
  private async include(document: ThinkingDocument<File>, target: ThinkingTarget): Promise<void> {
    await this.mutate(
      async () => {
        const isSource =
          !target.blockId && this.host.sources().some((item) => item.path === target.path);
        const source =
          isSource && this.host.sourceSnapshot
            ? await this.host.sourceSnapshot(target.path)
            : undefined;
        this.guard();
        return this.host.store.editExploration({
          document,
          action: 'add',
          target,
          source,
          guard: this.guard,
        });
      },
      () => this.showInclusion(target),
    );
  }
  private showExploration(path: string): void {
    const document = this.documents.find((doc) => doc.path === path);
    this.clearBody();
    this.button(this.body, 'Back', () => this.back());
    this.element('h3', this.body, path);
    this.button(this.body, 'Open exploration Markdown', () => this.host.openNative({ path }));
    if (!document) {
      this.element('p', this.body, 'Exploration unavailable. Open native Markdown to inspect.');
      return;
    }
    this.element(
      'p',
      this.body,
      'Remove only removes the selected inclusion. Original saved entries and surrounding prose remain intact.',
      'reader-thinking-evidence',
    );
    const spans = [
      ...document.memberships.map((member) => ({ from: member.from, to: member.to, member })),
      ...document.records.map((record) => ({
        from: record.from,
        to: record.to,
        member: undefined,
      })),
    ].sort((a, b) => a.from - b.from);
    // Frontmatter is provider-owned. Text regions exclude every original record/link.
    const header = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(document.raw);
    let cursor = header?.[0].length ?? 0;
    const prose = (from: number, to: number) => {
      const text = document.raw.slice(from, to);
      if (!text.trim()) return;
      this.markdown(this.body, text, path);
      this.button(this.body, 'Edit prose', () =>
        this.editor(
          'Exploration Markdown',
          text,
          (next) =>
            this.mutate(
              () =>
                this.host.store.editExploration({
                  document,
                  action: 'edit',
                  from,
                  to,
                  expected: text,
                  text: next,
                  guard: this.guard,
                }),
              () => this.showExploration(path),
            ),
          () => this.showExploration(path),
        ),
      );
    };
    for (const span of spans) {
      if (span.from < cursor) continue;
      prose(cursor, span.from);
      if (span.member) {
        const member = span.member;
        const row = this.element('section', this.body, undefined, 'reader-thinking-item');
        this.button(row, title(member.target), () => this.showItem(member.target));
        this.button(row, 'Remove inclusion', () =>
          this.mutate(
            () =>
              this.host.store.editExploration({
                document,
                action: 'remove',
                membership: member,
                guard: this.guard,
              }),
            () => this.showExploration(path),
          ),
        );
        const index = document.memberships.indexOf(member);
        for (const [name, delta] of [
          ['Move up', -1],
          ['Move down', 1],
        ] as const) {
          const button = this.button(row, name, () => {
            const order = document.memberships.map((_, i) => i);
            [order[index], order[index + delta]] = [order[index + delta], order[index]];
            return this.mutate(
              () =>
                this.host.store.editExploration({
                  document,
                  action: 'reorder',
                  memberships: document.memberships,
                  order,
                  guard: this.guard,
                }),
              () => this.showExploration(path),
            );
          });
          button.disabled = index + delta < 0 || index + delta >= document.memberships.length;
        }
      } else
        this.element(
          'div',
          this.body,
          document.raw.slice(span.from, span.to),
          'reader-thinking-body',
        );
      cursor = span.to;
    }
    prose(cursor, document.raw.length);
    this.button(this.body, 'Add writing', () =>
      this.editor(
        'Exploration Markdown',
        '',
        (text) =>
          this.mutate(
            () =>
              this.host.store.editExploration({
                document,
                action: 'edit',
                from: document.raw.length,
                to: document.raw.length,
                expected: '',
                text: `\n${text}\n`,
                guard: this.guard,
              }),
            () => this.showExploration(path),
          ),
        () => this.showExploration(path),
      ),
    );
    this.button(this.body, 'Add saved material', () => this.pickMembership(document));
  }
  private pickMembership(document: ThinkingDocument<File>): void {
    this.clearBody();
    this.element('h3', this.body, 'Choose saved material');
    const targets = [
      ...this.host.sources().map((source) => ({ path: source.path, label: source.title })),
      ...this.records()
        .filter((record) => !record.readOnly)
        .map(recordTarget),
    ];
    for (const target of targets) {
      const included = document.memberships.some((member) => same(member.target, target));
      const button = this.button(this.body, `${included ? 'Included: ' : ''}${title(target)}`, () =>
        this.include(document, target),
      );
      button.disabled = included;
    }
    this.button(this.body, 'Cancel', () => this.showExploration(document.path));
  }
  private async mutate(
    operation: () => Promise<ThinkingResult<File>>,
    after?: () => void,
  ): Promise<void> {
    if (this.busy) return;
    this.guard();
    this.busy = true;
    const screen = this.screen;
    this.status.textContent = 'Saving…';
    try {
      const result = await operation();
      if (!this.active() || screen !== this.screen) return;
      this.status.textContent =
        result.status === 'saved'
          ? 'Saved locally. Obsidian Sync delivery is separate.'
          : result.status === 'unchanged'
            ? 'Already saved — no change.'
            : result.status === 'possibly-saved'
              ? `Possibly saved — open notebook to check. Completed phase: ${result.phase}. Do not blindly retry.`
              : result.status === 'partial'
                ? `Partially saved. Completed phase: ${result.phase}. Inspect saved work before retrying.`
                : 'Not saved. Open Markdown to inspect or reopen and retry.';
      if (result.status === 'possibly-saved' || result.status === 'partial') {
        for (const button of this.body.querySelectorAll('button')) {
          if (
            /^(?:Save|Confirm|Create |Add:|Add writing|Remove inclusion|Move )/u.test(
              button.textContent ?? '',
            )
          ) {
            button.disabled = true;
            button.setAttribute('data-reader-uncertain', 'true');
          }
        }
      }
      if (result.message) this.status.textContent += ` ${result.message}`;
      if (result.document)
        this.documents = [
          ...this.documents.filter((doc) => doc.path !== result.document!.path),
          result.document,
        ];
      if (result.status === 'saved' || result.status === 'unchanged') after?.();
      else
        this.button(this.body, 'Open notebook to check', () =>
          this.host.openNative({
            path:
              result.document?.path ?? this.selected?.path ?? this.host.notebookPaths()[0] ?? '',
          }),
        );
    } finally {
      this.busy = false;
    }
  }
}

import type { ArticleStore, NoteFile, Snapshot } from './store';
import type { HighlightSelection } from './hosted-highlights';
import { originLink } from './quotation';
import { readDocument } from './document';
import { linkPath } from './model';
import {
  readClipping,
  clippingOrigin,
  clippingMarkdown,
  clippingTitle,
  locateClipping,
  planClipping,
  sameClipping,
  type ClippingBinding,
  type LocatedClipping,
} from './clippings';

export interface ClippingCandidate<File> {
  file: File;
  path: string;
  bytes: number;
}
export interface ClippingPort<File extends NoteFile> {
  bindings(): readonly ClippingBinding[];
  candidates(source: Snapshot<File>): readonly ClippingCandidate<File>[];
  observed?(candidate: ClippingCandidate<File>, raw: string): void;
  revision(): number;
  prepare(signal: AbortSignal): Promise<{
    binding: ClippingBinding;
    folder: string;
    check(): void;
    validate(): Promise<void>;
    verify(path: string): Promise<void>;
  }>;
}
export interface ArticleClipping {
  path: string;
  location?: LocatedClipping;
  quote: string;
}
export interface ClippingScan {
  items: ArticleClipping[];
  referenced: boolean;
  complete: boolean;
  revision: number;
}
export interface KeptClipping<File extends NoteFile> {
  snapshot: Snapshot<File>;
  path: string;
  created: boolean;
}

/** One clipping write slot; native/provider work remains occupied until it actually settles. */
export class ClippingStore<File extends NoteFile> {
  private pending?: Promise<KeptClipping<File>>;
  constructor(
    readonly articles: ArticleStore<File>,
    private port: ClippingPort<File>,
  ) {
    articles.protectClippings(async (snapshot) => {
      const scan = await this.scan(snapshot, new AbortController().signal);
      return {
        protected: scan.referenced || !scan.complete,
        guard: () => {
          if (scan.revision !== port.revision())
            throw new Error('Clipping references changed before deletion. The source was kept.');
        },
      };
    });
  }
  async scan(snapshot: Snapshot<File>, signal: AbortSignal): Promise<ClippingScan> {
    const revision = this.port.revision(),
      items: ArticleClipping[] = [];
    let referenced = false,
      complete = true,
      bytes = 0,
      reads = 0;
    for (const candidate of this.port.candidates(snapshot)) {
      if (signal.aborted) throw new Error('Clipping lookup cancelled.');
      if (++reads > 200 || candidate.bytes > 200_000 || (bytes += candidate.bytes) > 1_000_000) {
        complete = false;
        continue;
      }
      try {
        const raw = await this.articles.vault.read(candidate.file);
        if (
          raw.length > 200_000 ||
          candidate.file.path !== candidate.path ||
          this.articles.vault.file(candidate.path) !== candidate.file
        ) {
          complete = false;
          continue;
        }
        bytes += Math.max(0, raw.length - candidate.bytes);
        if (bytes > 1_000_000) {
          complete = false;
          continue;
        }
        if (revision === this.port.revision()) this.port.observed?.(candidate, raw);
        if (!/^(?:\uFEFF)?---\r?\n/u.test(raw)) continue;
        const doc = readDocument(raw);
        const source =
          clippingOrigin(doc.properties.origin)?.path ??
          (typeof doc.properties.origin === 'string' ? linkPath(doc.properties.origin) : undefined);
        if (source) {
          const target = this.articles.vault.resolveLink?.(source, candidate.path);
          if (target === snapshot.file) referenced = true;
          else if (!target) complete = false; // Unknown resolution cannot prove absence, even without a clipping type.
        }
        const clipping = readClipping(raw, this.port.bindings());
        if (!clipping) continue;
        const origin = clippingOrigin(clipping.origin)!;
        const target = this.articles.vault.resolveLink?.(origin.path, candidate.path);
        if (!target) {
          complete = false;
          continue;
        }
        if (target !== snapshot.file) continue;
        const location = locateClipping(snapshot.body, origin.blockId, clipping.quote);
        items.push({ path: candidate.path, quote: clipping.quote, location });
      } catch {
        complete = false;
      }
    }
    if (signal.aborted) throw new Error('Clipping lookup cancelled.');
    return { items, referenced, complete: complete && revision === this.port.revision(), revision };
  }
  keep(
    snapshot: Snapshot<File>,
    selection: HighlightSelection,
    signal: AbortSignal,
    guard: () => void,
    onSource: (snapshot: Snapshot<File>) => void,
  ): Promise<KeptClipping<File>> {
    if (this.pending)
      return Promise.reject(
        new Error('A clipping capture is still settling. Wait before keeping another passage.'),
      );
    const work = this.perform(snapshot, selection, signal, guard, onSource);
    this.pending = work;
    const clear = () => {
      if (this.pending === work) this.pending = undefined;
    };
    void work.then(clear, clear);
    return work;
  }
  private async perform(
    snapshot: Snapshot<File>,
    selection: HighlightSelection,
    signal: AbortSignal,
    guard: () => void,
    onSource: (snapshot: Snapshot<File>) => void,
  ): Promise<KeptClipping<File>> {
    const check = () => {
      if (signal.aborted) throw new Error('Clipping capture cancelled.');
      guard();
    };
    check();
    const plan = planClipping(snapshot.body, selection); // Reject unsafe/cross-paragraph selections before writes.
    const origin = originLink(snapshot.path, plan.blockId);
    const prepared = await this.port.prepare(signal);
    const raw = clippingMarkdown(prepared.binding, origin, plan.quoteMarkdown);
    const active = () => {
      check();
      prepared.check();
    };
    active();
    await this.articles.validate(snapshot);
    active();
    const scan = await this.scan(snapshot, signal);
    active();
    if (!scan.complete)
      throw new Error(
        'Clipping lookup is incomplete or changed. Nothing new was saved; retry after indexing settles.',
      );
    const desired = locateClipping(plan.body, plan.blockId, plan.quote);
    if (!desired)
      throw new Error(
        'These words occur more than once in the paragraph. Choose a longer, unique passage to keep.',
      );
    const matches = scan.items.filter(
      (item) => item.location && sameClipping(item.location, desired),
    );
    if (matches.length > 1)
      throw new Error(
        `Several clipping cards match this passage: ${matches.map((item) => item.path).join(', ')}. Open the existing cards before keeping it again.`,
      );
    const unresolved = scan.items.find(
      (item) =>
        !item.location &&
        item.quote.replace(/\s+/gu, ' ').trim() === plan.quote.replace(/\s+/gu, ' ').trim(),
    );
    if (unresolved)
      throw new Error(
        `An existing clipping has these words but its exact source is unresolved: ${unresolved.path}. Inspect it before keeping this passage again.`,
      );
    if (matches.length === 1) {
      const retained =
        snapshot.properties.status === 'feed'
          ? await this.articles.clippingSource(snapshot, snapshot.body, active, onSource)
          : snapshot;
      return { snapshot: retained, path: matches[0].path, created: false };
    }
    // Without a saved selection copy, an edited quotation may be another selection; do not infer identity.
    if (this.port.revision() !== scan.revision)
      throw new Error('The vault changed before capture. Retry after it settles.');
    const source = await this.articles.clippingSource(snapshot, plan.body, active, onSource);
    active();
    await prepared.validate();
    active();
    const finalScan = await this.scan(source, signal);
    active();
    if (!finalScan.complete)
      throw new Error('Source retained, but clipping lookup is incomplete. No card was created.');
    if (
      finalScan.items.some(
        (item) =>
          !item.location &&
          item.quote.replace(/\s+/gu, ' ').trim() === plan.quote.replace(/\s+/gu, ' ').trim(),
      )
    )
      throw new Error(
        'Source retained, but an existing clipping has an unresolved match. Inspect its source reference before retrying.',
      );
    const raced = finalScan.items.filter(
      (item) => item.location && sameClipping(item.location, desired),
    );
    if (raced.length === 1) return { snapshot: source, path: raced[0].path, created: false };
    if (raced.length > 1)
      throw new Error('Source retained, but several cards now match. No new card was created.');
    const title = clippingTitle(plan.quote);
    let path = `${prepared.folder}/${title}.md`;
    for (
      let suffix = 2;
      this.articles.vault.exists?.(path) || this.articles.vault.file(path);
      suffix++
    ) {
      if (suffix > 1000)
        throw new Error('Too many clipping filename collisions. No file was overwritten.');
      path = `${prepared.folder}/${title} ${suffix}.md`;
    }
    let dispatched = false;
    try {
      const file = await this.articles.vault.create(path, raw, async () => {
        active();
        await this.articles.validate(source);
        active();
        if (this.port.revision() !== finalScan.revision)
          throw new Error('The vault changed before card creation. Recheck before retrying.');
        dispatched = true;
      });
      active();
      const actual = await this.articles.vault.read(file);
      active();
      if (file.path !== path || this.articles.vault.file(path) !== file || actual !== raw)
        throw new Error('Created clipping changed before verification.');
      await prepared.verify(path);
      active();
      return { snapshot: source, path, created: true };
    } catch (error) {
      throw new Error(
        `${dispatched ? `Clipping may already be saved at ${path}. Inspect it before retrying.` : 'Source retained; card creation stopped.'} ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

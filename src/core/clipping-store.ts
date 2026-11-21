import type { ArticleStore, NoteFile, Snapshot } from './store';
import type { HighlightSelection } from './hosted-highlights';
import { originLink } from './quotation';
import { readDocument } from './document';
import { linkPath } from './model';
import {
  readClipping,
  clippingMember,
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
export interface ClippingChange {
  event: 'settings' | 'metadata' | 'create' | 'modify' | 'rename' | 'delete';
  path?: string;
}
function diagnosticPath(path: string): string {
  return JSON.stringify(path.length > 300 ? `${path.slice(0, 140)}…${path.slice(-140)}` : path);
}
export interface ClippingPort<File extends NoteFile> {
  bindings(): readonly ClippingBinding[];
  candidates(source: Snapshot<File>): readonly ClippingCandidate<File>[];
  observed?(candidate: ClippingCandidate<File>, raw: string): void;
  revision(): number;
  lastChange?(): ClippingChange | undefined;
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
  /** Bounded local diagnostics: reasons and paths only, never note contents or parser errors. */
  diagnostic: string;
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
  private changeDiagnostic(): string {
    const change = this.port.lastChange?.();
    return change
      ? ` Last change: ${change.event}${change.path ? ` in ${diagnosticPath(change.path)}` : ''}.`
      : '';
  }
  async scan(
    snapshot: Snapshot<File>,
    signal: AbortSignal,
    purpose: 'protection' | 'capture' = 'protection',
  ): Promise<ClippingScan> {
    const revision = this.port.revision(),
      items: ArticleClipping[] = [],
      problems: string[] = [];
    let referenced = false,
      complete = true,
      omitted = 0,
      bytes = 0,
      reads = 0;
    const incomplete = (reason: string, path?: string) => {
      complete = false;
      if (problems.length < 3) problems.push(path ? `${reason}: ${diagnosticPath(path)}.` : reason);
      else omitted++;
    };
    for (const candidate of this.port.candidates(snapshot)) {
      if (signal.aborted) throw new Error('Clipping lookup cancelled.');
      if (++reads > 200) {
        incomplete('Reached the 200-note scan limit before inspecting', candidate.path);
        continue;
      }
      if (candidate.bytes > 200_000) {
        incomplete('Exceeded the 200 KB note-size limit', candidate.path);
        continue;
      }
      if ((bytes += candidate.bytes) > 1_000_000) {
        incomplete('Exceeded the 1 MB scan-size limit before inspecting', candidate.path);
        continue;
      }
      let failure = 'Could not read note';
      try {
        const raw = await this.articles.vault.read(candidate.file);
        if (raw.length > 200_000) {
          incomplete('Exceeded the 200 KB note-size limit', candidate.path);
          continue;
        }
        if (
          candidate.file.path !== candidate.path ||
          this.articles.vault.file(candidate.path) !== candidate.file
        ) {
          incomplete('Note moved, was replaced, or was deleted', candidate.path);
          continue;
        }
        bytes += Math.max(0, raw.length - candidate.bytes);
        if (bytes > 1_000_000) {
          incomplete('Exceeded the 1 MB scan-size limit while reading', candidate.path);
          continue;
        }
        failure = 'Could not inspect note';
        if (revision === this.port.revision()) this.port.observed?.(candidate, raw);
        if (!/^(?:\uFEFF)?---\r?\n/u.test(raw)) continue;
        failure = 'Could not parse frontmatter';
        const doc = readDocument(raw);
        failure = 'Could not inspect clipping';
        // Capture deduplicates typed clippings; deletion must also protect ordinary
        // origin references, including former clippings whose type was edited away.
        // Keep unreadable/uninspected candidates uncertain in both cases.
        if (purpose === 'capture' && !clippingMember(doc.properties, this.port.bindings()))
          continue;
        const source =
          clippingOrigin(doc.properties.origin)?.path ??
          (typeof doc.properties.origin === 'string' ? linkPath(doc.properties.origin) : undefined);
        if (source) {
          const target = this.articles.vault.resolveLink?.(source, candidate.path);
          if (target === snapshot.file) referenced = true;
          else if (!target) {
            // Unknown resolution cannot prove absence, even without a clipping type.
            incomplete('Could not resolve origin in', candidate.path);
            continue;
          }
        }
        const clipping = readClipping(raw, this.port.bindings());
        if (!clipping) continue;
        const origin = clippingOrigin(clipping.origin)!;
        const target = this.articles.vault.resolveLink?.(origin.path, candidate.path);
        if (!target) {
          incomplete('Could not resolve origin in', candidate.path);
          continue;
        }
        if (target !== snapshot.file) continue;
        const location = locateClipping(snapshot.body, origin.blockId, clipping.quote);
        items.push({ path: candidate.path, quote: clipping.quote, location });
      } catch {
        incomplete(failure, candidate.path);
      }
    }
    if (signal.aborted) throw new Error('Clipping lookup cancelled.');
    if (revision !== this.port.revision())
      incomplete(
        `Vault, metadata or clipping settings changed during lookup.${this.changeDiagnostic()}`,
      );
    return {
      items,
      referenced,
      complete,
      revision,
      diagnostic: problems.join(' ') + (omitted ? ` ${omitted} additional lookup problems.` : ''),
    };
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
  /** Reconcile metadata lag without retrying writes or trusting an old source snapshot. */
  private async scanForCapture(
    snapshot: Snapshot<File>,
    signal: AbortSignal,
    active: () => void,
  ): Promise<ClippingScan> {
    for (let attempt = 0; attempt < 3; attempt++) {
      active();
      const revision = this.port.revision();
      await this.articles.validate(snapshot);
      active();
      // A native metadata event may arrive after our source write. Revalidate if
      // anything changed during the read; never replace newer evidence with old bytes.
      if (revision !== this.port.revision()) continue;
      this.port.observed?.(
        { file: snapshot.file, path: snapshot.path, bytes: snapshot.raw.length },
        snapshot.raw,
      );
      const scan = await this.scan(snapshot, signal, 'capture');
      active();
      if (scan.revision === this.port.revision()) return scan;
      // Only an invalidated scan is retried. Stable missing/oversized coverage still blocks.
    }
    return {
      items: [],
      referenced: false,
      complete: false,
      revision: this.port.revision(),
      diagnostic: `Vault, metadata or clipping settings changed during all 3 lookup attempts.${this.changeDiagnostic()}`,
    };
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
    const scan = await this.scanForCapture(snapshot, signal, active);
    active();
    if (!scan.complete)
      throw new Error(
        `Clipping lookup is incomplete. No new clipping was saved. ${scan.diagnostic}`,
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
    const existingCard = (scan: ClippingScan): string | undefined => {
      if (!scan.complete)
        throw new Error(
          `Source retained, but clipping lookup is incomplete. No card was created. ${scan.diagnostic}`,
        );
      if (
        scan.items.some(
          (item) =>
            !item.location &&
            item.quote.replace(/\s+/gu, ' ').trim() === plan.quote.replace(/\s+/gu, ' ').trim(),
        )
      )
        throw new Error(
          'Source retained, but an existing clipping has an unresolved match. Inspect its source reference before retrying.',
        );
      const matches = scan.items.filter(
        (item) => item.location && sameClipping(item.location, desired),
      );
      if (matches.length > 1)
        throw new Error('Source retained, but several cards now match. No new card was created.');
      return matches[0]?.path;
    };
    let finalScan = await this.scanForCapture(source, signal, active);
    active();
    const raced = existingCard(finalScan);
    if (raced) return { snapshot: source, path: raced, created: false };
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
        if (this.port.revision() !== finalScan.revision) {
          // Native create may invoke this guard more than once. Reconcile fresh
          // bytes and duplicate coverage, never replay the source write or ignore
          // a revision change merely because its last event was metadata.
          finalScan = await this.scanForCapture(source, signal, active);
          active();
          const existing = existingCard(finalScan);
          if (existing)
            throw new Error(
              `A clipping for this passage now exists at ${diagnosticPath(existing)}. No new card was created.`,
            );
        }
        if (this.port.revision() !== finalScan.revision)
          throw new Error(
            `The vault changed before card creation.${this.changeDiagnostic()} Recheck before retrying.`,
          );
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

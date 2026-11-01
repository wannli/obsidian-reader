import { App, parseFrontMatterAliases, prepareFuzzySearch, TFile } from 'obsidian';
import type { ClassMember } from './fileclass-contract';

export interface NodeEntry {
  file: TFile;
  type: string;
  classes: string[];
  labels: string[];
}
export interface NodeHit {
  entry: NodeEntry;
  label: string;
  rank: number;
  score: number;
}
interface Cached {
  entry: NodeEntry;
  path: string;
  lower: string[];
  empty: NodeHit;
}
interface Ranked {
  hit: NodeHit;
  order: number;
}

/** Fileclass membership is authoritative; search never asks the source or metadata cache. */
export class NodeIndex {
  private entries = new Map<string, Cached>();
  private labelCounts = new Map<string, number>();
  private ordered?: Cached[];
  private generation = 0;
  private disposed = false;
  private requests = new Map<string, object>();
  private changes?: Map<string, Cached | undefined>;

  constructor(
    private app: App,
    private source: () => Promise<ClassMember[]>,
  ) {}

  /** Pin an optional source per request; false means failed/discarded, not a published source snapshot. */
  async rebuild(source = this.source): Promise<boolean> {
    if (this.disposed) return false;
    const generation = ++this.generation;
    this.requests.clear();
    const changes = (this.changes = new Map<string, Cached | undefined>());
    const counts = new Map<string, number>();
    let entries = new Map<string, Cached>(),
      published = true;
    try {
      const members = await source();
      if (generation !== this.generation) return false;
      for (const [i, member] of members.entries()) {
        if (i && i % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (generation !== this.generation) return false;
        if (!member || typeof member.path !== 'string') continue;
        const file = this.app.vault.getAbstractFileByPath(member.path);
        if (!(file instanceof TFile) || changes.has(member.path)) continue;
        const classes = classNames(member.classes);
        if (!classes.length) continue;
        const previous = entries.get(file.path);
        const entry = this.entry(
          file,
          classNames([...(previous?.entry.classes ?? []), ...classes]),
        );
        this.countLabels(previous, -1, counts);
        this.countLabels(entry, 1, counts);
        entries.set(file.path, entry);
      }
    } catch {
      entries = new Map();
      counts.clear();
      published = false;
    }
    if (generation !== this.generation) return false;
    for (const [path, entry] of changes) {
      this.countLabels(entries.get(path), -1, counts);
      this.countLabels(entry, 1, counts);
      if (entry) entries.set(path, entry);
      else entries.delete(path);
    }
    this.entries = entries;
    this.labelCounts = counts;
    this.ordered = undefined;
    this.changes = undefined;
    return published;
  }

  /** Latest request for this original path wins; failures remove only that note. */
  async update(file: TFile, classes: () => Promise<string[]>): Promise<void> {
    const path = file.path;
    if (this.disposed || !(file instanceof TFile) || !this.current(file, path)) return;
    const request = {};
    this.requests.set(path, request);
    const current = () => this.requests.get(path) === request && this.current(file, path);
    try {
      const names = classNames(await classes());
      if (current()) this.put(path, names.length ? this.entry(file, names) : undefined);
    } catch {
      if (current()) this.put(path, undefined);
    } finally {
      if (this.requests.get(path) === request) this.requests.delete(path);
    }
  }

  /** Confirmed creation wins over the active full snapshot without restarting its scan. */
  remember(file: TFile, classes: string[]): void {
    if (this.disposed || !(file instanceof TFile) || !this.current(file, file.path)) return;
    const names = classNames(classes);
    if (!names.length) return;
    const entry = this.entry(file, names);
    this.requests.delete(file.path);
    this.put(file.path, entry);
  }

  /** Stage a tombstone in the active rebuild and invalidate only this note's pending request. */
  forget(path: string): void {
    if (this.disposed) return;
    this.requests.delete(path);
    this.put(path, undefined);
  }

  clear(): void {
    ++this.generation;
    this.requests.clear();
    this.changes = this.ordered = undefined;
    this.entries.clear();
    this.labelCounts.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
  all(): readonly NodeEntry[] {
    return [...this.entries.values()]
      .filter(({ entry, path }) => this.current(entry.file, path))
      .map((item) => item.entry);
  }

  /** Snapshot-only lookup; host mutations reconcile deletions and renames, never row rendering. */
  isAmbiguous(label: string): boolean {
    return (this.labelCounts.get(label.trim().toLocaleLowerCase()) ?? 0) > 1;
  }

  search(query: string, limit = 20, type?: string): NodeHit[] {
    const size = Math.trunc(limit),
      term = query.trim().toLocaleLowerCase();
    if (!(size > 0)) return [];
    if (!term) {
      this.ordered ??= [...this.entries.values()].sort((a, b) => compare(a.empty, b.empty));
      const hits: NodeHit[] = [];
      for (const { entry, path, empty } of this.ordered) {
        if ((!type || entry.classes.includes(type)) && this.current(entry.file, path))
          hits.push({ ...empty });
        if (hits.length >= size) break;
      }
      return hits;
    }
    const fuzzy = prepareFuzzySearch(query.trim()),
      hits: Ranked[] = [];
    let order = 0;
    for (const { entry, path, lower } of this.entries.values()) {
      const position = order++;
      if ((type && !entry.classes.includes(type)) || !this.current(entry.file, path)) continue;
      let best: NodeHit | undefined;
      for (let i = 0; i < entry.labels.length; i++) {
        const label = entry.labels[i],
          match = fuzzy(label);
        if (!match) continue;
        const rank = lower[i] === term ? 0 : lower[i].startsWith(term) ? 1 : 2;
        const candidate = { entry, label, rank, score: match.score };
        if (!best || compare(candidate, best) < 0) best = candidate;
      }
      if (best) {
        const item = { hit: best, order: position };
        if (size >= this.entries.size) hits.push(item);
        else retain(hits, item, size);
      }
    }
    return hits.sort(ranked).map((item) => item.hit);
  }

  private countLabels(entry: Cached | undefined, delta: number, counts = this.labelCounts): void {
    for (const label of new Set(entry?.lower.map((label) => label.trim()) ?? [])) {
      const count = (counts.get(label) ?? 0) + delta;
      if (count > 0) counts.set(label, count);
      else counts.delete(label);
    }
  }
  private put(path: string, entry?: Cached): void {
    this.countLabels(this.entries.get(path), -1);
    if (entry) this.entries.set(path, entry);
    else this.entries.delete(path);
    this.countLabels(entry, 1);
    this.changes?.set(path, entry);
    this.ordered = undefined;
  }
  private current(file: TFile, path: string): boolean {
    return file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
  }
  private entry(file: TFile, classes: string[]): Cached {
    const aliases =
      parseFrontMatterAliases(this.app.metadataCache.getFileCache(file)?.frontmatter) ?? [];
    const labels = [
      ...new Set([
        file.basename,
        ...aliases.filter((label) => typeof label === 'string' && !!label.trim()),
      ]),
    ];
    const entry = { file, type: classes[classes.length - 1], classes, labels };
    const label = labels.reduce((a, b) => (a.localeCompare(b) <= 0 ? a : b));
    return {
      entry,
      path: file.path,
      lower: labels.map((label) => label.toLocaleLowerCase()),
      empty: { entry, label, rank: 3, score: 0 },
    };
  }
}

/** Keep the last occurrence so removing duplicates cannot change the primary class. */
function classNames(classes: string[]): string[] {
  if (!Array.isArray(classes)) return [];
  return [
    ...new Set(classes.filter((name) => typeof name === 'string' && !!name.trim()).reverse()),
  ].reverse();
}
function compare(a: NodeHit, b: NodeHit): number {
  // Obsidian fuzzy scores are negative; closer to zero is a better match.
  return (
    a.rank - b.rank ||
    b.score - a.score ||
    a.label.localeCompare(b.label) ||
    a.entry.file.path.localeCompare(b.entry.file.path)
  );
}
function ranked(a: Ranked, b: Ranked): number {
  return compare(a.hit, b.hit) || a.order - b.order;
}

/** Max-heap: O(matches log limit), then sort only the retained hits. Ordinals preserve stable ties. */
function retain(heap: Ranked[], item: Ranked, limit: number): void {
  if (heap.length < limit) {
    let i = heap.length;
    heap.push(item);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (ranked(heap[parent], item) >= 0) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  } else if (ranked(item, heap[0]) < 0) {
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && ranked(heap[child + 1], heap[child]) > 0) child++;
      if (ranked(item, heap[child]) >= 0) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = item;
  }
}

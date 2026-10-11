import type { FileStore } from '../types';
import { assertUnambiguousNotePath, safePath } from './safety';

/** In-memory FileStore; snapshot returns a detached, serializable copy. */
export class MemoryStore implements FileStore {
  private readonly files = new Map<string, string>();
  private revisions = new Map<string, number>();
  private bumpObservedRevision(path: string) {
    if (/\.md$/i.test(path)) this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
  }
  revision(excludingPath?: string): number {
    let total = 0;
    for (const [path, revision] of this.revisions) if (path !== excludingPath) total += revision;
    return total;
  }
  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(safePath(path), content);
  }
  indexedPaths(): readonly string[] { return [...this.files.keys()]; }
  async list(): Promise<string[]> { return [...this.files.keys()].sort(); }
  async read(path: string): Promise<string> {
    const content = this.files.get(safePath(path));
    if (content === undefined) throw new Error('File not found: ' + path);
    return content;
  }
  assertNotePath(path: string): void { assertUnambiguousNotePath([...this.files.keys()].map(path => ({ path })), path); }
  async observe(path: string, read: (current: string) => void) {
    const revision = this.revisions.get(path);
    const expected = await this.read(path); read(expected);
    return { assert: () => { if (this.revisions.get(path) !== revision || this.files.get(path) !== expected) throw new Error('Node changed or was deleted: ' + path); }, dispose() {} };
  }
  async exists(path: string): Promise<boolean> { return this.files.has(safePath(path)); }
  assertAbsent(path: string): void { if (this.files.has(safePath(path))) throw new Error('File already exists: ' + path); }
  async create(path: string, content: string, options?: { guard?: () => void }): Promise<void> {
    safePath(path); options?.guard?.();
    if (this.files.has(path)) throw new Error('File already exists: ' + path);
    this.files.set(path, content); this.bumpObservedRevision(path);
  }
  async process(path: string, update: (current: string) => string): Promise<void> {
    safePath(path);
    const current = this.files.get(path);
    if (current === undefined) throw new Error('File not found: ' + path);
    const next = update(current); this.files.set(path, next);
    if (next !== current) this.bumpObservedRevision(path);
  }
  async rename(from: string, to: string, options: { expectedContent: string; guard?: () => void }): Promise<void> {
    options.guard?.();
    safePath(from, true); safePath(to, true);
    const current = this.files.get(from);
    if (current === undefined || current !== options.expectedContent) throw new Error('Article changed before move; retry');
    if (from === to) return;
    if ([...this.files.keys()].some(path => path.normalize('NFC').toLowerCase() === to.normalize('NFC').toLowerCase())) throw new Error('Move destination already exists: ' + to);
    this.files.set(to, current);
    this.files.delete(from); this.bumpObservedRevision(from); this.bumpObservedRevision(to);
  }
  snapshot(): Record<string, string> { return Object.fromEntries(this.files); }
}

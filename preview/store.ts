import type { FileStore } from '../src/types';
import { assertUnambiguousNotePath, safePath } from '../src/storage/safety';
import { StaleArticleWriteError } from '../src/storage/preconditions';
import { assertNoLegacyOwnership } from '../src/storage/legacy-discovery';
import { isSidecarPath } from '../src/storage/sidecar-format';
export class BrowserStore implements FileStore {
  private files: Record<string, string>;
  private revisions = new Map<string, number>();
  private bumpObservedRevision(path: string) {
    if (/\.md$/i.test(path) || isSidecarPath(path)) this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
  }
  revision(excludingPath?: string): number {
    let total = 0;
    for (const [path, revision] of this.revisions) if (path !== excludingPath) total += revision;
    return total;
  }
  constructor(private key = 'reader-preview-v1') {
    const raw = localStorage.getItem(key);
    this.files = raw ? JSON.parse(raw) as Record<string, string> : {};
  }
  indexedPaths(): readonly string[] { return Object.keys(JSON.parse(localStorage.getItem(this.key) ?? '{}')); }
  async list() { return Object.keys(this.files); }
  assertNotePath(path: string): void { assertUnambiguousNotePath(Object.keys(this.files).map(path => ({ path })), path); }
  async observe(path: string, read: (current: string) => void) {
    const revision = this.revisions.get(path);
    const expected = await this.read(path); read(expected);
    return { assert: () => { if (this.revisions.get(path) !== revision || this.files[path] !== expected || JSON.parse(localStorage.getItem(this.key) ?? '{}')[path] !== expected) throw new Error('Node changed or was deleted: ' + path); }, dispose() {} };
  }
  async exists(path: string) { return Object.hasOwn(this.files, path); }
  async read(path: string) { if (!await this.exists(path)) throw new Error('Missing note: ' + path); return this.files[path]; }
  async create(path: string, content: string, options?: { guard?: () => void }) {
    options?.guard?.();
    const revision = this.revision(path);
    if (/\.md$/i.test(path)) await assertNoLegacyOwnership(this, path);
    if (this.revision(path) !== revision) throw new StaleArticleWriteError();
    options?.guard?.();
    if (Object.hasOwn(this.files, path)) throw new Error('Note already exists: ' + path);
    const next = { ...this.files, [path]: content };
    localStorage.setItem(this.key, JSON.stringify(next)); this.files = next; this.bumpObservedRevision(path);
  }
  async process(path: string, update: (current: string) => string) {
    if (!Object.hasOwn(this.files, path)) throw new Error('Missing note: ' + path);
    const before = this.files[path], next = update(before);
    if (!Object.hasOwn(this.files, path) || this.files[path] !== before) throw new StaleArticleWriteError();
    const files = { ...this.files, [path]: next };
    localStorage.setItem(this.key, JSON.stringify(files)); this.files = files;
    if (next !== before) this.bumpObservedRevision(path);
  }
  async rename(from: string, to: string, options: { expectedContent: string; guard?: () => void }): Promise<void> {
    options.guard?.();
    safePath(from, true); safePath(to, true);
    const valid = (path: string) => !/[\\\r\n]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');
    if (!valid(from) || !valid(to)) throw new Error('Invalid note path');
    if (!Object.hasOwn(this.files, from) || this.files[from] !== options.expectedContent) throw new StaleArticleWriteError();
    if (from === to) return;
    const folded = (path: string) => path.normalize('NFC').toLowerCase(), target = folded(to);
    if (folded(from) === target || Object.keys(this.files).some(path => folded(path) === target || folded(path).startsWith(target + '/') || target.startsWith(folded(path) + '/'))) throw new Error('Note or folder already exists: ' + to);
    const next = { ...this.files, [to]: this.files[from] }; delete next[from];
    // One localStorage write: a failure leaves both the persisted and live snapshot unchanged.
    localStorage.setItem(this.key, JSON.stringify(next)); this.files = next; this.bumpObservedRevision(from); this.bumpObservedRevision(to);
  }
  snapshot() { return { ...this.files }; }
}

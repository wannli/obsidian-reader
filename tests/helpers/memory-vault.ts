import { ChangedNote } from '../../src/core/document';
import type { NoteFile, VaultPort } from '../../src/core/store';

export class MemoryVault implements VaultPort<NoteFile> {
  files = new Map<string, NoteFile>();
  bytes = new Map<NoteFile, string>();
  trashed: string[] = [];
  dirty = new Set<NoteFile>();
  failMove = false;
  failWrite = false;
  beforeMove?: () => Promise<void>;
  beforeTrash?: () => Promise<void>;
  file(path: string): NoteFile | undefined {
    return this.files.get(path);
  }
  async read(file: NoteFile): Promise<string> {
    if (this.file(file.path) !== file) throw new ChangedNote();
    return this.bytes.get(file)!;
  }
  async create(path: string, content: string): Promise<NoteFile> {
    if (this.files.has(path)) throw new Error('File exists');
    const file = { path };
    this.files.set(path, file);
    this.bytes.set(file, content);
    return file;
  }
  async process(file: NoteFile, update: (current: string) => string): Promise<string> {
    if (this.failWrite) throw new Error('Disk full');
    const next = update(await this.read(file));
    this.bytes.set(file, next);
    return next;
  }
  async move(file: NoteFile, path: string, guard: () => void = () => {}): Promise<void> {
    await this.beforeMove?.();
    guard();
    if (this.failMove) throw new Error('Move failed');
    if (this.files.has(path)) throw new Error('File exists');
    this.files.delete(file.path);
    file.path = path;
    this.files.set(path, file);
  }
  async trash(file: NoteFile, validate: (current: string) => void = () => {}): Promise<void> {
    const path = file.path;
    await this.beforeTrash?.();
    const current = await this.read(file);
    if (file.path !== path || this.file(path) !== file) throw new ChangedNote();
    this.assertWritable(file);
    validate(current);
    this.trashed.push(file.path);
    this.files.delete(file.path);
    this.bytes.delete(file);
  }
  assertWritable(file: NoteFile): void {
    if (this.dirty.has(file)) throw new Error('Native editor has unfinished edits');
  }
}
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

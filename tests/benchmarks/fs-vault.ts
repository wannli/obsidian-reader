import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NoteFile, VaultPort } from '../../src/core/store';

export type Counts = Record<string, number>;
export type PathGuard = (path: string, kind: 'file' | 'directory') => Promise<void>;

export function checkedNotePath(root: string, path: string): string {
  if (
    !path.startsWith('Reading/') ||
    !path.endsWith('.md') ||
    /[\\\x00-\x1f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Unsafe corpus note path');
  const full = resolve(root, path),
    child = relative(root, full);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Path escapes corpus');
  return full;
}

/** Benchmark-only port: real files, stable identities, no Obsidian/editor/backlink emulation.
 * Every disk access is fenced by the caller's repository/corpus/symlink guard.
 * Writes are buffered (not fsync); no-op process callbacks do not rewrite files. */
export class FileVault implements VaultPort<NoteFile> {
  readonly files = new Map<string, NoteFile>();
  private identities = new WeakMap<NoteFile, { dev: number; ino: number }>();
  private counters: Counts = {
    reads: 0,
    articleReads: 0,
    feedReads: 0,
    readBytes: 0,
    writes: 0,
    writtenBytes: 0,
    creates: 0,
    processes: 0,
    moves: 0,
    trashes: 0,
    pathGuards: 0,
  };
  constructor(
    readonly root: string,
    private guard: PathGuard,
  ) {}
  counts(): Counts {
    return { ...this.counters };
  }
  file(path: string): NoteFile | undefined {
    checkedNotePath(this.root, path);
    return this.files.get(path);
  }
  exists(path: string): boolean {
    checkedNotePath(this.root, path);
    return this.files.has(path);
  }
  assertWritable(file: NoteFile): void {
    checkedNotePath(this.root, file.path);
    assert.equal(this.files.get(file.path), file, 'File identity changed');
  }
  private async checked(path: string, kind: 'file' | 'directory'): Promise<void> {
    this.counters.pathGuards++;
    await this.guard(path, kind);
  }
  private countedRead(path: string, raw: string): string {
    this.counters.reads++;
    this.counters.readBytes += Buffer.byteLength(raw);
    this.counters[path.startsWith('Reading/Wires/') ? 'feedReads' : 'articleReads']++;
    return raw;
  }
  private async handle(file: NoteFile, flags: number) {
    this.assertWritable(file);
    const path = checkedNotePath(this.root, file.path);
    await this.checked(path, 'file');
    const handle = await open(path, flags | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(),
        identity = this.identities.get(file);
      assert(
        stat.isFile() &&
          stat.nlink === 1 &&
          identity?.dev === stat.dev &&
          identity.ino === stat.ino,
        'Disk file identity changed',
      );
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async read(file: NoteFile): Promise<string> {
    const handle = await this.handle(file, constants.O_RDONLY);
    try {
      return this.countedRead(file.path, await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  }
  async create(
    path: string,
    content: string,
    guard: () => void | Promise<void> = () => {},
  ): Promise<NoteFile> {
    const full = checkedNotePath(this.root, path);
    await guard();
    await this.checked(full, 'file');
    await this.checked(dirname(full), 'directory');
    await mkdir(dirname(full), { recursive: true });
    await this.checked(full, 'file');
    await guard();
    assert(!this.files.has(path), 'Existing corpus file');
    const handle = await open(
      full,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content);
      const stat = await handle.stat(),
        file = { path };
      assert(stat.isFile() && stat.nlink === 1);
      this.identities.set(file, { dev: stat.dev, ino: stat.ino });
      this.files.set(path, file);
      this.counters.creates++;
      this.counters.writes++;
      this.counters.writtenBytes += Buffer.byteLength(content);
      return file;
    } finally {
      await handle.close();
    }
  }
  async process(file: NoteFile, update: (current: string) => string): Promise<string> {
    const handle = await this.handle(file, constants.O_RDWR);
    try {
      const current = this.countedRead(file.path, await handle.readFile('utf8'));
      this.counters.processes++;
      const next = update(current);
      if (next !== current) {
        const bytes = Buffer.from(next);
        for (let at = 0; at < bytes.length;) {
          const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, at);
          assert(bytesWritten > 0, 'Short write');
          at += bytesWritten;
        }
        await handle.truncate(bytes.length);
        this.counters.writes++;
        this.counters.writtenBytes += bytes.length;
      }
      return next;
    } finally {
      await handle.close();
    }
  }
  async move(file: NoteFile, path: string): Promise<void> {
    this.assertWritable(file);
    const from = checkedNotePath(this.root, file.path),
      to = checkedNotePath(this.root, path);
    assert(!this.files.has(path), 'Occupied corpus destination');
    const handle = await this.handle(file, constants.O_RDONLY);
    await handle.close();
    await this.checked(dirname(to), 'directory');
    await mkdir(dirname(to), { recursive: true });
    await this.checked(from, 'file');
    await this.checked(to, 'file');
    // link is exclusive, unlike rename's replace-existing behavior. Both paths are
    // inside this fresh corpus; the temporary second hard link is immediately removed.
    await link(from, to);
    await unlink(from);
    this.files.delete(file.path);
    file.path = path;
    this.files.set(path, file);
    this.counters.moves++;
  }
  async trash(file: NoteFile, validate: (current: string) => void): Promise<void> {
    const current = await this.read(file),
      from = checkedNotePath(this.root, file.path);
    const trash = join(this.root, '.trash');
    await this.checked(trash, 'directory');
    await mkdir(trash, { recursive: true });
    const to = join(trash, `${randomUUID()}.md`);
    await this.checked(from, 'file');
    await this.checked(to, 'file');
    // Expiry in this benchmark must never reach this path; still retain recoverable bytes.
    this.assertWritable(file);
    validate(current);
    await link(from, to);
    await unlink(from);
    this.files.delete(file.path);
    this.counters.trashes++;
  }
  async assertFiles(): Promise<void> {
    for (const file of this.files.values()) {
      const path = checkedNotePath(this.root, file.path);
      await this.checked(path, 'file');
      const stat = await lstat(path),
        identity = this.identities.get(file);
      assert(
        stat.isFile() &&
          stat.nlink === 1 &&
          identity?.dev === stat.dev &&
          identity.ino === stat.ino,
      );
    }
  }
}

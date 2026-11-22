import { describe, expect, it, vi } from 'vitest';
import {
  installReaderDiagnostics,
  isReaderError,
  logReaderError,
  ReaderDiagnostics,
  readerBreadcrumb,
  redactDiagnostic,
  type DiagnosticStorage,
} from '../src/host/diagnostics';

function fixture() {
  const files = new Map<string, string>();
  const storage: DiagnosticStorage = {
    exists: vi.fn(async (path) => files.has(path)),
    mkdir: vi.fn(async (path) => {
      files.set(path, '');
    }),
    stat: vi.fn(async (path) =>
      files.has(path) ? { size: new TextEncoder().encode(files.get(path)!).length } : null,
    ),
    read: vi.fn(async (path) => files.get(path)!),
    write: vi.fn(async (path, data) => {
      files.set(path, data);
    }),
  };
  const logger = new ReaderDiagnostics(storage, 'plugin/logs', {
    reader: '1.0',
    obsidian: '1.12',
    platform: 'mobile',
  });
  const entries = () =>
    (files.get('plugin/logs/errors.jsonl') ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { logger, files, storage, entries };
}

describe('persistent Reader diagnostics', () => {
  it('records versions, timestamps, session, operation, stack and bounded recent actions', async () => {
    const { logger, entries } = fixture();
    for (let i = 0; i < 20; i++) logger.breadcrumb(`action.${i}`);
    const error = new Error('Write failed');
    error.stack =
      'Error: Write failed\n    at save (plugin:obsidian-reader:20:4)\nsource text must not be logged';
    logger.error(error, 'highlight.save');
    await logger.flush();
    expect(entries()[0]).toMatchObject({
      reader: '1.0',
      obsidian: '1.12',
      platform: 'mobile',
      operation: 'highlight.save',
      message: 'Write failed',
      count: 1,
    });
    expect(Date.parse(entries()[0].at)).not.toBeNaN();
    expect(entries()[0].session).toBeTruthy();
    expect(entries()[0].stack).toContain('plugin:obsidian-reader:20:4');
    expect(entries()[0].stack).not.toContain('source text');
    expect(entries()[0].trail).toHaveLength(12);
    expect(entries()[0].trail[0].operation).toBe('action.8');
  });
  it('redacts URLs, credentials, note paths, quoted values and multiline parser excerpts', async () => {
    const { logger, entries } = fixture();
    logger.error(
      new Error(
        'Failed https://user:pass@example.com/private?token=secret /home/person/vault/note.md token=abc "private selection" [[Private note]]\nSECRET BODY',
      ),
    );
    await logger.flush();
    const serialized = JSON.stringify(entries());
    for (const secret of [
      'example.com',
      'user:pass',
      '/home/person',
      'note.md',
      'abc',
      'private selection',
      'Private note',
      'SECRET BODY',
    ])
      expect(serialized).not.toContain(secret);
    expect(redactDiagnostic('Could not write Reading/Article.md')).not.toContain('Article.md');
  });
  it('groups bursts and reports bounded queue overflow', async () => {
    const { logger, entries } = fixture();
    for (let i = 0; i < 100; i++) logger.error('same failure');
    for (let i = 0; i < 100; i++) logger.error(`failure ${i}`);
    await logger.flush();
    expect(entries()[0].count).toBe(100);
    expect(entries()).toHaveLength(65);
    expect(entries().at(-1)).toMatchObject({ operation: 'diagnostics.overflow', dropped: 37 });
  });
  it('preserves previous sessions and rotates with both files bounded in UTF-8 bytes', async () => {
    const { logger, files, entries } = fixture();
    files.set('plugin/logs/errors.jsonl', JSON.stringify({ previousSession: true }) + '\n');
    logger.error('first');
    await logger.flush();
    expect(entries()[0]).toEqual({ previousSession: true });
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 64; i++) logger.error(`${batch}-${i} ${'界'.repeat(2000)}`);
      await logger.flush();
    }
    expect(files.has('plugin/logs/errors.previous.jsonl')).toBe(true);
    for (const [path, value] of files) {
      expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(256 * 1024);
      if (path.endsWith('.jsonl'))
        for (const line of value.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    }
  });
  it('never reads an oversized externally modified log', async () => {
    const { logger, files, storage, entries } = fixture();
    files.set('plugin/logs/errors.jsonl', 'x'.repeat(300_000));
    logger.error('recover');
    await logger.flush();
    expect(storage.read).not.toHaveBeenCalled();
    expect(entries()).toHaveLength(1);
  });
  it('serializes overlapping writes without losing incoming records', async () => {
    const { logger, storage, entries } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = storage.write;
    storage.write = vi.fn(async (path, data) => {
      await blocked;
      await write(path, data);
    });
    logger.error('first');
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
    logger.error('second');
    release();
    await logger.flush();
    expect(entries().map((entry) => entry.message)).toEqual(['first', 'second']);
  });
  it('contains storage failures and can recover on the next error', async () => {
    const { logger, storage, entries } = fixture();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(storage.write).mockRejectedValueOnce(new Error('Disk full'));
    logger.error('failed write');
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith('[Reader] Diagnostic log could not be written.');
    logger.error('next');
    await logger.flush();
    expect(entries()[0].message).toBe('next');
    consoleError.mockRestore();
  });
  it('routes existing reporting, stops new records on unload, and drains dispatched writes', async () => {
    const { logger, entries } = fixture();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = installReaderDiagnostics(logger);
    readerBreadcrumb('article.open');
    logReaderError('before unload', 'view');
    stop();
    logReaderError('after unload');
    await logger.flush();
    expect(entries()).toHaveLength(1);
    expect(entries()[0].trail[0].operation).toBe('article.open');
    consoleError.mockRestore();
  });
  it('only attributes global errors with Reader stack frames', () => {
    const error = new Error('broken');
    error.stack = 'Error\n at run (plugin:another-plugin:1:2)';
    expect(isReaderError(error)).toBe(false);
    error.stack = 'Error\n at run (plugin:obsidian-reader:1:2)';
    expect(isReaderError(error)).toBe(true);
    error.stack = 'Error\n at run (plugin:obsidian-reader2:1:2)';
    expect(isReaderError(error)).toBe(false);
    expect(isReaderError('Reader crashed')).toBe(false);
    expect(
      isReaderError(Object.assign(new Error(), { stack: 'at obsidian-reader-other.js:1' })),
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosticDeviceId,
  installReaderDiagnostics,
  isReaderError,
  logReaderError,
  ReaderDiagnostics,
  readerBreadcrumb,
  readerTrace,
  redactDiagnostic,
  type DiagnosticStorage,
} from '../src/host/diagnostics';

const currentPath = 'Reader Diagnostics/errors-mobile-test-device.md';
const previousPath = 'Reader Diagnostics/errors-mobile-test-device.previous.md';
const parseEntries = (content: string) =>
  content
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(device = 'mobile-test-device', files = new Map<string, string>()) {
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
  const logger = new ReaderDiagnostics(
    storage,
    'Reader Diagnostics',
    {
      reader: '1.0',
      obsidian: '1.12',
      platform: 'mobile',
    },
    device,
  );
  const entries = () => parseEntries(files.get(`Reader Diagnostics/errors-${device}.md`) ?? '');
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
  it('persists correlated, bounded stage and outcome traces without exposing note paths', async () => {
    const { logger, entries } = fixture();
    const stop = installReaderDiagnostics(logger);
    try {
      readerTrace('article.acquire.start', 'Reading/Private.md');
      readerTrace('article.acquire.extract', 'Reading/Private.md');
      readerTrace('article.acquire.failed', 'Reading/Private.md');
      readerTrace('article.expire.archived.body-annotation', 'Reading/Another.md');
      await logger.flush();
      expect(entries().map((entry) => entry.operation)).toEqual([
        'article.acquire.start',
        'article.acquire.extract',
        'article.acquire.failed',
        'article.expire.archived.body-annotation',
      ]);
      expect(entries()[0].note).toBe(entries()[1].note);
      expect(entries()[0].note).not.toBe(entries()[3].note);
      expect(JSON.stringify(entries())).not.toContain('Private.md');
      expect(JSON.stringify(entries())).not.toContain('Another.md');
    } finally {
      stop();
    }
  });
  it('bounds persistent tracing during large recovery bursts', async () => {
    const { logger, entries } = fixture();
    for (let i = 0; i < 400; i++) logger.trace('article.acquire.recovery', `Reading/${i}.md`);
    await logger.flush();
    expect(entries()).toHaveLength(64);
    expect(new Set(entries().map((entry) => entry.note)).size).toBe(64);
  });
  it('reserves room for a later protected-trash decision after startup tracing is exhausted', async () => {
    const { logger, entries } = fixture();
    for (let i = 0; i < 400; i++) logger.trace('article.acquire.start', `Reading/${i}.md`);
    logger.trace('article.trash.archived.topics', 'Reading/surprise.md');
    await logger.flush();
    expect(entries().at(-1)?.operation).toBe('article.trash.archived.topics');
    expect(JSON.stringify(entries())).not.toContain('surprise.md');
  });
  it('keeps a note-correlated error when a burst of traces fills the queue', async () => {
    const { logger, entries } = fixture();
    for (let i = 0; i < 64; i++) logger.trace('article.acquire.start', `Reading/${i}.md`);
    logger.error(new Error('Extraction failed'), 'article.acquire', 'Reading/63.md');
    await logger.flush();
    const error = entries().find((entry) => entry.message === 'Extraction failed');
    expect(error?.note).toBe(entries().at(-2)?.note);
    expect(entries()).toHaveLength(64);
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
    logger.error('previous session');
    await logger.flush();
    const resumed = fixture('mobile-test-device', files).logger;
    resumed.error('first');
    await resumed.flush();
    expect(entries()[0].message).toBe('previous session');
    expect(entries()[1].session).not.toBe(entries()[0].session);
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 64; i++) logger.error(`${batch}-${i} ${'界'.repeat(2000)}`);
      await logger.flush();
    }
    expect(files.has(previousPath)).toBe(true);
    for (const [path, value] of files) {
      expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(256 * 1024);
      if (path.endsWith('.md')) {
        expect(value).toContain('# Reader errors (mobile-test-device)');
        expect(parseEntries(value).length).toBeGreaterThan(0);
      }
    }
  });
  it('preserves oversized or user-authored files rather than overwriting them', async () => {
    for (const value of ['x'.repeat(300_000), '# My personal note\n']) {
      const { logger, files, storage } = fixture();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      files.set(currentPath, value);
      logger.error('recover');
      await logger.flush();
      expect(storage.write).not.toHaveBeenCalled();
      expect(files.get(currentPath)).toBe(value);
    }
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
  it('keeps distinct device files and rotations isolated in a shared vault', async () => {
    const files = new Map<string, string>();
    const first = fixture('ios-first-device', files);
    const second = fixture('linux-second-device', files);
    first.logger.error('phone error');
    second.logger.error('desktop error');
    await Promise.all([first.logger.flush(), second.logger.flush()]);
    expect(first.entries()[0]).toMatchObject({
      message: 'phone error',
      device: 'ios-first-device',
    });
    expect(second.entries()[0]).toMatchObject({
      message: 'desktop error',
      device: 'linux-second-device',
    });
    const secondBytes = files.get('Reader Diagnostics/errors-linux-second-device.md');
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 64; i++) first.logger.error(`${batch}-${i} ${'界'.repeat(2000)}`);
      await first.logger.flush();
    }
    expect(files.has('Reader Diagnostics/errors-ios-first-device.previous.md')).toBe(true);
    expect(files.get('Reader Diagnostics/errors-linux-second-device.md')).toBe(secondBytes);
  });
  it('retains an edited log and an unrelated rotation destination', async () => {
    const { logger, files, storage } = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('first');
    await logger.flush();
    files.set(currentPath, files.get(currentPath)! + 'My own writing\n');
    const edited = files.get(currentPath);
    logger.error('second');
    await logger.flush();
    expect(files.get(currentPath)).toBe(edited);
    files.set(currentPath, edited!.replace('My own writing\n', ''));
    files.set(previousPath, '# Personal note\n');
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 64; i++) logger.error(`${batch}-${i} ${'界'.repeat(2000)}`);
      await logger.flush();
    }
    expect(files.get(previousPath)).toBe('# Personal note\n');
    expect(storage.write).not.toHaveBeenCalledWith(previousPath, expect.anything());
  });
  it('uses stable local-only random device IDs, not synced settings or hardware identifiers', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const first = diagnosticDeviceId();
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(diagnosticDeviceId()).toBe(first);
    values.clear();
    expect(diagnosticDeviceId()).not.toBe(first);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw Error('blocked');
      },
      setItem: () => {
        throw Error('blocked');
      },
    });
    expect(diagnosticDeviceId()).not.toBe(diagnosticDeviceId());
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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as diagnostics from '../src/host/diagnostics';

const key = 'obsidian-reader:debug-logging';
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('persists only the device-local toggle and emits safe events when enabled', () => {
  diagnostics.initializeReaderDebugLogging();
  diagnostics.setReaderDebugLogging(true);
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(true);
  const event = {
    event: 'operation.completed',
    operation: 'save',
    durationMs: 12,
    count: 1,
  } as const;
  diagnostics.recordReaderDebug(event);
  expect(console.debug).toHaveBeenCalledExactlyOnceWith('[Reader debug]', event);
  expect(diagnostics.readReaderDebugLog()).toEqual([event]);
  expect([...stored]).toEqual([[key, '1']]);
  diagnostics.initializeReaderDebugLogging();
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(true);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
});

it('keeps only the latest 200 events and exposes defensive snapshots', () => {
  diagnostics.initializeReaderDebugLogging();
  diagnostics.setReaderDebugLogging(true);
  for (let count = 0; count < 205; count++) {
    diagnostics.recordReaderDebug({
      event: 'operation.completed',
      operation: 'read',
      durationMs: 0,
      count,
    });
  }
  const snapshot = diagnostics.readReaderDebugLog();
  expect(snapshot).toHaveLength(200);
  expect(snapshot[0]).toEqual({
    event: 'operation.completed',
    operation: 'read',
    durationMs: 0,
    count: 5,
  });
  expect(snapshot[199]).toEqual({
    event: 'operation.completed',
    operation: 'read',
    durationMs: 0,
    count: 204,
  });
  Object.assign(snapshot[0], { count: 999 });
  expect(diagnostics.readReaderDebugLog()[0]).toHaveProperty('count', 5);
  diagnostics.clearReaderDebugLog();
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(true);
});

it('clears on disable and unload, rejects late events and retains only the unload preference', () => {
  diagnostics.initializeReaderDebugLogging();
  diagnostics.setReaderDebugLogging(true);
  const event = { event: 'operation.cancelled', operation: 'search', durationMs: 4 } as const;
  diagnostics.recordReaderDebug(event);
  diagnostics.setReaderDebugLogging(false);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  expect(stored.get(key)).toBe('0');
  diagnostics.recordReaderDebug(event);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  diagnostics.setReaderDebugLogging(true);
  diagnostics.recordReaderDebug(event);
  diagnostics.disposeReaderDebugLogging();
  diagnostics.recordReaderDebug(event);
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(false);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  expect(stored.get(key)).toBe('1');
  expect(console.debug).toHaveBeenCalledTimes(2);
  diagnostics.initializeReaderDebugLogging();
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(true);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
});

it('fails closed on unavailable reads and clears immediately even if persisting disable fails', () => {
  diagnostics.initializeReaderDebugLogging();
  diagnostics.setReaderDebugLogging(true);
  diagnostics.recordReaderDebug({ event: 'operation.cancelled', operation: 'read', durationMs: 1 });
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('Storage unavailable');
    },
    setItem: () => {
      throw new Error('Storage unavailable');
    },
  });
  expect(() => diagnostics.setReaderDebugLogging(false)).toThrow('Storage unavailable');
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(false);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  expect(() => diagnostics.setReaderDebugLogging(true)).toThrow('Storage unavailable');
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(false);
  expect(() => diagnostics.initializeReaderDebugLogging()).not.toThrow();
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(false);
});

it('records only fixed safe scalar fields, never arbitrary metadata or caller objects', () => {
  diagnostics.initializeReaderDebugLogging();
  diagnostics.setReaderDebugLogging(true);
  const privateText = 'Private/Secret.md https://private.example token=secret selected words';
  const input = {
    event: 'operation.failed',
    operation: 'save',
    durationMs: 3,
    category: 'write',
    title: privateText,
    path: privateText,
    url: privateText,
    payload: { text: privateText },
    toJSON: () => privateText,
  } as const;
  diagnostics.recordReaderDebug(input);
  const safe = { event: 'operation.failed', operation: 'save', durationMs: 3, category: 'write' };
  expect(diagnostics.readReaderDebugLog()).toEqual([safe]);
  expect(console.debug).toHaveBeenCalledExactlyOnceWith('[Reader debug]', safe);
  expect(JSON.stringify(diagnostics.readReaderDebugLog())).not.toContain(privateText);
  expect(console.debug).not.toHaveBeenCalledWith(
    '[Reader debug]',
    expect.objectContaining({ path: privateText }),
  );
  expect([...stored]).toEqual([[key, '1']]);
});

it.each([
  { event: 'Private title', operation: 'read', durationMs: 1 },
  { event: 'operation.cancelled', operation: 'Private/path.md', durationMs: 1 },
  {
    event: 'operation.failed',
    operation: 'save',
    durationMs: 1,
    category: 'https://private.example',
  },
  { event: 'operation.cancelled', operation: 'read', durationMs: 'secret' },
  { event: 'operation.cancelled', operation: 'read', durationMs: NaN },
  { event: 'operation.cancelled', operation: 'read', durationMs: Infinity },
  { event: 'operation.cancelled', operation: 'read', durationMs: -1 },
  { event: 'operation.completed', operation: 'read', durationMs: 1, count: 'secret' },
  { event: 'operation.completed', operation: 'read', durationMs: 1, count: -1 },
  { event: 'operation.completed', operation: 'read', durationMs: 1, count: 0.5 },
  { event: 'operation.completed', operation: 'read', durationMs: 1, count: Infinity },
  null,
])('rejects unsafe runtime values before console or ring output: %#', (input) => {
  diagnostics.initializeReaderDebugLogging();
  diagnostics.setReaderDebugLogging(true);
  // Simulate a JavaScript caller that bypasses the public fixed event union.
  // @ts-expect-error Invalid event names, categories and scalar types are intentionally rejected.
  diagnostics.recordReaderDebug(input);
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  expect(console.debug).not.toHaveBeenCalled();
});

it('defaults off and leaves ordinary errors visible without debug logging', () => {
  diagnostics.initializeReaderDebugLogging();
  expect(diagnostics.readerDebugLoggingEnabled()).toBe(false);
  diagnostics.recordReaderDebug({
    event: 'operation.completed',
    operation: 'save',
    durationMs: 12,
    count: 1,
  });
  expect(diagnostics.readReaderDebugLog()).toEqual([]);
  expect(console.debug).not.toHaveBeenCalled();
  const error = new Error('Ordinary failure');
  diagnostics.logReaderError(error);
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[Reader]', error);
  expect(stored.size).toBe(0);
});

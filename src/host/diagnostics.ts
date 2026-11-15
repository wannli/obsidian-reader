type ReaderDebugOperation = 'save' | 'read' | 'search' | 'capture' | 'retention' | 'context';
export type ReaderDebugEvent =
  | {
      event: 'operation.completed';
      operation: ReaderDebugOperation;
      durationMs: number;
      count: number;
    }
  | {
      event: 'operation.failed';
      operation: ReaderDebugOperation;
      durationMs: number;
      category: 'validation' | 'conflict' | 'unavailable' | 'write' | 'readback' | 'unknown';
    }
  | { event: 'operation.cancelled'; operation: ReaderDebugOperation; durationMs: number };

const preferenceKey = 'obsidian-reader:debug-logging';
let enabled = false;
const entries: ReaderDebugEvent[] = [];

/** Call once on plugin load, not on folder/view reconfiguration. */
export function initializeReaderDebugLogging(): void {
  enabled = false;
  clearReaderDebugLog();
  try {
    enabled = localStorage.getItem(preferenceKey) === '1';
  } catch {
    // Unavailable device storage fails closed; diagnostics must not block Reader.
  }
}
export function readerDebugLoggingEnabled(): boolean {
  return enabled;
}
export function readReaderDebugLog(): readonly ReaderDebugEvent[] {
  return entries.map((entry) => ({ ...entry }));
}
/** Persistence errors reach the settings UI; disabling still takes effect immediately. */
export function setReaderDebugLogging(value: boolean): void {
  if (!value) disposeReaderDebugLogging();
  localStorage.setItem(preferenceKey, value ? '1' : '0');
  enabled = value;
}

/** Fixed scalar schema only: never forward caller objects to the console or ring. */
export function recordReaderDebug(event: ReaderDebugEvent): void {
  if (!enabled) return;
  const safe = safeEvent(event);
  if (!safe) return;
  if (entries.length === 200) entries.shift();
  entries.push(Object.freeze(safe));
  console.debug('[Reader debug]', safe);
}
function safeEvent(input: ReaderDebugEvent): ReaderDebugEvent | undefined {
  if (!input || typeof input !== 'object') return;
  const { event, operation, durationMs } = input;
  if (
    !['save', 'read', 'search', 'capture', 'retention', 'context'].includes(operation) ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return;
  if (event === 'operation.completed') {
    const { count } = input;
    if (!Number.isSafeInteger(count) || count < 0) return;
    return { event, operation, durationMs, count };
  }
  if (event === 'operation.failed') {
    const { category } = input;
    if (
      !['validation', 'conflict', 'unavailable', 'write', 'readback', 'unknown'].includes(category)
    )
      return;
    return { event, operation, durationMs, category };
  }
  if (event === 'operation.cancelled') return { event, operation, durationMs };
}
export function clearReaderDebugLog(): void {
  entries.length = 0;
}
/** Call before stopping other services on unload, so late settlements stay quiet. */
export function disposeReaderDebugLogging(): void {
  enabled = false;
  clearReaderDebugLog();
}

/** Quiet diagnostics: inspect in Obsidian's developer console, not as toast notices. */
export function logReaderError(error: unknown): void {
  console.error('[Reader]', error);
}

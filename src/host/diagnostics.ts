/** Local, bounded diagnostics. Never pass note bodies, selections or provider payloads here. */
export interface DiagnosticStorage {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ size: number } | null>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}
interface Environment {
  reader: string;
  obsidian: string;
  platform: string;
}
const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** Defense in depth, not a guarantee that arbitrary third-party error prose is anonymous. */
export function redactDiagnostic(value: string): string {
  return value
    .slice(0, 8000)
    .replace(/(?:https?|app|file|obsidian):\/\/[^\s)\]<>]+/gi, '[url]')
    .replace(/\[\[[^\]]*\]\]/g, '[note]')
    .replace(/(?:[A-Z]:\\|\/)(?:[^\s:()]+[\/\\])*[^\s:()]+/gi, '[path]')
    .replace(/[^\s"'<>]+/g, (token) => (/\.md\b/i.test(token) ? '[note]' : token))
    .replace(
      /\b(authorization|bearer|token|password|secret|api[_-]?key)\b[\s:=]+[^\s,;]+/gi,
      '$1 [redacted]',
    )
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '[quoted]')
    .slice(0, 2000);
}
function errorDetails(error: unknown): { name: string; message: string; stack?: string } {
  try {
    return {
      name: error instanceof Error ? redactDiagnostic(error.name) : 'Error',
      message: redactDiagnostic(
        (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '',
      ),
      // Keep call sites, not the repeated message or source excerpts in parser errors.
      stack:
        error instanceof Error
          ? redactDiagnostic(
              (error.stack ?? '')
                .split('\n')
                .filter((line) => /^\s*at /.test(line))
                .slice(0, 12)
                .join('\n'),
            )
          : undefined,
    };
  } catch {
    return { name: 'Error', message: 'Unreadable error value' };
  }
}

export class ReaderDiagnostics {
  private pending = new Map<string, Record<string, unknown>>();
  private trail: { at: string; operation: string }[] = [];
  private running?: Promise<void>;
  private stopped = false;
  private dropped = 0;
  private session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  constructor(
    private storage: DiagnosticStorage,
    private directory: string,
    private environment: Environment,
  ) {}
  breadcrumb(operation: string): void {
    if (this.stopped) return;
    this.trail.push({
      at: new Date().toISOString(),
      operation: redactDiagnostic(operation).slice(0, 100),
    });
    if (this.trail.length > 12) this.trail.shift();
  }
  error(error: unknown, operation = 'reader'): void {
    if (this.stopped) return;
    const details = errorDetails(error),
      context = redactDiagnostic(operation).slice(0, 100);
    const key = JSON.stringify([context, details]);
    const previous = this.pending.get(key);
    if (previous) {
      previous.count = Number(previous.count) + 1;
      previous.lastAt = new Date().toISOString();
    } else if (this.pending.size < 64) {
      this.pending.set(key, {
        at: new Date().toISOString(),
        session: this.session,
        ...this.environment,
        operation: context,
        ...details,
        count: 1,
        trail: [...this.trail],
      });
    } else this.dropped++;
    this.schedule();
  }
  private schedule(): void {
    if (this.running) return;
    this.running = Promise.resolve()
      .then(() => this.drain())
      .catch(() => {
        // No recursive logging and no user-facing failure if storage is unavailable.
        console.error('[Reader] Diagnostic log could not be written.');
      })
      .finally(() => {
        this.running = undefined;
        if (this.pending.size) this.schedule();
      });
  }
  private async drain(): Promise<void> {
    const records = [...this.pending.values()];
    this.pending.clear();
    if (this.dropped)
      records.push({
        at: new Date().toISOString(),
        operation: 'diagnostics.overflow',
        dropped: this.dropped,
      });
    this.dropped = 0;
    if (!(await this.storage.exists(this.directory))) await this.storage.mkdir(this.directory);
    const path = `${this.directory}/errors.jsonl`;
    const stat = await this.storage.stat(path);
    let content = stat && stat.size <= MAX_BYTES ? await this.storage.read(path) : '';
    let size = encoder.encode(content).length;
    for (const record of records) {
      const line = JSON.stringify(record) + '\n';
      const lineSize = encoder.encode(line).length;
      if (size + lineSize > MAX_BYTES) {
        // Only rotate bounded content, never an externally enlarged file.
        if (content) await this.storage.write(`${this.directory}/errors.previous.jsonl`, content);
        content = '';
        size = 0;
      }
      content += line;
      size += lineSize;
    }
    await this.storage.write(path, content);
  }
  async flush(): Promise<void> {
    while (this.running) await this.running;
  }
  stop(): void {
    this.stopped = true;
  }
}
let active: ReaderDiagnostics | undefined;
export function installReaderDiagnostics(logger: ReaderDiagnostics): () => void {
  active = logger;
  return () => {
    logger.stop();
    if (active === logger) active = undefined;
  };
}
export function readerBreadcrumb(operation: string): void {
  active?.breadcrumb(operation);
}
export function logReaderError(error: unknown, operation = 'reader'): void {
  console.error('[Reader]', error);
  active?.error(error, operation);
}
/** Attribution is deliberately narrow: unrelated plugin errors are not collected. */
export function isReaderError(error: unknown): boolean {
  try {
    return (
      error instanceof Error &&
      /(?:plugin:obsidian-reader(?=[:)\s]|$)|plugins\/obsidian-reader\/main\.js(?=[:)?\s]|$))/.test(
        error.stack ?? '',
      )
    );
  } catch {
    return false;
  }
}

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
export const DIAGNOSTIC_DIRECTORY = 'Reader Diagnostics';
const DEVICE_KEY = 'obsidian-reader:diagnostics-device';
const MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** Device-local only: never put this ID in synced plugin settings or Markdown frontmatter. */
export function diagnosticDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && /^[a-f0-9]{32}$/.test(stored)) return stored;
  } catch {
    /* A private-storage device gets a fresh namespace each launch. */
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* Still collision-safe without persistence. */
  }
  return id;
}

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
    private device: string,
  ) {
    if (!/^[a-z0-9-]{1,80}$/.test(device)) throw new Error('Invalid diagnostic device ID.');
  }
  private get header(): string {
    return `<!-- Reader diagnostic log: ${this.device}; format=1 -->\n# Reader errors (${this.device})\n\n`;
  }
  private async readLog(path: string): Promise<string> {
    const stat = await this.storage.stat(path);
    if (!stat) return this.header;
    if (stat.size > MAX_BYTES) throw new Error('Diagnostic file is too large; preserved it.');
    const content = await this.storage.read(path);
    if (encoder.encode(content).length > MAX_BYTES)
      throw new Error('Diagnostic file grew; preserved it.');
    if (!content.startsWith(this.header))
      throw new Error('Diagnostic path contains other content.');
    const body = content.slice(this.header.length);
    const blocks = body.match(/```json\n[^\n]+\n```\n\n/g) ?? [];
    if (blocks.join('') !== body) throw new Error('Diagnostic file was edited; preserved it.');
    for (const block of blocks) {
      const entry: unknown = JSON.parse(block.split('\n')[1]!);
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as Record<string, unknown>).operation !== 'string'
      )
        throw new Error('Diagnostic file was edited; preserved it.');
    }
    return content;
  }
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
        device: this.device,
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
    const path = `${this.directory}/errors-${this.device}.md`;
    const previous = `${this.directory}/errors-${this.device}.previous.md`;
    let content = await this.readLog(path);
    let size = encoder.encode(content).length;
    for (const record of records) {
      const line = '```json\n' + JSON.stringify(record) + '\n```\n\n';
      const lineSize = encoder.encode(line).length;
      if (size + lineSize > MAX_BYTES) {
        // Verify both destinations belong to this logger before replacing either.
        await this.readLog(previous);
        await this.storage.write(previous, content);
        content = this.header;
        size = encoder.encode(content).length;
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

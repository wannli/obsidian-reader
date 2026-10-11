import { stringify } from 'yaml';
import type { FileStore, ReadGuard } from '../types';
import { noteType, parseNote } from './markdown';
import { safePath } from './safety';

/** Shared explicit node creation/observation. Never writes or deletes existing notes. */
export class TypedNodeBatch {
  readonly created: string[] = [];
  private entries: { path: string; expected: string; observation: ReadGuard }[] = [];
  constructor(private store: FileStore, private guard: () => void) {}
  async prepare(path: string, type: string, create = false): Promise<void> {
    safePath(path, true); this.guard();
    if (!this.store.assertNotePath || !this.store.observe) throw new Error('This store cannot safely guard typed node writes.');
    this.store.assertNotePath(path);
    if (!await this.store.exists(path)) {
      if (!create) throw new Error(`Choose an existing note with type: ${type}: ${path}`);
      await this.store.create(path, `---\n${stringify({ type })}---\n`, { guard: () => { this.guard(); this.store.assertNotePath!(path); } });
      this.created.push(path);
    }
    let expected = '';
    const observation = await this.store.observe(path, raw => {
      if (noteType(parseNote(raw)) !== type) throw new Error(`Node ${path} already exists with a different or missing type. It was not overwritten.`);
      expected = raw;
    });
    this.entries.push({ path, expected, observation });
  }
  assert(): void {
    this.guard();
    for (const entry of this.entries) { entry.observation.assert(); this.store.assertNotePath!(entry.path); }
  }
  async verify(): Promise<void> {
    this.assert();
    for (const entry of this.entries) {
      const check = (raw: string) => { if (raw !== entry.expected) throw new Error('Node changed during save: ' + entry.path); };
      if (this.store.inspect) await this.store.inspect(entry.path, check); else check(await this.store.read(entry.path));
    }
    this.assert();
  }
  dispose(): void { for (const entry of this.entries) entry.observation.dispose(); }
}

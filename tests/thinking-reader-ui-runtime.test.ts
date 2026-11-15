import { describe, expect, it, vi } from 'vitest';
import type { TFile } from 'obsidian';
import { hostFixture } from './helpers/reader-view-fixture';
import { ThinkingRuntime } from '../src/host/thinking-runtime';
import { patchProperties, readDocument } from '../src/core/document';

async function runtimeFixture() {
  const f = hostFixture();
  const notebook = await f.note('Notes/Thinking.md', 'Authored preface.', 'notebook');
  const raw = await f.vault.process(notebook, (raw) =>
    patchProperties(raw, { fileClass: 'Notebook' }),
  );
  f.cache.get(notebook).frontmatter = readDocument(raw).properties;
  Object.defineProperty(notebook, 'stat', {
    configurable: true,
    get: () => ({ size: new TextEncoder().encode(f.vault.bytes.get(notebook) ?? '').byteLength }),
  });
  const runtime = new ThinkingRuntime(f.app, f.store, f.signal.signal, {
    notebook: '[[Notes/Thinking.md]]',
    notebookType: 'Notebook',
    explorationType: 'Exploration',
    bindingProperty: 'fileClass',
  });
  return { ...f, notebook, runtime };
}

describe('generation-owned thinking runtime authority', () => {
  it('protects saved sources and invalidates an unprotected final-trash witness synchronously', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Inbox/Source.md', 'A source passage.');
    const other = await f.note('Reading/Inbox/Other.md', 'Other words.');
    expect((await f.runtime.keep(await f.store.read(source.path), 0, 16)).status).toBe('saved');
    const saved = await f.runtime.referenceAuthority(source.path);
    expect(saved.coverage).toBe('complete');
    expect(saved.protected).toBe(true);
    const witness = await f.runtime.referenceAuthority(other.path);
    expect(witness.coverage).toBe('complete');
    expect(witness.protected).toBe(false);
    witness.assertUnprotected();
    f.runtime.invalidate(f.notebook);
    expect(() => witness.assertUnprotected()).toThrow();
    expect((await f.runtime.referenceAuthority(other.path)).protected).toBe(true);
  });
  it('retains formerly proven containers after type loss instead of certifying a negative', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Inbox/Source.md', 'A source passage.');
    await f.runtime.keep(await f.store.read(source.path), 0, 16);
    expect((await f.runtime.referenceAuthority(source.path)).coverage).toBe('complete');
    const raw = await f.vault.process(f.notebook, (raw) =>
      patchProperties(raw, { fileClass: undefined }),
    );
    f.cache.get(f.notebook).frontmatter = readDocument(raw).properties;
    f.runtime.invalidate(f.notebook);
    f.runtime.metadataSettled(f.notebook);
    const authority = await f.runtime.referenceAuthority('Reading/Inbox/Unrelated.md');
    expect(authority.coverage).toBe('unknown');
    expect(authority.protected).toBe(true);
    expect(f.runtime.referencePaths()).toContain(f.notebook.path);
  });
  it('discovers a new typed container before stale metadata can authorize a negative', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Inbox/Source.md', 'A source passage.');
    const fresh = await f.note('Notes/New.md', 'Ordinary text.', 'note');
    f.runtime.invalidate(fresh);
    await f.vault.process(fresh, (raw) => patchProperties(raw, { fileClass: 'Notebook' }));
    const pending = await f.runtime.referenceAuthority(source.path);
    expect(pending.coverage).toBe('unknown');
    expect(f.runtime.referencePaths()).toContain(fresh.path);
    f.cache.get(fresh).frontmatter = readDocument(await f.vault.read(fresh)).properties;
    f.runtime.metadataSettled(fresh);
    expect((await f.runtime.referenceAuthority(source.path)).coverage).toBe('complete');
  });
  it('eventually certifies unrelated settled Markdown without treating it as a broken notebook', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Inbox/Source.md', 'A source passage.');
    f.runtime.invalidate(source);
    expect((await f.runtime.referenceAuthority(source.path)).coverage).toBe('unknown');
    f.runtime.metadataSettled(source);
    const authority = await f.runtime.referenceAuthority(source.path);
    expect(authority.coverage).toBe('complete');
    expect(authority.protected).toBe(false);
    expect(f.runtime.referencePaths()).not.toContain(source.path);
  });
  it('rejects native source changes during the awaited target read using the shared core witness', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Inbox/Source.md', 'A source passage.');
    const read = f.vault.read.bind(f.vault);
    let notebookReads = 0;
    vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      const raw = await read(file);
      if (file === f.notebook && ++notebookReads === 2) f.runtime.invalidate(source);
      return raw;
    });
    const result = await f.runtime.keep(await f.store.read(source.path), 0, 16);
    expect(result.status).toBe('partial');
    expect(result.message).toContain('Source observation changed');
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(0);
  });
  it('does not mistake delayed source metadata or its own Feed retention for a native source-byte change', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Stream/Source.md', 'A source passage.');
    const read = f.vault.read.bind(f.vault),
      move = f.vault.move.bind(f.vault);
    vi.spyOn(f.vault, 'move').mockImplementation(async (file, path, guard) => {
      await move(file, path, guard);
      f.runtime.invalidate(source);
    });
    let notebookReads = 0;
    vi.spyOn(f.vault, 'read').mockImplementation(async (file) => {
      const raw = await read(file);
      if (file === f.notebook && ++notebookReads === 2) f.runtime.invalidate(source, false);
      return raw;
    });
    const result = await f.runtime.keep(await f.store.read(source.path), 0, 16);
    expect(result.status).toBe('saved');
    expect(f.store.catalog.article(source.path)?.queue).toBe('Later');
    expect(readDocument(await f.vault.read(source)).body).toBe('A source passage.');
    expect((await f.runtime.store.read(f.notebook.path)).records).toHaveLength(1);
  });
  it('caps automatic source material at twelve notebook reads and reuses same-revision observations', async () => {
    const f = await runtimeFixture();
    for (let index = 0; index < 20; index++) {
      const file = await f.note(
        `Notes/Notebook ${index}.md`,
        'Small authored notebook.',
        'notebook',
      );
      const raw = await f.vault.process(file, (raw) =>
        patchProperties(raw, { fileClass: 'Notebook' }),
      );
      f.cache.get(file).frontmatter = readDocument(raw).properties;
      Object.defineProperty(file, 'stat', {
        get: () => ({ size: new TextEncoder().encode(f.vault.bytes.get(file) ?? '').byteLength }),
      });
    }
    const read = vi.spyOn(f.vault, 'read');
    const material = await f.runtime.readSourceMaterial(() => true);
    expect(material.complete).toBe(false);
    expect(material.documentsRead).toBe(12);
    expect(read).toHaveBeenCalledTimes(12);
    await f.runtime.readSourceMaterial(() => true);
    expect(read).toHaveBeenCalledTimes(12);
    f.runtime.invalidate(f.notebook, false);
    await f.runtime.readSourceMaterial(() => true);
    expect(read).toHaveBeenCalledTimes(24);
  });
  it('preflights the total 200k native-byte budget before reading or parsing notebooks', async () => {
    const f = await runtimeFixture();
    const large = await f.note('Notes/Large.md', 'Authored text.', 'notebook');
    const raw = await f.vault.process(large, (raw) =>
      patchProperties(raw, { fileClass: 'Notebook' }),
    );
    f.cache.get(large).frontmatter = readDocument(raw).properties;
    Object.defineProperty(large, 'stat', { value: { size: 200001 } });
    const read = vi.spyOn(f.vault, 'read');
    const material = await f.runtime.readSourceMaterial(() => true);
    expect(material.complete).toBe(false);
    expect(read.mock.calls.some(([file]) => file === large)).toBe(false);
    expect(material.bytesBudgeted).toBeLessThanOrEqual(200000);
  });
  it('budgets UTF-8 bytes cumulatively rather than independently per notebook', async () => {
    const f = await runtimeFixture();
    const files: TFile[] = [];
    for (const [path, body] of [
      ['Notes/First large.md', 'é'.repeat(70000)],
      ['Notes/Over remaining budget.md', 'x'.repeat(70000)],
    ]) {
      const file = await f.note(path, body, 'notebook');
      const raw = await f.vault.process(file, (raw) =>
        patchProperties(raw, { fileClass: 'Notebook' }),
      );
      f.cache.get(file).frontmatter = readDocument(raw).properties;
      Object.defineProperty(file, 'stat', {
        get: () => ({ size: new TextEncoder().encode(f.vault.bytes.get(file) ?? '').byteLength }),
      });
      files.push(file);
    }
    const read = vi.spyOn(f.vault, 'read');
    const material = await f.runtime.readSourceMaterial(() => true);
    expect(material.complete).toBe(false);
    expect(material.bytesBudgeted).toBeGreaterThanOrEqual(140000);
    expect(material.bytesBudgeted).toBeLessThanOrEqual(200000);
    expect(read.mock.calls.some(([file]) => file === files[0])).toBe(true);
    expect(read.mock.calls.some(([file]) => file === files[1])).toBe(false);
  });
  it('does not reuse the byte budget consumed by a failed native read', async () => {
    const f = await runtimeFixture();
    await f.vault.process(f.notebook, (raw) => raw + 'x'.repeat(140000));
    const second = await f.note('Notes/Second large.md', 'x'.repeat(140000), 'notebook');
    const raw = await f.vault.process(second, (raw) =>
      patchProperties(raw, { fileClass: 'Notebook' }),
    );
    f.cache.get(second).frontmatter = readDocument(raw).properties;
    Object.defineProperty(second, 'stat', {
      get: () => ({ size: new TextEncoder().encode(f.vault.bytes.get(second) ?? '').byteLength }),
    });
    const read = vi.spyOn(f.vault, 'read').mockRejectedValueOnce(new Error('Native read failed'));
    const material = await f.runtime.readSourceMaterial(() => true);
    expect(material.complete).toBe(false);
    expect(material.bytesBudgeted).toBeGreaterThanOrEqual(140000);
    expect(material.bytesBudgeted).toBeLessThanOrEqual(200000);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0]).toBe(f.notebook);
  });
  it('coalesces live source projections and never caches a cancelled observation', async () => {
    const f = await runtimeFixture();
    let release!: (raw: string) => void;
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(f.vault, 'read').mockImplementationOnce(() => held);
    let live = true;
    const first = f.runtime.readSourceMaterial(() => live);
    const second = f.runtime.readSourceMaterial(() => live);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    live = false;
    release(f.vault.bytes.get(f.notebook)!);
    const results = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    expect(results[0].cancelled).toBe(true);
    expect(results[0].complete).toBe(false);
    const retry = await f.runtime.readSourceMaterial(() => true);
    expect(retry.cancelled).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects captures from a disposed generation without writing', async () => {
    const f = await runtimeFixture();
    const source = await f.note('Reading/Inbox/Source.md', 'A source passage.');
    const snapshot = await f.store.read(source.path);
    f.runtime.dispose();
    await expect(f.runtime.keep(snapshot, 0, 16)).rejects.toThrow('settings changed');
    expect(await f.vault.read(f.notebook)).not.toContain('[!quote]');
  });
});

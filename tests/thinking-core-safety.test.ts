import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault, gate } from './helpers/memory-vault';

async function setup(body = 'Before. Selected **words**. After.') {
  const vault = new MemoryVault();
  const file = await vault.create('Source.md', `---\ntype: article\nstatus: feed\n---\n${body}\n`);
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\nNative text.\n');
  const articles = new ArticleStore(vault);
  const source = await articles.read(file.path);
  const store = new ThinkingStore(vault, {
    retainSource: async (snapshot, guard) => {
      guard();
      await articles.validate(snapshot);
      return snapshot;
    },
    now: () => new Date(2026, 10, 15),
  });
  const from = source.body.indexOf('Selected'),
    to = from + 'Selected **words**.'.length;
  const keep = () => store.keep({ notebookPath: 'Book.md', source, from, to });
  return { vault, store, articles, source, file, keep };
}
it('round-trips escaped comparison and inline code context without losing visible publisher evidence', async () => {
  const { keep, store } = await setup('`x < y` before. Selected **words**. After `a > b`.');
  const result = await keep();
  expect(result.status, result.message).toBe('saved');
  const record = (await store.read('Book.md')).records[0];
  expect(record.before).toBe('x < y before.');
  expect(record.after).toBe('After a > b.');
});
it('deduplicates verified repeated clicks without writing a second passage', async () => {
  const { keep, store } = await setup();
  const results = await Promise.all([keep(), keep()]);
  expect(results.map((result) => result.status)).toEqual(['saved', 'saved']);
  expect((await keep()).status).toBe('unchanged');
  expect((await store.read('Book.md')).records).toHaveLength(1);
});
it.each([
  'source bytes',
  'source identity',
  'dirty source',
  'dirty notebook',
  'missing notebook',
] as const)('rejects %s before publishing', async (mode) => {
  const { vault, file, source, keep, store } = await setup();
  if (mode === 'source bytes') vault.bytes.set(file, source.raw + '\nNative change.');
  if (mode === 'source identity') vault.files.set(source.path, { path: source.path });
  if (mode === 'dirty source') vault.dirty.add(file);
  if (mode === 'dirty notebook') vault.dirty.add(vault.file('Book.md')!);
  if (mode === 'missing notebook') vault.files.delete('Book.md');
  const result = await keep();
  expect(result.status).toBe('failed');
  if (mode !== 'missing notebook') expect((await store.read('Book.md')).records).toEqual([]);
});
it('reports retained source and failed notebook separately without rolling retention back', async () => {
  const { vault, source } = await setup();
  const protectedSource = { ...source, raw: source.raw.replace('status: feed', 'status: later') };
  const store = new ThinkingStore(vault, {
    retainSource: async () => {
      vault.bytes.set(source.file, protectedSource.raw);
      vault.failWrite = true;
      return protectedSource;
    },
  });
  const result = await store.keep({
    notebookPath: 'Book.md',
    source,
    from: source.body.indexOf('Selected'),
    to: source.body.indexOf(' After.'),
  });
  expect(result.status).toBe('partial');
  expect(result.retainedSource?.raw).toContain('status: later');
  expect(await vault.read(source.file)).toContain('status: later');
  expect((await store.read('Book.md')).records).toHaveLength(0);
});
it.each(['read rejection', 'native edit', 'rename'] as const)(
  'reports Possibly saved after %s during readback and never rolls back',
  async (mode) => {
    const { vault, store, keep } = await setup();
    const read = vault.read.bind(vault),
      process = vault.process.bind(vault);
    let settled = false;
    vault.process = async (file, update) => {
      const result = await process(file, update);
      settled = true;
      return result;
    };
    vault.read = async (file) => {
      if (settled && file.path === 'Book.md') {
        if (mode === 'read rejection') throw new Error('Readback unavailable');
        if (mode === 'native edit')
          vault.bytes.set(file, vault.bytes.get(file)! + '\nA later native edit.');
        if (mode === 'rename') {
          vault.files.delete(file.path);
          file.path = 'Renamed.md';
          vault.files.set(file.path, file);
        }
      }
      return read(file);
    };
    const result = await keep();
    expect(result.status).toBe('possibly-saved');
    expect(result.phase).toBe('notebook');
    expect([...vault.bytes.values()].join('\n')).toContain('^passage-1');
    settled = false;
    expect((await store.read(mode === 'rename' ? 'Renamed.md' : 'Book.md')).records).toHaveLength(
      1,
    );
  },
);
it('does not overwrite a target changed at the native process boundary', async () => {
  const { vault, store, keep } = await setup();
  const process = vault.process.bind(vault);
  vault.process = async (file, update) => {
    vault.bytes.set(file, vault.bytes.get(file)! + '\nNative change.');
    return process(file, update);
  };
  const result = await keep();
  expect(result.status).toBe('partial');
  const document = await store.read('Book.md');
  expect(document.records).toEqual([]);
  expect(document.raw).toContain('Native change.');
});
it('holds the dispatched slot through native settlement and drains it after disposal', async () => {
  const { vault, store, keep } = await setup();
  const entered = gate(),
    settlement = gate();
  vault.process = async (file, update) => {
    const next = update(await vault.read(file));
    entered.resolve();
    await settlement.promise;
    vault.bytes.set(file, next);
    return next;
  };
  const operation = keep();
  await entered.promise;
  store.dispose();
  let drained = false;
  const draining = store.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  settlement.resolve();
  const result = await operation;
  await draining;
  expect(result.status).toBe('saved');
  expect(drained).toBe(true);
  expect((await keep()).status).toBe('failed');
});
it('checks configured role authority before source retention and at commit', async () => {
  const { vault, source } = await setup();
  let retained = false;
  const store = new ThinkingStore(vault, {
    validateContainer: () => {
      throw new Error('Not a configured notebook');
    },
    retainSource: async (snapshot) => {
      retained = true;
      return snapshot;
    },
  });
  const result = await store.keep({ notebookPath: 'Book.md', source, from: 8, to: 16 });
  expect(result.status).toBe('failed');
  expect(retained).toBe(false);
});
it('does not silently reuse an occurrence whose bounded context also matches another location', async () => {
  const paragraph = 'A'.repeat(180) + ' Selected **words**. ' + 'Z'.repeat(180);
  const { store, source } = await setup(paragraph + '\n\n' + paragraph);
  const from = source.body.indexOf('Selected'),
    to = from + 'Selected **words**.'.length;
  const result = await store.keep({ notebookPath: 'Book.md', source, from, to });
  expect(result.status).toBe('failed');
  expect(result.message).toMatch(/ambiguous|unique|occurrence/i);
  expect((await store.read('Book.md')).records).toHaveLength(0);
});

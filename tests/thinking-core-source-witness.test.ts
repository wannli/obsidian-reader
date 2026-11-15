import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

it.each(['target read', 'target process'] as const)(
  'rejects native source changes during %s using a synchronous source revision witness',
  async (phase) => {
    const vault = new MemoryVault();
    await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
    const file = await vault.create('Source.md', '---\ntype: article\n---\nSelected source words.');
    const source = await new ArticleStore(vault).read(file.path);
    let revision = 0,
      notebookReads = 0;
    const read = vault.read.bind(vault),
      process = vault.process.bind(vault);
    const nativeChange = () => {
      revision++;
      vault.bytes.set(file, source.raw + '\nNative source change.');
    };
    vault.read = async (file) => {
      if (file.path === 'Book.md' && ++notebookReads === 2 && phase === 'target read')
        nativeChange();
      return read(file);
    };
    vault.process = async (file, update) => {
      if (phase === 'target process') nativeChange();
      return process(file, update);
    };
    const store = new ThinkingStore(vault, {
      retainSource: async (source) => source,
      observeSource: () => {
        const captured = revision;
        return () => {
          if (revision !== captured) throw new Error('Native source revision changed.');
        };
      },
    });
    const result = await store.keep({
      notebookPath: 'Book.md',
      source,
      from: 0,
      to: source.body.length,
    });
    expect(result.status).toBe('partial');
    expect(result.message).toContain('Native source revision changed');
    expect((await store.read('Book.md')).records).toEqual([]);
  },
);
it('constructs the final witness after own retention so an approved retention revision does not falsely reject saving', async () => {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\n');
  const file = await vault.create(
    'Source.md',
    '---\ntype: article\nstatus: feed\n---\nSelected source words.',
  );
  const source = await new ArticleStore(vault).read(file.path);
  let revision = 0;
  const store = new ThinkingStore(vault, {
    retainSource: async (source) => {
      revision++;
      const raw = source.raw.replace('status: feed', 'status: later');
      vault.bytes.set(source.file, raw);
      return { ...source, raw, properties: { ...source.properties, status: 'later' } };
    },
    observeSource: () => {
      const captured = revision;
      return () => {
        if (captured !== revision) throw new Error('Native source revision changed.');
      };
    },
  });
  const result = await store.keep({
    notebookPath: 'Book.md',
    source,
    from: 0,
    to: source.body.length,
  });
  expect(result.status, result.message).toBe('saved');
  expect(result.retainedSource?.raw).toContain('status: later');
});
